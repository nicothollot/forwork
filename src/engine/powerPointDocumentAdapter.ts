import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type {
  CommentOutputResult,
  DocumentAnchor,
  DocumentInspection,
  FindingValidation,
  LocalReviewJob,
  OutputVerification,
  PreparedDocument,
  PrepareReviewInput,
  ReviewConfig,
  ReviewPackageResult,
  SourceBlock,
  VisualPageRef
} from "../shared/types.js";
import type { DocumentAdapter, DocumentInspectInput, PrepareDocumentInput, ValidateFindingInput, VerifyOutputInput } from "./documentAdapter.js";
import { PROCESSING_VERSION } from "./constants.js";
import {
  assertInside,
  basenameWithoutExtension,
  createStagedOutputDirectory,
  createStagedOutputFile,
  ensureDirectory,
  ensureUniquePath,
  outputPathIsSource,
  readJsonFile,
  sanitizeFilenamePart,
  writeFileAtomic
} from "./fileSafety.js";
import { cachedSha256File, createJobTempDirectory } from "./jobFoundation.js";
import { sha256File } from "./hash.js";
import type {
  OfficeWorkerResponseBase,
  PowerPointApplyCommentsRequest,
  PowerPointApplyCommentsResponse,
  PowerPointCommentToApply,
  PowerPointDocumentType,
  PowerPointExtractResponse,
  PowerPointInspectResponse,
  PowerPointInspectionProperties,
  PowerPointRenderResponse,
  PowerPointSourceAnchor,
  PowerPointVerifyOutputResponse,
  PowerPointVisualCandidate
} from "./office/officeTypes.js";
import { runOfficeWorker } from "./office/officeWorkerClient.js";
import { validateClaudeResultText } from "./resultValidation.js";
import { validateReviewConfig } from "./schemaValidation.js";
import { normalizeForEvidence, normalizeStyle, renderComment } from "./template.js";
import { selectFindingsForOutput, skippedFindingsForOutput } from "./commentSelection.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import {
  assertGeneratedOutputWithinLimits,
  assertInspectionWithinLimits,
  assertSourceFileWithinLimits
} from "./safetyLimits.js";

const POWERPOINT_INSPECT_TIMEOUT_MS = 120000;
const POWERPOINT_EXTRACT_TIMEOUT_MS = 360000;
const POWERPOINT_RENDER_TIMEOUT_MS = 300000;
const POWERPOINT_APPLY_TIMEOUT_MS = 180000;
const POWERPOINT_VERIFY_TIMEOUT_MS = 180000;
const INDEX_ENTRIES_PER_PAGE = 40;

export const powerPointDocumentAdapter: DocumentAdapter = {
  documentTypes: ["pptx", "pptm"],
  inspect: inspectPowerPoint,
  prepareDocument: preparePowerPointDocument,
  createReviewPackage: createPowerPointReviewPackage,
  validateFinding: validatePowerPointFinding,
  applyComments: createCommentedPowerPoint,
  verifyOutput: verifyPowerPointOutput
};

