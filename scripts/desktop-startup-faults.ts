import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_HEALTH_PATH = "/api/system/check";
const REAL_RUNTIME_ROOT = path.join(process.cwd(), "desktop", "runtime");

type Severity = "PASS" | "FAIL";

type ResultRow = {
  name: string;
  severity: Severity;
  detail: string;
};

class StartupError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function logResult(result: ResultRow): void {
  console.log(`${result.severity.padEnd(4, " ")} ${result.name} - ${result.detail}`);
}

function addResult(results: ResultRow[], result: ResultRow): void {
  results.push(result);
  logResult(result);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function runtimePaths(runtimeRoot: string): {
  standaloneDir: string;
  serverEntry: string;
  staticDir: string;
  workerEntry: string;
} {
  const standaloneDir = path.join(runtimeRoot, ".next", "standalone");
  return {
    standaloneDir,
    serverEntry: path.join(standaloneDir, "server.js"),
    staticDir: path.join(standaloneDir, ".next", "static"),
    workerEntry: path.join(standaloneDir, "dist", "worker.js"),
  };
}

function resolveRuntimeRoot(candidates: string[]): string {
  for (const candidate of candidates) {
    const paths = runtimePaths(candidate);
    if (fs.existsSync(paths.serverEntry)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      throw new StartupError(
        "BACKEND_ENTRY_MISSING",
        `Expected backend entry at ${runtimePaths(candidate).serverEntry}`,
      );
    }
  }

  throw new StartupError(
    "RUNTIME_NOT_PACKAGED",
    "No packaged runtime candidate includes .next/standalone/server.js",
  );
}

function commandAvailable(command: string, args: string[] = ["--version"]): boolean {
  const executable = process.platform === "win32" ? `${command}.exe` : command;
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (!result.error && (result.status ?? 1) === 0) {
    return true;
  }

  const fallback = spawnSync(command, args, { encoding: "utf8" });
  return !fallback.error && (fallback.status ?? 1) === 0;
}

function resolveNodeExecutable(runtimeRoot: string, allowSystemNode: boolean): string {
  const bundledCandidates =
    process.platform === "win32"
      ? [path.join(runtimeRoot, "node", "node.exe"), path.join(runtimeRoot, "node.exe")]
      : [
          path.join(runtimeRoot, "node", "bin", "node"),
          path.join(runtimeRoot, "node", "node"),
          path.join(runtimeRoot, "node"),
        ];

  for (const candidate of bundledCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (allowSystemNode && commandAvailable("node")) {
    return "node";
  }

  throw new StartupError("NODE_NOT_FOUND", "No bundled Node binary was found and system node is unavailable.");
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, BACKEND_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  if (!(await isPortAvailable(port))) {
    throw new StartupError("BACKEND_PORT_CONFLICT", `Port ${port} is already in use.`);
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, BACKEND_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to acquire free port"));
        return;
      }

      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function spawnProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawnFailureCode: string,
) : Promise<ChildProcess> {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", () => {
    // Keep streams drained to avoid backpressure stalls.
  });
  child.stderr.on("data", () => {
    // Keep streams drained to avoid backpressure stalls.
  });

  return await new Promise((resolve, reject) => {
    let settled = false;

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new StartupError(spawnFailureCode, err.message));
    });

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolve(child);
    });
  });
}

async function startBackend(runtimeRoot: string, nodeExecutable: string, port: number): Promise<ChildProcess> {
  const { standaloneDir, serverEntry, staticDir } = runtimePaths(runtimeRoot);
  if (!fs.existsSync(serverEntry)) {
    throw new StartupError("BACKEND_ENTRY_MISSING", `Expected backend entry at ${serverEntry}`);
  }
  if (!fs.existsSync(staticDir)) {
    throw new StartupError("BACKEND_STATIC_MISSING", `Expected static directory at ${staticDir}`);
  }

  return await spawnProcess(
    nodeExecutable,
    ["server.js"],
    standaloneDir,
    {
      ...process.env,
      HOSTNAME: BACKEND_HOST,
      PORT: String(port),
      NODE_ENV: "production",
      EMAILAGENT_DESKTOP: "1",
    },
    "BACKEND_SPAWN_FAILED",
  );
}

async function startWorker(runtimeRoot: string, nodeExecutable: string): Promise<ChildProcess> {
  const { standaloneDir, workerEntry } = runtimePaths(runtimeRoot);
  if (!fs.existsSync(workerEntry)) {
    throw new StartupError("WORKER_ENTRY_MISSING", `Expected worker entry at ${workerEntry}`);
  }

  return await spawnProcess(
    nodeExecutable,
    [workerEntry],
    standaloneDir,
    {
      ...process.env,
      NODE_ENV: "production",
      EMAILAGENT_DESKTOP: "1",
    },
    "WORKER_SPAWN_FAILED",
  );
}

