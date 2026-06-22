import { constants, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilenamePart(value: string, fallback = "document"): string {
  const clean = value
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, "");

  if (!clean || WINDOWS_RESERVED.test(clean)) return fallback;
  return clean.slice(0, 140);
}

export function basenameWithoutExtension(filePath: string): string {
  return sanitizeFilenamePart(path.basename(filePath, path.extname(filePath)), "document");
}

export function assertInside(parent: string, child: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Output path escaped the selected folder.");
  }
}

export async function ensureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureUniquePath(filePath: string): Promise<string> {
  if (!(await pathExists(filePath))) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}-${index}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error("Could not create a unique output filename.");
}

export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface StagedOutputFile {
  finalPath: string;
  stagingPath: string;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createStagedOutputFile(finalPath: string): Promise<StagedOutputFile> {
  await ensureDirectory(path.dirname(finalPath));
  const ext = path.extname(finalPath);
  const base = path.basename(finalPath, ext);
  const stagingPath = path.join(path.dirname(finalPath), `.${base}.${process.pid}.${Date.now()}.partial${ext || ".tmp"}`);
  assertInside(path.dirname(finalPath), stagingPath);
  return {
    finalPath,
    stagingPath,
    commit: async () => {
      await rename(stagingPath, finalPath);
    },
    cleanup: async () => {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  };
}

export interface StagedOutputDirectory {
  finalPath: string;
  stagingPath: string;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createStagedOutputDirectory(parentFolder: string, requestedName: string): Promise<StagedOutputDirectory> {
  await ensureDirectory(parentFolder);
  const finalPath = await ensureUniquePath(path.join(parentFolder, sanitizeFilenamePart(requestedName, "HL_Review")));
  assertInside(parentFolder, finalPath);
  const stagingPath = path.join(parentFolder, `.${path.basename(finalPath)}.${process.pid}.${Date.now()}.partial`);
  assertInside(parentFolder, stagingPath);
  await ensureDirectory(stagingPath);
  return {
    finalPath,
    stagingPath,
    commit: async () => {
      await rename(stagingPath, finalPath);
    },
    cleanup: async () => {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as T;
}

export async function assertReadableFile(filePath: string): Promise<void> {
  await stat(filePath);
  await import("node:fs/promises").then((fs) => fs.access(filePath, constants.R_OK));
}

export function outputPathIsSource(sourcePath: string, outputPath: string): boolean {
  return path.resolve(sourcePath).toLowerCase() === path.resolve(outputPath).toLowerCase();
}