async function inspectPowerPoint(input: DocumentInspectInput): Promise<DocumentInspection> {
  const documentType = powerPointDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const info = await stat(input.sourcePath);
  const inspection = await inspectPowerPointProperties(input.sourcePath, documentType);
  const result = {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    sha256: input.includeHash ? await cachedSha256File(input.sourcePath) : undefined,
    size_bytes: info.size,
    modified_time_ms: info.mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft PowerPoint.`,
    counts: {
      slides: inspection.slide_count
    }
  } satisfies DocumentInspection;
  assertInspectionWithinLimits(result);
  return result;
}

async function preparePowerPointDocument(input: PrepareDocumentInput): Promise<PreparedDocument> {
  input.isCancelled?.();
  const documentType = powerPointDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const outputBaseName = input.outputBaseName ?? basenameWithoutExtension(input.sourcePath);

  input.progress?.("extracting", 12, "Extracting PowerPoint slides, notes, and anchors");
  const extraction = await runPowerPointWorker<PowerPointExtractResponse>(
    {
      schema_version: "1.0",
      operation: "extract",
      application: "powerpoint",
      document_type: documentType,
      source_path: input.sourcePath,
      source_sha256: input.sourceHash,
      created_at: createdAt,
      options: {
        include_speaker_notes: true,
        include_existing_comments: Boolean(input.preserveExistingComments)
      }
    },
    POWERPOINT_EXTRACT_TIMEOUT_MS,
    input.isCancelled
  );

  const inspection = requirePowerPointInspection(extraction);
  assertInspectionWithinLimits({
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    size_bytes: (await stat(input.sourcePath)).size,
    modified_time_ms: (await stat(input.sourcePath)).mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft PowerPoint.`,
    counts: {
      slides: inspection.slide_count
    }
  });
  const totalSlides = Math.max(inspection.slide_count, 1);
  const selectedVisualSlides = selectPowerPointVisualSlides({
    mode: input.mode,
    totalSlides,
    candidates: asArray(extraction.visual_pages),
    forceVisualSupplement: input.forceVisualSupplement
  });
  const indexPageCount = powerPointVisualSupplementIndexPageCount(selectedVisualSlides.length);
  const visualPages: VisualPageRef[] = selectedVisualSlides.map((candidate, index) => ({
    page: candidate.slide,
    supplementPage: indexPageCount + index + 1,
    reason: candidate.reason
  }));

  let visualPdfPath: string | null = null;
  if (input.outputFolder && visualPages.length > 0) {
    input.progress?.("detecting-visuals", 55, "Rendering PowerPoint visual supplement through Microsoft PowerPoint");
    const temp = await createJobTempDirectory(`powerpoint-render-${randomUUID()}`);
    try {
      const renderedPdfPath = path.join(temp.path, "powerpoint-render.pdf");
      await runPowerPointWorker<PowerPointRenderResponse>(
        {
          schema_version: "1.0",
          operation: "render",
          application: "powerpoint",
          document_type: documentType,
          source_path: input.sourcePath,
          output_pdf_path: renderedPdfPath
        },
        POWERPOINT_RENDER_TIMEOUT_MS,
        input.isCancelled
      );
      visualPdfPath = await writePowerPointVisualSupplementPdf({
        renderedPdfPath,
        selectedSlides: visualPages,
        outputPath: path.join(input.outputFolder, `${outputBaseName}_visuals.pdf`),
        sourceFilename: path.basename(input.sourcePath)
      });
    } finally {
      await temp.cleanup();
    }
  }

  const sourceMap = {
    schema_version: "1.0" as const,
    processing_version: PROCESSING_VERSION,
    source: {
      filename: path.basename(input.sourcePath),
      path: input.sourcePath,
      sha256: input.sourceHash,
      document_type: documentType,
      total_slides: totalSlides
    },
    anchors: convertPowerPointAnchors(extraction.anchors ?? {}),
    visual_pages: visualPages
  };

  const markdown = addPowerPointModeNotes({
    markdown: extraction.markdown ?? "",
    mode: input.mode,
    visualPages,
    visualSupplementName: `${outputBaseName}_visuals.pdf`
  });

  input.progress?.("extracting", 75, "PowerPoint extraction complete");
  return {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    source_sha256: input.sourceHash,
    markdown,
    source_map: sourceMap,
    visual_pages: visualPages,
    counts: {
      slides: totalSlides
    },
    artifacts: {
      visual_pdf_path: visualPdfPath
    }
  };
}