async function probeBackend(port: number): Promise<{ statusCode: number; isEmailagent: boolean } | null> {
  const url = `http://${BACKEND_HOST}:${port}${BACKEND_HEALTH_PATH}`;
  try {
    const response = await fetchWithTimeout(url, 700);
    const body = await response.text();
    const isEmailagent =
      body.includes("\"pipeline_ok\"") ||
      body.includes("\"service\":\"emailagent-backend\"") ||
      body.includes("\"service\": \"emailagent-backend\"");

    return {
      statusCode: response.status,
      isEmailagent,
    };
  } catch {
    return null;
  }
}

function exitStatusText(child: ChildProcess): string {
  if (child.exitCode !== null) {
    return String(child.exitCode);
  }
  if (child.signalCode) {
    return `signal:${child.signalCode}`;
  }
  return "unknown";
}

async function waitForBackend(
  backend: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null) {
      throw new StartupError(
        "BACKEND_EXITED",
        `Backend exited during startup (status ${exitStatusText(backend)})`,
      );
    }

    const probe = await probeBackend(port);
    if (probe?.isEmailagent) {
      return;
    }

    if (probe && !probe.isEmailagent && !(await isPortAvailable(port))) {
      throw new StartupError("BACKEND_PORT_CONFLICT", `Port ${port} is occupied by another process.`);
    }

    await sleep(250);
  }

  throw new StartupError(
    "BACKEND_BOOT_TIMEOUT",
    `No valid backend response at http://${BACKEND_HOST}:${port}${BACKEND_HEALTH_PATH} within ${timeoutMs}ms`,
  );
}

async function waitForWorkerBoot(worker: ChildProcess, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new StartupError(
        "WORKER_EXITED",
        `Worker exited during startup validation (status ${exitStatusText(worker)})`,
      );
    }
    await sleep(200);
  }
}

async function killChild(child: ChildProcess | null): Promise<void> {
  if (!child) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(1200),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(1200),
    ]);
  }
}

type ServerMode = "healthy" | "exit" | "idle";
type WorkerMode = "healthy" | "exit" | "missing";

function writeSyntheticRuntime(
  runtimeRoot: string,
  options: {
    serverMode: ServerMode;
    workerMode: WorkerMode;
    includeStatic: boolean;
  },
): void {
  const { standaloneDir, serverEntry, staticDir, workerEntry } = runtimePaths(runtimeRoot);

  fs.mkdirSync(standaloneDir, { recursive: true });
  if (options.includeStatic) {
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, ".keep"), "ok\n", "utf8");
  }

  let serverScript = "";
  if (options.serverMode === "healthy") {
    serverScript = [
      "const http = require('http');",
      "const host = process.env.HOSTNAME || '127.0.0.1';",
      "const port = Number(process.env.PORT || '3000');",
      `const healthPath = '${BACKEND_HEALTH_PATH}';`,
      "const server = http.createServer((req, res) => {",
      "  if (req.url === healthPath) {",
      "    res.writeHead(200, { 'Content-Type': 'application/json' });",
      "    res.end(JSON.stringify({ service: 'emailagent-backend', pipeline_ok: true }));",
      "    return;",
      "  }",
      "  res.writeHead(404, { 'Content-Type': 'application/json' });",
      "  res.end(JSON.stringify({ error: 'not_found' }));",
      "});",
      "server.listen(port, host);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
  } else if (options.serverMode === "exit") {
    serverScript = "process.exit(41);\n";
  } else {
    serverScript = "setInterval(() => {}, 1000);\n";
  }

  fs.writeFileSync(serverEntry, serverScript, "utf8");

  if (options.workerMode !== "missing") {
    fs.mkdirSync(path.dirname(workerEntry), { recursive: true });
    const workerScript =
      options.workerMode === "healthy"
        ? "setInterval(() => {}, 1000);\n"
        : "process.exit(31);\n";
    fs.writeFileSync(workerEntry, workerScript, "utf8");
  }
}

