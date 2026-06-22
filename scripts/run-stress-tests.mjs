import { spawn } from "node:child_process";
import path from "node:path";

const vitest = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
const env = { ...process.env, HL_STRESS: "1" };

const files = ["tests/stress.test.ts"];
if (process.env.HL_NATIVE_OFFICE_STRESS === "1") {
  env.HL_EXCEL_INTEGRATION = "1";
  env.HL_EXCEL_STRESS = "1";
  env.HL_POWERPOINT_INTEGRATION = "1";
  env.HL_POWERPOINT_STRESS = "1";
  files.push("tests/excel-engine.test.ts", "tests/powerpoint-engine.test.ts");
}

process.exitCode = await run(process.execPath, [vitest, "run", ...files], env);

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