async function createPowerPointReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  await ensureDirectory(input.outputFolder);
  const documentType = powerPointDocumentTypeForPath(input.sourcePath);
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
    const prepared = await preparePowerPointDocument({
      sourcePath: input.sourcePath,
      mode: "text-visual",
      sourceHash,
      outputFolder: uploadFolder,
      outputBaseName: documentName,
      forceVisualSupplement: input.forceVisualSupplement,
      preserveExistingComments: true
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
        document_type: documentType,
        total_slides: prepared.counts.slides
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
    await writeFileAtomic(promptPath, buildPowerPointPrompt(reviewConfig, Boolean(prepared.artifacts.visual_pdf_path)));

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
      totalPages: prepared.counts.slides ?? 0,
      visualPages: prepared.visual_pages
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

function validatePowerPointFinding(input: ValidateFindingInput): FindingValidation {
  const { localJob, finding } = input;
  if (finding.anchor.kind !== "pptx_shape" && finding.anchor.kind !== "pptx_slide") {
    return { finding, status: "invalid", reason: `Unsupported anchor kind: ${finding.anchor.kind}` };
  }

  const anchorId = resolvePowerPointAnchorId(localJob, finding.anchor);
  const anchor = anchorId ? localJob.source_map.anchors[anchorId] : undefined;
  if (!anchor) return { finding, status: "invalid", reason: "Anchor was not found in the source map." };
  if (anchor.slide && finding.anchor.slide !== anchor.slide) {
    return { finding, status: "invalid", reason: "Anchor slide number does not match the source map." };
  }
  if (anchor.anchor?.kind === "pptx_shape" && finding.anchor.kind === "pptx_shape") {
    if (anchor.anchor.slide_id !== finding.anchor.slide_id || anchor.anchor.shape_id !== finding.anchor.shape_id) {
      return { finding, status: "invalid", reason: "Shape anchor identity does not match the source map." };
    }
  }
  if (anchor.anchor?.kind === "pptx_slide" && finding.anchor.kind === "pptx_slide") {
    if (anchor.anchor.slide_id !== finding.anchor.slide_id) {
      return { finding, status: "invalid", reason: "Slide anchor identity does not match the source map." };
    }
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

  const textMatches = normalizeForEvidence(anchor.text).includes(normalizeForEvidence(evidence));
  if (!textMatches && finding.anchor.kind === "pptx_shape") {
    return {
      finding,
      status: "invalid",
      reason: "Evidence was not found near the referenced PowerPoint shape anchor.",
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

async function createCommentedPowerPoint(input: {
  sourcePath: string;
  localJobPath: string;
  claudeJsonText?: string;
  claudeJsonPath?: string;
  outputFolder: string;
  outputFilename?: string;
  approvedFindings?: Array<{ id: string; finalComment?: string }>;
}): Promise<CommentOutputResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  const documentType = powerPointDocumentTypeForPath(input.sourcePath);
  if (localJob.source.document_type !== "pptx" && localJob.source.document_type !== "pptm") {
    throw new Error("Only verified PowerPoint comment output is enabled for presentations.");
  }
  if (documentType !== localJob.source.document_type) {
    throw new Error("The selected source presentation type does not match this review job.");
  }

  const sourceHash = await cachedSha256File(input.sourcePath);
  if (sourceHash !== localJob.source.sha256) {
    throw new Error("The selected source presentation does not match the review job hash.");
  }

  const rawJson = input.claudeJsonText ?? (input.claudeJsonPath ? await readFile(input.claudeJsonPath, "utf8") : "");
  const validation = await validateClaudeResultText(localJob, rawJson);
  const findingsToApply = selectFindingsForOutput(validation.validations, input.approvedFindings).filter(
    (finding) => finding.anchorId
  );
  if (validation.errors.length > 0 || findingsToApply.length === 0) {
    throw new Error(validation.errors[0] ?? "No valid comments are available to apply.");
  }

  const baseline = await inspectPowerPointProperties(input.sourcePath, documentType);
  if (baseline.signature_present) {
    throw new Error("This PowerPoint presentation appears to contain a digital signature. HL Intelligence will not modify signed presentations.");
  }

  await ensureDirectory(input.outputFolder);
  const sourceExt = path.extname(input.sourcePath).toLowerCase() || `.${documentType}`;
  const fallbackName = `${sanitizeFilenamePart(path.basename(input.sourcePath, sourceExt))}_commented${sourceExt}`;
  const requestedName = sanitizeFilenamePart(input.outputFilename || fallbackName, fallbackName);
  const outputPath = await ensureUniquePath(
    path.join(input.outputFolder, requestedName.toLowerCase().endsWith(sourceExt) ? requestedName : `${requestedName}${sourceExt}`)
  );
  assertInside(input.outputFolder, outputPath);
  if (outputPathIsSource(input.sourcePath, outputPath)) {
    throw new Error("HL Intelligence will not overwrite the source presentation.");
  }

  const comments = findingsToApply.map((item): PowerPointCommentToApply => {
    const anchorId = item.anchorId as string;
    const sourceAnchor = localJob.source_map.anchors[anchorId]?.anchor ?? item.finding.anchor;
    return {
      id: item.finding.id,
      anchor_id: anchorId,
      anchor: toPowerPointCommentAnchor(sourceAnchor),
      comment: item.renderedComment ?? item.finding.comment_body
    };
  });

  let commentApi = "unknown";
  const staged = await createStagedOutputFile(outputPath);
  let committed = false;
  try {
    const applyResponse = await runPowerPointWorker<PowerPointApplyCommentsResponse>(
      {
        schema_version: "1.0",
        operation: "apply-comments",
        application: "powerpoint",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        comments
      } satisfies PowerPointApplyCommentsRequest,
      POWERPOINT_APPLY_TIMEOUT_MS
    );
    commentApi = applyResponse.comment_api ?? commentApi;

    const verifyResponse = await runPowerPointWorker<PowerPointVerifyOutputResponse>(
      {
        schema_version: "1.0",
        operation: "verify-output",
        application: "powerpoint",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        expected: {
          slide_count: baseline.slide_count,
          hidden_state_signature: baseline.hidden_state_signature,
          shape_count: baseline.shape_count,
          slide_master_count: baseline.slide_master_count,
          notes_signature: baseline.notes_signature,
          chart_count: baseline.chart_count,
          existing_comment_count: baseline.existing_comment_count,
          macro_present: baseline.macro_present,
          source_sha256: sourceHash,
          anchors: comments
        }
      },
      POWERPOINT_VERIFY_TIMEOUT_MS
    );
    commentApi = verifyResponse.verification?.comment_api ?? commentApi;

    if ((await sha256File(input.sourcePath)) !== sourceHash) {
      throw new Error("Source PowerPoint presentation changed while creating commented output.");
    }
    await assertGeneratedOutputWithinLimits([staged.stagingPath]);
    await staged.commit();
    committed = true;
  } catch (error) {
    await staged.cleanup();
    if (!committed) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const reportPath = await ensureUniquePath(outputPath.replace(/\.(pptx|pptm)$/i, "_comment_report.json"));
  const skipped = skippedFindingsForOutput(validation.validations, findingsToApply, input.approvedFindings);
  try {
    await writeFileAtomic(
      reportPath,
      JSON.stringify(
        {
          schema_version: "1.0",
          source_filename: localJob.source.filename,
          source_sha256: localJob.source.sha256,
          output_file: path.basename(outputPath),
          output_verification:
            "PowerPoint output reopened through Microsoft PowerPoint, expected native comments were found, presentation properties were preserved, and the source presentation hash was unchanged.",
          comment_api: commentApi,
          summary: validation.summary,
          skipped: skipped.map((item) => ({
            id: item.finding.id,
            status: item.status,
            reason: item.reason,
            anchor: item.finding.anchor
          }))
        },
        null,
        2
      )
    );
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    outputPath,
    reportPath,
    summary: validation.summary,
    skipped
  };
}

async function verifyPowerPointOutput(input: VerifyOutputInput): Promise<OutputVerification> {
  try {
    const documentType = powerPointDocumentTypeForPath(input.outputPath);
    const inspection = await inspectPowerPointProperties(input.outputPath, documentType);
    if (input.localJob.source.total_slides && inspection.slide_count !== input.localJob.source.total_slides) {
      throw new Error("PowerPoint output slide count changed.");
    }
    return {
      schema_version: "1.0",
      document_type: documentType,
      output_path: input.outputPath,
      ok: true,
      message: "PowerPoint output reopened normally through Microsoft PowerPoint."
    };
  } catch (error) {
    return {
      schema_version: "1.0",
      document_type: powerPointDocumentTypeForPath(input.outputPath),
      output_path: input.outputPath,
      ok: false,
      message: error instanceof Error ? error.message : "PowerPoint output integrity verification failed."
    };
  }
}

async function inspectPowerPointProperties(
  sourcePath: string,
  documentType: PowerPointDocumentType
): Promise<PowerPointInspectionProperties> {
  const response = await runPowerPointWorker<PowerPointInspectResponse>(
    {
      schema_version: "1.0",
      operation: "inspect",
      application: "powerpoint",
      document_type: documentType,
      source_path: sourcePath
    },
    POWERPOINT_INSPECT_TIMEOUT_MS
  );
  return requirePowerPointInspection(response);
}

async function runPowerPointWorker<T extends OfficeWorkerResponseBase>(
  request: Parameters<typeof runOfficeWorker<T>>[0],
  timeoutMs: number,
  isCancelled?: () => boolean
): Promise<T> {
  try {
    const response = await runOfficeWorker<T>(request, { timeoutMs, isCancelled });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "The PowerPoint operation failed. No source presentation was modified.");
    }
    return response;
  } catch (error) {
    throw sanitizePowerPointError(error);
  }
}

function sanitizePowerPointError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message === "cancelled") return new Error("cancelled");
  if (lower.includes("timed out")) {
    return new Error("Microsoft PowerPoint did not finish the operation before the timeout. Close any PowerPoint dialogs and try again.");
  }
  if (lower.includes("enoent") || lower.includes("pwsh") || lower.includes("powershell")) {
    return new Error("Microsoft PowerPoint is not installed or local PowerPoint automation is unavailable.");
  }
  return new Error(message || "The PowerPoint operation failed. No source presentation was modified.");
}

function requirePowerPointInspection(response: PowerPointInspectResponse | PowerPointExtractResponse): PowerPointInspectionProperties {
  if (!response.inspection) throw new Error("PowerPoint inspection did not return presentation properties.");
  return response.inspection;
}

function convertPowerPointAnchors(anchors: Record<string, PowerPointSourceAnchor>): Record<string, SourceBlock> {
  const converted: Record<string, SourceBlock> = {};
  for (const [anchorId, anchor] of Object.entries(anchors)) {
    converted[anchorId] = {
      anchorId,
      kind: anchor.kind,
      anchor: anchor.anchor as DocumentAnchor,
      slide: anchor.slide,
      slideId: anchor.slideId,
      shapeId: anchor.shapeId,
      text: anchor.text,
      bbox: anchor.bbox
    };
  }
  return converted;
}

function resolvePowerPointAnchorId(localJob: LocalReviewJob, anchor: DocumentAnchor): string | undefined {
  if (anchor.kind === "pptx_shape") {
    return Object.values(localJob.source_map.anchors).find((candidate) => {
      const sourceAnchor = candidate.anchor;
      return (
        candidate.kind === "pptx_shape" &&
        sourceAnchor?.kind === "pptx_shape" &&
        sourceAnchor.slide === anchor.slide &&
        sourceAnchor.slide_id === anchor.slide_id &&
        sourceAnchor.shape_id === anchor.shape_id
      );
    })?.anchorId;
  }
  if (anchor.kind === "pptx_slide") {
    return Object.values(localJob.source_map.anchors).find((candidate) => {
      const sourceAnchor = candidate.anchor;
      return (
        candidate.kind === "pptx_slide" &&
        sourceAnchor?.kind === "pptx_slide" &&
        sourceAnchor.slide === anchor.slide &&
        sourceAnchor.slide_id === anchor.slide_id
      );
    })?.anchorId;
  }
  return undefined;
}

function toPowerPointCommentAnchor(anchor: DocumentAnchor): PowerPointCommentToApply["anchor"] {
  if (anchor.kind === "pptx_shape") {
    return {
      kind: "pptx_shape",
      slide: anchor.slide,
      slide_id: anchor.slide_id,
      shape_id: anchor.shape_id
    };
  }
  if (anchor.kind === "pptx_slide") {
    return {
      kind: "pptx_slide",
      slide: anchor.slide,
      slide_id: anchor.slide_id
    };
  }
  throw new Error(`Unsupported PowerPoint anchor kind: ${anchor.kind}`);
}

function powerPointDocumentTypeForPath(filePath: string): PowerPointDocumentType {
  return path.extname(filePath).toLowerCase() === ".pptm" ? "pptm" : "pptx";
}

function selectPowerPointVisualSlides(input: {
  mode: "text-only" | "text-visual" | "text-all-pages";
  totalSlides: number;
  candidates: PowerPointVisualCandidate[];
  forceVisualSupplement?: boolean;
}): Array<{ slide: number; reason: string }> {
  if (input.mode === "text-only") return [];
  if (input.mode === "text-all-pages" || input.forceVisualSupplement) {
    return Array.from({ length: input.totalSlides }, (_, index) => ({
      slide: index + 1,
      reason: input.mode === "text-all-pages" ? "Full visual reference requested." : "Visual supplement forced."
    }));
  }
  const slides = new Map<number, string>();
  for (const candidate of input.candidates) {
    if (candidate.slide < 1 || candidate.slide > input.totalSlides) continue;
    const reason = candidate.low_confidence
      ? `low-confidence visual classification: ${candidate.reason}`
      : candidate.reason;
    slides.set(candidate.slide, reason);
  }
  return [...slides.entries()].sort((a, b) => a[0] - b[0]).map(([slide, reason]) => ({ slide, reason }));
}

async function writePowerPointVisualSupplementPdf(input: {
  renderedPdfPath: string;
  selectedSlides: VisualPageRef[];
  outputPath: string;
  sourceFilename: string;
}): Promise<string | null> {
  if (input.selectedSlides.length === 0) return null;
  const rendered = await PDFDocument.load(await readFile(officeWorkerPathToLocal(input.renderedPdfPath)), {
    ignoreEncryption: false,
    updateMetadata: false
  });
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const indexPageCount = powerPointVisualSupplementIndexPageCount(input.selectedSlides.length);

  for (let pageIndex = 0; pageIndex < indexPageCount; pageIndex += 1) {
    const indexPage = output.addPage([612, 792]);
    drawPowerPointSupplementIndexPage({
      indexPage,
      font,
      bold,
      sourceFilename: input.sourceFilename,
      selectedSlides: input.selectedSlides,
      pageIndex,
      indexPageCount
    });
  }

  for (const ref of input.selectedSlides) {
    if (ref.page < 1 || ref.page > rendered.getPageCount()) {
      throw new Error(`PowerPoint visual supplement slide ${ref.page} was outside the rendered PDF page range.`);
    }
  }
  const copiedPages = await output.copyPages(
    rendered,
    input.selectedSlides.map((ref) => ref.page - 1)
  );
  copiedPages.forEach((page) => output.addPage(page));

  await ensureDirectory(path.dirname(input.outputPath));
  const uniquePath = await ensureUniquePath(input.outputPath);
  await writeFileAtomic(uniquePath, await output.save({ useObjectStreams: false }));
  return uniquePath;
}

function powerPointVisualSupplementIndexPageCount(selectedSlideCount: number): number {
  if (selectedSlideCount <= 0) return 0;
  return Math.max(1, Math.ceil(selectedSlideCount / INDEX_ENTRIES_PER_PAGE));
}

function drawPowerPointSupplementIndexPage(input: {
  indexPage: any;
  font: any;
  bold: any;
  sourceFilename: string;
  selectedSlides: VisualPageRef[];
  pageIndex: number;
  indexPageCount: number;
}): void {
  const { indexPage, font, bold, sourceFilename, selectedSlides, pageIndex, indexPageCount } = input;
  indexPage.drawText("HL Intelligence PowerPoint Visual Supplement", {
    x: 48,
    y: 744,
    size: 16,
    font: bold,
    color: rgb(0, 0.157, 0.333)
  });
  indexPage.drawText(`Source filename: ${sourceFilename}`, { x: 48, y: 718, size: 10, font });
  indexPage.drawText(`Index page ${pageIndex + 1} of ${indexPageCount}`, { x: 48, y: 700, size: 10, font });
  indexPage.drawText("Mapped slides:", { x: 48, y: 674, size: 11, font: bold });

  const start = pageIndex * INDEX_ENTRIES_PER_PAGE;
  const entries = selectedSlides.slice(start, start + INDEX_ENTRIES_PER_PAGE);
  entries.forEach((entry, index) => {
    const y = 650 - index * 14;
    const line = `Original PowerPoint slide ${entry.page} -> supplement page ${entry.supplementPage}: ${entry.reason}`;
    indexPage.drawText(truncate(line, 112), { x: 58, y, size: 9, font });
  });
}

function addPowerPointModeNotes(input: {
  markdown: string;
  mode: "text-only" | "text-visual" | "text-all-pages";
  visualPages: VisualPageRef[];
  visualSupplementName: string;
}): string {
  const lines: string[] = [input.markdown.trimEnd()];
  if (input.mode === "text-only") {
    lines.push("", "> Warning: Text only mode extracts slide text, tables, and speaker notes only. Layout, charts, diagrams, images, and visual meaning are excluded.");
  }
  if (input.visualPages.length > 0) {
    lines.push("", "## Visual Supplement");
    for (const ref of input.visualPages) {
      lines.push(
        `- Original PowerPoint slide ${ref.page}: ${input.visualSupplementName}, supplement page ${ref.supplementPage}. Reason: ${ref.reason}.`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildPowerPointPrompt(config: ReviewConfig, hasVisualSupplement: boolean): string {
  const visualLine = hasVisualSupplement
    ? "Use the visual supplement only to verify charts, images, diagrams, SmartArt, grouped shapes, complex tables, sparse graphical slides, or layout-dependent content referenced by the Markdown."
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

function asArray<T>(value: T[] | T | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function officeWorkerPathToLocal(filePath: string): string {
  if (process.platform === "win32") return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const unc = /^\/\/wsl\.localhost\/[^/]+(\/.*)$/i.exec(normalized);
  if (unc) return unc[1];
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  return filePath;
}
