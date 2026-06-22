import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CancellationToken, FileMetadata, JobStage, ProgressEvent } from "../shared/types.js";
import { assertInside, basenameWithoutExtension, ensureDirectory, ensureUniquePath, sanitizeFilenamePart, writeFileAtomic } from "./fileSafety.js";
import { sha256File } from "./hash.js";

export interface FileStamp {
  path: string;
  sizeBytes: number;
  modifiedTimeMs: number;
}

export class FileMetadataCache {
  private readonly values = new Map<string, unknown>();

  async get<T>(filePath: string, loader: (stamp: FileStamp) => Promise<T>): Promise<T> {
    const stamp = await stampFile(filePath);
    const key = cacheKey(stamp);
    if (this.values.has(key)) return this.values.get(key) as T;
    const value = await loader(stamp);
    this.values.set(key, value);
    return value;
  }

  async getHash(filePath: string): Promise<string> {
    return this.get(filePath, () => sha256File(filePath));
  }

  clear(): void {
    this.values.clear();
  }
}

export const workflowMetadataCache = new FileMetadataCache();

export async function cachedSha256File(filePath: string): Promise<string> {
  return workflowMetadataCache.getHash(filePath);
}

export async function stampFile(filePath: string): Promise<FileStamp> {
  const info = await stat(filePath);
  return {
    path: path.resolve(filePath),
    sizeBytes: info.size,
    modifiedTimeMs: info.mtimeMs
  };
}

export function cacheKey(stamp: FileStamp): string {
  return `${stamp.path}:${stamp.sizeBytes}:${stamp.modifiedTimeMs}`;
}

export function safeOutputBaseName(sourcePath: string, suffix = ""): string {
  return sanitizeFilenamePart(`${basenameWithoutExtension(sourcePath)}${suffix}`, "document");
}

export async function safeOutputPath(parentFolder: string, requestedName: string): Promise<string> {
  await ensureDirectory(parentFolder);
  const safeName = sanitizeFilenamePart(requestedName, "document");
  const outputPath = await ensureUniquePath(path.join(parentFolder, safeName));
  assertInside(parentFolder, outputPath);
  return outputPath;
}

export async function writeCompletedOutput(outputPath: string, data: string | Uint8Array): Promise<string> {
  await writeFileAtomic(outputPath, data);
  return outputPath;
}

export interface JobTempDirectory {
  path: string;
  cleanup(): Promise<void>;
}

export async function createJobTempDirectory(jobId: string = randomUUID()): Promise<JobTempDirectory> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `hl-intelligence-${sanitizeFilenamePart(jobId, "job")}-`));
  return {
    path: dir,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

export async function withJobTempDirectory<T>(jobId: string, task: (dir: string) => Promise<T>): Promise<T> {
  const temp = await createJobTempDirectory(jobId);
  try {
    return await task(temp.path);
  } finally {
    await temp.cleanup();
  }
}

export interface CancellationController extends CancellationToken {
  cancel(): void;
}

export function createCancellationController(): CancellationController {
  let isCancelled = false;
  return {
    get cancelled() {
      return isCancelled;
    },
    cancel() {
      isCancelled = true;
    },
    throwIfCancelled() {
      if (isCancelled) throw new Error("cancelled");
    }
  };
}

export function cancellationTokenFromCheck(check: () => boolean): CancellationToken {
  return {
    get cancelled() {
      return check();
    },
    throwIfCancelled() {
      if (check()) throw new Error("cancelled");
    }
  };
}

export type ProgressSink = (event: ProgressEvent) => void;

export function createProgressReporter(jobId: string, filePath: string | undefined, sink: ProgressSink) {
  return (stage: JobStage, percent: number, message: string): void => {
    sink({ jobId, filePath, stage, percent, message });
  };
}

export async function cleanupPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((targetPath) => rm(targetPath, { recursive: true, force: true }).catch(() => undefined)));
}

export async function runFileTask<T>(
  sourcePath: string,
  task: () => Promise<T>
): Promise<{ sourcePath: string; status: "complete"; value: T } | { sourcePath: string; status: "error"; error: string }> {
  try {
    return { sourcePath, status: "complete", value: await task() };
  } catch (error) {
    return {
      sourcePath,
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

export function metadataFromCacheValue(value: unknown): FileMetadata | null {
  if (typeof value === "object" && value && "path" in value && "sizeBytes" in value) return value as FileMetadata;
  return null;
}
