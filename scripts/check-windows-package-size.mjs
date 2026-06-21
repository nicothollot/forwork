import { existsSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const limitBytes = 120 * 1024 * 1024;
const exePath = path.resolve(process.argv[2] ?? path.join(root, "release", "windows-portable", "HL Intelligence.exe"));

if (!existsSync(exePath)) {
  console.error(`Windows portable executable was not found: ${exePath}`);
  process.exit(1);
}

const sizeBytes = statSync(exePath).size;
const sizeMiB = sizeBytes / 1024 / 1024;
const limitMiB = limitBytes / 1024 / 1024;

if (sizeBytes > limitBytes) {
  console.error(`HL Intelligence.exe is ${sizeMiB.toFixed(1)} MiB, exceeding the ${limitMiB.toFixed(0)} MiB limit.`);
  process.exit(1);
}

console.log(`HL Intelligence.exe size: ${sizeMiB.toFixed(1)} MiB (limit ${limitMiB.toFixed(0)} MiB)`);
