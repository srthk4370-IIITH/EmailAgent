import { db } from "../src/db/client";

async function main() {
  console.log("--- RAG SYSTEM RESET ---");
  console.log("Deleting all existing embeddings from email_embeddings...");
  
  try {
    const result = await db.query("DELETE FROM email_embeddings");
    const feedbackResult = await db.query("DELETE FROM chunk_feedback");
    
    console.log(`Successfully deleted ${result.rowCount} embeddings.`);
    console.log(`Successfully deleted ${feedbackResult.rowCount} feedback records.`);
    console.log("RAG system is now clean.");
  } catch (err) {
    console.error("Failed to reset RAG system:", err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
