import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const BOOTSTRAP_ENV_KEYS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "MIDDLEWARE_VERIFY_SECRET",
  "ONBOARDING_DRAFT_SECRET",
  "ONBOARDING_DRAFT_SECRET_PREVIOUS",
  "SESSION_COOKIE_SECURE",
];

function assertExists(label, targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} is missing at ${targetPath}`);
  }
}

function copyDir(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function loadBootstrapEnv(root) {
  const mergedEnv = {};

  const envSources = [
    path.join(root, ".env"),
    path.join(root, ".env.local"),
  ];

  for (const envPath of envSources) {
    if (!fs.existsSync(envPath)) continue;
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    Object.assign(mergedEnv, parsed);
  }

  Object.assign(mergedEnv, process.env);

  const bootstrapEnv = {
    NODE_ENV: "production",
  };

  for (const key of BOOTSTRAP_ENV_KEYS) {
    const value = mergedEnv[key];
    if (typeof value === "string" && value.trim().length > 0) {
      bootstrapEnv[key] = value.trim();
    }
  }

  return bootstrapEnv;
}

function main() {
  const root = process.cwd();
  const standaloneSource = path.join(root, ".next", "standalone");
  const staticSource = path.join(root, ".next", "static");
  const publicSource = path.join(root, "public");
  const workerSource = path.join(root, "dist", "worker.js");

  const runtimeRoot = path.join(root, "desktop", "runtime");
  const runtimeStandalone = path.join(runtimeRoot, ".next", "standalone");
  const runtimeStatic = path.join(runtimeStandalone, ".next", "static");
  const runtimePublic = path.join(runtimeStandalone, "public");
  const runtimeWorkerDir = path.join(runtimeStandalone, "dist");
  const runtimeWorker = path.join(runtimeWorkerDir, "worker.js");
  const runtimeServerEntry = path.join(runtimeStandalone, "server.js");

  assertExists("Next standalone output", standaloneSource);
  assertExists("Next static output", staticSource);
  assertExists("Worker build output", workerSource);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  copyDir(standaloneSource, runtimeStandalone);
  copyDir(staticSource, runtimeStatic);

  if (fs.existsSync(publicSource)) {
    copyDir(publicSource, runtimePublic);
  }

  copyFile(workerSource, runtimeWorker);
  assertExists("Runtime backend entry", runtimeServerEntry);
  assertExists("Runtime static assets", runtimeStatic);
  assertExists("Runtime worker entry", runtimeWorker);

  // Worker emit is CommonJS. Force CJS module interpretation even if parent standalone package is ESM.
  fs.writeFileSync(
    path.join(runtimeWorkerDir, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2),
  );

  const bundledNodeSource = process.env.BUNDLED_NODE_PATH?.trim();
  const nodeSource = bundledNodeSource && bundledNodeSource.length > 0 ? bundledNodeSource : process.execPath;

  if (nodeSource && fs.existsSync(nodeSource)) {
    const nodeDestination =
      process.platform === "win32"
        ? path.join(runtimeRoot, "node", "node.exe")
        : path.join(runtimeRoot, "node", "bin", "node");
    copyFile(nodeSource, nodeDestination);

    if (process.platform !== "win32") {
      fs.chmodSync(nodeDestination, 0o755);
    }

    console.log(`Bundled node runtime staged from ${nodeSource}`);
  }

  const bootstrapEnv = loadBootstrapEnv(root);
  const bootstrapDir = path.join(runtimeRoot, "bootstrap");
  const bootstrapEnvPath = path.join(runtimeRoot, "bootstrap", "runtime-env.json");
  fs.mkdirSync(path.dirname(bootstrapEnvPath), { recursive: true });
  fs.writeFileSync(bootstrapEnvPath, JSON.stringify(bootstrapEnv, null, 2));

  const runtimeManifestPath = path.join(bootstrapDir, "runtime-manifest.json");
  fs.writeFileSync(
    runtimeManifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        backendEntry: path.relative(runtimeRoot, runtimeServerEntry),
        staticDir: path.relative(runtimeRoot, runtimeStatic),
        workerEntry: path.relative(runtimeRoot, runtimeWorker),
        bundledNodeDetected: fs.existsSync(
          process.platform === "win32"
            ? path.join(runtimeRoot, "node", "node.exe")
            : path.join(runtimeRoot, "node", "bin", "node"),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`Bootstrap runtime env staged at ${bootstrapEnvPath}`);
  console.log(`Runtime manifest staged at ${runtimeManifestPath}`);

  console.log(`Desktop runtime staged at ${runtimeRoot}`);
}

main();
