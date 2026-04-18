import { backfillSentMessages } from "../src/services/gmail";
import { insertEmailIfNotExists, getEmailById } from "../src/db/emails";
import { indexEmailForRag } from "../src/core/rag";
import { createTraceId } from "../src/utils/trace";
import { sanitizeStoredEmailText } from "../src/utils/sanitizeEmail";

async function main() {
  console.log("--- HISTORICAL SENT SYNC (BACKFILL) ---");
  console.log("Fetching the last 100 sent emails to seed RAG knowledge...");

  try {
    const emails = await backfillSentMessages(100);
    console.log(`Fetched ${emails.length} historical sent emails.`);

    let indexedCount = 0;

    for (const email of emails) {
      const traceId = `backfill-${createTraceId()}`;

      const inserted = await insertEmailIfNotExists({
        gmailId: email.gmailId,
        traceId,
        threadId: email.threadId,
        fromEmail: sanitizeStoredEmailText(email.from || ""),
        subject: sanitizeStoredEmailText(email.subject || "(no subject)"),
        body: sanitizeStoredEmailText(email.body || ""),
        snippet: sanitizeStoredEmailText(email.snippet || ""),
        internalDate: email.internalDate,
        source: "sent",
        state: "SENT",
      });

      if (inserted) {
        // Force RAG indexing for sent emails
        console.log(`Indexing historical sent email: ${inserted.subject} (${inserted.gmail_id})`);
        await indexEmailForRag(inserted);
        indexedCount++;
      } else {
        // logger.info("Backfill skip: already exists", { gmailId: email.gmailId });
      }
    }

    console.log(`Historical backfill complete. Indexed ${indexedCount} new sent messages.`);
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
