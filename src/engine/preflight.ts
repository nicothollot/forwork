import { stat } from "node:fs/promises";
import path from "node:path";
import type { PreflightFileResult, PreflightGenerateInput, ProgressEvent } from "../shared/types.js";
import { PROCESSING_VERSION } from "./constants.js";
import { basenameWithoutExtension, ensureDirectory, ensureUniquePath, writeFileAtomic } from "./fileSafety.js";
import { documentAdapterRegistry } from "./documentAdapterRegistry.js";
import { documentSupportForPath, documentTypeForPath } from "./documentDetection.js";
import { cachedSha256File, cleanupPaths, createProgressReporter } from "./jobFoundation.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import { assertGeneratedOutputWithinLimits, assertSourceFileWithinLimits } from "./safetyLimits.js";

export type ProgressSink = (event: ProgressEvent) => void;
export type CancelCheck = (jobId: string) => boolean;

export async function generatePreflightFiles(
  input: PreflightGenerateInput,
  progress: ProgressSink = () => undefined,
  isCancelled: CancelCheck = () => false
): Promise<PreflightFileResult[]> {
  await ensureDirectory(input.outputFolder);
  const results: PreflightFileResult[] = [];

  for (const file of input.files) {
    const filePath = file.path;
    const send = createProgressReporter(input.jobId, filePath, progress);
    let outputFolder: string | null = null;

    try {
      if (isCancelled(input.jobId)) throw new Error("cancelled");
      const documentType = documentTypeForPath(filePath);
      if (!documentType) throw new Error(documentSupportForPath(filePath).message);
      const adapter = documentAdapterRegistry.get(documentType);
      if (!adapter) throw new Error(documentSupportForPath(filePath).message);
      await assertSourceFileWithinLimits(filePath);
      await verifyDocumentSignature(filePath, documentType);

      send("hashing", 5, "Hashing source file");
      const sourceHash = await cachedSha256File(filePath);
      const sourceSizeBytes = (await stat(filePath)).size;
      const sourceBase = basenameWithoutExtension(filePath);
      outputFolder = await ensureUniquePath(path.join(input.outputFolder, sourceBase));
      await ensureDirectory(outputFolder);

      send("extracting", 10, "Extracting Markdown and anchors");
      const prepared = await adapter.prepareDocument({
        sourcePath: filePath,
        mode: file.mode,
        sourceHash,
        outputFolder,
        outputBaseName: sourceBase,
        forceVisualSupplement: input.options.forceVisualSupplement,
        preserveExistingComments: input.options.preserveExistingComments,
        progress: send,
        isCancelled: () => isCancelled(input.jobId)
      });

      if (isCancelled(input.jobId)) throw new Error("cancelled");
      send("writing", 82, "Writing Markdown");
      const markdownPath = path.join(outputFolder, `${sourceBase}.md`);
      await writeFileAtomic(markdownPath, prepared.markdown);
      const markdownSizeBytes = Buffer.byteLength(prepared.markdown, "utf8");
      const visualSupplementSizeBytes = prepared.artifacts.visual_pdf_path
        ? (await stat(prepared.artifacts.visual_pdf_path)).size
        : 0;
      const totalOutputBytes = markdownSizeBytes + visualSupplementSizeBytes;
      const approximateReductionPercent = Math.round((1 - totalOutputBytes / Math.max(1, sourceSizeBytes)) * 100);

      const manifestPath = path.join(outputFolder, `${sourceBase}_manifest.json`);
      await writeFileAtomic(
        manifestPath,
        JSON.stringify(
          {
            schema_version: "1.0",
            processing_version: PROCESSING_VERSION,
            source: prepared.source_map.source,
            mode: file.mode,
            markdown_file: path.basename(markdownPath),
            visual_supplement_file: prepared.artifacts.visual_pdf_path ? path.basename(prepared.artifacts.visual_pdf_path) : null,
            visual_pages: prepared.visual_pages,
            anchor_count: Object.keys(prepared.source_map.anchors).length
          },
          null,
          2
        )
      );
      await assertGeneratedOutputWithinLimits([
        markdownPath,
        prepared.artifacts.visual_pdf_path ?? "",
        manifestPath
      ]);

      send("complete", 100, "Complete");
      results.push({
        sourcePath: filePath,
        outputFolder,
        markdownPath,
        visualPdfPath: prepared.artifacts.visual_pdf_path ?? null,
        manifestPath,
        status: "complete",
        summary: {
          originalSizeBytes: sourceSizeBytes,
          markdownSizeBytes,
          visualSupplementSizeBytes,
          approximateTokenEstimate: Math.ceil(prepared.markdown.length / 4),
          approximateReductionPercent,
          visualPageCount: prepared.visual_pages.length,
          warningCount: 0
        }
      });
    } catch (error) {
      const status = error instanceof Error && error.message === "cancelled" ? "cancelled" : "error";
      if (outputFolder) await cleanupPaths([outputFolder]);
      send(status, status === "cancelled" ? 0 : 100, status === "cancelled" ? "Cancelled" : "Error");
      results.push({
        sourcePath: filePath,
        outputFolder: input.outputFolder,
        markdownPath: "",
        visualPdfPath: null,
        manifestPath: "",
        status,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return results;
}
