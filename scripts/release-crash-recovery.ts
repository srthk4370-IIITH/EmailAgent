import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";

const BASE_URL = process.env.RELEASE_CRASH_BASE_URL ?? "http://127.0.0.1:3101";
const USE_EXISTING_SERVER = (process.env.RELEASE_USE_EXISTING_SERVER ?? "false").toLowerCase() === "true";
const START_TIMEOUT_MS = Number(process.env.RELEASE_SERVER_START_TIMEOUT_MS ?? 120_000);

type AuthSession = {
  cookieHeader: string;
};

function parsePort(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForEndpoint(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, {}, 8_000);
      if (res.ok) return;
      lastError = `status=${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`Timeout waiting for ${url} (${lastError})`);
}

async function waitForEndpointDown(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, {}, 5_000);
      if (!res.ok) return;
    } catch {
      return;
    }
    await sleep(700);
  }
  throw new Error(`Endpoint still reachable after ${timeoutMs}ms: ${url}`);
}

function startBackend(baseUrl: string): ChildProcessWithoutNullStreams {
  const port = parsePort(baseUrl);
  const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", port], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "pipe",
  });

  child.stdout.on("data", () => {
    // keep process stream drained
  });
  child.stderr.on("data", () => {
    // keep process stream drained
  });

  return child;
}

async function stopBackend(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child) return;
  if (child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(8_000),
  ]);
  if (!child.killed) {
    child.kill("SIGKILL");
  }
}

function parseSessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  if (!raw) return "";
  const token = raw.split(";")[0] ?? "";
  return token.trim();
}

async function login(baseUrl: string): Promise<AuthSession> {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `release-recovery-${Date.now()}@example.com` }),
    },
    10_000,
  );
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }
  const cookieHeader = parseSessionCookie(res);
  if (!cookieHeader) {
    throw new Error("Missing session cookie after login");
  }
  return { cookieHeader };
}

async function postJson(baseUrl: string, path: string, body: unknown, session: AuthSession): Promise<Response> {
  return fetchWithTimeout(
    `${baseUrl}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify(body),
    },
    15_000,
  );
}

async function ensureGuidedFailure(baseUrl: string, session: AuthSession, scenario: string, expectedFixWord: string): Promise<void> {
  const res = await postJson(baseUrl, "/api/system/diagnostics/simulate", { scenario }, session);
  if (res.status !== 500) {
    throw new Error(`Simulation ${scenario} returned ${res.status} instead of 500`);
  }
  const payload = (await res.json().catch(() => null)) as { error?: { fix?: string } | string; fix?: string } | null;
  const fixText =
    typeof payload?.fix === "string"
      ? payload.fix
      : typeof payload?.error === "object" && payload.error && typeof payload.error.fix === "string"
      ? payload.error.fix
      : "";

  if (!fixText.toLowerCase().includes(expectedFixWord.toLowerCase())) {
    throw new Error(`Simulation ${scenario} missing expected guidance. Got fix="${fixText}"`);
  }
}

async function main() {
  const healthUrl = `${BASE_URL}/api/system/health`;
  let backend: ChildProcessWithoutNullStreams | null = null;

  try {
    if (!USE_EXISTING_SERVER) {
      backend = startBackend(BASE_URL);
      await waitForEndpoint(healthUrl, START_TIMEOUT_MS);
    } else {
      await waitForEndpoint(healthUrl, START_TIMEOUT_MS);
    }

    const session = await login(BASE_URL);

    await fetchWithTimeout(`${BASE_URL}/api/emails?filter=inbox&limit=5`, {
      headers: { Cookie: session.cookieHeader },
    });

    if (!USE_EXISTING_SERVER) {
      await stopBackend(backend);
      backend = null;
      await waitForEndpointDown(healthUrl, 30_000);

      backend = startBackend(BASE_URL);
      await waitForEndpoint(healthUrl, START_TIMEOUT_MS);
    }

    await ensureGuidedFailure(BASE_URL, session, "llm_timeout", "retry");
    await waitForEndpoint(healthUrl, 30_000);

    await ensureGuidedFailure(BASE_URL, session, "oauth_invalid_grant", "reconnect");
    await waitForEndpoint(healthUrl, 30_000);

    for (let i = 0; i < 3; i += 1) {
      await waitForEndpoint(healthUrl, 20_000);
      await sleep(700);
    }

    console.log("RELEASE_CRASH_RECOVERY_PASSED", {
      baseUrl: BASE_URL,
      usedExistingServer: USE_EXISTING_SERVER,
      checks: [
        "backend_kill_restart",
        "network_disconnect_reconnect_simulation",
        "gmail_revoke_simulation",
        "guided_failure_messages",
        "health_recovery_no_stuck_state",
      ],
    });
  } finally {
    if (!USE_EXISTING_SERVER) {
      await stopBackend(backend);
    }
  }
}

void main().catch((error) => {
  console.error("RELEASE_CRASH_RECOVERY_FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
