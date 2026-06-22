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
import type {
  OfficeWorkerResponseBase,
  WordApplyCommentsRequest,
  WordApplyCommentsResponse,
  WordCommentToApply,
  WordDocumentType,
  WordExtractResponse,
  WordInspectResponse,
  WordInspectionProperties,
  WordRenderResponse,
  WordSourceAnchor,
  WordVerifyOutputResponse
} from "./office/officeTypes.js";
import { runOfficeWorker } from "./office/officeWorkerClient.js";
import { validateClaudeResultText } from "./resultValidation.js";
import { validateReviewConfig } from "./schemaValidation.js";
import { sha256File } from "./hash.js";
import { normalizeForEvidence, normalizeStyle, renderComment } from "./template.js";
import { selectFindingsForOutput, skippedFindingsForOutput } from "./commentSelection.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import {
  assertGeneratedOutputWithinLimits,
  assertInspectionWithinLimits,
  assertSourceFileWithinLimits
} from "./safetyLimits.js";

const WORD_INSPECT_TIMEOUT_MS = 60000;
const WORD_EXTRACT_TIMEOUT_MS = 180000;
const WORD_RENDER_TIMEOUT_MS = 180000;
const WORD_APPLY_TIMEOUT_MS = 180000;
const WORD_VERIFY_TIMEOUT_MS = 120000;
const INDEX_ENTRIES_PER_PAGE = 40;

export const wordDocumentAdapter: DocumentAdapter = {
  documentTypes: ["docx", "docm"],
  inspect: inspectWord,
  prepareDocument: prepareWordDocument,
  createReviewPackage: createWordReviewPackage,
  validateFinding: validateWordFinding,
  applyComments: createCommentedWord,
  verifyOutput: verifyWordOutput
};

