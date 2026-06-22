import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString
} from "pdf-lib";
import type {
  CreateCommentedPdfInput,
  CreateCommentedPdfResult,
  FindingValidation,
  LocalReviewJob,
  OutputVerification
} from "../shared/types.js";
import {
  assertInside,
  createStagedOutputFile,
  ensureDirectory,
  ensureUniquePath,
  outputPathIsSource,
  readJsonFile,
  sanitizeFilenamePart,
  writeFileAtomic
} from "./fileSafety.js";
import { sha256File } from "./hash.js";
import { cachedSha256File } from "./jobFoundation.js";
import { validateClaudeResultText } from "./resultValidation.js";
import { selectFindingsForOutput, skippedFindingsForOutput } from "./commentSelection.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import { assertGeneratedOutputWithinLimits, assertSourceFileWithinLimits } from "./safetyLimits.js";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageSnapshot {
  mediaBox: Box;
  cropBox: Box;
  rotation: number;
  annotationCount: number;
  textSignature: string;
}

interface PdfSnapshot {
  pageCount: number;
  pages: PageSnapshot[];
  outlineCount: number;
  formFieldCount: number;
}

export async function createCommentedPdf(input: CreateCommentedPdfInput): Promise<CreateCommentedPdfResult> {
  return createCommentedPdfForPdf(input);
}

export async function createCommentedPdfForPdf(input: CreateCommentedPdfInput): Promise<CreateCommentedPdfResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, "pdf");
  const sourceHash = await cachedSha256File(input.sourcePath);
  if (sourceHash !== localJob.source.sha256) {
    throw new Error("The selected source document does not match the review job hash.");
  }
  if (localJob.source.document_type !== "pdf") {
    throw new Error("Only verified PDF comment output is currently enabled.");
  }

  const rawJson = input.claudeJsonText ?? (input.claudeJsonPath ? await readFile(input.claudeJsonPath, "utf8") : "");
  const validation = await validateClaudeResultText(localJob, rawJson);
  const findingsToApply = selectFindingsForOutput(validation.validations, input.approvedFindings);
  if (validation.errors.length > 0 || findingsToApply.length === 0) {
    throw new Error(validation.errors[0] ?? "No valid comments are available to apply.");
  }

  await ensureDirectory(input.outputFolder);
  const sourceExt = path.extname(input.sourcePath) || ".pdf";
  const fallbackName = `${sanitizeFilenamePart(path.basename(input.sourcePath, sourceExt))}_commented${sourceExt}`;
  const requestedName = sanitizeFilenamePart(input.outputFilename || fallbackName, fallbackName);
  const outputPath = await ensureUniquePath(path.join(input.outputFolder, requestedName.endsWith(".pdf") ? requestedName : `${requestedName}.pdf`));
  assertInside(input.outputFolder, outputPath);
  if (outputPathIsSource(input.sourcePath, outputPath)) {
    throw new Error("HL Intelligence will not overwrite the source document.");
  }

  const pdfBytes = await readFile(input.sourcePath);
  assertPdfIsNotSignatureLike(pdfBytes);
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false, updateMetadata: false });
  const iconPlacements = new Map<number, Box[]>();
  const expectedAddedByPage = new Map<number, number>();

  for (const finding of findingsToApply) {
    const added = addFindingAnnotation(pdf, localJob, finding, iconPlacements);
    if (added.count > 0) {
      expectedAddedByPage.set(added.pageIndex, (expectedAddedByPage.get(added.pageIndex) ?? 0) + added.count);
    }
  }

  const staged = await createStagedOutputFile(outputPath);
  let committed = false;
  try {
    await writeFileAtomic(staged.stagingPath, await pdf.save({ useObjectStreams: false }));
    await assertGeneratedOutputWithinLimits([staged.stagingPath]);
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
  let outputVerification: OutputVerification;
  try {
    outputVerification = await verifyCommentedPdfIntegrity({
      sourcePath: input.sourcePath,
      outputPath: staged.stagingPath,
      localJob,
      originalSourceSha256: sourceHash,
      expectedAddedByPage
    });
    if (!outputVerification.ok) throw new Error(outputVerification.message);
    await staged.commit();
    committed = true;
  } catch (error) {
    await staged.cleanup();
    throw error;
  }

  const reportPath = await ensureUniquePath(outputPath.replace(/\.pdf$/i, "_comment_report.json"));
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
          output_verification: outputVerification.message,
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
    if (committed) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    outputPath,
    reportPath,
    summary: validation.summary,
    skipped
  };
}

