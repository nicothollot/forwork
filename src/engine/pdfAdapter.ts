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

const INDEX_ENTRIES_PER_PAGE = 42;
const HEADER_FOOTER_PAGE_RATIO = 0.62;

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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextFragment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  angle: number;
}

interface TextLine {
  text: string;
  fragments: TextFragment[];
  bbox: Box;
  fontSize: number;
  x: number;
  y: number;
  width: number;
  height: number;
  column?: number;
  isHeading?: boolean;
  isTable?: boolean;
  isFootnote?: boolean;
  isRepeatedHeaderFooter?: boolean;
  hasRotatedText?: boolean;
}

interface ParagraphBlock {
  kind: "paragraph" | "heading" | "table" | "footnote";
  text: string;
  bbox: Box;
  lines: TextLine[];
}

interface VisualDetection {
  include: boolean;
  reason: string | null;
  lowConfidence: boolean;
}

interface PageAnalysis {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  lines: TextLine[];
  bodyLines: TextLine[];
  blocks: ParagraphBlock[];
  visualDetection: VisualDetection;
  warnings: string[];
  omittedHeaderFooterCount: number;
}

export async function loadPdfPageCount(filePath: string): Promise<number> {
  const bytes = await readFile(filePath);
  assertPdfIsNotEncrypted(bytes);
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
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
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;

  const anchors: Record<string, SourceBlock> = {};
  const pageMarkdown: string[] = [];
  const totalPages = doc.numPages;
  const visualSupplementName = `${basenameWithoutExtension(filePath)}_visuals.pdf`;

  try {
    const pages: PageAnalysis[] = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (isCancelled()) throw new Error("cancelled");
      progress("extracting", Math.round(((pageNumber - 1) / totalPages) * 55), `Extracting page ${pageNumber}`);
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const lines = groupTextItemsIntoLines(textContent.items);
      markLineRoles(lines, viewport.width, viewport.height);
      const visualDetection = await detectVisualPage(pdfjs, page, lines, viewport.width * viewport.height);
      const warnings = extractionWarnings(pageNumber, lines, visualDetection);
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: Number(page.rotate ?? 0),
        lines,
        bodyLines: [],
        blocks: [],
        visualDetection,
        warnings,
        omittedHeaderFooterCount: 0
      });
      if (typeof page.cleanup === "function") page.cleanup();
    }

    progress("detecting-visuals", 58, "Detecting repeated headers, footers, and visual pages");
    const repeatedHeaderFooterKeys = detectRepeatedHeaderFooterKeys(pages);
    for (const page of pages) {
      for (const line of page.lines) {
        line.isRepeatedHeaderFooter = isHighConfidenceHeaderFooter(line, page, repeatedHeaderFooterKeys);
      }
      page.bodyLines = page.lines.filter((line) => !line.isRepeatedHeaderFooter);
      page.omittedHeaderFooterCount = page.lines.length - page.bodyLines.length;
      page.blocks = reconstructParagraphBlocks(page, orderLinesForReading(page, page.bodyLines));
    }

    const visualSelections = pages
      .filter((page) => shouldIncludeVisualPage(page, options))
      .map((page) => ({
        page: page.pageNumber,
        reason: visualReason(page, options)
      }));
    const indexPageCount = visualSupplementIndexPageCount(visualSelections.length);
    const visualPages: VisualPageRef[] = visualSelections.map((page, index) => ({
      page: page.page,
      supplementPage: indexPageCount + index + 1,
      reason: page.reason
    }));

    for (const page of pages) {
      if (isCancelled()) throw new Error("cancelled");
      progress("extracting", 60 + Math.round((page.pageNumber / totalPages) * 15), `Building anchors for page ${page.pageNumber}`);
      appendPageMarkdown({
        filePath,
        page,
        anchors,
        pageMarkdown,
        visualRef: visualPages.find((ref) => ref.page === page.pageNumber),
        visualSupplementName
      });
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
  const indexPageCount = visualSupplementIndexPageCount(selectedOriginalPages.length);

  for (let pageIndex = 0; pageIndex < indexPageCount; pageIndex += 1) {
    const indexPage = output.addPage([612, 792]);
    drawSupplementIndexPage({
      indexPage,
      font,
      bold,
      sourcePath,
      selectedOriginalPages,
      pageIndex,
      indexPageCount
    });
  }

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

export function visualSupplementIndexPageCount(selectedPageCount: number): number {
  if (selectedPageCount <= 0) return 0;
  return Math.max(1, Math.ceil(selectedPageCount / INDEX_ENTRIES_PER_PAGE));
}

function appendPageMarkdown(input: {
  filePath: string;
  page: PageAnalysis;
  anchors: Record<string, SourceBlock>;
  pageMarkdown: string[];
  visualRef?: VisualPageRef;
  visualSupplementName: string;
}): void {
  const { page, anchors, pageMarkdown, visualRef, visualSupplementName } = input;
  const pageAnchorId = `p${pad4(page.pageNumber)}:page`;
  const pageText = page.blocks.map((block) => block.text).filter(Boolean).join("\n\n");
  anchors[pageAnchorId] = {
    anchorId: pageAnchorId,
    kind: "pdf_page",
    anchor: {
      kind: "pdf_page",
      page: page.pageNumber
    },
    page: page.pageNumber,
    text: pageText
  };

  pageMarkdown.push(`<!-- HL_SOURCE_PAGE: ${page.pageNumber} -->`);
  pageMarkdown.push(`<!-- HL:${pageAnchorId} -->`);
  for (const warning of page.warnings) {
    pageMarkdown.push(`> Warning: ${warning}`);
  }
  if (page.omittedHeaderFooterCount > 0) {
    pageMarkdown.push(`> Note: ${page.omittedHeaderFooterCount} repeated header/footer line(s) omitted with high confidence.`);
  }

  if (page.blocks.length === 0) {
    pageMarkdown.push("_No extractable body text was found on this page._");
  } else {
    page.blocks.forEach((block, index) => {
      const blockId = `p${pad4(page.pageNumber)}:b${pad4(index + 1)}`;
      anchors[blockId] = {
        anchorId: blockId,
        kind: "pdf_block",
        anchor: {
          kind: "pdf_block",
          page: page.pageNumber,
          block_id: blockId
        },
        page: page.pageNumber,
        blockId,
        text: block.text,
        bbox: block.bbox
      };
      pageMarkdown.push(`<!-- HL:${blockId} -->`);
      if (block.kind === "heading") {
        pageMarkdown.push(`## ${block.text}`);
      } else if (block.kind === "footnote") {
        pageMarkdown.push(`Footnote: ${block.text}`);
      } else {
        pageMarkdown.push(block.text);
      }
      pageMarkdown.push("");
    });
  }

  if (visualRef) {
    pageMarkdown.push(
      `Visual reference: ${visualSupplementName}, supplement page ${visualRef.supplementPage}, original PDF page ${page.pageNumber}. Reason: ${visualRef.reason}.`
    );
  }
  pageMarkdown.push("");
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

function groupTextItemsIntoLines(items: any[]): TextLine[] {
  const fragments = items
    .filter((item) => typeof item.str === "string" && item.str.trim())
    .map((item): TextFragment => {
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
      const a = Number(transform[0] ?? 1);
      const b = Number(transform[1] ?? 0);
      const d = Number(transform[3] ?? 10);
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      const fontSize = Math.max(Math.hypot(a, b), Math.abs(Number(item.height ?? d ?? 10)), 6);
      const width = Math.max(Number(item.width ?? 0), normalizePdfText(item.str).length * Math.max(fontSize * 0.34, 3.2));
      const height = Math.max(Math.abs(Number(item.height ?? d ?? fontSize)), fontSize * 0.7, 6);
      const angle = normalizeAngle((Math.atan2(b, a) * 180) / Math.PI);
      return {
        text: normalizePdfText(item.str),
        x,
        y,
        width,
        height,
        fontSize,
        fontName: String(item.fontName ?? ""),
        angle
      };
    })
    .filter((fragment) => fragment.text)
    .sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));

  const yTolerance = Math.max(2.5, median(fragments.map((fragment) => fragment.height)) * 0.36);
  const lines: Array<{ y: number; fragments: TextFragment[] }> = [];
  for (const fragment of fragments) {
    const existing = lines.find((line) => Math.abs(line.y - fragment.y) <= yTolerance && sameTextDirection(line.fragments[0], fragment));
    if (existing) {
      existing.fragments.push(fragment);
      existing.y = (existing.y * (existing.fragments.length - 1) + fragment.y) / existing.fragments.length;
    } else {
      lines.push({ y: fragment.y, fragments: [fragment] });
    }
  }

  return lines
    .flatMap((line) => splitLineFragments(line.fragments).map((fragmentsForLine) => buildTextLine(fragmentsForLine)))
    .filter((line) => line.text)
    .sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));
}

