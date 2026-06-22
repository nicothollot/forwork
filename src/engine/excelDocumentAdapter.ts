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
  ExcelApplyCommentsRequest,
  ExcelApplyCommentsResponse,
  ExcelCommentToApply,
  ExcelDocumentType,
  ExcelExtractResponse,
  ExcelInspectResponse,
  ExcelInspectionProperties,
  ExcelRenderResponse,
  ExcelRenderTarget,
  ExcelSourceAnchor,
  ExcelVerifyOutputResponse,
  OfficeWorkerResponseBase
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

const EXCEL_INSPECT_TIMEOUT_MS = 240000;
const EXCEL_EXTRACT_TIMEOUT_MS = 600000;
const EXCEL_RENDER_TIMEOUT_MS = 300000;
const EXCEL_APPLY_TIMEOUT_MS = 180000;
const EXCEL_VERIFY_TIMEOUT_MS = 180000;
const INDEX_ENTRIES_PER_PAGE = 34;

export const excelDocumentAdapter: DocumentAdapter = {
  documentTypes: ["xlsx", "xlsm"],
  inspect: inspectExcel,
  prepareDocument: prepareExcelDocument,
  createReviewPackage: createExcelReviewPackage,
  validateFinding: validateExcelFinding,
  applyComments: createCommentedExcel,
  verifyOutput: verifyExcelOutput
};

