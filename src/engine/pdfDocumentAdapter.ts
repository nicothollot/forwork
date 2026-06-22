import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  ClaudeResult,
  DocumentInspection,
  FindingValidation,
  LocalReviewJob,
  OutputVerification,
  PreparedDocument,
  PrepareReviewInput,
  ReviewConfig,
  ReviewPackageResult,
  SourceBlock
} from "../shared/types.js";
import type { DocumentAdapter, DocumentInspectInput, PrepareDocumentInput, ValidateFindingInput, VerifyOutputInput } from "./documentAdapter.js";
import { PROCESSING_VERSION } from "./constants.js";
import {
  basenameWithoutExtension,
  createStagedOutputDirectory,
  ensureDirectory,
  writeFileAtomic
} from "./fileSafety.js";
import { cachedSha256File } from "./jobFoundation.js";
import { extractPdfInWorker, loadPdfPageCountInWorker, writeVisualSupplementPdfInWorker } from "./pdfWorkerClient.js";
import { validateReviewConfig } from "./schemaValidation.js";
import { normalizeForEvidence, normalizeStyle, renderComment } from "./template.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import {
  assertGeneratedOutputWithinLimits,
  assertInspectionWithinLimits,
  assertSourceFileWithinLimits
} from "./safetyLimits.js";

export const pdfDocumentAdapter: DocumentAdapter = {
  documentTypes: ["pdf"],
  inspect: inspectPdf,
  prepareDocument: preparePdfDocument,
  createReviewPackage: createPdfReviewPackage,
  validateFinding: validatePdfFinding,
  applyComments: async (input) => {
    const { createCommentedPdfForPdf } = await import("./pdfComments.js");
    return createCommentedPdfForPdf(input);
  },
  verifyOutput: verifyPdfOutput
};

async function inspectPdf(input: DocumentInspectInput): Promise<DocumentInspection> {
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, "pdf");
  const info = await stat(input.sourcePath);
  const pages = await loadPdfPageCountInWorker(input.sourcePath);
  const inspection = {
    schema_version: "1.0",
    document_type: "pdf",
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    sha256: input.includeHash ? await cachedSha256File(input.sourcePath) : undefined,
    size_bytes: info.size,
    modified_time_ms: info.mtimeMs,
    support_status: "verified",
    support_message: "PDF support is verified.",
    counts: {
      pages
    }
  } satisfies DocumentInspection;
  assertInspectionWithinLimits(inspection);
  return inspection;
}

async function preparePdfDocument(input: PrepareDocumentInput): Promise<PreparedDocument> {
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, "pdf");
  const extraction = await extractPdfInWorker(
    input.sourcePath,
    {
      mode: input.mode,
      sourceHash: input.sourceHash,
      forceVisualSupplement: input.forceVisualSupplement,
      preserveExistingComments: input.preserveExistingComments,
      createdAt: input.createdAt
    },
    input.progress ?? (() => undefined),
    input.isCancelled
  );
  if ((extraction.totalPages ?? 0) > 0) {
    assertInspectionWithinLimits({
      schema_version: "1.0",
      document_type: "pdf",
      source_path: input.sourcePath,
      filename: path.basename(input.sourcePath),
      size_bytes: (await stat(input.sourcePath)).size,
      modified_time_ms: (await stat(input.sourcePath)).mtimeMs,
      support_status: "verified",
      support_message: "PDF support is verified.",
      counts: { pages: extraction.totalPages }
    });
  }

  const outputBaseName = input.outputBaseName ?? basenameWithoutExtension(input.sourcePath);
  const visualPdfPath = input.outputFolder
    ? await writeVisualSupplementPdfInWorker(
        input.sourcePath,
        extraction.visualPages.map((page) => page.page),
        path.join(input.outputFolder, `${outputBaseName}_visuals.pdf`),
        input.isCancelled
      )
    : null;

  return {
    schema_version: "1.0",
    document_type: "pdf",
    source_path: input.sourcePath,
    source_sha256: input.sourceHash,
    markdown: extraction.markdown,
    source_map: extraction.sourceMap,
    visual_pages: extraction.visualPages,
    counts: {
      pages: extraction.totalPages
    },
    artifacts: {
      visual_pdf_path: visualPdfPath
    }
  };
}