function buildTextLine(fragments: TextFragment[]): TextLine {
  const sorted = fragments.sort((a, b) => a.x - b.x);
  const text = joinFragments(sorted);
  const bbox = unionBoxes(
    sorted.map((fragment) => ({
      x: fragment.x,
      y: fragment.y,
      width: fragment.width,
      height: fragment.height
    }))
  );
  const fontSize = median(sorted.map((fragment) => fragment.fontSize));
  return {
    text,
    fragments: sorted,
    bbox,
    fontSize,
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
    hasRotatedText: sorted.some((fragment) => Math.abs(fragment.angle) > 8 && Math.abs(Math.abs(fragment.angle) - 180) > 8)
  };
}

function splitLineFragments(fragments: TextFragment[]): TextFragment[][] {
  const sorted = fragments.sort((a, b) => a.x - b.x);
  if (sorted.length < 2) return [sorted];
  const typicalSize = Math.max(median(sorted.map((fragment) => fragment.fontSize)), 8);
  const significantGaps: Array<{ index: number; gap: number }> = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gap = current.x - (previous.x + previous.width);
    if (gap > Math.max(32, typicalSize * 2.2)) significantGaps.push({ index, gap });
  }
  if (significantGaps.length !== 1) return [sorted];
  const splitAt = significantGaps[0].index;
  return [sorted.slice(0, splitAt), sorted.slice(splitAt)].filter((group) => group.length > 0);
}

