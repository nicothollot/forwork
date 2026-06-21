import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  rgb
} from "pdf-lib";
import type {
  CreateCommentedPdfInput,
  CreateCommentedPdfResult,
  FindingValidation,
  LocalReviewJob
} from "../shared/types.js";
import { assertInside, ensureDirectory, ensureUniquePath, outputPathIsSource, readJsonFile, sanitizeFilenamePart, writeFileAtomic } from "./fileSafety.js";
import { sha256File } from "./hash.js";
import { validateClaudeResultText } from "./resultValidation.js";

export async function createCommentedPdf(input: CreateCommentedPdfInput): Promise<CreateCommentedPdfResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  const sourceHash = await sha256File(input.sourcePath);
  if (sourceHash !== localJob.source.sha256) {
    throw new Error("The selected source document does not match the review job hash.");
  }
  if (localJob.source.document_type !== "pdf") {
    throw new Error("Only verified PDF comment output is currently enabled.");
  }

  const rawJson = input.claudeJsonText ?? (input.claudeJsonPath ? await readFile(input.claudeJsonPath, "utf8") : "");
  const validation = await validateClaudeResultText(localJob, rawJson);
  const validFindings = validation.validations.filter((finding) => finding.status === "valid");
  if (validation.errors.length > 0 || validFindings.length === 0) {
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
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false, updateMetadata: false });
  for (const finding of validFindings) {
    addFindingAnnotation(pdf, localJob, finding);
  }

  await writeFileAtomic(outputPath, await pdf.save({ useObjectStreams: false }));
  const reportPath = await ensureUniquePath(outputPath.replace(/\.pdf$/i, "_comment_report.json"));
  const skipped = validation.validations.filter((finding) => finding.status !== "valid");
  await writeFileAtomic(
    reportPath,
    JSON.stringify(
      {
        schema_version: "1.0",
        source_filename: localJob.source.filename,
        source_sha256: localJob.source.sha256,
        output_file: path.basename(outputPath),
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

  return {
    outputPath,
    reportPath,
    summary: validation.summary,
    skipped
  };
}

function addFindingAnnotation(pdf: PDFDocument, localJob: LocalReviewJob, validation: FindingValidation): void {
  const anchorId = validation.anchorId;
  if (!anchorId) return;
  const anchor = localJob.source_map.anchors[anchorId];
  if (!anchor) return;
  const page = pdf.getPage(anchor.page - 1);
  const size = page.getSize();
  const comment = validation.renderedComment ?? validation.finding.comment_body;
  const bbox = anchor.bbox ?? { x: 36, y: size.height - 72, width: 220, height: 16 };
  const x = clamp(bbox.x, 24, Math.max(24, size.width - 48));
  const y = clamp(bbox.y, 24, Math.max(24, size.height - 48));
  const width = clamp(bbox.width, 12, size.width - x);
  const height = clamp(bbox.height, 10, 48);

  if (anchor.bbox) {
    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: rgb(1, 0.88, 0.32),
      opacity: 0.22,
      borderOpacity: 0
    });
    appendHighlightAnnotation(page, x, y, width, height);
  }

  appendTextAnnotation(page, comment, Math.min(x + width + 8, size.width - 28), Math.min(y + height + 8, size.height - 28));
}

function appendTextAnnotation(page: any, contents: string, x: number, y: number): void {
  const context = page.doc.context;
  const annotation = context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [x, y, x + 22, y + 22],
    Contents: PDFHexString.fromText(contents),
    T: PDFString.of("HL Intelligence"),
    Name: "Comment",
    Open: false,
    C: [0, 0.405, 0.647],
    M: PDFString.of(new Date().toISOString())
  });
  appendAnnotationRef(page, context.register(annotation));
}

function appendHighlightAnnotation(page: any, x: number, y: number, width: number, height: number): void {
  const context = page.doc.context;
  const annotation = context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [x, y, x + width, y + height],
    QuadPoints: [x, y + height, x + width, y + height, x, y, x + width, y],
    C: [1, 0.82, 0.2],
    CA: 0.35,
    Contents: PDFString.of("HL Intelligence evidence highlight")
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
