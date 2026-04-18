import fs from "fs";
import path from "path";

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

  console.log(`Desktop runtime staged at ${runtimeRoot}`);
}

main();
