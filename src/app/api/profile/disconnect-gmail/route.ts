import { NextResponse } from "next/server";
import { withApiRoute } from "../../../../lib/routeErrorHandler";

async function POSTHandler() {
  return NextResponse.json(
    {
      ok: false,
      message:
        "Gmail is configured at the workspace level through server environment variables. Remove GMAIL_REFRESH_TOKEN to fully disconnect it.",
    },
    { status: 409 },
  );
}


export const POST = withApiRoute(POSTHandler, { route: '/profile/disconnect-gmail', operation: 'POST' });
