import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type {
  JobStage,
  ProcessingMode,
  ProgressEvent,
  SourceBlock,
  SourceMap,
  VisualPageRef
} from "../shared/types.js";
import { PROCESSING_VERSION } from "./constants.js";
import { basenameWithoutExtension, ensureDirectory, ensureUniquePath, writeFileAtomic } from "./fileSafety.js";

type PdfJs = any;
type CancelCheck = () => boolean;
type ProgressReporter = (stage: JobStage, percent: number, message: string) => void;

export interface PdfExtractionOptions {
  mode: ProcessingMode;
  sourceHash: string;
  forceVisualSupplement?: boolean;
  preserveExistingComments?: boolean;
  createdAt?: string;
}

export interface PdfExtractionResult {
  markdown: string;
  sourceMap: SourceMap;
  visualPages: VisualPageRef[];
  totalPages: number;
}

interface LineBlock {
  text: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export async function loadPdfPageCount(filePath: string): Promise<number> {
  const bytes = await readFile(filePath);
  assertPdfIsNotEncrypted(bytes);
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    return doc.numPages;
  } finally {
    await cleanupPdfDocument(loadingTask, doc);
  }
}

export async function extractPdf(
  filePath: string,
  options: PdfExtractionOptions,
  progress: ProgressReporter = () => undefined,
  isCancelled: CancelCheck = () => false
): Promise<PdfExtractionResult> {
  const bytes = await readFile(filePath);
  assertPdfIsNotEncrypted(bytes);
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;

  const anchors: Record<string, SourceBlock> = {};
  const visualPages: VisualPageRef[] = [];
  const pageMarkdown: string[] = [];
  const totalPages = doc.numPages;
  const visualSupplementName = `${basenameWithoutExtension(filePath)}_visuals.pdf`;

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (isCancelled()) throw new Error("cancelled");
      progress("extracting", Math.round(((pageNumber - 1) / totalPages) * 70), `Extracting page ${pageNumber}`);
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const lines = groupTextItemsIntoLines(textContent.items);
      const visualReason = await detectVisualPage(pdfjs, page, lines, viewport.width * viewport.height);

      const includeVisual =
        options.mode === "text-all-pages" ||
        options.forceVisualSupplement ||
        (options.mode === "text-visual" && visualReason !== null);

      if (includeVisual) {
        visualPages.push({
          page: pageNumber,
          supplementPage: visualPages.length + 2,
          reason: options.mode === "text-all-pages" ? "Full visual reference requested." : visualReason ?? "Visual supplement forced."
        });
      }

      pageMarkdown.push(`<!-- HL_SOURCE_PAGE: ${pageNumber} -->`);
      if (lines.length === 0) {
        const anchorId = `p${pad4(pageNumber)}:page`;
        anchors[anchorId] = {
          anchorId,
          kind: "pdf_page",
          page: pageNumber,
          text: ""
        };
        pageMarkdown.push(`<!-- HL:${anchorId} -->`);
        pageMarkdown.push("_No extractable text was found on this page._");
      } else {
        lines.forEach((line, index) => {
          const blockId = `p${pad4(pageNumber)}:b${pad4(index + 1)}`;
          anchors[blockId] = {
            anchorId: blockId,
            kind: "pdf_block",
            page: pageNumber,
            blockId,
            text: line.text,
            bbox: line.bbox
          };
          pageMarkdown.push(`<!-- HL:${blockId} -->`);
          pageMarkdown.push(line.text);
          pageMarkdown.push("");
        });
      }

      const visualRef = visualPages.find((ref) => ref.page === pageNumber);
      if (visualRef) {
        pageMarkdown.push(
          `Visual reference: ${visualSupplementName}, supplement page ${visualRef.supplementPage}, original PDF page ${pageNumber}.`
        );
      }
      pageMarkdown.push("");
    }

    const markdown = buildMarkdown(filePath, options.sourceHash, totalPages, pageMarkdown.join("\n"), options.createdAt);
    const sourceMap: SourceMap = {
      schema_version: "1.0",
      processing_version: PROCESSING_VERSION,
      source: {
        filename: path.basename(filePath),
        path: filePath,
        sha256: options.sourceHash,
        document_type: "pdf",
        total_pages: totalPages
      },
      anchors,
      visual_pages: visualPages
    };

    progress("extracting", 75, "PDF extraction complete");
    return { markdown, sourceMap, visualPages, totalPages };
  } finally {
    await cleanupPdfDocument(loadingTask, doc);
  }
}

export async function writeVisualSupplementPdf(
  sourcePath: string,
  selectedOriginalPages: number[],
  outputPath: string
): Promise<string | null> {
  if (selectedOriginalPages.length === 0) return null;
  const sourceBytes = await readFile(sourcePath);
  assertPdfIsNotEncrypted(sourceBytes);
  const source = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: false,
    updateMetadata: false
  });
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const indexPage = output.addPage([612, 792]);
  indexPage.drawText("HL Intelligence Visual Supplement", {
    x: 48,
    y: 742,
    size: 16,
    font: bold,
    color: rgb(0, 0.156, 0.333)
  });
  indexPage.drawText(`Source: ${path.basename(sourcePath)}`, {
    x: 48,
    y: 714,
    size: 10,
    font,
    color: rgb(0.18, 0.2, 0.24)
  });
  indexPage.drawText("Supplement page -> original PDF page", {
    x: 48,
    y: 682,
    size: 10,
    font: bold,
    color: rgb(0.18, 0.2, 0.24)
  });
  selectedOriginalPages.forEach((pageNumber, index) => {
    const y = 658 - index * 16;
    if (y > 48) {
      indexPage.drawText(`${index + 2} -> ${pageNumber}`, {
        x: 48,
        y,
        size: 10,
        font,
        color: rgb(0.18, 0.2, 0.24)
      });
    }
  });

  const copiedPages = await output.copyPages(
    source,
    selectedOriginalPages.map((pageNumber) => pageNumber - 1)
  );
  copiedPages.forEach((page) => output.addPage(page));

  await ensureDirectory(path.dirname(outputPath));
  const uniquePath = await ensureUniquePath(outputPath);
  await writeFileAtomic(uniquePath, await output.save({ useObjectStreams: false }));
  return uniquePath;
}