function readLockPid(lockPath: string): number | null {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  const raw = fs.readFileSync(lockPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("pid=")) {
      const parsed = Number(trimmed.replace("pid=", "").trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return null;
}

function acquireInstanceLock(
  lockPath: string,
  currentPid: number,
  isPidRunning: (pid: number) => boolean,
): { release: () => void } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const openNew = (): number => {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error("LOCK_ALREADY_EXISTS");
      }
      throw new Error(`Unable to create instance lock file: ${(error as Error).message}`);
    }
  };

  let fd: number;
  try {
    fd = openNew();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "LOCK_ALREADY_EXISTS") {
      throw error;
    }

    const existingPid = readLockPid(lockPath);
    if (existingPid !== null && isPidRunning(existingPid)) {
      throw new Error(`Another EmailAgent Desktop instance is already running (pid=${existingPid}).`);
    }

    fs.rmSync(lockPath, { force: true });

    try {
      fd = openNew();
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      if (retryMessage === "LOCK_ALREADY_EXISTS") {
        throw new Error("Another EmailAgent Desktop instance is already running.");
      }
      throw retryError;
    }
  }

  fs.writeFileSync(fd, `pid=${currentPid}\n`, "utf8");

  return {
    release: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // no-op
      }
      fs.rmSync(lockPath, { force: true });
    },
  };
}

function ensureInstanceLock(
  lockPath: string,
  currentPid: number,
  isPidRunning: (pid: number) => boolean,
): { release: () => void } {
  try {
    return acquireInstanceLock(lockPath, currentPid, isPidRunning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartupError("INSTANCE_LOCK_FAILED", message);
  }
}

async function expectFailure(
  results: ResultRow[],
  name: string,
  expectedCode: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
    addResult(results, {
      name,
      severity: "FAIL",
      detail: `Expected ${expectedCode} but no error was thrown`,
    });
  } catch (error) {
    if (error instanceof StartupError && error.code === expectedCode) {
      addResult(results, {
        name,
        severity: "PASS",
        detail: `Captured expected code ${expectedCode}`,
      });
      return;
    }

    addResult(results, {
      name,
      severity: "FAIL",
      detail:
        error instanceof StartupError
          ? `Expected ${expectedCode}, got ${error.code}: ${error.message}`
          : `Expected ${expectedCode}, got ${String(error)}`,
    });
  }
}

