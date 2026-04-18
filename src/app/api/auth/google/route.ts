import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient } from "../../../../services/oauth";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { redirectToConfiguredLocalAuthHostIfNeeded } from "../../../../lib/hostUtils";

function loginOAuthClient(_: NextRequest) {
  return getOAuthClient();
}

async function GETHandler(request: NextRequest) {
  const hostRedirect = redirectToConfiguredLocalAuthHostIfNeeded(request);
  if (hostRedirect) return hostRedirect;

  try {
    const oauth2 = loginOAuthClient(request);
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      prompt: "consent",
    });
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/login?error=oauth_config", request.url));
  }
}


export const GET = withApiRoute(GETHandler, { route: '/auth/google', operation: 'GET' });
