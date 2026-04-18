import fs from "fs";
import path from "path";

function assertExists(label, targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} is missing at ${targetPath}`);
  }
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => path.join(directory, name));
}

function pickNewest(filePaths) {
  if (filePaths.length === 0) {
    return null;
  }

  return filePaths
    .map((filePath) => ({
      filePath,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].filePath;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function main() {
  const root = process.cwd();
  const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
  const nsisDir = path.join(bundleRoot, "nsis");

  assertExists("Tauri bundle output directory", bundleRoot);
  assertExists("NSIS bundle output directory", nsisDir);

  const exeCandidates = listFiles(nsisDir, ".exe");
  const newestExe = pickNewest(exeCandidates);

  if (!newestExe) {
    throw new Error(`No NSIS .exe installer found in ${nsisDir}`);
  }

  const rootInstallerPath = path.join(root, "EmailAgent-Installer.exe");
  copyFile(newestExe, rootInstallerPath);

  console.log(`Installer copied to ${rootInstallerPath}`);
  console.log(`Source installer: ${newestExe}`);
}

main();