function joinFragments(fragments: TextFragment[]): string {
  let text = "";
  let previousEnd = 0;
  const typicalSize = Math.max(median(fragments.map((fragment) => fragment.fontSize)), 8);
  for (const fragment of fragments) {
    if (!text) {
      text = fragment.text;
    } else {
      const gap = fragment.x - previousEnd;
      text += gap > typicalSize * 0.2 ? ` ${fragment.text}` : fragment.text;
    }
    previousEnd = Math.max(previousEnd, fragment.x + fragment.width);
  }
  return text.replace(/\s+/g, " ").trim();
}

function sameTextDirection(left: TextFragment | undefined, right: TextFragment): boolean {
  if (!left) return true;
  return Math.abs(left.angle - right.angle) <= 8;
}

function markLineRoles(lines: TextLine[], pageWidth: number, pageHeight: number): void {
  const medianFont = Math.max(median(lines.map((line) => line.fontSize)), 10);
  const tableXStops = repeatedXStops(lines);
  for (const line of lines) {
    const words = line.text.split(/\s+/).filter(Boolean).length;
    const largeGaps = countLargeFragmentGaps(line, medianFont);
    const alignedFragments = line.fragments.filter((fragment) => tableXStops.has(roundTo(fragment.x, 6))).length;
    line.isTable =
      (line.fragments.length >= 3 && largeGaps >= 2) ||
      (line.fragments.length >= 2 && alignedFragments >= 2 && /\d/.test(line.text) && line.width > pageWidth * 0.35);
    line.isFootnote =
      !line.isTable &&
      line.y < pageHeight * 0.23 &&
      (line.fontSize <= medianFont * 0.88 || /^\s*(\d+|[*])[\s.)-]/.test(line.text));
    line.isHeading =
      !line.isTable &&
      !line.isFootnote &&
      words <= 14 &&
      line.text.length <= 140 &&
      (line.fontSize >= medianFont * 1.22 || (line.fontSize >= 14 && line.y > pageHeight * 0.62));
  }
}

