import { access, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

await run("npm", ["run", "build"]);
await run("npm", ["run", "skill:build"]);

const required = [
  "dist/main/main.js",
  "dist/preload/preload.cjs",
  "dist/renderer/index.html",
  "dist/schemas/review-config.schema.json",
  "dist/schemas/review-output.schema.json",
  "resources/office/office-worker.ps1"
];

for (const relative of required) {
  await access(path.join(process.cwd(), relative));
}

const renderer = await stat(path.join(process.cwd(), "dist/renderer/index.html"));
if (renderer.size <= 0) throw new Error("Renderer build output is empty.");

console.log("Package QA check passed. Final Windows distribution packaging was not run.");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
    child.on("error", reject);
  });
}
