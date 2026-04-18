import { NextResponse } from "next/server";

import { getDefaultSystemId } from "../../../../db/systems";
import { getDefaultEmailAccount, listEmailAccounts } from "../../../../db/emailAccounts";
import { apiError } from "../../../../lib/apiError";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function GETHandler() {
  try {
    const systemId = await getDefaultSystemId();
    const [accounts, active] = await Promise.all([
      listEmailAccounts(systemId),
      getDefaultEmailAccount(systemId),
    ]);

    return NextResponse.json({
      systemId,
      activeAccountId: active?.id ?? null,
      accounts: accounts.map((a) => ({
        id: a.id,
        email: a.email_address,
        status: a.status,
        lastSyncAt: a.last_sync_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      apiError(
        "ACCOUNT_LIST_FAILED",
        err instanceof Error ? err.message : "unknown_error",
        "Retry account load and run diagnostics if this persists.",
      ),
      { status: 500 },
    );
  }
}


export const GET = withApiRoute(GETHandler, { route: '/system/accounts', operation: 'GET' });