function repeatedXStops(lines: TextLine[]): Set<number> {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const seen = new Set<number>();
    for (const fragment of line.fragments) {
      seen.add(roundTo(fragment.x, 6));
    }
    for (const x of seen) counts.set(x, (counts.get(x) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= 3).map(([x]) => x));
}

function countLargeFragmentGaps(line: TextLine, medianFont: number): number {
  let gaps = 0;
  for (let index = 1; index < line.fragments.length; index += 1) {
    const previous = line.fragments[index - 1];
    const current = line.fragments[index];
    if (current.x - (previous.x + previous.width) > medianFont * 1.8) gaps += 1;
  }
  return gaps;
}

function detectRepeatedHeaderFooterKeys(pages: PageAnalysis[]): Set<string> {
  if (pages.length < 3) return new Set();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const pageKeys = new Set<string>();
    for (const line of page.lines) {
      if (!inHeaderFooterZone(line, page)) continue;
      const key = headerFooterKey(line.text);
      if (!key) continue;
      pageKeys.add(key);
    }
    for (const key of pageKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * HEADER_FOOTER_PAGE_RATIO));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
}

function isHighConfidenceHeaderFooter(line: TextLine, page: PageAnalysis, repeatedKeys: Set<string>): boolean {
  if (!inHeaderFooterZone(line, page)) return false;
  const key = headerFooterKey(line.text);
  return Boolean(key && repeatedKeys.has(key));
}

function inHeaderFooterZone(line: TextLine, page: PageAnalysis): boolean {
  const top = line.y + line.height;
  return top >= page.height * 0.9 || line.y <= page.height * 0.1;
}

function headerFooterKey(text: string): string | null {
  const normalized = normalizePdfText(text)
    .toLowerCase()
    .replace(/\bpage\s+\d+(\s+of\s+\d+)?\b/g, "page #")
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letterCount = (normalized.match(/\p{L}/gu) ?? []).length;
  return letterCount >= 5 || (letterCount >= 4 && normalized.includes("#")) ? normalized : null;
}

function orderLinesForReading(page: PageAnalysis, lines: TextLine[]): TextLine[] {
  const topSorted = [...lines].sort((a, b) => (Math.abs((b.y + b.height) - (a.y + a.height)) > 4 ? b.y - a.y : a.x - b.x));
  const ordered: TextLine[] = [];
  let segment: TextLine[] = [];

  const flush = () => {
    if (segment.length) {
      ordered.push(...orderSegment(page, segment));
      segment = [];
    }
  };

  for (const line of topSorted) {
    if (line.isHeading || isWideLine(line, page.width)) {
      flush();
      ordered.push(line);
    } else {
      segment.push(line);
    }
  }
  flush();
  return ordered;
}

function orderSegment(page: PageAnalysis, segment: TextLine[]): TextLine[] {
  const sorted = [...segment].sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
  const tableRatio = sorted.filter((line) => line.isTable).length / Math.max(sorted.length, 1);
  if (sorted.length < 4 || tableRatio > 0.3) return sorted;

  const candidates = sorted.filter((line) => line.width < page.width * 0.58 && !line.isTable);
  if (candidates.length < 4) return sorted;
  const centers = candidates.map((line) => line.x + line.width / 2).sort((a, b) => a - b);
  let bestGap = 0;
  let splitIndex = -1;
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index] - centers[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitIndex = index;
    }
  }
  if (splitIndex < 2 || centers.length - splitIndex < 2 || bestGap < page.width * 0.16) return sorted;

  const threshold = (centers[splitIndex - 1] + centers[splitIndex]) / 2;
  const left: TextLine[] = [];
  const right: TextLine[] = [];
  for (const line of sorted) {
    const center = line.x + line.width / 2;
    if (center <= threshold) {
      line.column = 1;
      left.push(line);
    } else {
      line.column = 2;
      right.push(line);
    }
  }
  const byReading = (a: TextLine, b: TextLine) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x);
  return [...left.sort(byReading), ...right.sort(byReading)];
}

function isWideLine(line: TextLine, pageWidth: number): boolean {
  return line.width >= pageWidth * 0.64 || (line.x <= pageWidth * 0.18 && line.x + line.width >= pageWidth * 0.76);
}

