import { google } from "googleapis";
import { getRuntimeConfigRequiredSync } from "../lib/runtimeConfig";

export function getOAuthClient() {
  const clientId = getRuntimeConfigRequiredSync("GMAIL_CLIENT_ID");
  const clientSecret = getRuntimeConfigRequiredSync("GMAIL_CLIENT_SECRET");
  const redirectUri = getRuntimeConfigRequiredSync("GMAIL_REDIRECT_URI");

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getOAuthUrl(): string {
  const oauth2Client = getOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    prompt: "consent",
  });
}

export async function exchangeCodeForTokens(code: string) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}
