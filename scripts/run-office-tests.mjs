import { spawn } from "node:child_process";
import path from "node:path";

const vitest = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const env = {
  ...process.env,
  HL_WORD_INTEGRATION: "1",
  HL_EXCEL_INTEGRATION: "1",
  HL_POWERPOINT_INTEGRATION: "1"
};

const suites = [
  ["tests/office-hardening.test.ts"],
  ["tests/word-engine.test.ts"],
  ["tests/excel-engine.test.ts"],
  ["tests/powerpoint-engine.test.ts"]
];

for (const files of suites) {
  const code = await run(process.execPath, [vitest, "run", ...files], env);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

function run(command, args, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: childEnv,
      stdio: "inherit",
      shell: false
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
  });
}
