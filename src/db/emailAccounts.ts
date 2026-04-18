import { db } from "./client";
import { getPrimaryUser } from "./auth";
import { getDefaultSystemId } from "./systems";

export interface EmailAccountRow {
  id: number;
  system_id: number;
  user_id: number | null;
  email_address: string;
  provider: string;
  oauth_refresh_token: string | null;
  oauth_token_expiry: string | null;
  status: string;
  last_history_id: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listEmailAccounts(systemId: number): Promise<EmailAccountRow[]> {
  const result = await db.query<EmailAccountRow>(
    "SELECT * FROM email_accounts WHERE system_id = $1 ORDER BY id ASC",
    [systemId],
  );
  return result.rows;
}

export async function getEmailAccountById(id: number): Promise<EmailAccountRow | null> {
  const result = await db.query<EmailAccountRow>("SELECT * FROM email_accounts WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

export async function getDefaultEmailAccount(systemId?: number): Promise<EmailAccountRow | null> {
  const sid = systemId ?? (await getDefaultSystemId());
  const result = await db.query<EmailAccountRow>(
    `SELECT *
     FROM email_accounts
     WHERE system_id = $1
     ORDER BY
       CASE
         WHEN status = 'active' THEN 0
         WHEN status = 'needs_reauth' THEN 1
         ELSE 2
       END,
       id ASC
     LIMIT 1`,
    [sid],
  );
  return result.rows[0] ?? null;
}

export async function resolveDefaultAccountId(systemId?: number): Promise<number | null> {
  const account = await getDefaultEmailAccount(systemId);
  if (account) return account.id;

  const user = await getPrimaryUser();
  if (!user) return null;

  const sid = systemId ?? (await getDefaultSystemId());
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO email_accounts (system_id, user_id, email_address, provider, oauth_refresh_token, oauth_token_expiry, status)
     VALUES ($1, $2, $3, 'gmail', $4, $5, $6)
     ON CONFLICT (system_id, email_address)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [
      sid,
      user.id,
      user.gmail_email ?? user.email,
      user.gmail_refresh_token ?? null,
      user.gmail_token_expiry ?? null,
      user.gmail_refresh_token ? "active" : "needs_reauth",
    ],
  );

  return inserted.rows[0]?.id ?? null;
}

export async function updateAccountHistoryCursor(accountId: number, historyId: string): Promise<void> {
  await db.query(
    "UPDATE email_accounts SET last_history_id = $1, last_sync_at = NOW(), updated_at = NOW() WHERE id = $2",
    [historyId, accountId],
  );
}

export async function clearAccountHistoryCursor(accountId: number): Promise<void> {
  await db.query(
    "UPDATE email_accounts SET last_history_id = NULL, updated_at = NOW() WHERE id = $1",
    [accountId],
  );
}

export async function markEmailAccountNeedsReauth(accountId: number): Promise<void> {
  await db.query(
    `UPDATE email_accounts
     SET oauth_refresh_token = NULL,
         oauth_token_expiry = NULL,
         status = 'needs_reauth',
         updated_at = NOW()
     WHERE id = $1`,
    [accountId],
  );
}

export async function markUserEmailAccountsNeedsReauth(userId: number): Promise<void> {
  await db.query(
    `UPDATE email_accounts
     SET oauth_refresh_token = NULL,
         oauth_token_expiry = NULL,
         status = 'needs_reauth',
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId],
  );
}

export async function upsertDefaultAccountForUser(input: {
  userId: number;
  emailAddress: string;
  refreshToken?: string | null;
  tokenExpiry?: Date | null;
}): Promise<number> {
  const sid = await getDefaultSystemId();
  const result = await db.query<{ id: number }>(
    `INSERT INTO email_accounts (
       system_id, user_id, email_address, provider,
       oauth_refresh_token, oauth_token_expiry, status
     )
     VALUES ($1, $2, $3, 'gmail', $4, $5, $6)
     ON CONFLICT (system_id, email_address)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       oauth_refresh_token = COALESCE(EXCLUDED.oauth_refresh_token, email_accounts.oauth_refresh_token),
       oauth_token_expiry = COALESCE(EXCLUDED.oauth_token_expiry, email_accounts.oauth_token_expiry),
       status = CASE
         WHEN COALESCE(EXCLUDED.oauth_refresh_token, email_accounts.oauth_refresh_token) IS NULL THEN 'needs_reauth'
         ELSE 'active'
       END,
       updated_at = NOW()
     RETURNING id`,
    [
      sid,
      input.userId,
      input.emailAddress,
      input.refreshToken ?? null,
      input.tokenExpiry ?? null,
      input.refreshToken ? "active" : "needs_reauth",
    ],
  );
  return result.rows[0]?.id ?? 0;
}
