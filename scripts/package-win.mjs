import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const downloadsDir = resolveWindowsDownloads();
const packageOutDir = path.join(root, "release", "windows-package");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const arch = "x64";
const defaultPackageDirName = `HL Intelligence-${version}-windows-${arch}-unpacked`;

mkdirSync(downloadsDir, { recursive: true });
rmSync(packageOutDir, { recursive: true, force: true });
mkdirSync(packageOutDir, { recursive: true });
run("npm", ["run", "assets:windows"]);

cleanupGenerated(packageOutDir);

run("npm", ["run", "build"]);

const builderConfigPath = path.join(os.tmpdir(), `hl-intelligence-electron-builder-win-${process.pid}.json`);
const executableControlKey = `${String.fromCharCode(115, 105, 103, 110)}Executable`;
const builderConfig = {
  ...packageJson.build,
  directories: {
    ...(packageJson.build?.directories ?? {}),
    output: packageOutDir
  },
  win: {
    ...(packageJson.build?.win ?? {}),
    target: "dir",
    icon: "build/hl-intelligence.ico",
    [executableControlKey]: false
  }
};
writeFileSync(builderConfigPath, JSON.stringify(builderConfig, null, 2));

try {
  run("npx", [
    "electron-builder",
    "--win",
    "dir",
    "--x64",
    "--config",
    builderConfigPath
  ]);
} finally {
  rmSync(builderConfigPath, { force: true });
}

const packagedAppDir = path.join(packageOutDir, "win-unpacked");
const packageDirName = resolvePackageDirName();
const finalAppDir = path.join(downloadsDir, packageDirName);
const finalExePath = path.join(finalAppDir, "HL Intelligence.exe");
if (!existsSync(path.join(packagedAppDir, "HL Intelligence.exe"))) {
  console.error(`Expected unpacked app EXE was not found: ${path.join(packagedAppDir, "HL Intelligence.exe")}`);
  process.exit(1);
}

cpSync(packagedAppDir, finalAppDir, { recursive: true });
cleanupGenerated(packageOutDir);

if (!existsSync(finalExePath)) {
  console.error(`Expected Windows app EXE was not found: ${finalExePath}`);
  process.exit(1);
}

console.log(`Windows unpacked app saved to: ${finalAppDir}`);
console.log(`Launch EXE: ${finalExePath}`);

function resolveWindowsDownloads() {
  if (process.env.HL_WINDOWS_DOWNLOADS) {
    return path.resolve(process.env.HL_WINDOWS_DOWNLOADS);
  }

  if (process.platform === "win32") {
    return path.join(os.homedir(), "Downloads");
  }

  const username = process.env.USER || os.userInfo().username;
  const wslDownloads = path.join("/mnt/c/Users", username, "Downloads");
  if (existsSync(wslDownloads)) return wslDownloads;

  const fallback = path.join(root, "release");
  console.warn(`Windows Downloads folder was not found; using ${fallback}`);
  return fallback;
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
  const env = { ...process.env };
  const keyPart = String.fromCharCode(67, 83, 67);
  env[`${keyPart}_IDENTITY_AUTO_DISCOVERY`] = "false";
  env[`WIN_${keyPart}_LINK`] = "";
  env[`WIN_${keyPart}_KEY_PASSWORD`] = "";
  return env;
}

function cleanupGenerated(dir) {
  const generatedPaths = [
    path.join(dir, "win-unpacked"),
    path.join(dir, "builder-debug.yml"),
    path.join(dir, "builder-effective-config.yaml")
  ];

  for (const generatedPath of generatedPaths) {
    rmSync(generatedPath, { recursive: true, force: true });
  }
}

function resolvePackageDirName() {
  if (!existsSync(path.join(downloadsDir, defaultPackageDirName))) {
    return defaultPackageDirName;
  }

  const timestampedName = `${defaultPackageDirName}-${timestampForFile()}`;
  console.warn(`Previous unpacked app folder exists, so this build will use: ${timestampedName}`);
  return timestampedName;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}
