# Tauri Desktop Runbook

This project uses Tauri as a native wrapper around the existing Next.js + worker runtime.

## Architecture

- UI and APIs remain the same Next.js app.
- Worker remains the same background process.
- Tauri only provides native desktop window packaging.
- Dev runtime uses `build.devUrl` (`http://localhost:3000`).
- Packaged runtime uses `build.frontendDist` (`desktop/web-dist` fallback page).

## Prerequisites

1. Node.js and npm installed.
2. Rust toolchain installed (`rustup`, `cargo`, `rustc`).
3. Visual Studio C++ Build Tools on Windows (required by Tauri native build).
4. Existing `.env.local` with required runtime values.

Windows quick install commands (PowerShell):

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
```

Then restart terminal and verify:

```bash
rustc --version
cargo --version
npx tauri info
```

## Development (hot reload)

```bash
npm run desktop:tauri:dev
```

What this does:
- Starts `next dev`.
- Starts `worker`.
- Waits for `http://localhost:3000`.
- Launches `tauri dev`.

## Production-like local runtime (without packaging)

```bash
npm run build
npm run desktop:runtime:prod
```

Use this when you want to validate runtime behavior with production Next output.

## Build desktop app (installer/bundle)

```bash
npm run desktop:tauri:build
```

This runs:
1. typecheck
2. Next build
3. desktop preflight
4. tauri build

## Deep QA gate

```bash
npm run desktop:qa:deep
```

Includes:
- typecheck + build
- desktop preflight
- hard-validation tests
- RAG integrity audit
- Playwright E2E onboarding tests
- fault-injection validation

Recommended native check before final bundle:

```bash
npx tauri info
```

You should see Rust/Cargo installed and Windows MSVC+SDK detected.

## Change-safe customization points

You can still make iterative changes safely:

1. Window/runtime behavior:
- Edit `src-tauri/tauri.conf.json` window size/title and `build.devUrl`/`build.frontendDist`.

2. App runtime stack:
- Edit scripts in `package.json` (`desktop:runtime:*`, `desktop:tauri:*`).

3. Preflight gates:
- Edit `scripts/desktop-preflight.ts` to tighten or relax checks.

4. QA policy and integrity checks:
- Edit `scripts/profile-rag-audit.ts` and `scripts/repair-embedding-integrity.ts`.

## Troubleshooting

1. If Tauri build fails with missing Rust/C++ tools:
- Install Rust (`rustup`) and Visual Studio Build Tools.

2. If desktop opens but shows blank/unreachable:
- Confirm runtime is running at `http://localhost:3000`.
- Run `npm run desktop:runtime:prod` or `npm run desktop:tauri:dev`.

3. If OAuth callback fails in desktop:
- Verify `GMAIL_REDIRECT_URI` points to loopback callback host.
- Run `npm run desktop:preflight` and check `oauth:*` checks.
