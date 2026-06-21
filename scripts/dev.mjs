import { spawn } from "node:child_process";
import { once } from "node:events";

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5173"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

await waitForVite();

const tsc = spawn("npx", ["tsc", "-p", "tsconfig.node.json", "--watch", "--preserveWatchOutput"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

await waitForFile("dist/main/main.js");

const electron = spawn("npx", ["electron", "dist/main/main.js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" }
});

function stop() {
  electron.kill();
  tsc.kill();
  vite.kill();
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

await once(electron, "exit");
stop();

async function waitForVite() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:5173/");
      if (response.ok) return;
    } catch {
      await delay(300);
    }
  }
  throw new Error("Vite dev server did not start.");
}

async function waitForFile(filePath) {
  const { access } = await import("node:fs/promises");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(300);
    }
  }
  throw new Error(`${filePath} was not created.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
