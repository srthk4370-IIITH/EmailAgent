import { google, gmail_v1 } from "googleapis";
import { db } from "../db/client";

import type { AppConfig } from "../db/config";
import { cleanEmailBody } from "../utils/cleanEmail";
import { withRetry } from "../utils/retry";
import { withTimeout } from "../utils/withTimeout";
import { getOAuthClient } from "./oauth";
import {
  getEmailAccountById,
  markEmailAccountNeedsReauth,
  markUserEmailAccountsNeedsReauth,
} from "../db/emailAccounts";
import { getRuntimeConfigSync } from "../lib/runtimeConfig";

type OAuthRefreshErrorLike = {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  response?: {
    status?: unknown;
    data?: {
      error?: unknown;
      error_description?: unknown;
    };
  };
  cause?: {
    message?: unknown;
  };
};

function safeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const parsed = err as OAuthRefreshErrorLike;

  const parts = [
    safeText(parsed.message),
    safeText(parsed.cause?.message),
    safeText(parsed.response?.data?.error),
    safeText(parsed.response?.data?.error_description),
  ]
    .filter(Boolean)
    .map((item) => item.toLowerCase());

  return parts.some((item) => item.includes("invalid_grant") || item.includes("expired") || item.includes("revoked"));
}

function summarizeRefreshError(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown_refresh_error";
  const parsed = err as OAuthRefreshErrorLike;

  const providerError = safeText(parsed.response?.data?.error);
  const providerDescription = safeText(parsed.response?.data?.error_description);
  const message = safeText(parsed.message) || safeText(parsed.cause?.message);
  const status = safeText(parsed.status) || safeText(parsed.code);

  const summaryParts = [providerError, providerDescription, message, status ? `status=${status}` : ""].filter(Boolean);
  return summaryParts.join(" | ") || "unknown_refresh_error";
}

function resolveErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const parsed = err as OAuthRefreshErrorLike;

  const candidates = [parsed.response?.status, parsed.status, parsed.code];
  for (const candidate of candidates) {
    const normalized = Number(candidate);
    if (Number.isFinite(normalized) && normalized > 0) {
      return normalized;
    }
  }

  return null;
}

function isInvalidStartHistoryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const parsed = err as OAuthRefreshErrorLike;

  const normalizedText = [
    safeText(parsed.message),
    safeText(parsed.cause?.message),
    safeText(parsed.response?.data?.error),
    safeText(parsed.response?.data?.error_description),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const mentionsStartHistoryId = normalizedText.includes("starthistoryid");
  const mentionsInvalidHistoryId =
    normalizedText.includes("historyid") &&
    (normalizedText.includes("invalid") || normalizedText.includes("too old") || normalizedText.includes("expired"));

  const status = resolveErrorStatus(err);
  return mentionsStartHistoryId || (status === 400 && mentionsInvalidHistoryId);
}