function buildMarkdown(sourcePath: string, sourceHash: string, totalPages: number, body: string, createdAt?: string): string {
  const created = createdAt ?? new Date().toISOString();
  return [
    `# ${path.basename(sourcePath)}`,
    "",
    `Source filename: ${path.basename(sourcePath)}`,
    `Source SHA-256: ${sourceHash}`,
    `Processing date: ${created}`,
    `Original PDF pages: ${totalPages}`,
    "",
    body.trim(),
    ""
  ].join("\n");
}

async function loadPdfJs(): Promise<PdfJs> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function cleanupPdfDocument(loadingTask: any, doc: any): Promise<void> {
  if (typeof doc?.destroy === "function") {
    await doc.destroy();
    return;
  }
  if (typeof loadingTask?.destroy === "function") {
    await loadingTask.destroy();
    return;
  }
  if (typeof doc?.cleanup === "function") {
    await doc.cleanup();
  }
}

function assertPdfIsNotEncrypted(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).subarray(0, Math.min(bytes.length, 1024 * 1024)).toString("latin1");
  if (text.includes("/Encrypt")) {
    throw new Error("Password-protected PDFs are not supported. HL Intelligence will not bypass document passwords.");
  }
}

function groupTextItemsIntoLines(items: any[]): LineBlock[] {
  const fragments = items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .map((item) => {
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      const width = Math.max(Number(item.width ?? 0), item.str.length * 3.5);
      const height = Math.max(Math.abs(Number(item.height ?? transform[3] ?? 10)), 8);
      return { text: item.str.trim(), x, y, width, height };
    })
    .sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));

  const lines: Array<{ y: number; fragments: typeof fragments }> = [];
  for (const fragment of fragments) {
    const existing = lines.find((line) => Math.abs(line.y - fragment.y) <= 3);
    if (existing) {
      existing.fragments.push(fragment);
      existing.y = (existing.y + fragment.y) / 2;
    } else {
      lines.push({ y: fragment.y, fragments: [fragment] });
    }
  }

  return lines
    .map((line) => {
      const sorted = line.fragments.sort((a, b) => a.x - b.x);
      const text = sorted.map((fragment) => fragment.text).join(" ").replace(/\s+/g, " ").trim();
      const minX = Math.min(...sorted.map((fragment) => fragment.x));
      const minY = Math.min(...sorted.map((fragment) => fragment.y));
      const maxX = Math.max(...sorted.map((fragment) => fragment.x + fragment.width));
      const maxY = Math.max(...sorted.map((fragment) => fragment.y + fragment.height));
      return {
        text,
        bbox: {
          x: round2(minX),
          y: round2(minY),
          width: round2(maxX - minX),
          height: round2(maxY - minY)
        }
      };
    })
    .filter((line) => line.text);
}

async function detectVisualPage(pdfjs: PdfJs, page: any, lines: LineBlock[], pageArea: number): Promise<string | null> {
  const operatorList = await page.getOperatorList();
  const ops = pdfjs.OPS ?? {};
  const rasterOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintJpegXObject].filter(Boolean));
  const vectorOps = new Set(
    [
      ops.constructPath,
      ops.stroke,
      ops.fill,
      ops.eoFill,
      ops.fillStroke,
      ops.eoFillStroke,
      ops.shadingFill,
      ops.paintSolidColorImageMask,
      ops.paintFormXObjectBegin
    ].filter(Boolean)
  );

  let rasterCount = 0;
  let vectorCount = 0;
  for (const fn of operatorList.fnArray as number[]) {
    if (rasterOps.has(fn)) rasterCount += 1;
    if (vectorOps.has(fn)) vectorCount += 1;
  }

  const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);
  const textBoxArea = lines.reduce((sum, line) => sum + line.bbox.width * line.bbox.height, 0);
  const textCoverage = pageArea > 0 ? textBoxArea / pageArea : 0;
  const reasons: string[] = [];

  if (rasterCount > 0 && textCoverage < 0.22) reasons.push("contains raster imagery with limited text coverage");
  if (vectorCount >= 28) reasons.push("contains dense vector drawing or chart-like geometry");
  if (vectorCount >= 12 && lines.length <= 18) reasons.push("contains positioned graphics with sparse text");
  if (charCount < 40 && (rasterCount > 0 || vectorCount > 8)) reasons.push("may be scanned or visually dependent");
  if (lines.length > 45 && vectorCount > 18) reasons.push("contains dense layout or complex tabular structure");

  return reasons.length ? reasons.join("; ") : null;
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function stageEvent(jobId: string, filePath: string | undefined, stage: JobStage, percent: number, message: string): ProgressEvent {
  return { jobId, filePath, stage, percent, message };
}