export async function verifyCommentedPdfIntegrity(input: {
  sourcePath?: string;
  outputPath: string;
  localJob: LocalReviewJob;
  originalSourceSha256?: string;
  expectedAddedByPage?: Map<number, number>;
}): Promise<OutputVerification> {
  try {
    const output = await snapshotPdf(input.outputPath);
    const sourcePath = input.sourcePath ?? input.localJob.source.path;
    if (!sourcePath) {
      const expectedPages = input.localJob.source.total_pages;
      if (expectedPages && output.pageCount !== expectedPages) {
        throw new Error(`PDF output page count changed: expected ${expectedPages}, found ${output.pageCount}.`);
      }
      return {
        schema_version: "1.0",
        document_type: "pdf",
        output_path: input.outputPath,
        ok: true,
        message: "PDF output could be opened and page count was retained."
      };
    }

    const source = await snapshotPdf(sourcePath);
    if (source.pageCount !== output.pageCount) {
      throw new Error(`PDF output page count changed: source ${source.pageCount}, output ${output.pageCount}.`);
    }

    for (let index = 0; index < source.pages.length; index += 1) {
      const sourcePage = source.pages[index];
      const outputPage = output.pages[index];
      if (!sameBox(sourcePage.mediaBox, outputPage.mediaBox) || !sameBox(sourcePage.cropBox, outputPage.cropBox)) {
        throw new Error(`PDF output page ${index + 1} dimensions changed.`);
      }
      if (sourcePage.rotation !== outputPage.rotation) {
        throw new Error(`PDF output page ${index + 1} rotation changed.`);
      }
      if (sourcePage.textSignature !== outputPage.textSignature) {
        throw new Error(`PDF output page ${index + 1} text geometry changed.`);
      }
      const expectedAdded = input.expectedAddedByPage?.get(index) ?? 0;
      if (outputPage.annotationCount < sourcePage.annotationCount + expectedAdded) {
        throw new Error(`PDF output page ${index + 1} is missing expected annotations.`);
      }
    }

    if (output.outlineCount < source.outlineCount) {
      throw new Error("PDF output did not retain all supported bookmarks.");
    }
    if (output.formFieldCount < source.formFieldCount) {
      throw new Error("PDF output did not retain all supported form fields.");
    }
    if (input.originalSourceSha256 && (await sha256File(sourcePath)) !== input.originalSourceSha256) {
      throw new Error("Source PDF changed while creating commented output.");
    }

    const expectedAnnotations = [...(input.expectedAddedByPage?.values() ?? [])].reduce((sum, count) => sum + count, 0);
    return {
      schema_version: "1.0",
      document_type: "pdf",
      output_path: input.outputPath,
      ok: true,
      message: `PDF output reopened, retained page geometry/content, retained supported annotations/bookmarks/forms, and contains ${expectedAnnotations} added annotation(s).`
    };
  } catch (error) {
    return {
      schema_version: "1.0",
      document_type: "pdf",
      output_path: input.outputPath,
      ok: false,
      message: error instanceof Error ? error.message : "PDF output integrity verification failed."
    };
  }
}

