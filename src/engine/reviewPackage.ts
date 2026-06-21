import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LocalReviewJob, PrepareReviewInput, ReviewConfig, ReviewPackageResult } from "../shared/types.js";
import { PROCESSING_VERSION } from "./constants.js";
import {
  assertInside,
  basenameWithoutExtension,
  ensureDirectory,
  ensureUniquePath,
  sanitizeFilenamePart,
  writeFileAtomic
} from "./fileSafety.js";
import { sha256File } from "./hash.js";
import { extractPdf, writeVisualSupplementPdf } from "./pdfAdapter.js";
import { validateReviewConfig } from "./schemaValidation.js";
import { normalizeStyle } from "./template.js";

export async function prepareReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  if (path.extname(input.sourcePath).toLowerCase() !== ".pdf") {
    throw new Error("PDF is the only verified Commenter source format in this build.");
  }

  await ensureDirectory(input.outputFolder);
  const documentName = basenameWithoutExtension(input.sourcePath);
  const outputRoot = await ensureUniquePath(path.join(input.outputFolder, `${documentName}_HL_Review`));
  const uploadFolder = path.join(outputRoot, "Upload_to_Claude");
  const keepLocalFolder = path.join(outputRoot, "Keep_Local");
  assertInside(input.outputFolder, outputRoot);
  await ensureDirectory(uploadFolder);
  await ensureDirectory(keepLocalFolder);

  const sourceHash = await sha256File(input.sourcePath);
  const style = normalizeStyle(input.style);
  const extraction = await extractPdf(input.sourcePath, {
    mode: "text-visual",
    sourceHash,
    forceVisualSupplement: input.forceVisualSupplement
  });

  const markdownPath = path.join(uploadFolder, `${documentName}.md`);
  await writeFileAtomic(markdownPath, extraction.markdown);

  const visualPdfPath = await writeVisualSupplementPdf(
    input.sourcePath,
    extraction.visualPages.map((page) => page.page),
    path.join(uploadFolder, `${documentName}_visuals.pdf`)
  );

  const requestId = randomUUID();
  const reviewConfig: ReviewConfig = {
    schema_version: "1.0",
    request_id: requestId,
    source: {
      filename: path.basename(input.sourcePath),
      sha256: sourceHash,
      document_type: "pdf",
      total_pages: extraction.totalPages
    },
    review_instructions: input.reviewInstructions.trim(),
    style,
    required_output_filename: "hl_comments.json"
  };

  const configValidation = await validateReviewConfig(reviewConfig);
  if (!configValidation.ok) throw new Error(`Generated review-config.json was invalid: ${configValidation.errors.join("; ")}`);

  const reviewConfigPath = path.join(uploadFolder, "review-config.json");
  await writeFileAtomic(reviewConfigPath, JSON.stringify(reviewConfig, null, 2));

  const promptPath = path.join(uploadFolder, "PROMPT_TO_COPY.txt");
  await writeFileAtomic(promptPath, buildPrompt(reviewConfig, Boolean(visualPdfPath)));

  const localJob: LocalReviewJob = {
    schema_version: "1.0",
    processing_version: PROCESSING_VERSION,
    request_id: requestId,
    created_at: new Date().toISOString(),
    source: extraction.sourceMap.source,
    style,
    source_map: extraction.sourceMap
  };
  const localJobPath = path.join(keepLocalFolder, "review-job.hlreview");
  await writeFileAtomic(localJobPath, JSON.stringify(localJob, null, 2));

  return {
    requestId,
    sourceHash,
    outputRoot,
    uploadFolder,
    keepLocalFolder,
    markdownPath,
    visualPdfPath,
    reviewConfigPath,
    promptPath,
    localJobPath,
    totalPages: extraction.totalPages,
    visualPages: extraction.visualPages
  };
}

function buildPrompt(config: ReviewConfig, hasVisualSupplement: boolean): string {
  const visualLine = hasVisualSupplement
    ? "Use the visual supplement only to verify charts, diagrams, scanned pages, or layout-dependent content referenced by the Markdown."
    : "No visual supplement was generated because the prepared Markdown was sufficient for this request.";

  return [
    "Use the installed HL Commenter Skill.",
    "",
    "Files uploaded for this review:",
    "- Prepared anchored Markdown",
    hasVisualSupplement ? "- Visual supplement PDF" : "- No visual supplement PDF",
    "- review-config.json",
    "",
    visualLine,
    "Follow review-config.json exactly.",
    "Return a single file named hl_comments.json.",
    "Return JSON only. No introduction, conclusion, Markdown fence, or unrelated prose.",
    "",
    `Request ID: ${config.request_id}`,
    `Source SHA-256: ${config.source.sha256}`
  ].join("\n");
}
