import { db, initDbSchema } from "../src/db/client";
import { getDefaultSystemId } from "../src/db/systems";
import { resolveDefaultAccountId } from "../src/db/emailAccounts";

async function main() {
  await db.query("SET statement_timeout TO 0");
  await db.query("SET lock_timeout TO 0");
  await initDbSchema();

  const systemId = await getDefaultSystemId();
  const accountId = await resolveDefaultAccountId(systemId);

  const checks = await Promise.all([
    db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM information_schema.columns WHERE table_name = 'emails' AND column_name = 'account_id'"),
    db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM information_schema.tables WHERE table_name = 'send_attempts'"),
    db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM information_schema.tables WHERE table_name = 'model_performance'"),
    db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM systems"),
    db.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM email_accounts"),
  ]);

  const hasEmailAccountColumn = checks[0].rows[0]?.c === "1";
  const hasSendAttemptsTable = checks[1].rows[0]?.c === "1";
  const hasModelPerformanceTable = checks[2].rows[0]?.c === "1";
  const systemsCount = Number(checks[3].rows[0]?.c ?? "0");
  const accountsCount = Number(checks[4].rows[0]?.c ?? "0");

  console.log("DB_INIT_OK");
  console.log(`systemId=${systemId}`);
  console.log(`accountId=${accountId ?? "none"}`);
  console.log(`emails.account_id=${hasEmailAccountColumn}`);
  console.log(`send_attempts.table=${hasSendAttemptsTable}`);
  console.log(`model_performance.table=${hasModelPerformanceTable}`);
  console.log(`systems.count=${systemsCount}`);
  console.log(`email_accounts.count=${accountsCount}`);
}

void main().catch((err) => {
  console.error("DB_INIT_FAILED", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