function addFindingAnnotation(
  pdf: PDFDocument,
  localJob: LocalReviewJob,
  validation: FindingValidation,
  iconPlacements: Map<number, Box[]>
): { pageIndex: number; count: number } {
  const anchorId = validation.anchorId;
  if (!anchorId) return { pageIndex: 0, count: 0 };
  const anchor = localJob.source_map.anchors[anchorId];
  if (!anchor?.page) return { pageIndex: 0, count: 0 };
  const pageIndex = anchor.page - 1;
  const page = pdf.getPage(pageIndex);
  const visibleBox = visiblePageBox(page);
  const comment = validation.renderedComment ?? validation.finding.comment_body;
  const evidenceBox = anchor.bbox ? clampBox(anchor.bbox, visibleBox) : defaultCommentTarget(visibleBox);
  let count = 0;

  if (anchor.bbox && evidenceBox.width >= 2 && evidenceBox.height >= 2) {
    appendHighlightAnnotation(page, evidenceBox);
    count += 1;
  }

  const placements = iconPlacements.get(pageIndex) ?? [];
  const icon = placeTextIcon(evidenceBox, visibleBox, placements);
  placements.push(icon);
  iconPlacements.set(pageIndex, placements);
  appendTextAnnotation(page, comment, icon);
  count += 1;

  return { pageIndex, count };
}

function appendTextAnnotation(page: any, contents: string, rect: Box): void {
  const context = page.doc.context;
  const now = PDFString.of(formatPdfDate(new Date()));
  const annotation = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Contents: PDFHexString.fromText(contents),
    T: PDFString.of("HL Intelligence"),
    Name: PDFName.of("Comment"),
    Open: false,
    C: [0, 0.405, 0.647],
    M: now,
    CreationDate: now,
    F: 4
  });
  appendAnnotationRef(page, context.register(annotation));
}

function appendHighlightAnnotation(page: any, rect: Box): void {
  const context = page.doc.context;
  const now = PDFString.of(formatPdfDate(new Date()));
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  const annotation = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [x1, y1, x2, y2],
    QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
    C: [1, 0.82, 0.2],
    CA: 0.35,
    Contents: PDFString.of("HL Intelligence evidence highlight"),
    M: now,
    CreationDate: now,
    F: 4
  });
  appendAnnotationRef(page, context.register(annotation));
}

function appendAnnotationRef(page: any, ref: any): void {
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) {
    existing.push(ref);
    return;
  }
  const annots = page.doc.context.obj([]);
  annots.push(ref);
  page.node.set(PDFName.of("Annots"), annots);
}

function visiblePageBox(page: any): Box {
  const crop = typeof page.getCropBox === "function"
    ? page.getCropBox()
    : { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() };
  return {
    x: Number(crop.x ?? 0),
    y: Number(crop.y ?? 0),
    width: Math.max(Number(crop.width ?? page.getWidth()), 1),
    height: Math.max(Number(crop.height ?? page.getHeight()), 1)
  };
}

function defaultCommentTarget(pageBox: Box): Box {
  return {
    x: pageBox.x + 36,
    y: pageBox.y + pageBox.height - 78,
    width: Math.min(220, pageBox.width - 72),
    height: 18
  };
}

function clampBox(box: Box, pageBox: Box): Box {
  const margin = 2;
  const minX = pageBox.x + margin;
  const minY = pageBox.y + margin;
  const maxX = pageBox.x + pageBox.width - margin;
  const maxY = pageBox.y + pageBox.height - margin;
  const x = clamp(box.x, minX, Math.max(minX, maxX - 2));
  const y = clamp(box.y, minY, Math.max(minY, maxY - 2));
  return {
    x,
    y,
    width: clamp(box.width, 2, Math.max(2, maxX - x)),
    height: clamp(box.height, 2, Math.max(2, maxY - y))
  };
}

function placeTextIcon(target: Box, pageBox: Box, existing: Box[]): Box {
  const size = 22;
  const gap = 5;
  let x = target.x + target.width + gap;
  if (x + size > pageBox.x + pageBox.width - gap) x = target.x - size - gap;
  x = clamp(x, pageBox.x + gap, pageBox.x + pageBox.width - size - gap);
  let y = target.y + Math.min(target.height + gap, 30);
  y = clamp(y, pageBox.y + gap, pageBox.y + pageBox.height - size - gap);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = { x, y, width: size, height: size };
    if (!existing.some((rect) => overlaps(rect, candidate))) return candidate;
    y -= size + 4;
    if (y < pageBox.y + gap) {
      y = pageBox.y + pageBox.height - size - gap;
      x -= size + 4;
      x = clamp(x, pageBox.x + gap, pageBox.x + pageBox.width - size - gap);
    }
  }
  return { x, y, width: size, height: size };
}

