import { spawn } from "node:child_process";

const steps = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "test:unit"]],
  ["npm", ["run", "test:integration"]],
  ["npm", ["run", "test:ui"]],
  ["npm", ["run", "test:office"]],
  ["npm", ["run", "test:stress"]],
  ["npm", ["run", "test:ui:visual"]],
  ["npm", ["run", "test:package"]]
];

for (const [command, args] of steps) {
  console.log(`\n==> ${command} ${args.join(" ")}`);
  const code = await run(command, args);
  if (code !== 0) {
    console.error(`\nfinal:verify stopped at: ${command} ${args.join(" ")}`);
    process.exit(code);
  }
}

console.log("\nfinal:verify passed.");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
  });
}