async function inspectExcel(input: DocumentInspectInput): Promise<DocumentInspection> {
  const documentType = excelDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const info = await stat(input.sourcePath);
  const inspection = await inspectExcelProperties(input.sourcePath, documentType);
  const result = {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    sha256: input.includeHash ? await cachedSha256File(input.sourcePath) : undefined,
    size_bytes: info.size,
    modified_time_ms: info.mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft Excel.`,
    counts: {
      sheets: inspection.sheet_count
    }
  } satisfies DocumentInspection;
  assertInspectionWithinLimits(result);
  return result;
}

async function prepareExcelDocument(input: PrepareDocumentInput): Promise<PreparedDocument> {
  input.isCancelled?.();
  const documentType = excelDocumentTypeForPath(input.sourcePath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const outputBaseName = input.outputBaseName ?? basenameWithoutExtension(input.sourcePath);
  const generateCsvSidecars = process.env.HL_EXCEL_CSV_SIDECARS === "1" && Boolean(input.outputFolder);
  const csvFolder = generateCsvSidecars && input.outputFolder ? path.join(input.outputFolder, "csv_sidecars") : undefined;
  if (csvFolder) await ensureDirectory(csvFolder);

  input.progress?.("extracting", 12, "Extracting Excel workbook text, formulas, and anchors");
  const extraction = await runExcelWorker<ExcelExtractResponse>(
    {
      schema_version: "1.0",
      operation: "extract",
      application: "excel",
      document_type: documentType,
      source_path: input.sourcePath,
      source_sha256: input.sourceHash,
      created_at: createdAt,
      options: {
        include_existing_comments: Boolean(input.preserveExistingComments),
        generate_csv_sidecars: generateCsvSidecars,
        csv_sidecar_folder_path: csvFolder
      }
    },
    EXCEL_EXTRACT_TIMEOUT_MS,
    input.isCancelled
  );

  const inspection = requireExcelInspection(extraction);
  assertInspectionWithinLimits({
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    filename: path.basename(input.sourcePath),
    size_bytes: (await stat(input.sourcePath)).size,
    modified_time_ms: (await stat(input.sourcePath)).mtimeMs,
    support_status: "verified",
    support_message: `${documentType.toUpperCase()} support is verified with local Microsoft Excel.`,
    counts: {
      sheets: inspection.sheet_count
    }
  });
  const allTargets = asArray(extraction.render_targets);
  const visualCandidates = asArray(extraction.visual_pages);
  const selectedTargets = selectExcelRenderTargets({
    mode: input.mode,
    candidates: visualCandidates,
    allTargets,
    forceVisualSupplement: input.forceVisualSupplement
  });

  let visualPdfPath: string | null = null;
  let visualPages: VisualPageRef[] = [];
  if (input.outputFolder && selectedTargets.length > 0) {
    input.progress?.("detecting-visuals", 55, "Rendering Excel visual supplement through Microsoft Excel");
    const temp = await createJobTempDirectory(`excel-render-${randomUUID()}`);
    try {
      const rendered = await runExcelWorker<ExcelRenderResponse>(
        {
          schema_version: "1.0",
          operation: "render",
          application: "excel",
          document_type: documentType,
          source_path: input.sourcePath,
          output_folder_path: temp.path,
          render_targets: selectedTargets
        },
        EXCEL_RENDER_TIMEOUT_MS,
        input.isCancelled
      );
      const supplement = await writeExcelVisualSupplementPdf({
        renderedTargets: asArray(rendered.rendered_targets),
        outputPath: path.join(input.outputFolder, `${outputBaseName}_visuals.pdf`),
        sourceFilename: path.basename(input.sourcePath)
      });
      visualPdfPath = supplement.pdfPath;
      visualPages = supplement.visualPages;
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
      total_sheets: inspection.sheet_count
    },
    anchors: convertExcelAnchors(extraction.anchors ?? {}),
    visual_pages: visualPages
  };

  const markdown = addExcelModeNotes({
    markdown: extraction.markdown ?? "",
    mode: input.mode,
    visualPages,
    visualSupplementName: `${outputBaseName}_visuals.pdf`,
    csvSidecars: extraction.csv_sidecars ?? []
  });

  input.progress?.("extracting", 75, "Excel extraction complete");
  return {
    schema_version: "1.0",
    document_type: documentType,
    source_path: input.sourcePath,
    source_sha256: input.sourceHash,
    markdown,
    source_map: sourceMap,
    visual_pages: visualPages,
    counts: {
      sheets: inspection.sheet_count
    },
    artifacts: {
      visual_pdf_path: visualPdfPath
    }
  };
}

async function createExcelReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  await ensureDirectory(input.outputFolder);
  const documentType = excelDocumentTypeForPath(input.sourcePath);
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
    const prepared = await prepareExcelDocument({
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
        total_sheets: prepared.counts.sheets
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
    await writeFileAtomic(promptPath, buildExcelPrompt(reviewConfig, Boolean(prepared.artifacts.visual_pdf_path)));

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
      totalPages: prepared.counts.sheets ?? 0,
      visualPages: prepared.visual_pages
    };
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
}

function validateExcelFinding(input: ValidateFindingInput): FindingValidation {
  const { localJob, finding } = input;
  if (finding.anchor.kind !== "xlsx_cell" && finding.anchor.kind !== "xlsx_range") {
    return { finding, status: "invalid", reason: `Unsupported anchor kind: ${finding.anchor.kind}` };
  }

  const anchorId = resolveExcelAnchorId(localJob, finding.anchor);
  const anchor = anchorId ? localJob.source_map.anchors[anchorId] : undefined;
  if (!anchor) return { finding, status: "invalid", reason: "Anchor was not found in the source map." };

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
      reason: "Evidence was not found near the referenced Excel anchor.",
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

async function createCommentedExcel(input: {
  sourcePath: string;
  localJobPath: string;
  claudeJsonText?: string;
  claudeJsonPath?: string;
  outputFolder: string;
  outputFilename?: string;
  approvedFindings?: Array<{ id: string; finalComment?: string }>;
}): Promise<CommentOutputResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  const documentType = excelDocumentTypeForPath(input.sourcePath);
  if (localJob.source.document_type !== "xlsx" && localJob.source.document_type !== "xlsm") {
    throw new Error("Only verified Excel comment output is enabled for Excel workbooks.");
  }
  if (documentType !== localJob.source.document_type) {
    throw new Error("The selected source workbook type does not match this review job.");
  }

  const sourceHash = await cachedSha256File(input.sourcePath);
  if (sourceHash !== localJob.source.sha256) {
    throw new Error("The selected source workbook does not match the review job hash.");
  }

  const rawJson = input.claudeJsonText ?? (input.claudeJsonPath ? await readFile(input.claudeJsonPath, "utf8") : "");
  const validation = await validateClaudeResultText(localJob, rawJson);
  const findingsToApply = selectFindingsForOutput(validation.validations, input.approvedFindings).filter(
    (finding) => finding.anchorId
  );
  if (validation.errors.length > 0 || findingsToApply.length === 0) {
    throw new Error(validation.errors[0] ?? "No valid comments are available to apply.");
  }

  const baseline = await inspectExcelProperties(input.sourcePath, documentType);
  await ensureDirectory(input.outputFolder);
  const sourceExt = path.extname(input.sourcePath).toLowerCase() || `.${documentType}`;
  const fallbackName = `${sanitizeFilenamePart(path.basename(input.sourcePath, sourceExt))}_commented${sourceExt}`;
  const requestedName = sanitizeFilenamePart(input.outputFilename || fallbackName, fallbackName);
  const outputPath = await ensureUniquePath(
    path.join(input.outputFolder, requestedName.toLowerCase().endsWith(sourceExt) ? requestedName : `${requestedName}${sourceExt}`)
  );
  assertInside(input.outputFolder, outputPath);
  if (outputPathIsSource(input.sourcePath, outputPath)) {
    throw new Error("HL Intelligence will not overwrite the source workbook.");
  }

  const comments = findingsToApply.map((item): ExcelCommentToApply => {
    const anchorId = item.anchorId as string;
    const sourceBlock = localJob.source_map.anchors[anchorId];
    const sourceAnchor = sourceBlock?.anchor ?? item.finding.anchor;
    const comment = ensureExcelRangeReference(item.renderedComment ?? item.finding.comment_body, sourceAnchor);
    return {
      id: item.finding.id,
      anchor_id: anchorId,
      anchor: toExcelCommentAnchor(sourceAnchor),
      comment,
      expected_number_format: sourceBlock?.numberFormat
    };
  });

  const staged = await createStagedOutputFile(outputPath);
  let committed = false;
  try {
    await runExcelWorker<ExcelApplyCommentsResponse>(
      {
        schema_version: "1.0",
        operation: "apply-comments",
        application: "excel",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        comments
      } satisfies ExcelApplyCommentsRequest,
      EXCEL_APPLY_TIMEOUT_MS
    );

    await runExcelWorker<ExcelVerifyOutputResponse>(
      {
        schema_version: "1.0",
        operation: "verify-output",
        application: "excel",
        document_type: documentType,
        source_path: input.sourcePath,
        output_path: staged.stagingPath,
        expected: {
          sheet_count: baseline.sheet_count,
          formula_cell_count: baseline.formula_cell_count,
          named_range_count: baseline.named_range_count,
          chart_count: baseline.chart_count,
          existing_comment_count: baseline.existing_comment_count,
          macro_present: baseline.macro_present,
          hidden_state_signature: baseline.hidden_state_signature,
          named_range_signature: baseline.named_range_signature,
          number_format_signature: baseline.number_format_signature,
          external_link_signature: baseline.external_link_signature,
          anchors: comments
        }
      },
      EXCEL_VERIFY_TIMEOUT_MS
    );

    if ((await sha256File(input.sourcePath)) !== sourceHash) {
      throw new Error("Source Excel workbook changed while creating commented output.");
    }
    await assertGeneratedOutputWithinLimits([staged.stagingPath]);
    await staged.commit();
    committed = true;
  } catch (error) {
    await staged.cleanup();
    if (!committed) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const reportPath = await ensureUniquePath(outputPath.replace(/\.(xlsx|xlsm)$/i, "_comment_report.json"));
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
            "Excel output reopened through Microsoft Excel, expected notes were found, workbook properties were preserved, and the source workbook hash was unchanged.",
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

async function verifyExcelOutput(input: VerifyOutputInput): Promise<OutputVerification> {
  try {
    const documentType = excelDocumentTypeForPath(input.outputPath);
    const inspection = await inspectExcelProperties(input.outputPath, documentType);
    if (input.localJob.source.total_sheets && inspection.sheet_count !== input.localJob.source.total_sheets) {
      throw new Error("Excel output sheet count changed.");
    }
    return {
      schema_version: "1.0",
      document_type: documentType,
      output_path: input.outputPath,
      ok: true,
      message: "Excel output reopened normally through Microsoft Excel."
    };
  } catch (error) {
    return {
      schema_version: "1.0",
      document_type: excelDocumentTypeForPath(input.outputPath),
      output_path: input.outputPath,
      ok: false,
      message: error instanceof Error ? error.message : "Excel output integrity verification failed."
    };
  }
}

async function inspectExcelProperties(sourcePath: string, documentType: ExcelDocumentType): Promise<ExcelInspectionProperties> {
  const response = await runExcelWorker<ExcelInspectResponse>(
    {
      schema_version: "1.0",
      operation: "inspect",
      application: "excel",
      document_type: documentType,
      source_path: sourcePath
    },
    EXCEL_INSPECT_TIMEOUT_MS
  );
  return requireExcelInspection(response);
}

async function runExcelWorker<T extends OfficeWorkerResponseBase>(
  request: Parameters<typeof runOfficeWorker<T>>[0],
  timeoutMs: number,
  isCancelled?: () => boolean
): Promise<T> {
  try {
    const response = await runOfficeWorker<T>(request, { timeoutMs, isCancelled });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "The Excel operation failed. No source workbook was modified.");
    }
    return response;
  } catch (error) {
    throw sanitizeExcelError(error);
  }
}

function sanitizeExcelError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message === "cancelled") return new Error("cancelled");
  if (lower.includes("timed out")) {
    return new Error("Microsoft Excel did not finish the operation before the timeout. Close any Excel dialogs and try again.");
  }
  if (lower.includes("enoent") || lower.includes("pwsh") || lower.includes("powershell")) {
    return new Error("Microsoft Excel is not installed or local Excel automation is unavailable.");
  }
  return new Error(message || "The Excel operation failed. No source workbook was modified.");
}

function requireExcelInspection(response: ExcelInspectResponse | ExcelExtractResponse): ExcelInspectionProperties {
  if (!response.inspection) throw new Error("Excel inspection did not return workbook properties.");
  return response.inspection;
}

function convertExcelAnchors(anchors: Record<string, ExcelSourceAnchor>): Record<string, SourceBlock> {
  const converted: Record<string, SourceBlock> = {};
  for (const [anchorId, anchor] of Object.entries(anchors)) {
    converted[anchorId] = {
      anchorId,
      kind: anchor.kind,
      anchor: anchor.anchor as DocumentAnchor,
      sheet: anchor.sheet,
      cell: anchor.cell,
      range: anchor.range,
      displayedValue: anchor.displayedValue,
      formula: anchor.formula,
      numberFormat: anchor.numberFormat,
      text: anchor.text
    };
  }
  return converted;
}

function resolveExcelAnchorId(localJob: LocalReviewJob, anchor: DocumentAnchor): string | undefined {
  if (anchor.kind !== "xlsx_cell" && anchor.kind !== "xlsx_range") return undefined;
  const normalizedSheet = normalizeExcelSheetName(anchor.sheet);
  if (anchor.kind === "xlsx_cell") {
    const cell = normalizeExcelAddress(anchor.cell);
    return Object.values(localJob.source_map.anchors).find((candidate) => {
      return (
        candidate.kind === "xlsx_cell" &&
        normalizeExcelSheetName(candidate.sheet ?? "") === normalizedSheet &&
        normalizeExcelAddress(candidate.cell ?? "") === cell
      );
    })?.anchorId;
  }

  const range = normalizeExcelAddress(anchor.range);
  return Object.values(localJob.source_map.anchors).find((candidate) => {
    return (
      candidate.kind === "xlsx_range" &&
      normalizeExcelSheetName(candidate.sheet ?? "") === normalizedSheet &&
      normalizeExcelAddress(candidate.range ?? "") === range
    );
  })?.anchorId;
}

function toExcelCommentAnchor(anchor: DocumentAnchor): ExcelCommentToApply["anchor"] {
  if (anchor.kind === "xlsx_cell") {
    return {
      kind: "xlsx_cell",
      sheet: anchor.sheet,
      cell: anchor.cell
    };
  }
  if (anchor.kind === "xlsx_range") {
    return {
      kind: "xlsx_range",
      sheet: anchor.sheet,
      range: anchor.range
    };
  }
  throw new Error(`Unsupported Excel anchor kind: ${anchor.kind}`);
}

function ensureExcelRangeReference(comment: string, anchor: DocumentAnchor): string {
  if (anchor.kind !== "xlsx_range") return comment;
  const reference = `${anchor.sheet}!${anchor.range}`;
  return comment.includes(anchor.range) || comment.includes(reference) ? comment : `${comment} [Range: ${reference}]`;
}

function excelDocumentTypeForPath(filePath: string): ExcelDocumentType {
  return path.extname(filePath).toLowerCase() === ".xlsm" ? "xlsm" : "xlsx";
}

function normalizeExcelSheetName(sheet: string): string {
  return sheet.trim().toLocaleLowerCase();
}

function normalizeExcelAddress(address: string): string {
  return address.replace(/\$/g, "").trim().toLocaleUpperCase();
}

function selectExcelRenderTargets(input: {
  mode: "text-only" | "text-visual" | "text-all-pages";
  candidates: ExcelRenderTarget[];
  allTargets: ExcelRenderTarget[];
  forceVisualSupplement?: boolean;
}): ExcelRenderTarget[] {
  if (input.mode === "text-only") return [];
  const selected = input.mode === "text-all-pages" || input.forceVisualSupplement ? input.allTargets : input.candidates;
  const seen = new Set<string>();
  return selected.filter((target) => {
    const key = `${normalizeExcelSheetName(target.sheet)}|${normalizeExcelAddress(target.range ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function writeExcelVisualSupplementPdf(input: {
  renderedTargets: Array<{
    sheet: string;
    sheet_index: number;
    range?: string;
    reason: string;
    output_pdf_path: string;
  }>;
  outputPath: string;
  sourceFilename: string;
}): Promise<{ pdfPath: string | null; visualPages: VisualPageRef[] }> {
  if (input.renderedTargets.length === 0) return { pdfPath: null, visualPages: [] };

  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const loadedTargets: Array<{
    target: (typeof input.renderedTargets)[number];
    pdf: PDFDocument;
    pageCount: number;
  }> = [];

  for (const target of input.renderedTargets) {
    const pdf = await PDFDocument.load(await readFile(officeWorkerPathToLocal(target.output_pdf_path)), {
      ignoreEncryption: false,
      updateMetadata: false
    });
    loadedTargets.push({ target, pdf, pageCount: pdf.getPageCount() });
  }

  const indexPageCount = excelVisualSupplementIndexPageCount(loadedTargets.length);
  const visualPages: VisualPageRef[] = [];
  let supplementPage = indexPageCount + 1;
  for (const item of loadedTargets) {
    visualPages.push({
      page: item.target.sheet_index,
      supplementPage,
      supplementPageEnd: supplementPage + item.pageCount - 1,
      reason: item.target.reason,
      sheet: item.target.sheet,
      sourceRange: item.target.range
    });
    supplementPage += item.pageCount;
  }

  for (let pageIndex = 0; pageIndex < indexPageCount; pageIndex += 1) {
    const indexPage = output.addPage([612, 792]);
    drawExcelSupplementIndexPage({
      indexPage,
      font,
      bold,
      sourceFilename: input.sourceFilename,
      visualPages,
      pageIndex,
      indexPageCount
    });
  }

  for (const item of loadedTargets) {
    const copiedPages = await output.copyPages(
      item.pdf,
      Array.from({ length: item.pageCount }, (_, index) => index)
    );
    copiedPages.forEach((page) => output.addPage(page));
  }

  await ensureDirectory(path.dirname(input.outputPath));
  const uniquePath = await ensureUniquePath(input.outputPath);
  await writeFileAtomic(uniquePath, await output.save({ useObjectStreams: false }));
  return { pdfPath: uniquePath, visualPages };
}

function excelVisualSupplementIndexPageCount(selectedTargetCount: number): number {
  if (selectedTargetCount <= 0) return 0;
  return Math.max(1, Math.ceil(selectedTargetCount / INDEX_ENTRIES_PER_PAGE));
}

function drawExcelSupplementIndexPage(input: {
  indexPage: any;
  font: any;
  bold: any;
  sourceFilename: string;
  visualPages: VisualPageRef[];
  pageIndex: number;
  indexPageCount: number;
}): void {
  const { indexPage, font, bold, sourceFilename, visualPages, pageIndex, indexPageCount } = input;
  indexPage.drawText("HL Intelligence Excel Visual Supplement", {
    x: 48,
    y: 744,
    size: 16,
    font: bold,
    color: rgb(0, 0.157, 0.333)
  });
  indexPage.drawText(`Source filename: ${sourceFilename}`, { x: 48, y: 718, size: 10, font });
  indexPage.drawText(`Index page ${pageIndex + 1} of ${indexPageCount}`, { x: 48, y: 700, size: 10, font });
  indexPage.drawText("Mapped sheets and ranges:", { x: 48, y: 674, size: 11, font: bold });

  const start = pageIndex * INDEX_ENTRIES_PER_PAGE;
  const entries = visualPages.slice(start, start + INDEX_ENTRIES_PER_PAGE);
  entries.forEach((entry, index) => {
    const y = 650 - index * 16;
    const pageLabel =
      entry.supplementPageEnd && entry.supplementPageEnd !== entry.supplementPage
        ? `${entry.supplementPage}-${entry.supplementPageEnd}`
        : `${entry.supplementPage}`;
    const sourceRange = entry.sourceRange ? ` ${entry.sourceRange}` : "";
    const line = `Sheet ${entry.page} "${entry.sheet ?? ""}"${sourceRange} -> supplement page ${pageLabel}: ${entry.reason}`;
    indexPage.drawText(truncate(line, 112), { x: 58, y, size: 9, font });
  });
}

function addExcelModeNotes(input: {
  markdown: string;
  mode: "text-only" | "text-visual" | "text-all-pages";
  visualPages: VisualPageRef[];
  visualSupplementName: string;
  csvSidecars: string[];
}): string {
  const lines: string[] = [input.markdown.trimEnd()];
  if (input.mode === "text-only") {
    lines.push("", "> Warning: Text only mode excludes rendered charts, images, dashboards, complex merged layouts, and conditional-format visuals.");
  }
  if (input.visualPages.length > 0) {
    lines.push("", "## Visual Supplement");
    for (const ref of input.visualPages) {
      const pageLabel =
        ref.supplementPageEnd && ref.supplementPageEnd !== ref.supplementPage
          ? `${ref.supplementPage}-${ref.supplementPageEnd}`
          : `${ref.supplementPage}`;
      const range = ref.sourceRange ? `, range ${ref.sourceRange}` : "";
      lines.push(
        `- Sheet ${ref.page} "${ref.sheet ?? ""}"${range}: ${input.visualSupplementName}, supplement page ${pageLabel}. Reason: ${ref.reason}.`
      );
    }
  }
  if (input.csvSidecars.length > 0) {
    lines.push("", "## CSV Sidecars");
    for (const csvPath of input.csvSidecars) {
      lines.push(`- ${path.basename(csvPath)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildExcelPrompt(config: ReviewConfig, hasVisualSupplement: boolean): string {
  const visualLine = hasVisualSupplement
    ? "Use the visual supplement only to verify rendered charts, images, dashboards, complex merged layouts, conditional formatting, or layout-dependent workbook content referenced by the Markdown."
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

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function asArray<T>(value: T[] | T | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
