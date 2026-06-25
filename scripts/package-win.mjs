import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const finalOutDir = resolveFinalOutputDir();
const stagingOutDir = path.join(root, "release", "windows-portable-staging");
const finalExePath = path.join(finalOutDir, "HL Intelligence.exe");
const stagedExePath = path.join(stagingOutDir, "HL Intelligence.exe");
const builderConfigPath = path.join(os.tmpdir(), `hl-intelligence-electron-builder-portable-${process.pid}.json`);

cleanGeneratedOutput();
mkdirSync(stagingOutDir, { recursive: true });
mkdirSync(finalOutDir, { recursive: true });

run("npm", ["run", "assets:windows"]);
run("npm", ["run", "build"]);

const builderConfig = {
  ...packageJson.build,
  directories: {
    ...(packageJson.build?.directories ?? {}),
    output: stagingOutDir
  }
};
writeFileSync(builderConfigPath, JSON.stringify(builderConfig, null, 2));

try {
  run("npx", [
    "electron-builder",
    "--win",
    "portable",
    "--x64",
    "--config",
    builderConfigPath
  ]);
} finally {
  rmSync(builderConfigPath, { force: true });
}

if (!existsSync(stagedExePath)) {
  console.error(`Expected portable EXE was not found: ${stagedExePath}`);
  process.exit(1);
}

prepareFinalOutput();
copyFileSync(stagedExePath, finalExePath);
assertSingleDefaultOutput();
run("node", ["scripts/check-windows-package-size.mjs", finalExePath]);

console.log(`Windows portable app saved to: ${finalExePath}`);
console.log(`Artifact size: ${formatMiB(statSync(finalExePath).size)}`);

function resolveFinalOutputDir() {
  if (process.env.HL_WINDOWS_DOWNLOADS) {
    const normalized = normalizeOutputOverride(process.env.HL_WINDOWS_DOWNLOADS);
    if (normalized !== process.env.HL_WINDOWS_DOWNLOADS) {
      console.log(`Converted Windows output path for WSL: ${normalized}`);
    }
    return path.resolve(normalized);
  }
  return path.join(root, "release", "windows-portable");
}

function normalizeOutputOverride(outputDir) {
  const trimmed = outputDir.trim();
  if (process.platform !== "win32") {
    const drivePath = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (drivePath) {
      const drive = drivePath[1].toLowerCase();
      const rest = drivePath[2].replace(/\\/g, "/");
      return path.posix.join("/mnt", drive, rest);
    }
  }
  return trimmed;
}

function cleanGeneratedOutput() {
  const generatedDirs = [
    path.join(root, "dist"),
    stagingOutDir
  ];

  if (!process.env.HL_WINDOWS_DOWNLOADS) {
    generatedDirs.push(finalOutDir);
  }

  for (const dir of generatedDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prepareFinalOutput() {
  if (process.env.HL_WINDOWS_DOWNLOADS) {
    rmSync(finalExePath, { force: true });
    return;
  }
  rmSync(finalOutDir, { recursive: true, force: true });
  mkdirSync(finalOutDir, { recursive: true });
}

function assertSingleDefaultOutput() {
  if (process.env.HL_WINDOWS_DOWNLOADS) return;
  const entries = readdirSync(finalOutDir).filter((entry) => entry !== ".DS_Store");
  if (entries.length !== 1 || entries[0] !== "HL Intelligence.exe") {
    console.error(`Final release directory must contain only HL Intelligence.exe. Found: ${entries.join(", ")}`);
    process.exit(1);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: buildToolEnv()
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function buildToolEnv() {
  return {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    WIN_CSC_LINK: "",
    WIN_CSC_KEY_PASSWORD: ""
  };
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
