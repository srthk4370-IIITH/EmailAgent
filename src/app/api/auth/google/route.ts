import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient } from "../../../../services/oauth";
import { isValidDesktopHandoffId } from "../../../../lib/desktopAuthHandoff";
import { withApiRoute } from "../../../../lib/routeErrorHandler";
import { redirectToConfiguredLocalAuthHostIfNeeded } from "../../../../lib/hostUtils";

function loginOAuthClient(_: NextRequest) {
  return getOAuthClient();
}

function normalizePrompt(rawPrompt: string | null): string {
  const normalized = (rawPrompt ?? "").trim().toLowerCase();
  if (normalized === "consent") return "consent";
  if (normalized === "select_account") return "select_account";
  if (normalized === "consent select_account" || normalized === "select_account consent") {
    return "consent select_account";
  }
  return "consent select_account";
}

function parseDesktopHandoffId(request: NextRequest): string | null {
  const candidate = request.nextUrl.searchParams.get("desktop_handoff")?.trim() ?? "";
  if (!candidate) return null;
  return isValidDesktopHandoffId(candidate) ? candidate : null;
}

async function GETHandler(request: NextRequest) {
  const hostRedirect = redirectToConfiguredLocalAuthHostIfNeeded(request);
  if (hostRedirect) return hostRedirect;

  try {
    const oauth2 = loginOAuthClient(request);
    const prompt = normalizePrompt(request.nextUrl.searchParams.get("prompt"));
    const desktopHandoffId = parseDesktopHandoffId(request);
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
      prompt,
      include_granted_scopes: true,
      ...(desktopHandoffId ? { state: `desktop_handoff:${desktopHandoffId}` } : {}),
    });
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/login?error=oauth_config", request.url));
  }
}


export const GET = withApiRoute(GETHandler, { route: '/auth/google', operation: 'GET' });