function reconstructParagraphBlocks(page: PageAnalysis, orderedLines: TextLine[]): ParagraphBlock[] {
  const medianFont = Math.max(median(orderedLines.map((line) => line.fontSize)), 10);
  const blocks: ParagraphBlock[] = [];
  let current: ParagraphBlock | null = null;

  const flush = () => {
    if (current && current.text.trim()) blocks.push(current);
    current = null;
  };

  for (const line of orderedLines) {
    const kind = lineKind(line);
    if (!current || shouldStartNewBlock(current, line, kind, medianFont)) {
      flush();
      current = {
        kind,
        text: line.text,
        bbox: { ...line.bbox },
        lines: [line]
      };
      continue;
    }

    current.text = appendLineToBlock(current, line);
    current.bbox = unionBoxes([current.bbox, line.bbox]);
    current.lines.push(line);
  }
  flush();
  return blocks;
}

function lineKind(line: TextLine): ParagraphBlock["kind"] {
  if (line.isHeading) return "heading";
  if (line.isTable) return "table";
  if (line.isFootnote) return "footnote";
  return "paragraph";
}

function shouldStartNewBlock(
  current: ParagraphBlock,
  line: TextLine,
  nextKind: ParagraphBlock["kind"],
  medianFont: number
): boolean {
  if (current.kind !== nextKind) return true;
  if (current.kind === "heading") return true;
  const previous = current.lines[current.lines.length - 1];
  if (!previous) return false;
  if (previous.column && line.column && previous.column !== line.column) return true;
  if (current.kind === "table") return previous.y - line.y > medianFont * 1.9;
  if (current.kind === "footnote") return previous.y - line.y > medianFont * 1.35;

  const baselineGap = previous.y - line.y;
  if (baselineGap > medianFont * 1.48) return true;
  const indentShift = Math.abs(line.x - current.lines[0].x);
  if (indentShift > medianFont * 2.2 && /[.!?:;)]$/.test(previous.text)) return true;
  return false;
}

function appendLineToBlock(block: ParagraphBlock, line: TextLine): string {
  if (block.kind === "table") return `${block.text}\n${line.text}`;
  if (block.kind === "footnote") return `${block.text} ${line.text}`.replace(/\s+/g, " ").trim();
  return joinParagraphLines(block.text, line.text);
}

function joinParagraphLines(previous: string, next: string): string {
  if (/[A-Za-z]-$/.test(previous) && /^[a-z]/.test(next)) {
    return `${previous.slice(0, -1)}${next}`.replace(/\s+/g, " ").trim();
  }
  return `${previous} ${next}`.replace(/\s+/g, " ").trim();
}

async function detectVisualPage(pdfjs: PdfJs, page: any, lines: TextLine[], pageArea: number): Promise<VisualDetection> {
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
      ops.paintFormXObjectBegin,
      ops.paintFormXObjectEnd
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
  const tableLineCount = lines.filter((line) => line.isTable).length;
  const rotatedLineCount = lines.filter((line) => line.hasRotatedText).length;
  const uniqueX = new Set(lines.flatMap((line) => line.fragments.map((fragment) => roundTo(fragment.x, 8)))).size;
  const reasons: string[] = [];
  let score = 0;

  if (rasterCount > 0 && textCoverage < 0.25) {
    score += 3;
    reasons.push("contains raster imagery with limited text coverage");
  }
  if (rasterCount > 0 && charCount < 90) {
    score += 3;
    reasons.push("may be scanned or image-dominant");
  }
  if (vectorCount >= 34) {
    score += 3;
    reasons.push("contains dense vector drawing or chart-like geometry");
  } else if (vectorCount >= 14 && lines.length <= 24) {
    score += 2;
    reasons.push("contains positioned vector graphics with sparse text");
  }
  if (tableLineCount >= 4 && (vectorCount >= 8 || uniqueX >= 12)) {
    score += 2;
    reasons.push("contains a complex table region");
  }
  if (rotatedLineCount > 0 || Number(page.rotate ?? 0) !== 0) {
    score += 2;
    reasons.push("contains rotated content");
  }
  if (textCoverage < 0.04 && rasterCount + vectorCount > 0) {
    score += 2;
    reasons.push("contains large non-text regions");
  }
  if (lines.length > 48 && uniqueX > 20) {
    score += 1;
    reasons.push("contains dense positioning");
  }

  const uncertain =
    score >= 2 ||
    (rasterCount > 0 && textCoverage < 0.34) ||
    (vectorCount >= 10 && charCount < 220) ||
    (tableLineCount >= 4 && textCoverage < 0.18);
  const include = score >= 3 || uncertain;
  const reason = reasons.length ? reasons.join("; ") : null;
  return {
    include,
    reason: include && reason ? `${score < 3 ? "low-confidence visual classification: " : ""}${reason}` : null,
    lowConfidence: include && score < 3
  };
}