async function expectPass(results: ResultRow[], name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    addResult(results, {
      name,
      severity: "PASS",
      detail: "ok",
    });
  } catch (error) {
    addResult(results, {
      name,
      severity: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  const results: ResultRow[] = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emailagent-startup-fi-"));

  try {
    await expectPass(results, "real_runtime_payload_present", () => {
      const required = [
        path.join(REAL_RUNTIME_ROOT, ".next", "standalone", "server.js"),
        path.join(REAL_RUNTIME_ROOT, ".next", "standalone", ".next", "static"),
        path.join(REAL_RUNTIME_ROOT, ".next", "standalone", "dist", "worker.js"),
      ];
      for (const file of required) {
        if (!fs.existsSync(file)) {
          throw new Error(`Missing runtime artifact: ${file}`);
        }
      }
    });

    await expectFailure(results, "runtime_missing", "RUNTIME_NOT_PACKAGED", () => {
      resolveRuntimeRoot([path.join(tempRoot, "none-a"), path.join(tempRoot, "none-b")]);
    });

    await expectFailure(results, "backend_entry_missing", "BACKEND_ENTRY_MISSING", () => {
      const runtimeRoot = path.join(tempRoot, "backend-entry-missing");
      fs.mkdirSync(path.join(runtimeRoot, ".next", "standalone"), { recursive: true });
      resolveRuntimeRoot([runtimeRoot]);
    });

    await expectFailure(results, "backend_static_missing", "BACKEND_STATIC_MISSING", async () => {
      const runtimeRoot = path.join(tempRoot, "backend-static-missing");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "healthy",
        includeStatic: false,
      });
      const port = await pickFreePort();
      await startBackend(runtimeRoot, process.execPath, port);
    });

    await expectFailure(results, "worker_entry_missing", "WORKER_ENTRY_MISSING", async () => {
      const runtimeRoot = path.join(tempRoot, "worker-entry-missing");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "missing",
        includeStatic: true,
      });
      await startWorker(runtimeRoot, process.execPath);
    });

    await expectFailure(results, "node_not_found", "NODE_NOT_FOUND", () => {
      const runtimeRoot = path.join(tempRoot, "node-not-found");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "healthy",
        includeStatic: true,
      });
      resolveNodeExecutable(runtimeRoot, false);
    });

    await expectFailure(results, "backend_spawn_failed", "BACKEND_SPAWN_FAILED", async () => {
      const runtimeRoot = path.join(tempRoot, "backend-spawn-failed");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "healthy",
        includeStatic: true,
      });
      const port = await pickFreePort();
      await startBackend(runtimeRoot, path.join(runtimeRoot, "node", "missing-node.exe"), port);
    });

    await expectFailure(results, "worker_spawn_failed", "WORKER_SPAWN_FAILED", async () => {
      const runtimeRoot = path.join(tempRoot, "worker-spawn-failed");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "healthy",
        includeStatic: true,
      });
      await startWorker(runtimeRoot, path.join(runtimeRoot, "node", "missing-node.exe"));
    });

    await expectFailure(results, "backend_port_conflict", "BACKEND_PORT_CONFLICT", async () => {
      const port = await pickFreePort();
      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, BACKEND_HOST, () => resolve());
      });

      try {
        await assertPortAvailable(port);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    await expectFailure(results, "backend_exited", "BACKEND_EXITED", async () => {
      const runtimeRoot = path.join(tempRoot, "backend-exited");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "exit",
        workerMode: "healthy",
        includeStatic: true,
      });

      const nodeExecutable = resolveNodeExecutable(runtimeRoot, true);
      const port = await pickFreePort();
      const backend = await startBackend(runtimeRoot, nodeExecutable, port);
      try {
        await waitForBackend(backend, port, 2_500);
      } finally {
        await killChild(backend);
      }
    });

    await expectFailure(results, "backend_timeout", "BACKEND_BOOT_TIMEOUT", async () => {
      const runtimeRoot = path.join(tempRoot, "backend-timeout");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "idle",
        workerMode: "healthy",
        includeStatic: true,
      });

      const nodeExecutable = resolveNodeExecutable(runtimeRoot, true);
      const port = await pickFreePort();
      const backend = await startBackend(runtimeRoot, nodeExecutable, port);
      try {
        await waitForBackend(backend, port, 1_500);
      } finally {
        await killChild(backend);
      }
    });

    await expectFailure(results, "worker_exited", "WORKER_EXITED", async () => {
      const runtimeRoot = path.join(tempRoot, "worker-exited");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "exit",
        includeStatic: true,
      });

      const nodeExecutable = resolveNodeExecutable(runtimeRoot, true);
      const worker = await startWorker(runtimeRoot, nodeExecutable);
      try {
        await waitForWorkerBoot(worker, 1_500);
      } finally {
        await killChild(worker);
      }
    });

    await expectFailure(results, "instance_lock_live_pid", "INSTANCE_LOCK_FAILED", () => {
      const lockPath = path.join(tempRoot, "instance-lock-live", "instance.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `pid=${process.pid}\n`, "utf8");

      ensureInstanceLock(lockPath, process.pid, (pid) => pid === process.pid);
    });

    await expectPass(results, "instance_lock_stale_recovery", () => {
      const lockPath = path.join(tempRoot, "instance-lock-stale", "instance.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, "pid=999999\n", "utf8");

      const handle = ensureInstanceLock(lockPath, process.pid, (pid) => pid === process.pid);
      const writtenPid = readLockPid(lockPath);
      handle.release();

      if (writtenPid !== process.pid) {
        throw new Error(`Expected lock pid=${process.pid}, got ${writtenPid ?? "null"}`);
      }
    });

    await expectPass(results, "synthetic_runtime_boot_happy_path", async () => {
      const runtimeRoot = path.join(tempRoot, "runtime-happy-path");
      writeSyntheticRuntime(runtimeRoot, {
        serverMode: "healthy",
        workerMode: "healthy",
        includeStatic: true,
      });

      const resolvedRuntime = resolveRuntimeRoot([runtimeRoot]);
      const nodeExecutable = resolveNodeExecutable(resolvedRuntime, true);
      const port = await pickFreePort();

      await assertPortAvailable(port);

      const backend = await startBackend(resolvedRuntime, nodeExecutable, port);
      let worker: ChildProcess | null = null;
      try {
        await waitForBackend(backend, port, 3_500);
        worker = await startWorker(resolvedRuntime, nodeExecutable);
        await waitForWorkerBoot(worker, 1_200);
      } finally {
        await killChild(worker);
        await killChild(backend);
      }
    });

    const passCount = results.filter((row) => row.severity === "PASS").length;
    const failCount = results.filter((row) => row.severity === "FAIL").length;

    console.log("\nDesktop startup fault simulation summary");
    console.log(`PASS: ${passCount}`);
    console.log(`FAIL: ${failCount}`);

    if (failCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("DESKTOP_STARTUP_FAULTS_FAILED", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