async function createPdfReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  await ensureDirectory(input.outputFolder);
  const documentName = basenameWithoutExtension(input.sourcePath);
  const staged = await createStagedOutputDirectory(input.outputFolder, `${documentName}_HL_Review`);
  const uploadFolder = path.join(staged.stagingPath, "Upload_to_Claude");
  const keepLocalFolder = path.join(staged.stagingPath, "Keep_Local");
  const finalPath = (filePath: string) => path.join(staged.finalPath, path.relative(staged.stagingPath, filePath));

  try {
    await ensureDirectory(uploadFolder);
    await ensureDirectory(keepLocalFolder);

    const sourceHash = await cachedSha256File(input.sourcePath);
    const style = normalizeStyle(input.style);
    const prepared = await preparePdfDocument({
      sourcePath: input.sourcePath,
      mode: "text-visual",
      sourceHash,
      outputFolder: uploadFolder,
      outputBaseName: documentName,
      forceVisualSupplement: input.forceVisualSupplement
    });

    const markdownPath = path.join(uploadFolder, `${documentName}.md`);
    await writeFileAtomic(markdownPath, prepared.markdown);

    const requestId = randomUUID();
    const reviewConfig: ReviewConfig = {
      schema_version: "1.0",
      request_id: requestId,
      source: {
        filename: path.basename(input.sourcePath),
        sha256: sourceHash,
        document_type: "pdf",
        total_pages: prepared.counts.pages
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
    await writeFileAtomic(promptPath, buildPrompt(reviewConfig, Boolean(prepared.artifacts.visual_pdf_path)));

    const localJob: LocalReviewJob = {
      schema_version: "1.0",
      processing_version: PROCESSING_VERSION,
      request_id: requestId,
      created_at: new Date().toISOString(),
      source: prepared.source_map.source,
      style,
      source_map: prepared.source_map
    };
    const localJobPath = path.join(keepLocalFolder, "review-job.hlreview");
    await writeFileAtomic(localJobPath, JSON.stringify(localJob, null, 2));
    await assertGeneratedOutputWithinLimits([
      markdownPath,
      prepared.artifacts.visual_pdf_path ?? "",
      reviewConfigPath,
      promptPath,
      localJobPath
    ]);

    await staged.commit();
    return {
      requestId,
      sourceHash,
      outputRoot: staged.finalPath,
      uploadFolder: finalPath(uploadFolder),
      keepLocalFolder: finalPath(keepLocalFolder),
      markdownPath: finalPath(markdownPath),
      visualPdfPath: prepared.artifacts.visual_pdf_path ? finalPath(prepared.artifacts.visual_pdf_path) : null,
      reviewConfigPath: finalPath(reviewConfigPath),
      promptPath: finalPath(promptPath),
      localJobPath: finalPath(localJobPath),
      totalPages: prepared.counts.pages ?? 0,
      visualPages: prepared.visual_pages
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

function validatePdfFinding(input: ValidateFindingInput): FindingValidation {
  const { localJob, finding } = input;
  if (finding.anchor.kind !== "pdf_block" && finding.anchor.kind !== "pdf_page") {
    return { finding, status: "invalid", reason: `Unsupported anchor kind: ${finding.anchor.kind}` };
  }

  const anchorId = finding.anchor.kind === "pdf_block"
    ? finding.anchor.block_id
    : `p${String(finding.anchor.page).padStart(4, "0")}:page`;
  const anchor = localJob.source_map.anchors[anchorId];
  if (!anchor) return { finding, status: "invalid", reason: `Anchor was not found: ${anchorId}` };
  if (!anchor.page || finding.anchor.page !== anchor.page) {
    return { finding, status: "invalid", reason: "Anchor page does not match the source map." };
  }

  const evidence = finding.evidence?.trim();
  if (!evidence) {
    return {
      finding,
      status: "attention",
      reason: "Evidence was not provided.",
      anchorId,
      renderedComment: renderComment(finding, localJob.style, localJob.source_map, anchorId)
    };
  }

  const haystack = finding.anchor.kind === "pdf_block" ? anchor.text : pageText(localJob, anchor.page);
  if (!normalizeForEvidence(haystack).includes(normalizeForEvidence(evidence))) {
    return {
      finding,
      status: "invalid",
      reason: "Evidence was not found near the referenced anchor.",
      anchorId
    };
  }

  return {
    finding,
    status: "valid",
    anchorId,
    renderedComment: renderComment(finding, localJob.style, localJob.source_map, anchorId)
  };
}

async function verifyPdfOutput(input: VerifyOutputInput): Promise<OutputVerification> {
  const { verifyCommentedPdfIntegrity } = await import("./pdfComments.js");
  return verifyCommentedPdfIntegrity({
    sourcePath: input.localJob.source.path,
    outputPath: input.outputPath,
    localJob: input.localJob,
    originalSourceSha256: input.localJob.source.sha256
  });
}

function pageText(localJob: LocalReviewJob, page: number): string {
  return Object.values(localJob.source_map.anchors)
    .filter((anchor): anchor is SourceBlock & { page: number } => anchor.page === page)
    .map((anchor) => anchor.text)
    .join("\n");
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
