import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OfficeWorkerClientOptions, OfficeWorkerRequest } from "./officeTypes.js";
import { createJobTempDirectory } from "../jobFoundation.js";

const DEFAULT_TIMEOUT_MS = 15000;
const CANCEL_POLL_MS = 150;

export async function runOfficeWorker<TResponse>(
  request: OfficeWorkerRequest,
  options: OfficeWorkerClientOptions = {}
): Promise<TResponse> {
  const temp = options.tempRoot
    ? { path: options.tempRoot, cleanup: () => rm(options.tempRoot as string, { recursive: true, force: true }) }
    : await createJobTempDirectory(`office-${request.operation}-${randomUUID()}`);
  await mkdir(temp.path, { recursive: true });

  const requestPath = path.join(temp.path, "request.json");
  const responsePath = path.join(temp.path, "response.json");
  const cancelPath = path.join(temp.path, "cancel");
  const powerShellPath = options.powerShellPath ?? defaultPowerShellPath();
  const workerScriptPath = options.workerScriptPath ?? defaultWorkerScriptPath();
  const useWindowsPathBridge = shouldUseWindowsPathBridge(powerShellPath);
  const requestWithCancelPath = { ...request, cancel_path: cancelPath };
  const workerRequest = useWindowsPathBridge ? convertRequestPathsForWindows(requestWithCancelPath) : requestWithCancelPath;
  const officeBaseline = await snapshotOfficeAutomationProcesses(powerShellPath).catch(() => new Map<string, Set<number>>());
  await writeFile(requestPath, JSON.stringify(workerRequest, null, 2), "utf8");

  try {
    await invokePowerShell({
      powerShellPath,
      workerScriptPath: useWindowsPathBridge ? toWindowsWorkerPath(workerScriptPath) : workerScriptPath,
      requestPath: useWindowsPathBridge ? toWindowsWorkerPath(requestPath) : requestPath,
      responsePath: useWindowsPathBridge ? toWindowsWorkerPath(responsePath) : responsePath,
      cancelPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      isCancelled: options.isCancelled
    });
    return JSON.parse(stripBom(await readFile(responsePath, "utf8"))) as TResponse;
  } finally {
    await cleanupNewOfficeAutomationProcesses(powerShellPath, officeBaseline).catch(() => undefined);
    await temp.cleanup();
  }
}

interface InvokePowerShellInput {
  powerShellPath: string;
  workerScriptPath: string;
  requestPath: string;
  responsePath: string;
  cancelPath: string;
  timeoutMs: number;
  isCancelled?: () => boolean;
}

async function invokePowerShell(input: InvokePowerShellInput): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      input.powerShellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        input.workerScriptPath,
        "-RequestPath",
        input.requestPath,
        "-ResponsePath",
        input.responsePath
      ],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cancelPoll: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    let pendingFailure: Error | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      if (hardKill) clearTimeout(hardKill);
      callback();
    };
    const requestWorkerStop = (marker: string, error: Error) => {
      if (pendingFailure) return;
      pendingFailure = error;
      try {
        writeFileSync(input.cancelPath, marker, "utf8");
      } catch {
      }
      hardKill = setTimeout(() => {
        child.kill();
        finish(() => reject(error));
      }, 5000);
    };
    timeout = setTimeout(() => {
      requestWorkerStop("timeout", new Error(`Office worker timed out after ${input.timeoutMs} ms.`));
    }, input.timeoutMs);
    cancelPoll = setInterval(() => {
      if (!input.isCancelled?.()) return;
      requestWorkerStop("cancelled", new Error("cancelled"));
    }, CANCEL_POLL_MS);

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("exit", (code) => {
      if (pendingFailure) {
        finish(() => reject(pendingFailure));
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(sanitizeOfficeWorkerStderr(stderr) || `Office worker exited with code ${code}.`)));
    });
  });
}

function sanitizeOfficeWorkerStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .replace(/[a-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gi, "[path]")
    .replace(/\/(?:[^/\s'"]+\/)*[^/\s'"]+/g, "[path]")
    .slice(0, 500)
    .trim();
}

async function snapshotOfficeAutomationProcesses(powerShellPath: string): Promise<Map<string, Set<number>>> {
  const snapshot = new Map<string, Set<number>>([
    ["WINWORD.EXE", new Set<number>()],
    ["EXCEL.EXE", new Set<number>()],
    ["POWERPNT.EXE", new Set<number>()]
  ]);
  const rows = await queryWindowsProcesses(powerShellPath, "name='WINWORD.EXE' or name='EXCEL.EXE' or name='POWERPNT.EXE'");
  for (const row of rows) {
    if (!/\/Automation -Embedding/i.test(row.CommandLine ?? "") && row.Name !== "EXCEL.EXE" && row.Name !== "POWERPNT.EXE") continue;
    snapshot.get(row.Name)?.add(row.ProcessId);
  }
  return snapshot;
}

async function cleanupNewOfficeAutomationProcesses(powerShellPath: string, baseline: Map<string, Set<number>>): Promise<void> {
  const current = await queryWindowsProcesses(powerShellPath, "name='WINWORD.EXE' or name='EXCEL.EXE' or name='POWERPNT.EXE'");
  const newPids = current
    .filter((row) => {
      const existing = baseline.get(row.Name);
      if (existing?.has(row.ProcessId)) return false;
      if (row.Name === "WINWORD.EXE") return /\/Automation -Embedding/i.test(row.CommandLine ?? "");
      return row.Name === "EXCEL.EXE" || row.Name === "POWERPNT.EXE";
    })
    .map((row) => row.ProcessId);
  if (newPids.length === 0) return;
  await runPowerShellJson(powerShellPath, `$ids = @(${newPids.join(",")}); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; @()`);
}

interface WindowsProcessRow {
  Name: string;
  ProcessId: number;
  CommandLine?: string;
}

async function queryWindowsProcesses(powerShellPath: string, filter: string): Promise<WindowsProcessRow[]> {
  if (!isWindowsPowerShellAvailable(powerShellPath)) return [];
  const escapedFilter = filter.replace(/'/g, "''");
  const command = `Get-CimInstance Win32_Process -Filter '${escapedFilter}' | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const value = await runPowerShellJson(powerShellPath, command);
  if (!value) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .filter((row): row is WindowsProcessRow => Boolean(row && typeof row === "object"))
    .map((row) => ({
      Name: String((row as WindowsProcessRow).Name ?? ""),
      ProcessId: Number((row as WindowsProcessRow).ProcessId ?? 0),
      CommandLine: typeof (row as WindowsProcessRow).CommandLine === "string" ? (row as WindowsProcessRow).CommandLine : undefined
    }))
    .filter((row) => row.Name && Number.isInteger(row.ProcessId) && row.ProcessId > 0);
}

async function runPowerShellJson(powerShellPath: string, command: string): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command", command], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(sanitizeOfficeWorkerStderr(err) || `PowerShell process query exited with code ${code}.`));
    });
  });
  if (!stdout) return null;
  return JSON.parse(stripBom(stdout));
}

function isWindowsPowerShellAvailable(powerShellPath: string): boolean {
  return process.platform === "win32" || /powershell\.exe$/i.test(powerShellPath.replace(/\\/g, "/"));
}

function defaultPowerShellPath(): string {
  if (process.platform === "win32") return "powershell.exe";
  const windowsPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  return existsSync(windowsPowerShell) ? windowsPowerShell : "pwsh";
}

function defaultWorkerScriptPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "";
  const candidates = [
    path.join(process.cwd(), "resources", "office", "office-worker.ps1"),
    resourcesPath ? path.join(resourcesPath, "office", "office-worker.ps1") : ""
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function shouldUseWindowsPathBridge(powerShellPath: string): boolean {
  return process.platform !== "win32" && /powershell\.exe$/i.test(powerShellPath.replace(/\\/g, "/"));
}

function convertRequestPathsForWindows(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => convertRequestPathsForWindows(item));
  if (!value || typeof value !== "object") return value;
  const converted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    converted[key] = typeof entry === "string" && key.endsWith("_path")
      ? toWindowsWorkerPath(entry)
      : convertRequestPathsForWindows(entry);
  }
  return converted;
}

function toWindowsWorkerPath(filePath: string): string {
  if (/^[a-z]:[\\/]/i.test(filePath) || filePath.startsWith("\\\\")) return filePath;
  if (filePath.startsWith("/mnt/") && filePath.length > 6) {
    const drive = filePath[5].toUpperCase();
    const rest = filePath.slice(7).replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `\\\\wsl.localhost\\${distro}${filePath.replace(/\//g, "\\")}`;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
