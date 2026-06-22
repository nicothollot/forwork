import { parentPort, workerData } from "node:worker_threads";
import type { JobStage } from "../shared/types.js";
import {
  extractPdf,
  loadPdfPageCount,
  writeVisualSupplementPdf,
  type PdfExtractionOptions
} from "./pdfAdapter.js";

type PdfWorkerRequest =
  | { id: string; operation: "page-count"; filePath: string }
  | { id: string; operation: "extract"; filePath: string; options: PdfExtractionOptions }
  | { id: string; operation: "visual-supplement"; sourcePath: string; selectedOriginalPages: number[]; outputPath: string };

let cancelled = false;

parentPort?.on("message", (message) => {
  if (message && typeof message === "object" && (message as { type?: string }).type === "cancel") {
    cancelled = true;
  }
});

void run(workerData as PdfWorkerRequest);

async function run(request: PdfWorkerRequest): Promise<void> {
  try {
    const result = await runRequest(request);
    parentPort?.postMessage({ type: "result", id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    parentPort?.close();
  }
}

async function runRequest(request: PdfWorkerRequest): Promise<unknown> {
  if (request.operation === "page-count") return loadPdfPageCount(request.filePath);
  if (request.operation === "extract") {
    return extractPdf(
      request.filePath,
      request.options,
      (stage: JobStage, percent: number, message: string) => {
        parentPort?.postMessage({ type: "progress", id: request.id, progress: { stage, percent, message } });
      },
      () => cancelled
    );
  }
  return writeVisualSupplementPdf(request.sourcePath, request.selectedOriginalPages, request.outputPath);
}
