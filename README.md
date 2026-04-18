# EmailAgent Desktop

EmailAgent is a desktop AI email assistant for Gmail. It helps you triage inbound mail, draft responses, and control send behavior with clear safety gates.

The app runs a local desktop runtime (UI + API + worker), keeps your workspace state in your configured database, and uses your own OpenAI + Google OAuth credentials.

## 1. Overview

### What the app does
- Connects to Gmail and syncs email threads.
- Classifies incoming messages and suggests or prepares replies.
- Supports three operating modes for different levels of automation.
- Applies safety checks before sending.
- Surfaces clear failure reasons and recovery actions.

### How it works (simple)
1. Desktop app launches local runtime.
2. You complete onboarding (OpenAI key, Google OAuth, Gmail connect).
3. Worker ingests and processes emails.
4. Replies move through mode-specific states (manual review or auto-send).
5. Logs and diagnostics expose system health and recovery guidance.

## 2. Installation

### Option A: Run from source (GitHub clone)

Prerequisites:
- Node.js 20+
- npm 10+
- PostgreSQL database (local or hosted)
- OpenAI API key
- Google OAuth client credentials for Gmail API

Desktop packaging prerequisites (for installer builds):
- Rust (`rustc`, `cargo`)
- On Windows: Visual Studio Build Tools with MSVC + Windows SDK

Setup steps:
1. Clone the repository.
2. Install dependencies:
	- `npm install`
	- If npm reports peer-resolution issues, use: `npm install --legacy-peer-deps`
3. Create local runtime config:
	- Copy `.env.example` to `.env.local`
	- Fill in your own credentials and database URL
4. Initialize database schema:
	- `npm run db:init`
5. Run preflight checks:
	- `npm run desktop:preflight`

Run commands:
- App + worker (development runtime): `npm run desktop:runtime:dev`
- App + worker (production runtime): `npm run build && npm run desktop:runtime:prod`
- Tauri desktop dev shell: `npm run desktop:tauri:dev`
- Build installer/app bundle: `npm run desktop:tauri:build`

### Option B: Install prebuilt desktop app
1. Download the latest installer from your release channel.
2. Run the installer.
3. Launch EmailAgent Desktop.

### First run behavior
- On first launch, EmailAgent opens onboarding automatically.
- You must provide your own OpenAI and Google OAuth credentials.
- Gmail connection is validated before full operation is enabled.

### Replication verification checklist (fresh clone)
1. `npm run typecheck` passes.
2. `npm run desktop:preflight` shows all required checks as PASS.
3. `npm run release:ship:checklist` passes.
4. `npm run desktop:tauri:build` produces a desktop bundle/installer.

## 3. Onboarding (step-by-step)

1. Add OpenAI API key.
2. Add Google OAuth Client ID and Client Secret.
3. Connect Gmail account.
4. Run final validation and confirm all checks are green.

## 4. Google OAuth (Important)

This app uses your own Google OAuth credentials.

### Why this is required
- Avoids Google OAuth 100-user testing limit tied to shared developer projects.
- Keeps your Gmail authorization scoped to your own Google Cloud project.
- Prevents accidental reliance on developer credentials.

### How to set up Google OAuth
1. Go to Google Cloud Console.
2. Create a new project.
3. Enable Gmail API.
4. Create an OAuth client (Web application).
5. Copy Client ID and Client Secret.
6. Paste them into onboarding Step 3 in EmailAgent.

Important:
- Use the callback URL shown by the app exactly.
- Mismatched redirect URLs will fail OAuth validation.

## 5. OpenAI Setup

### Get an API key
1. Open OpenAI platform dashboard.
2. Navigate to API keys.
3. Create a new secret key.
4. Paste it into onboarding Step 1.

### Verify setup
- Run onboarding validation.
- OpenAI check must return connected/responding.
- If it fails, verify key, quota, and billing status.

## 6. Modes

### Manual
- Processing stops at READY_TO_GENERATE.
- You explicitly trigger draft generation/review actions.

### Assist
- App generates draft and moves to AWAITING_REVIEW.
- You approve or edit before sending.

### Auto
- Full pipeline executes end-to-end.
- Safety gates can still block auto-send and move item to review.

## 7. Common Errors

### Gmail not connecting
Check OAuth Client ID/Secret and redirect URI. Reconnect Gmail and approve all requested scopes.

### OpenAI not working
Check API key validity, quota, and billing. Re-save key in onboarding/settings and retry.

### No emails loading
Check Gmail connection status and sync readiness. Use diagnostics and retry list fetch.

### Slow responses
System may switch to degraded behavior during dependency delays. Retry and monitor diagnostics.

## 8. Troubleshooting

### App not starting
- Restart the app.
- Verify database availability and runtime prerequisites.
- Check health/diagnostics endpoints in the app.

### Stuck processing
- Use force-process and logs to inspect the trace.
- Confirm mode settings (manual vs assist/auto).
- Check for safety/manual hold reasons in logs.

### Login issues
- Re-run Google sign-in.
- If OAuth config error appears, complete onboarding Step 3.

### Network errors
- Retry after short delay.
- Confirm internet access and API provider availability.
- Use diagnostics to identify failing subsystem and fix guidance.

## 9. System Behavior

### Auto recovery
- Worker retries transient failures.
- Crash recovery restarts backend/worker without leaving stuck states.

### Degraded responses
- Email list and diagnostics can return degraded payloads instead of hard crashes.
- Degraded responses include reason, warnings, and fix guidance.

### Retry logic
- Temporary failures back off and retry.
- Repeated failures can trigger manual hold/safety stop to avoid unsafe automation.

## 10. Limitations

- Requires your own OpenAI API key.
- Requires your own Google OAuth Client ID/Secret.
- Runs as a local backend runtime inside the desktop app.
- Subject to Gmail API quotas and Google OAuth policy constraints.

## Security Notes

- OpenAI and OAuth credentials are treated as runtime secrets.
- User-provided OpenAI/OAuth credentials do not auto-fallback from process environment variables.
- In fresh installs, onboarding input is required before those integrations are available.

## Quick Verification Checklist

1. Login works.
2. Onboarding checks all pass.
3. Gmail sync and email list load.
4. Manual/Assist/Auto mode behavior matches expectations.
5. Diagnostics show clear error cause/fix during simulated failures.
6. Crash recovery script passes.