async function markUserGmailNeedsReauth(userId: number): Promise<void> {
  await db.query(
    `UPDATE users
     SET gmail_refresh_token = NULL,
         gmail_token_expiry = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [userId],
  );

  await markUserEmailAccountsNeedsReauth(userId);
}

function normalizeRecipientEmail(input: string): string {
  // Gmail requires a valid email address (newlines/encoded display names can break "To:" header).
  const s = (input ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!s) return "";

  const angle = s.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();

  const direct = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (direct) return direct.trim();

  return "";
}

export interface GmailEmail {
  gmailId: string;
  threadId: string;
  subject: string;
  body: string;
  to: string;
  from: string;
  snippet: string;
  internalDate: number | null;
  threadMessages: Array<{ from: string; subject: string; body: string; internal_date: number | null; message_id?: string | null }>;
  source: "inbox" | "sent";
  appGenerated: boolean;
  userEdited: boolean;
}

export type GmailIncrementalSyncResult =
  | { kind: "disabled" }
  | { kind: "first_run"; profileHistoryId: string }
  | { kind: "history_reset"; profileHistoryId: string }
  | { kind: "invalid_history_id"; cursorHistoryId: string; summary: string }
  | { kind: "synced"; emails: GmailEmail[]; nextHistoryId: string; noNewMessages: boolean };

export interface GmailFullResyncResult {
  emails: GmailEmail[];
  latestHistoryId: string;
  fetchedMessageCount: number;
}

/**
 * getValidUserClient checks tokens for a given user, refreshes if expired,
 * and returns a ready-to-use Gmail client.
 */
export async function getValidUserClient(userId: number): Promise<gmail_v1.Gmail | null> {
  const result = await db.query<any>(
    "SELECT gmail_refresh_token, gmail_token_expiry FROM users WHERE id = $1",
    [userId],
  );
  const user = result.rows[0];
  if (!user || !user.gmail_refresh_token) {
    return null;
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: user.gmail_refresh_token,
  });

  const isExpired = !user.gmail_token_expiry || new Date(user.gmail_token_expiry).getTime() <= Date.now() + 60000;

  if (isExpired) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      const expiry = credentials.expiry_date ? new Date(credentials.expiry_date) : null;

      await db.query(
        "UPDATE users SET gmail_token_expiry = $1, updated_at = NOW() WHERE id = $2",
        [expiry, userId],
      );
    } catch (err) {
      const summary = summarizeRefreshError(err);
      if (isInvalidGrantError(err)) {
        try {
          await markUserGmailNeedsReauth(userId);
        } catch (markErr) {
          console.error(
            "Failed to mark Gmail credentials as needs_reauth for user",
            userId,
            summarizeRefreshError(markErr),
          );
        }

        console.warn(
          `Gmail refresh token revoked for user ${userId}; marked credentials as needs_reauth (${summary})`,
        );
      } else {
        console.error(`Failed to refresh Gmail token for user ${userId}: ${summary}`);
      }
      return null;
    }
  }

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function getValidAccountClient(accountId: number): Promise<gmail_v1.Gmail | null> {
  const account = await getEmailAccountById(accountId);
  if (!account || !account.oauth_refresh_token) {
    if (account && account.status !== "needs_reauth") {
      try {
        await markEmailAccountNeedsReauth(accountId);
      } catch {
        // Keep null return; this is best-effort consistency cleanup.
      }
    }
    return null;
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: account.oauth_refresh_token,
  });

  const isExpired = !account.oauth_token_expiry || new Date(account.oauth_token_expiry).getTime() <= Date.now() + 60000;

  if (isExpired) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      const expiry = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
      await db.query(
        "UPDATE email_accounts SET oauth_token_expiry = $1, updated_at = NOW() WHERE id = $2",
        [expiry, accountId],
      );
    } catch (err) {
      const summary = summarizeRefreshError(err);
      if (isInvalidGrantError(err)) {
        try {
          await markEmailAccountNeedsReauth(accountId);
        } catch (markErr) {
          console.error(
            "Failed to mark Gmail credentials as needs_reauth for account",
            accountId,
            summarizeRefreshError(markErr),
          );
        }

        console.warn(
          `Gmail refresh token revoked for account ${accountId}; marked credentials as needs_reauth (${summary})`,
        );
      } else {
        console.error(`Failed to refresh Gmail token for account ${accountId}: ${summary}`);
      }
      return null;
    }
  }

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/** @deprecated Use getValidUserClient(userId) for per-user ownership. */
export function getAuthedGmailClient(): gmail_v1.Gmail | null {
  const refreshToken = getRuntimeConfigSync("GMAIL_REFRESH_TOKEN");
  if (!refreshToken) {
    console.warn("Gmail disabled: no refresh token");
    return null;
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  const part = payload.parts?.find((p) => p.mimeType === "text/plain");
  if (part?.body?.data) {
    return decodeBody(part.body.data);
  }

  return "";
}

function resolveInboxOrSent(labelIds: string[] | undefined): "inbox" | "sent" | null {
  if (!labelIds?.length) return null;
  
  // Hard filters
  if (labelIds.includes("TRASH") || labelIds.includes("SPAM") || labelIds.includes("DRAFT")) {
    return null;
  }

  // Mandatory: SENT label strictly identifies a sent email
  if (labelIds.includes("SENT")) return "sent";
  
  // Mandatory: INBOX label strictly identifies an inbox email
  if (labelIds.includes("INBOX")) return "inbox";
  
  return null;
}

export async function buildGmailEmail(
  gmail: gmail_v1.Gmail,
  messageId: string,
  source: "inbox" | "sent",
): Promise<GmailEmail | null> {
  const detail = await withRetry(
    () =>
      withTimeout(
        gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        }),
        10_000,
      ),
    { attempts: 3, delayMs: 700 },
  );

  const payload = detail.data.payload;
  const threadId = detail.data.threadId ?? "";
  if (!threadId) return null;

  const appGeneratedHeader = getHeader(payload?.headers, "X-App-Generated").toLowerCase();
  const appGenerated = appGeneratedHeader === "true" || appGeneratedHeader === "1" || appGeneratedHeader === "yes";
  const userEditedHeader = getHeader(payload?.headers, "X-User-Edited").toLowerCase();
  const userEdited = userEditedHeader === "true" || userEditedHeader === "1" || userEditedHeader === "yes";

  const fromHeader = getHeader(payload?.headers, "From");
  const toHeader = getHeader(payload?.headers, "To");

  const thread = await withRetry(
    () =>
      withTimeout(
        gmail.users.threads.get({
          userId: "me",
          id: threadId,
          format: "full",
        }),
        10_000,
      ),
    { attempts: 3, delayMs: 700 },
  );
    const threadMessages = (() => {
      const messages =
        thread.data.messages?.map((m) => {
          const mPayload = m.payload;
          return {
            from: getHeader(mPayload?.headers, "From"),
            subject: getHeader(mPayload?.headers, "Subject"),
            body: cleanEmailBody(extractBody(mPayload) || m.snippet || ""),
            internal_date: m.internalDate ? Number(m.internalDate) : null,
            message_id: m.id ?? null,
          };
        }) ?? [];

      const currentMessage = {
        from: fromHeader,
        subject: getHeader(payload?.headers, "Subject"),
        body: cleanEmailBody(extractBody(payload) || detail.data.snippet || ""),
        internal_date: detail.data.internalDate ? Number(detail.data.internalDate) : null,
        message_id: detail.data.id ?? null,
      };

      const deduped = [...messages, currentMessage].filter((message, index, all) => {
        const key = `${message.message_id ?? ""}\n${message.from}\n${message.subject}\n${message.body}\n${message.internal_date ?? "null"}`;
        return all.findIndex((candidate) => `${candidate.message_id ?? ""}\n${candidate.from}\n${candidate.subject}\n${candidate.body}\n${candidate.internal_date ?? "null"}` === key) === index;
      });

      return deduped.sort((a, b) => (a.internal_date ?? 0) - (b.internal_date ?? 0));
    })();

  return {
    gmailId: messageId,
    threadId,
    subject: getHeader(payload?.headers, "Subject"),
    body: cleanEmailBody(extractBody(payload) || detail.data.snippet || ""),
    to: toHeader,
    from: fromHeader,
    snippet: detail.data.snippet ?? "",
    internalDate: detail.data.internalDate && Number.isFinite(Number(detail.data.internalDate)) ? Number(detail.data.internalDate) : null,
    threadMessages,
    source,
    appGenerated,
    userEdited,
  };
}

async function fetchMessageForSync(client: gmail_v1.Gmail, messageId: string): Promise<GmailEmail | null> {
  const head = await withRetry(
    () =>
      withTimeout(
        client.users.messages.get({
          userId: "me",
          id: messageId,
          format: "minimal",
        }),
        10_000,
      ),
    { attempts: 2, delayMs: 500 },
  );

  const source = resolveInboxOrSent(head.data.labelIds ?? undefined);
  if (!source) return null;
  return await buildGmailEmail(client, messageId, source);
}

/**
 * Incremental Gmail sync: first run stores profile historyId only (no backfill).
 * Later runs use History API only — never messages.list without a cursor.
 */
export async function syncGmailMailbox(
  config: AppConfig,
  userId: number,
  cursorOverride?: string | null,
  accountId?: number,
): Promise<GmailIncrementalSyncResult> {
  const gmail = (accountId ? await getValidAccountClient(accountId) : null) ?? (await getValidUserClient(userId));
  if (!gmail) {
    return { kind: "disabled" };
  }
  const client = gmail;

  const effectiveCursor = cursorOverride ?? config.last_gmail_history_id;

  if (!effectiveCursor) {
    const profile = await withRetry(
      () => withTimeout(client.users.getProfile({ userId: "me" }), 10_000),
      { attempts: 3, delayMs: 700 },
    );
    const hid = profile.data.historyId;
    if (!hid) {
      return { kind: "disabled" };
    }
    return { kind: "first_run", profileHistoryId: String(hid) };
  }

  const cursorHistoryId = effectiveCursor;
  const messageIdSet = new Set<string>();
  let nextHistoryId: string | null = null;

  const FETCH_BATCH = 20;

  try {
    let historyPageToken: string | undefined;
    do {
      const listParams: gmail_v1.Params$Resource$Users$History$List = {
        userId: "me",
        historyTypes: ["messageAdded"],
      };
      if (historyPageToken) {
        listParams.pageToken = historyPageToken;
      } else {
        listParams.startHistoryId = cursorHistoryId;
      }

      const history = await withRetry(
        () => withTimeout(client.users.history.list(listParams), 20_000),
        { attempts: 3, delayMs: 700 },
      );

      const hist = history.data.history ?? [];
      nextHistoryId = history.data.historyId ? String(history.data.historyId) : nextHistoryId;

      for (const h of hist) {
        for (const added of h.messagesAdded ?? []) {
          const mid = added.message?.id;
          if (mid) messageIdSet.add(mid);
        }
      }

      historyPageToken = history.data.nextPageToken ?? undefined;

      if (hist.length === 0 && !historyPageToken && messageIdSet.size === 0) {
        const hid = history.data.historyId
          ? String(history.data.historyId)
          : nextHistoryId ?? cursorHistoryId;
        return {
          kind: "synced",
          emails: [],
          nextHistoryId: hid,
          noNewMessages: true,
        };
      }
    } while (historyPageToken);
  } catch (err: unknown) {
    if (isInvalidStartHistoryError(err)) {
      return {
        kind: "invalid_history_id",
        cursorHistoryId,
        summary: summarizeRefreshError(err),
      };
    }

    const code = resolveErrorStatus(err) ?? undefined;
    if (code === 404) {
      const profile = await withRetry(
        () => withTimeout(client.users.getProfile({ userId: "me" }), 10_000),
        { attempts: 3, delayMs: 700 },
      );
      const hid = profile.data.historyId;
      if (!hid) {
        return { kind: "disabled" };
      }
      return { kind: "history_reset", profileHistoryId: String(hid) };
    }
    throw err;
  }

  if (!nextHistoryId) {
    const profile = await withRetry(
      () => withTimeout(client.users.getProfile({ userId: "me" }), 10_000),
      { attempts: 3, delayMs: 700 },
    );
    const hid = profile.data.historyId;
    if (!hid) {
      return { kind: "disabled" };
    }
    nextHistoryId = String(hid);
  }

  const emails: GmailEmail[] = [];
  const ids = Array.from(messageIdSet);

  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const batch = ids.slice(i, i + FETCH_BATCH);
    const settled = await Promise.allSettled(batch.map((id) => fetchMessageForSync(client, id)));
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        emails.push(s.value);
      }
    }
  }

  const noNewMessages = emails.length === 0;

  return { kind: "synced", emails, nextHistoryId, noNewMessages };
}

export async function performFullResync(
  userId: number,
  accountId?: number,
  maxResults = 100,
): Promise<GmailFullResyncResult | null> {
  const gmail = (accountId ? await getValidAccountClient(accountId) : null) ?? (await getValidUserClient(userId));
  if (!gmail) {
    return null;
  }

  const limit = Math.max(50, Math.min(100, Math.floor(maxResults)));
  const list = await withRetry(
    () =>
      withTimeout(
        gmail.users.messages.list({
          userId: "me",
          maxResults: limit,
          q: "-in:trash -in:spam -in:draft",
        }),
        20_000,
      ),
    { attempts: 3, delayMs: 700 },
  );

  const messageIds = Array.from(
    new Set(
      (list.data.messages ?? [])
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const emails: GmailEmail[] = [];
  const FETCH_BATCH = 20;

  for (let i = 0; i < messageIds.length; i += FETCH_BATCH) {
    const batch = messageIds.slice(i, i + FETCH_BATCH);
    const settled = await Promise.allSettled(batch.map((id) => fetchMessageForSync(gmail, id)));
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        emails.push(result.value);
      }
    }
  }

  const profile = await withRetry(
    () => withTimeout(gmail.users.getProfile({ userId: "me" }), 10_000),
    { attempts: 3, delayMs: 700 },
  );
  const latestHistoryId = profile.data.historyId ? String(profile.data.historyId) : null;
  if (!latestHistoryId) {
    return null;
  }

  return {
    emails,
    latestHistoryId,
    fetchedMessageCount: messageIds.length,
  };
}

export async function createGmailDraft(params: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  userId?: number;
  accountId?: number;
}): Promise<string> {
  const gmail =
    (params.accountId ? await getValidAccountClient(params.accountId) : null) ??
    (params.userId ? await getValidUserClient(params.userId) : null);
  if (!gmail) {
    throw new Error("Gmail disabled for user: missing or invalid tokens");
  }
  const email = [
    `To: ${params.to}`,
    `Subject: Re: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\n");

  const raw = Buffer.from(email).toString("base64url");
  const result = await withTimeout(
    gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId: params.threadId ?? null,
        },
      },
    }),
    10_000,
  );

  return result.data.id ?? "";
}

