import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { JobStage } from "../shared/types.js";
import type { PdfExtractionOptions, PdfExtractionResult } from "./pdfAdapter.js";

type ProgressReporter = (stage: JobStage, percent: number, message: string) => void;
type CancelCheck = () => boolean;

type PdfWorkerRequest =
  | { id: string; operation: "page-count"; filePath: string }
  | { id: string; operation: "extract"; filePath: string; options: PdfExtractionOptions }
  | { id: string; operation: "visual-supplement"; sourcePath: string; selectedOriginalPages: number[]; outputPath: string };

const MAX_CONCURRENT_PDF_WORKERS = 2;
const PDF_WORKER_CANCEL_GRACE_MS = 1200;
const PDF_WORKER_DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const activeWorkers = new Set<Worker>();
const queue: Array<() => void> = [];
let activeSlots = 0;

export async function loadPdfPageCountInWorker(filePath: string, isCancelled?: CancelCheck): Promise<number> {
  return runPdfWorker<number>(
    { id: randomUUID(), operation: "page-count", filePath },
    { timeoutMs: 60000, isCancelled }
  );
}

export async function extractPdfInWorker(
  filePath: string,
  options: PdfExtractionOptions,
  progress: ProgressReporter,
  isCancelled?: CancelCheck
): Promise<PdfExtractionResult> {
  return runPdfWorker<PdfExtractionResult>(
    { id: randomUUID(), operation: "extract", filePath, options },
    { timeoutMs: PDF_WORKER_DEFAULT_TIMEOUT_MS, progress, isCancelled }
  );
}

export async function writeVisualSupplementPdfInWorker(
  sourcePath: string,
  selectedOriginalPages: number[],
  outputPath: string,
  isCancelled?: CancelCheck
): Promise<string | null> {
  return runPdfWorker<string | null>(
    { id: randomUUID(), operation: "visual-supplement", sourcePath, selectedOriginalPages, outputPath },
    { timeoutMs: PDF_WORKER_DEFAULT_TIMEOUT_MS, isCancelled }
  );
}

export async function terminateAllPdfWorkers(): Promise<void> {
  await Promise.all([...activeWorkers].map((worker) => worker.terminate().catch(() => undefined)));
  activeWorkers.clear();
}

async function runPdfWorker<T>(
  request: PdfWorkerRequest,
  options: {
    timeoutMs: number;
    progress?: ProgressReporter;
    isCancelled?: CancelCheck;
  }
): Promise<T> {
  await acquireWorkerSlot();
  try {
    return await invokePdfWorker<T>(request, options);
  } finally {
    releaseWorkerSlot();
  }
}

async function acquireWorkerSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENT_PDF_WORKERS) {
    activeSlots += 1;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
  activeSlots += 1;
}

function releaseWorkerSlot(): void {
  activeSlots = Math.max(0, activeSlots - 1);
  const next = queue.shift();
  if (next) next();
}

async function invokePdfWorker<T>(
  request: PdfWorkerRequest,
  options: {
    timeoutMs: number;
    progress?: ProgressReporter;
    isCancelled?: CancelCheck;
  }
): Promise<T> {
  const workerPath = pdfWorkerPath();
  if (!workerPath) return runDirectForSourceTests<T>(request, options);

  const worker = new Worker(pathToFileURL(workerPath), {
    workerData: request
  });
  activeWorkers.add(worker);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cancelPoll: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      if (hardKill) clearTimeout(hardKill);
      activeWorkers.delete(worker);
      worker.removeAllListeners();
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const cancel = () => {
      worker.postMessage({ type: "cancel" });
      hardKill ??= setTimeout(() => {
        void worker.terminate().finally(() => finish(() => reject(new Error("cancelled"))));
      }, PDF_WORKER_CANCEL_GRACE_MS);
    };

    timeout = setTimeout(() => {
      worker.postMessage({ type: "cancel" });
      hardKill = setTimeout(() => {
        void worker.terminate().finally(() => finish(() => reject(new Error("PDF worker timed out before finishing."))));
      }, PDF_WORKER_CANCEL_GRACE_MS);
    }, options.timeoutMs);

    cancelPoll = setInterval(() => {
      if (options.isCancelled?.()) cancel();
    }, 120);

    worker.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      const typed = message as {
        type?: string;
        id?: string;
        result?: T;
        error?: string;
        progress?: { stage: JobStage; percent: number; message: string };
      };
      if (typed.id !== request.id) return;
      if (typed.type === "progress" && typed.progress) {
        options.progress?.(typed.progress.stage, typed.progress.percent, typed.progress.message);
      } else if (typed.type === "result") {
        finish(() => resolve(typed.result as T));
      } else if (typed.type === "error") {
        finish(() => reject(new Error(typed.error || "PDF worker failed.")));
      }
    });

    worker.on("error", (error) => {
      finish(() => reject(error));
    });

    worker.on("exit", (code) => {
      if (settled) return;
      finish(() => reject(new Error(code === 0 ? "PDF worker exited before returning a result." : `PDF worker exited with code ${code}.`)));
    });
  });
}

function pdfWorkerPath(): string | null {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "pdfWorkerHost.js"),
    path.join(here, "..", "pdfWorkerHost.js"),
    path.join(process.cwd(), "dist", "main", "pdfWorkerHost.js"),
    path.join(process.cwd(), "dist", "engine", "pdfWorkerHost.js")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error("PDF worker host was not found in the application bundle.");
}

async function runDirectForSourceTests<T>(
  request: PdfWorkerRequest,
  options: {
    progress?: ProgressReporter;
    isCancelled?: CancelCheck;
  }
): Promise<T> {
  const { extractPdf, loadPdfPageCount, writeVisualSupplementPdf } = await import("./pdfAdapter.js");
  if (options.isCancelled?.()) throw new Error("cancelled");
  if (request.operation === "page-count") return (await loadPdfPageCount(request.filePath)) as T;
  if (request.operation === "extract") {
    return (await extractPdf(
      request.filePath,
      request.options,
      options.progress ?? (() => undefined),
      () => Boolean(options.isCancelled?.())
    )) as T;
  }
  return (await writeVisualSupplementPdf(request.sourcePath, request.selectedOriginalPages, request.outputPath)) as T;
}