async function inspectWord(input: DocumentInspectInput): Promise<DocumentInspection> {
  const documentType = wordDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const info = await stat(input.sourcePath);
  const inspection = await inspectWordProperties(input.sourcePath, documentType);
  const result = {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    sha256: input.includeHash ? await cachedSha256File(input.sourcePath) : undefined,
    size_bytes: info.size,
    modified_time_ms: info.mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft Word.`,
    counts: {
      pages: inspection.page_count,
      sections: inspection.section_count
    }
  } satisfies DocumentInspection;
  assertInspectionWithinLimits(result);
  return result;
}

async function prepareWordDocument(input: PrepareDocumentInput): Promise<PreparedDocument> {
  input.isCancelled?.();
  const documentType = wordDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const createdAt = input.createdAt ?? new Date().toISOString();
  input.progress?.("extracting", 12, "Extracting Word text and anchors");

  const extraction = await runWordWorker<WordExtractResponse>(
    {
      schema_version: "1.0",
      operation: "extract",
      application: "word",
      document_type: documentType,
      source_path: input.sourcePath,
      source_sha256: input.sourceHash,
      created_at: createdAt,
      options: {
        include_headers_footers: true,
        include_existing_comments: Boolean(input.preserveExistingComments),
        include_track_changes: true
      }
    },
    WORD_EXTRACT_TIMEOUT_MS,
    input.isCancelled
  );

  const inspection = requireInspection(extraction);
  assertInspectionWithinLimits({
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    size_bytes: (await stat(input.sourcePath)).size,
    modified_time_ms: (await stat(input.sourcePath)).mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft Word.`,
    counts: {
      pages: inspection.page_count,
      sections: inspection.section_count
    }
  });
  const totalPages = Math.max(inspection.page_count, 1);
  const visualCandidates = Array.isArray(extraction.visual_pages)
    ? extraction.visual_pages
    : extraction.visual_pages
      ? [extraction.visual_pages]
      : [];
  const selectedVisualPages = selectWordVisualPages({
    mode: input.mode,
    totalPages,
    candidates: visualCandidates,
    forceVisualSupplement: input.forceVisualSupplement
  });
  const indexPageCount = wordVisualSupplementIndexPageCount(selectedVisualPages.length);
  const visualPages: VisualPageRef[] = selectedVisualPages.map((candidate, index) => ({
    page: candidate.page,
    supplementPage: indexPageCount + index + 1,
    reason: candidate.reason
  }));

  let visualPdfPath: string | null = null;
  const outputBaseName = input.outputBaseName ?? basenameWithoutExtension(input.sourcePath);
  if (input.outputFolder && visualPages.length > 0) {
    input.progress?.("detecting-visuals", 55, "Rendering Word visual supplement through Microsoft Word");
    const temp = await createJobTempDirectory(`word-render-${randomUUID()}`);
    try {
      const renderedPdfPath = path.join(temp.path, "word-render.pdf");
      await runWordWorker<WordRenderResponse>(
        {
          schema_version: "1.0",
          operation: "render",
          application: "word",
          document_type: documentType,
          source_path: input.sourcePath,
          output_pdf_path: renderedPdfPath
        },
        WORD_RENDER_TIMEOUT_MS,
        input.isCancelled
      );
      visualPdfPath = await writeWordVisualSupplementPdf({
        renderedPdfPath,
        selectedPages: visualPages,
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
      total_pages: totalPages,
      total_sections: inspection.section_count
    },
    anchors: convertWordAnchors(extraction.anchors ?? {}),
    visual_pages: visualPages
  };

  const markdown = addWordModeNotes({
    markdown: extraction.markdown ?? "",
    mode: input.mode,
    visualPages,
    visualSupplementName: `${outputBaseName}_visuals.pdf`
  });

  input.progress?.("extracting", 75, "Word extraction complete");
  return {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    source_sha256: input.sourceHash,
    markdown,
    source_map: sourceMap,
    visual_pages: visualPages,
    counts: {
      pages: totalPages,
      sections: inspection.section_count
    },
    artifacts: {
      visual_pdf_path: visualPdfPath
    }
  };
}

async function createWordReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  await ensureDirectory(input.outputFolder);
  const documentType = wordDocumentTypeForPath(input.sourcePath);
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
    const prepared = await prepareWordDocument({
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
        total_pages: prepared.counts.pages,
        total_sections: prepared.counts.sections
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
    await writeFileAtomic(promptPath, buildWordPrompt(reviewConfig, Boolean(prepared.artifacts.visual_pdf_path)));

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

function validateWordFinding(input: ValidateFindingInput): FindingValidation {
  const { localJob, finding } = input;
  if (finding.anchor.kind !== "docx_paragraph" && finding.anchor.kind !== "docx_table_cell") {
    return { finding, status: "invalid", reason: `Unsupported anchor kind: ${finding.anchor.kind}` };
  }

  const anchorId = resolveWordAnchorId(localJob, finding.anchor);
  const anchor = anchorId ? localJob.source_map.anchors[anchorId] : undefined;
  if (!anchor) return { finding, status: "invalid", reason: "Anchor was not found in the source map." };
  if (finding.anchor.page && anchor.page && finding.anchor.page !== anchor.page) {
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

  if (!normalizeForEvidence(anchor.text).includes(normalizeForEvidence(evidence))) {
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

async function createCommentedWord(input: {
  sourcePath: string;
  localJobPath: string;
  claudeJsonText?: string;
  claudeJsonPath?: string;
  outputFolder: string;
  outputFilename?: string;
  approvedFindings?: Array<{ id: string; finalComment?: string }>;
}): Promise<CommentOutputResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  const documentType = wordDocumentTypeForPath(input.sourcePath);
  if (localJob.source.document_type !== "docx" && localJob.source.document_type !== "docm") {
    throw new Error("Only verified Word comment output is enabled for Word documents.");
  }
  if (documentType !== localJob.source.document_type) {
    throw new Error("The selected source document type does not match this review job.");
  }

  const sourceHash = await cachedSha256File(input.sourcePath);
  if (sourceHash !== localJob.source.sha256) {
    throw new Error("The selected source document does not match the review job hash.");
  }

  const rawJson = input.claudeJsonText ?? (input.claudeJsonPath ? await readFile(input.claudeJsonPath, "utf8") : "");
  const validation = await validateClaudeResultText(localJob, rawJson);
  const findingsToApply = selectFindingsForOutput(validation.validations, input.approvedFindings).filter(
    (finding) => finding.anchorId
  );
  if (validation.errors.length > 0 || findingsToApply.length === 0) {
    throw new Error(validation.errors[0] ?? "No valid comments are available to apply.");
  }

  const baseline = await inspectWordProperties(input.sourcePath, documentType);
  if (baseline.signature_present) {
    throw new Error("This Word document appears to contain a digital signature. HL Intelligence will not modify signed Word documents.");
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
    throw new Error("HL Intelligence will not overwrite the source document.");
  }

  const comments = findingsToApply.map((item): WordCommentToApply => {
    const anchorId = item.anchorId as string;
    const sourceAnchor = localJob.source_map.anchors[anchorId]?.anchor ?? item.finding.anchor;
    return {
      id: item.finding.id,
      anchor_id: anchorId,
      anchor: toWordCommentAnchor(sourceAnchor),
      comment: item.renderedComment ?? item.finding.comment_body
    };
  });

  const staged = await createStagedOutputFile(outputPath);
  let committed = false;
  try {
    await runWordWorker<WordApplyCommentsResponse>(
      {
        schema_version: "1.0",
        operation: "apply-comments",
        application: "word",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        comments
      } satisfies WordApplyCommentsRequest,
      WORD_APPLY_TIMEOUT_MS
    );

    await runWordWorker<WordVerifyOutputResponse>(
      {
        schema_version: "1.0",
        operation: "verify-output",
        application: "word",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        expected: {
          comments_added: comments.length,
          existing_comment_count: baseline.existing_comment_count,
          section_count: baseline.section_count,
          table_count: baseline.table_count,
          track_revisions_enabled: baseline.track_revisions_enabled,
          revision_count: baseline.revision_count,
          macro_present: baseline.macro_present,
          anchors: comments
        }
      },
      WORD_VERIFY_TIMEOUT_MS
    );

    if ((await sha256File(input.sourcePath)) !== sourceHash) {
      throw new Error("Source Word document changed while creating commented output.");
    }
    await assertGeneratedOutputWithinLimits([staged.stagingPath]);
    await staged.commit();
    committed = true;
  } catch (error) {
    await staged.cleanup();
    if (!committed) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const reportPath = await ensureUniquePath(outputPath.replace(/\.(docx|docm)$/i, "_comment_report.json"));
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
          output_verification: "Word output reopened, expected comments were found, document structure was preserved, and the source document hash was unchanged.",
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

async function verifyWordOutput(input: VerifyOutputInput): Promise<OutputVerification> {
  try {
    const documentType = wordDocumentTypeForPath(input.outputPath);
    const inspection = await inspectWordProperties(input.outputPath, documentType);
    if (input.localJob.source.total_pages && inspection.page_count < 1) {
      throw new Error("Word output page count could not be read.");
    }
    if (input.localJob.source.total_sections && inspection.section_count !== input.localJob.source.total_sections) {
      throw new Error("Word output section count changed.");
    }
    return {
      schema_version: "1.0",
      document_type: documentType,
      output_path: input.outputPath,
      ok: true,
      message: "Word output reopened normally through Microsoft Word."
    };
  } catch (error) {
    return {
      schema_version: "1.0",
      document_type: wordDocumentTypeForPath(input.outputPath),
      output_path: input.outputPath,
      ok: false,
      message: error instanceof Error ? error.message : "Word output integrity verification failed."
    };
  }
}

async function inspectWordProperties(sourcePath: string, documentType: WordDocumentType): Promise<WordInspectionProperties> {
  const response = await runWordWorker<WordInspectResponse>(
    {
      schema_version: "1.0",
      operation: "inspect",
      application: "word",
      document_type: documentType,
      source_path: sourcePath
    },
    WORD_INSPECT_TIMEOUT_MS
  );
  return requireInspection(response);
}

async function runWordWorker<T extends OfficeWorkerResponseBase>(
  request: Parameters<typeof runOfficeWorker<T>>[0],
  timeoutMs: number,
  isCancelled?: () => boolean
): Promise<T> {
  try {
    const response = await runOfficeWorker<T>(request, { timeoutMs, isCancelled });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "The Word operation failed. No source document was modified.");
    }
    return response;
  } catch (error) {
    throw sanitizeWordError(error);
  }
}

function sanitizeWordError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message === "cancelled") return new Error("cancelled");
  if (lower.includes("timed out")) {
    return new Error("Microsoft Word did not finish the operation before the timeout. Close any Word dialogs and try again.");
  }
  if (lower.includes("enoent") || lower.includes("pwsh") || lower.includes("powershell")) {
    return new Error("Microsoft Word is not installed or local Word automation is unavailable.");
  }
  return new Error(message || "The Word operation failed. No source document was modified.");
}

function requireInspection(response: WordInspectResponse | WordExtractResponse): WordInspectionProperties {
  if (!response.inspection) throw new Error("Word inspection did not return document properties.");
  return response.inspection;
}

function convertWordAnchors(anchors: Record<string, WordSourceAnchor>): Record<string, SourceBlock> {
  const converted: Record<string, SourceBlock> = {};
  for (const [anchorId, anchor] of Object.entries(anchors)) {
    converted[anchorId] = {
      anchorId,
      kind: anchor.kind,
      anchor: anchor.anchor as DocumentAnchor,
      page: anchor.page,
      paragraphId: anchor.paragraphId,
      tableId: anchor.tableId,
      cellId: anchor.cellId,
      row: anchor.row,
      column: anchor.column,
      text: anchor.text
    };
  }
  return converted;
}

function resolveWordAnchorId(localJob: LocalReviewJob, anchor: DocumentAnchor): string | undefined {
  if (anchor.kind === "docx_paragraph") return anchor.paragraph_id;
  if (anchor.kind !== "docx_table_cell") return undefined;
  if (anchor.cell_id && localJob.source_map.anchors[anchor.cell_id]) return anchor.cell_id;
  return Object.values(localJob.source_map.anchors).find((candidate) => {
    const sourceAnchor = candidate.anchor;
    return (
      candidate.kind === "docx_table_cell" &&
      sourceAnchor?.kind === "docx_table_cell" &&
      sourceAnchor.table_id === anchor.table_id &&
      sourceAnchor.row === anchor.row &&
      sourceAnchor.column === anchor.column
    );
  })?.anchorId;
}

function toWordCommentAnchor(anchor: DocumentAnchor): WordCommentToApply["anchor"] {
  if (anchor.kind === "docx_paragraph") {
    return {
      kind: "docx_paragraph",
      paragraph_id: anchor.paragraph_id,
      page: anchor.page
    };
  }
  if (anchor.kind === "docx_table_cell") {
    return {
      kind: "docx_table_cell",
      table_id: anchor.table_id,
      row: anchor.row,
      column: anchor.column,
      cell_id: anchor.cell_id,
      page: anchor.page
    };
  }
  throw new Error(`Unsupported Word anchor kind: ${anchor.kind}`);
}

function wordDocumentTypeForPath(filePath: string): WordDocumentType {
  return path.extname(filePath).toLowerCase() === ".docm" ? "docm" : "docx";
}

function addWordModeNotes(input: {
  markdown: string;
  mode: "text-only" | "text-visual" | "text-all-pages";
  visualPages: VisualPageRef[];
  visualSupplementName: string;
}): string {
  const lines: string[] = [input.markdown.trimEnd()];
  if (input.mode === "text-only") {
    lines.push("", "> Warning: Text only mode excludes visual layout, charts, images, text boxes, and page-rendered information.");
  }
  if (input.visualPages.length > 0) {
    lines.push("", "## Visual Supplement");
    for (const ref of input.visualPages) {
      lines.push(
        `- Original Word page ${ref.page}: ${input.visualSupplementName}, supplement page ${ref.supplementPage}. Reason: ${ref.reason}.`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function selectWordVisualPages(input: {
  mode: "text-only" | "text-visual" | "text-all-pages";
  totalPages: number;
  candidates: Array<{ page: number; reason: string; low_confidence: boolean }>;
  forceVisualSupplement?: boolean;
}): Array<{ page: number; reason: string }> {
  if (input.mode === "text-only") return [];
  if (input.mode === "text-all-pages" || input.forceVisualSupplement) {
    return Array.from({ length: input.totalPages }, (_, index) => ({
      page: index + 1,
      reason: input.mode === "text-all-pages" ? "Full visual reference requested." : "Visual supplement forced."
    }));
  }
  const pages = new Map<number, string>();
  for (const candidate of input.candidates) {
    if (candidate.page < 1 || candidate.page > input.totalPages) continue;
    const reason = candidate.low_confidence
      ? `low-confidence visual classification: ${candidate.reason}`
      : candidate.reason;
    pages.set(candidate.page, reason);
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, reason]) => ({ page, reason }));
}

async function writeWordVisualSupplementPdf(input: {
  renderedPdfPath: string;
  selectedPages: VisualPageRef[];
  outputPath: string;
  sourceFilename: string;
}): Promise<string | null> {
  if (input.selectedPages.length === 0) return null;
  const renderedBytes = await readFile(input.renderedPdfPath);
  const rendered = await PDFDocument.load(renderedBytes, {
    ignoreEncryption: false,
    updateMetadata: false
  });
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const indexPageCount = wordVisualSupplementIndexPageCount(input.selectedPages.length);

  for (let pageIndex = 0; pageIndex < indexPageCount; pageIndex += 1) {
    const indexPage = output.addPage([612, 792]);
    drawWordSupplementIndexPage({
      indexPage,
      font,
      bold,
      sourceFilename: input.sourceFilename,
      selectedPages: input.selectedPages,
      pageIndex,
      indexPageCount
    });
  }

  for (const ref of input.selectedPages) {
    if (ref.page < 1 || ref.page > rendered.getPageCount()) {
      throw new Error(`Word visual supplement page ${ref.page} was outside the rendered PDF page range.`);
    }
  }
  const copiedPages = await output.copyPages(
    rendered,
    input.selectedPages.map((ref) => ref.page - 1)
  );
  copiedPages.forEach((page) => output.addPage(page));

  await ensureDirectory(path.dirname(input.outputPath));
  const uniquePath = await ensureUniquePath(input.outputPath);
  await writeFileAtomic(uniquePath, await output.save({ useObjectStreams: false }));
  return uniquePath;
}

function wordVisualSupplementIndexPageCount(selectedPageCount: number): number {
  if (selectedPageCount <= 0) return 0;
  return Math.max(1, Math.ceil(selectedPageCount / INDEX_ENTRIES_PER_PAGE));
}

function drawWordSupplementIndexPage(input: {
  indexPage: any;
  font: any;
  bold: any;
  sourceFilename: string;
  selectedPages: VisualPageRef[];
  pageIndex: number;
  indexPageCount: number;
}): void {
  const { indexPage, font, bold, sourceFilename, selectedPages, pageIndex, indexPageCount } = input;
  indexPage.drawText("HL Intelligence Word Visual Supplement", {
    x: 48,
    y: 744,
    size: 16,
    font: bold,
    color: rgb(0, 0.157, 0.333)
  });
  indexPage.drawText(`Source filename: ${sourceFilename}`, { x: 48, y: 718, size: 10, font });
  indexPage.drawText(`Index page ${pageIndex + 1} of ${indexPageCount}`, { x: 48, y: 700, size: 10, font });
  indexPage.drawText("Mapped pages:", { x: 48, y: 674, size: 11, font: bold });

  const start = pageIndex * INDEX_ENTRIES_PER_PAGE;
  const entries = selectedPages.slice(start, start + INDEX_ENTRIES_PER_PAGE);
  entries.forEach((entry, index) => {
    const y = 650 - index * 14;
    const line = `Original Word page ${entry.page} -> supplement page ${entry.supplementPage}: ${entry.reason}`;
    indexPage.drawText(truncate(line, 112), { x: 58, y, size: 9, font });
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function buildWordPrompt(config: ReviewConfig, hasVisualSupplement: boolean): string {
  const visualLine = hasVisualSupplement
    ? "Use the visual supplement only to verify charts, images, text boxes, complex tables, columns, or layout-dependent content referenced by the Markdown."
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