async function snapshotPdf(filePath: string): Promise<PdfSnapshot> {
  const bytes = await readFile(filePath);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const textSignatures = await loadTextSignatures(bytes);
  const pages = pdf.getPages().map((page: any, index) => ({
    mediaBox: toBox(page.getMediaBox()),
    cropBox: toBox(page.getCropBox()),
    rotation: Number(page.getRotation().angle ?? 0),
    annotationCount: annotationCount(page),
    textSignature: textSignatures[index] ?? ""
  }));
  return {
    pageCount: pdf.getPageCount(),
    pages,
    outlineCount: await loadOutlineCount(bytes),
    formFieldCount: Math.max(loadPdfLibFormFieldCount(pdf), await loadPdfJsFormFieldCount(bytes))
  };
}

async function loadTextSignatures(bytes: Uint8Array): Promise<string[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const signatures: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      signatures.push(
        textContent.items
          .filter((item: any) => typeof item.str === "string" && item.str.trim())
          .map((item: any) => {
            const transform = item.transform ?? [];
            return [
              item.str.normalize("NFKC").replace(/\s+/g, " ").trim(),
              round2(Number(transform[4] ?? 0)),
              round2(Number(transform[5] ?? 0)),
              round2(Number(item.width ?? 0)),
              round2(Number(item.height ?? 0))
            ].join("@");
          })
          .join("|")
      );
      if (typeof page.cleanup === "function") page.cleanup();
    }
    return signatures;
  } finally {
    await cleanupPdfJsDocument(loadingTask, doc);
  }
}

async function loadOutlineCount(bytes: Uint8Array): Promise<number> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const outline = await doc.getOutline().catch(() => null);
    return countOutlineItems(outline);
  } finally {
    await cleanupPdfJsDocument(loadingTask, doc);
  }
}

async function loadPdfJsFormFieldCount(bytes: Uint8Array): Promise<number> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const fields = await doc.getFieldObjects().catch(() => null);
    if (!fields || typeof fields !== "object") return 0;
    return Object.values(fields as Record<string, unknown>).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
      0
    );
  } finally {
    await cleanupPdfJsDocument(loadingTask, doc);
  }
}

async function cleanupPdfJsDocument(loadingTask: any, doc: any): Promise<void> {
  if (typeof doc?.destroy === "function") {
    await doc.destroy();
  } else if (typeof loadingTask?.destroy === "function") {
    await loadingTask.destroy();
  } else if (typeof doc?.cleanup === "function") {
    await doc.cleanup();
  }
}

function loadPdfLibFormFieldCount(pdf: PDFDocument): number {
  try {
    return pdf.getForm().getFields().length;
  } catch {
    return 0;
  }
}

function annotationCount(page: any): number {
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  return annots ? annots.size() : 0;
}

function countOutlineItems(items: any): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + 1 + countOutlineItems(item.items), 0);
}

function assertPdfIsNotSignatureLike(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("latin1");
  if (/\/ByteRange\s*\[|\/FT\s*\/Sig\b|\/Type\s*\/Sig\b|\/SubFilter\s*\/adbe\.pkcs7|\/SubFilter\s*\/ETSI\./.test(text)) {
    throw new Error("This PDF appears to contain a digital signature. Create a copy without modifying the signed original, or obtain approval before annotation.");
  }
}

function sameBox(left: Box, right: Box): boolean {
  return (
    nearlyEqual(left.x, right.x) &&
    nearlyEqual(left.y, right.y) &&
    nearlyEqual(left.width, right.width) &&
    nearlyEqual(left.height, right.height)
  );
}

function toBox(value: { x: number; y: number; width: number; height: number }): Box {
  return {
    x: round2(value.x),
    y: round2(value.y),
    width: round2(value.width),
    height: round2(value.height)
  };
}

function formatPdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "D:",
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "Z"
  ].join("");
}

function overlaps(left: Box, right: Box): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.02;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
