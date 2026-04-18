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

function main() {
  const root = process.cwd();
  const standaloneSource = path.join(root, ".next", "standalone");
  const staticSource = path.join(root, ".next", "static");
  const publicSource = path.join(root, "public");
  const workerSource = path.join(root, "dist-worker");

  const runtimeRoot = path.join(root, "desktop", "runtime");
  const runtimeStandalone = path.join(runtimeRoot, ".next", "standalone");
  const runtimeStatic = path.join(runtimeStandalone, ".next", "static");
  const runtimePublic = path.join(runtimeStandalone, "public");
  const runtimeWorker = path.join(runtimeStandalone, "dist-worker");

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

  copyDir(workerSource, runtimeWorker);

  // Worker emit is CommonJS. Force CJS module interpretation even if parent standalone package is ESM.
  fs.writeFileSync(
    path.join(runtimeWorker, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2),
  );

  console.log(`Desktop runtime staged at ${runtimeRoot}`);
}

main();
