import fs from "fs";
import path from "path";

const root = process.cwd();
const target = path.join(root, "dist", "worker.js");
const candidates = [
  path.join(root, "dist", "worker.js"),
  path.join(root, "dist", "worker", "worker.js"),
];

const source = candidates.find((candidate) => fs.existsSync(candidate));
if (!source) {
  throw new Error("Worker build output not found under dist/worker.js or dist/worker/worker.js");
}

if (source !== target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

const cjsPkgPath = path.join(root, "dist", "package.json");
fs.writeFileSync(cjsPkgPath, JSON.stringify({ type: "commonjs" }, null, 2));

console.log(`Worker entry normalized at ${target}`);
