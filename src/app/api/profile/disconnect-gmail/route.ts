import { NextResponse } from "next/server";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function POSTHandler() {
  return NextResponse.json(
    {
      ok: false,
      message:
        "Use onboarding Step 4 to reconnect or switch the Gmail account. This endpoint does not delete account history directly.",
    },
    { status: 409 },
  );
}


export const POST = withApiRoute(POSTHandler, { route: '/profile/disconnect-gmail', operation: 'POST' });
