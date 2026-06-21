import path from "node:path";
import type { PreflightFileResult, PreflightGenerateInput, ProgressEvent } from "../shared/types.js";
import { PROCESSING_VERSION } from "./constants.js";
import { basenameWithoutExtension, ensureDirectory, ensureUniquePath, writeFileAtomic } from "./fileSafety.js";
import { sha256File } from "./hash.js";
import { extractPdf, stageEvent, writeVisualSupplementPdf } from "./pdfAdapter.js";

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
    const send = (stage: ProgressEvent["stage"], percent: number, message: string) => {
      progress(stageEvent(input.jobId, filePath, stage, percent, message));
    };

    try {
      if (isCancelled(input.jobId)) throw new Error("cancelled");
      if (path.extname(filePath).toLowerCase() !== ".pdf") {
        throw new Error("Only PDF preflight is verified in this build.");
      }

      send("hashing", 5, "Hashing source file");
      const sourceHash = await sha256File(filePath);
      const sourceBase = basenameWithoutExtension(filePath);
      const outputFolder = await ensureUniquePath(path.join(input.outputFolder, sourceBase));
      await ensureDirectory(outputFolder);

      send("extracting", 10, "Extracting Markdown and anchors");
      const extraction = await extractPdf(
        filePath,
        {
          mode: file.mode,
          sourceHash,
          forceVisualSupplement: input.options.forceVisualSupplement
        },
        send,
        () => isCancelled(input.jobId)
      );

      if (isCancelled(input.jobId)) throw new Error("cancelled");
      send("writing", 82, "Writing Markdown");
      const markdownPath = path.join(outputFolder, `${sourceBase}.md`);
      await writeFileAtomic(markdownPath, extraction.markdown);

      send("writing", 88, "Writing visual supplement");
      const visualPdfPath = await writeVisualSupplementPdf(
        filePath,
        extraction.visualPages.map((page) => page.page),
        path.join(outputFolder, `${sourceBase}_visuals.pdf`)
      );

      const manifestPath = path.join(outputFolder, `${sourceBase}_manifest.json`);
      await writeFileAtomic(
        manifestPath,
        JSON.stringify(
          {
            schema_version: "1.0",
            processing_version: PROCESSING_VERSION,
            source: extraction.sourceMap.source,
            mode: file.mode,
            markdown_file: path.basename(markdownPath),
            visual_supplement_file: visualPdfPath ? path.basename(visualPdfPath) : null,
            visual_pages: extraction.visualPages,
            anchor_count: Object.keys(extraction.sourceMap.anchors).length
          },
          null,
          2
        )
      );

      send("complete", 100, "Complete");
      results.push({
        sourcePath: filePath,
        outputFolder,
        markdownPath,
        visualPdfPath,
        manifestPath,
        status: "complete"
      });
    } catch (error) {
      const status = error instanceof Error && error.message === "cancelled" ? "cancelled" : "error";
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