function extractionWarnings(pageNumber: number, lines: TextLine[], visualDetection: VisualDetection): string[] {
  const warnings: string[] = [];
  const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);
  if (lines.length === 0) {
    warnings.push(`Page ${pageNumber} has no extractable text; use the visual supplement if generated.`);
  } else if (charCount < 80 && visualDetection.include) {
    warnings.push(`Page ${pageNumber} has low-confidence text extraction; verify against the visual supplement.`);
  }
  if (visualDetection.lowConfidence) {
    warnings.push(`Page ${pageNumber} was included in the visual supplement because visual classification was uncertain.`);
  }
  return warnings;
}

function shouldIncludeVisualPage(page: PageAnalysis, options: PdfExtractionOptions): boolean {
  return (
    options.mode === "text-all-pages" ||
    Boolean(options.forceVisualSupplement) ||
    (options.mode === "text-visual" && page.visualDetection.include)
  );
}

function visualReason(page: PageAnalysis, options: PdfExtractionOptions): string {
  if (options.mode === "text-all-pages") return "Full visual reference requested.";
  if (options.forceVisualSupplement && !page.visualDetection.reason) return "Visual supplement forced.";
  return page.visualDetection.reason ?? "Visual supplement forced.";
}

function drawSupplementIndexPage(input: {
  indexPage: any;
  font: any;
  bold: any;
  sourcePath: string;
  selectedOriginalPages: number[];
  pageIndex: number;
  indexPageCount: number;
}): void {
  const { indexPage, font, bold, sourcePath, selectedOriginalPages, pageIndex, indexPageCount } = input;
  indexPage.drawText("HL Intelligence Visual Supplement", {
    x: 48,
    y: 742,
    size: 16,
    font: bold,
    color: rgb(0, 0.156, 0.333)
  });
  indexPage.drawText(`Source filename: ${safePdfText(path.basename(sourcePath), 78)}`, {
    x: 48,
    y: 714,
    size: 10,
    font,
    color: rgb(0.18, 0.2, 0.24)
  });
  indexPage.drawText(`Index page ${pageIndex + 1} of ${indexPageCount}`, {
    x: 48,
    y: 698,
    size: 9,
    font,
    color: rgb(0.3, 0.33, 0.38)
  });
  indexPage.drawText("Supplement page -> original PDF page", {
    x: 48,
    y: 670,
    size: 10,
    font: bold,
    color: rgb(0.18, 0.2, 0.24)
  });

  const first = pageIndex * INDEX_ENTRIES_PER_PAGE;
  const entries = selectedOriginalPages.slice(first, first + INDEX_ENTRIES_PER_PAGE);
  entries.forEach((pageNumber, offset) => {
    const supplementPage = indexPageCount + first + offset + 1;
    const y = 648 - offset * 14;
    indexPage.drawText(`${supplementPage} -> source page ${pageNumber}`, {
      x: 48,
      y,
      size: 9.5,
      font,
      color: rgb(0.18, 0.2, 0.24)
    });
  });
}

function normalizePdfText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safePdfText(value: string, maxLength: number): string {
  const normalized = value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeAngle(angle: number): number {
  let current = angle;
  while (current <= -180) current += 360;
  while (current > 180) current -= 360;
  return current;
}

function unionBoxes(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x: round2(minX),
    y: round2(minY),
    width: round2(maxX - minX),
    height: round2(maxY - minY)
  };
}

function median(values: number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
