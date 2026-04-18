import { withTimeout } from "../utils/withTimeout";
import { getValidAccountClient } from "./gmail";

/**
 * Send a manual email via Gmail WITHOUT the X-App-Generated header.
 * This ensures the email is treated as user-authored knowledge by the RAG pipeline.
 * Does NOT prefix "Re:" to the subject (caller controls that).
 */
export async function sendManualGmailEmail(params: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  accountId: number;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
}): Promise<string> {
  const gmail = await getValidAccountClient(params.accountId);
  if (!gmail) throw new Error("Gmail disabled for account: missing or invalid refresh token");

  const normalizedTo = params.to.trim();
  if (!normalizedTo || !normalizedTo.includes("@")) {
    throw new Error("Invalid recipient email address");
  }

  const attachments = (params.attachments ?? []).filter(
    (item) => item.filename && item.mimeType && item.dataBase64,
  );

  const email = attachments.length
    ? buildMultipartEmail({
        to: normalizedTo,
        subject: params.subject,
        body: params.body,
        attachments,
      })
    : [
        `To: ${normalizedTo}`,
        `Subject: ${params.subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        params.body,
      ].join("\n");
  const raw = Buffer.from(email).toString("base64url");

  const result = await withTimeout(
    gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: params.threadId ?? null,
      },
    }),
    10_000,
  );

  return result.data.id ?? "";
}

function buildMultipartEmail(input: {
  to: string;
  subject: string;
  body: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
}): string {
  const boundary = `mime-boundary-${Date.now()}`;
  const lines: string[] = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    input.body,
  ];

  for (const attachment of input.attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name=\"${attachment.filename}\"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=\"${attachment.filename}\"`,
      "",
      attachment.dataBase64,
    );
  }

  lines.push(`--${boundary}--`, "");
  return lines.join("\n");
}
