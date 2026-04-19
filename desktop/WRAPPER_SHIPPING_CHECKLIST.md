# Desktop Wrapper Shipping Checklist

This checklist prepares the project to ship inside a desktop wrapper (Electron/Tauri) without changing server-side pipeline behavior.

## 1) Runtime and OAuth readiness

1. Set required runtime values:
   - DATABASE_URL
   - OPENAI_API_KEY
   - GMAIL_CLIENT_ID
   - GMAIL_CLIENT_SECRET
   - GMAIL_REDIRECT_URI
2. Prefer a loopback Gmail callback host for local desktop flows (localhost/127.0.0.1).
3. Keep SESSION_COOKIE_SECURE on auto unless you are intentionally forcing HTTPS behavior.

## 2) Validation commands

1. npm run typecheck
2. npm run build
3. npm run desktop:preflight
4. npm run desktop:ship:prep
5. npm run test:e2e
6. npm run desktop:startup:faults
7. npx tauri info
8. npm run desktop:qa:deep

## 3) Wrapper integration tasks

1. Choose wrapper runtime (Electron or Tauri) and define target platforms.
2. Auto-start the Next.js standalone backend and compiled worker from wrapper startup.
3. Load bootstrap shell first; redirect to local app URL only after `/api/system/check` is healthy.
4. Route OAuth login/callback through local loopback host to preserve cookie/session origin.
5. Configure auto-update, crash reporting, and signed builds per platform.

Current implementation command set:
- Development wrapper launch: npm run desktop:tauri:dev
- Runtime without wrapper (prod-like): npm run desktop:runtime:prod
- Build Tauri bundle: npm run desktop:tauri:build

## 4) Release hardening

1. Verify login, inbox, drafts, sent, settings, and logs views on desktop window sizes.
2. Verify worker startup and graceful shutdown from wrapper lifecycle events.
3. Validate offline/slow-network behavior and reconnect handling.
4. Confirm no secrets are embedded in renderer bundles.
5. Produce signed installers and run smoke tests before publishing.