export async function sendGmailEmail(params: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  userId?: number;
  accountId?: number;
  userEdited?: boolean;
}): Promise<string> {
  const gmail =
    (params.accountId ? await getValidAccountClient(params.accountId) : null) ??
    (params.userId ? await getValidUserClient(params.userId) : null);
  if (!gmail) {
    throw new Error("Gmail disabled for user: missing or invalid tokens");
  }
  const rawTo = params.to ?? "";
  const normalizedTo = normalizeRecipientEmail(rawTo);
  const rawHasAt = rawTo.includes("@");
  const rawHasNewlines = /[\r\n]+/.test(rawTo);
  const normalizedHasAt = normalizedTo.includes("@");

  if (!normalizedTo) {
    throw new Error(
      `Invalid recipient email (rawHasAt=${rawHasAt}, rawHasNewlines=${rawHasNewlines}, normalizedHasAt=${normalizedHasAt})`,
    );
  }
  const email = [
    `To: ${normalizedTo}`,
    `Subject: Re: ${params.subject}`,
    "X-App-Generated: true",
    `X-User-Edited: ${params.userEdited ? "true" : "false"}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\n");

  const raw = Buffer.from(email).toString("base64url");
  let result;
  try {
    result = await withTimeout(
      gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
          threadId: params.threadId ?? null,
        },
      }),
      10_000,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gmail_send_failed";
    throw new Error(
      `${message} (rawHasAt=${rawHasAt}, rawHasNewlines=${rawHasNewlines}, normalizedHasAt=${normalizedHasAt}, normalizedLen=${normalizedTo.length})`,
    );
  }

  return result.data.id ?? "";
}

/**
 * Backfill: Fetch up to N historical sent emails to seed the RAG system.
 */
export async function backfillSentMessages(userId: number, limit = 100): Promise<GmailEmail[]> {
  const gmail = await getValidUserClient(userId);
  if (!gmail) return [];

  const response = await withTimeout(
    gmail.users.messages.list({
      userId: "me",
      q: "label:SENT",
      maxResults: limit,
    }),
    20_000,
  );

  const messages = response.data.messages ?? [];
  const fetched: GmailEmail[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;
    try {
      const email = await buildGmailEmail(gmail, msg.id, "sent");
      if (email) fetched.push(email);
    } catch (err) {
      console.warn(`[Backfill] Failed to fetch message ${msg.id}`, err);
    }
  }

  return fetched;
}
