import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { brandTokens } from "../src/shared/brandTokens";
import { buildSkillZip } from "../src/engine/skillZip";
import { createCommentedPdf } from "../src/engine/pdfComments";
import { writeFileAtomic } from "../src/engine/fileSafety";
import { sha256File } from "../src/engine/hash";
import { extractJsonObject } from "../src/engine/jsonImport";
import { extractPdf, loadPdfPageCount, visualSupplementIndexPageCount, writeVisualSupplementPdf } from "../src/engine/pdfAdapter";
import { generatePreflightFiles } from "../src/engine/preflight";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import { validateReviewConfig } from "../src/engine/schemaValidation";
import { renderComment } from "../src/engine/template";
import type { ClaudeResult, LocalReviewJob } from "../src/shared/types";
import {
  createCorruptPdf,
  createBookmarkedPdf,
  createComplexTablePdf,
  createCropBoxPdf,
  createHyphenatedPdf,
  createLongUnicodeFilenamePdf,
  createManyVisualPagesPdf,
  createMixedTextChartPdf,
  createMultiColumnPdf,
  createPasswordProtectedStub,
  createPdfWithFormField,
  createPdfWithExistingAnnotation,
  createRasterImagePdf,
  createRepeatedHeaderFooterPdf,
  createRotatedPdf,
  createScannedPdf,
  createSignatureLikePdf,
  createTextPdf,
  createVectorChartPdf,
  createVisualPdf
} from "./fixtures";

describe("PDF engine", () => {
  it("extracts anchored Markdown for a text-only PDF", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const sourceHash = await sha256File(source);
    const result = await extractPdf(source, { mode: "text-only", sourceHash, createdAt: "2026-06-21T00:00:00.000Z" });

    expect(result.totalPages).toBe(1);
    expect(result.markdown).toContain("<!-- HL:p0001:b0001 -->");
    expect(result.markdown).toContain("Revenue increased by 14.2%");
    expect(result.visualPages).toEqual([]);
    expect(Object.keys(result.sourceMap.anchors).length).toBeGreaterThan(1);
  });

  it("reconstructs paragraphs, repairs conservative hyphenation, and preserves multi-column reading order", async () => {
    const dir = await tempDir();
    const hyphenated = await createHyphenatedPdf(dir);
    const hyphenatedResult = await extractPdf(hyphenated, { mode: "text-only", sourceHash: await sha256File(hyphenated) });

    expect(hyphenatedResult.markdown).toContain("Revenue increased by 14.2%");
    expect(hyphenatedResult.markdown).not.toContain("in-\ncreased");

    const multiColumn = await createMultiColumnPdf(dir);
    const multiColumnResult = await extractPdf(multiColumn, { mode: "text-only", sourceHash: await sha256File(multiColumn) });
    expect(multiColumnResult.markdown.indexOf("Left column closes before the right column.")).toBeLessThan(
      multiColumnResult.markdown.indexOf("Right column begins after the left column")
    );
    expect(blockAnchors(multiColumnResult.sourceMap.anchors).length).toBeLessThan(7);
  });

  it("removes only high-confidence repeated headers and footers", async () => {
    const dir = await tempDir();
    const source = await createRepeatedHeaderFooterPdf(dir);
    const result = await extractPdf(source, { mode: "text-only", sourceHash: await sha256File(source) });

    expect(result.markdown).not.toContain("HL Confidential Review Draft");
    expect(result.markdown).not.toContain("Page 1 of 3");
    expect(result.markdown).toContain("Page 1 body paragraph keeps unique source content.");
    expect(result.markdown).toContain("repeated header/footer line(s) omitted");
  });

  it("keeps complex table regions compact and source-linked", async () => {
    const dir = await tempDir();
    const source = await createComplexTablePdf(dir);
    const result = await extractPdf(source, { mode: "text-visual", sourceHash: await sha256File(source) });
    const tableBlock = Object.values(result.sourceMap.anchors).find((anchor) => anchor.text.includes("Revenue $100.0 $112.5 $126.2"));

    expect(tableBlock).toBeTruthy();
    expect(result.markdown).toContain("Revenue $100.0 $112.5 $126.2");
    expect(result.visualPages.some((page) => page.reason.includes("table"))).toBe(true);
  });

  it("detects vector and raster visual pages without relying only on image count", async () => {
    const dir = await tempDir();
    const source = await createVisualPdf(dir);
    const result = await extractPdf(source, { mode: "text-visual", sourceHash: await sha256File(source) });

    expect(result.visualPages.length).toBeGreaterThanOrEqual(2);
    expect(result.visualPages.some((page) => page.reason.includes("vector"))).toBe(true);
    expect(result.visualPages.some((page) => page.reason.includes("raster") || page.reason.includes("visually"))).toBe(true);
  });

  it("classifies vector, raster, mixed, table, scanned, and rotated pages as visual when uncertain", async () => {
    const dir = await tempDir();
    const fixtures = [
      { source: await createVectorChartPdf(dir), expected: /vector|chart/i },
      { source: await createRasterImagePdf(dir), expected: /raster|image/i },
      { source: await createMixedTextChartPdf(dir), expected: /vector|chart|graphics/i },
      { source: await createComplexTablePdf(dir, "visual-table.pdf"), expected: /table/i },
      { source: await createScannedPdf(dir), expected: /scanned|image|raster/i },
      { source: await createRotatedPdf(dir, "visual-rotated.pdf"), expected: /rotated/i }
    ];

    for (const fixture of fixtures) {
      const result = await extractPdf(fixture.source, { mode: "text-visual", sourceHash: await sha256File(fixture.source) });
      expect(result.visualPages.length).toBeGreaterThanOrEqual(1);
      expect(result.visualPages[0].reason).toMatch(fixture.expected);
    }
  });

  it("generates a visual supplement with multiple complete index pages", async () => {
    const dir = await tempDir();
    const source = await createManyVisualPagesPdf(dir, 48);
    const result = await extractPdf(source, { mode: "text-visual", sourceHash: await sha256File(source) });
    const selectedPages = result.visualPages.map((page) => page.page);
    const supplementPath = await writeVisualSupplementPdf(source, selectedPages, path.join(dir, "many-visuals.pdf"));

    expect(supplementPath).toBeTruthy();
    expect(result.visualPages.length).toBe(48);
    const indexPages = visualSupplementIndexPageCount(result.visualPages.length);
    expect(indexPages).toBeGreaterThan(1);
    expect(result.visualPages[0].supplementPage).toBe(indexPages + 1);
    expect(result.visualPages[47].supplementPage).toBe(indexPages + 48);
    await expect(loadPdfPageCount(supplementPath!)).resolves.toBe(indexPages + 48);
    expect(await pdfPageText(supplementPath!, 1)).toContain("Source filename: many-visual-pages.pdf");
    expect(await pdfPageText(supplementPath!, 2)).toContain("source page 43");
  });

  it("handles rotated pages and existing annotations in synthetic PDFs", async () => {
    const dir = await tempDir();
    const rotated = await createRotatedPdf(dir);
    const annotated = await createPdfWithExistingAnnotation(dir);

    await expect(loadPdfPageCount(rotated)).resolves.toBe(1);
    await expect(loadPdfPageCount(annotated)).resolves.toBe(1);
  });

  it("rejects corrupt and password-protected PDFs", async () => {
    const dir = await tempDir();
    const corrupt = await createCorruptPdf(dir);
    const password = await createPasswordProtectedStub(dir);

    await expect(loadPdfPageCount(corrupt)).rejects.toThrow();
    await expect(loadPdfPageCount(password)).rejects.toThrow(/Password-protected/);
  });

  it("generates a review package with schema-valid config and local source map", async () => {
    const dir = await tempDir();
    const source = await createVisualPdf(dir, "Example 10K.pdf");
    const output = path.join(dir, "out");

    const result = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: output,
      reviewInstructions: "Check all stated values for consistency.",
      style: {
        wording_mode: "guided",
        signals: ["concise", "evidence-first"],
        formality: "professional",
        max_words: 40,
        format_template: "[{value}] {comment} - Page {page}/{total_pages}",
        examples: ["Please confirm this value against the summary table."]
      }
    });

    expect(await exists(result.markdownPath)).toBe(true);
    expect(await exists(result.reviewConfigPath)).toBe(true);
    expect(await exists(result.promptPath)).toBe(true);
    expect(await exists(result.localJobPath)).toBe(true);
    expect(result.visualPdfPath).toBeTruthy();

    const config = JSON.parse(await readFile(result.reviewConfigPath, "utf8"));
    expect((await validateReviewConfig(config)).ok).toBe(true);
    const localJob = JSON.parse(await readFile(result.localJobPath, "utf8")) as LocalReviewJob;
    expect(localJob.source_map.anchors["p0001:b0001"]).toBeTruthy();
  });

  it("handles long Unicode filenames in review and visual supplement output", async () => {
    const dir = await tempDir();
    const source = await createLongUnicodeFilenamePdf(dir);
    const result = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "{comment}",
        examples: []
      },
      forceVisualSupplement: true
    });

    expect(await exists(result.markdownPath)).toBe(true);
    expect(await exists(result.visualPdfPath!)).toBe(true);
    expect(await loadPdfPageCount(result.visualPdfPath!)).toBeGreaterThan(1);
  });

  it("validates Claude-style JSON and rejects mismatches or missing anchors", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "[{value}] {comment} - Page {page}/{total_pages}",
        examples: []
      }
    });
    const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
    const validJson = claudeResult(localJob, "p0001:b0002");

    const withFence = `Here is the file:\n\`\`\`json\n${JSON.stringify(validJson)}\n\`\`\``;
    const validation = await validateClaudeResultText(localJob, withFence);
    expect(validation.ignoredExtraText).toBe(true);
    expect(validation.summary.valid).toBe(1);
    expect(validation.ok).toBe(true);

    const wrongHash = await validateClaudeResultText(localJob, JSON.stringify({ ...validJson, source_sha256: "a".repeat(64) }));
    expect(wrongHash.ok).toBe(false);
    expect(wrongHash.errors.join(" ")).toMatch(/SHA-256/);

    const wrongRequest = await validateClaudeResultText(localJob, JSON.stringify({ ...validJson, request_id: "wrong-request" }));
    expect(wrongRequest.ok).toBe(false);
    expect(wrongRequest.errors.join(" ")).toMatch(/Request ID/);

    const missingAnchor = claudeResult(localJob, "p0001:b9999");
    const missing = await validateClaudeResultText(localJob, JSON.stringify(missingAnchor));
    expect(missing.summary.invalid).toBe(1);
  });

  it("validates evidence across normalized hyphenation, punctuation, currency, and percentage formatting", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "{comment}",
        examples: []
      }
    });
    const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
    const normalizedPercentage = claudeResult(localJob, "p0001:b0002", "Revenue in-\ncreased by 14.2 %");
    const normalizedCurrency = claudeResult(localJob, "p0001:b0003", "Adjusted EBITDA was $ 42.0 million.");

    expect((await validateClaudeResultText(localJob, JSON.stringify(normalizedPercentage))).summary.valid).toBe(1);
    expect((await validateClaudeResultText(localJob, JSON.stringify(normalizedCurrency))).summary.valid).toBe(1);

    const missingAnchor = claudeResult(localJob, "p0001:b9999", "Revenue increased by 14.2%");
    const missing = await validateClaudeResultText(localJob, JSON.stringify(missingAnchor));
    expect(missing.summary.invalid).toBe(1);
  });

  it("renders comment templates deterministically", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const sourceHash = await sha256File(source);
    const extracted = await extractPdf(source, { mode: "text-only", sourceHash });
    const finding = claudeResult(
      {
        request_id: "request",
        source: extracted.sourceMap.source,
        source_map: extracted.sourceMap
      } as LocalReviewJob,
      "p0001:b0002"
    ).findings[0];

    const comment = renderComment(
      finding,
      {
        wording_mode: "guided",
        signals: ["concise"],
        formality: "professional",
        max_words: 40,
        format_template: "[{value}] {comment} - Page {page}/{total_pages}",
        examples: []
      },
      extracted.sourceMap,
      "p0001:b0002"
    );

    expect(comment).toBe("[14.2%] Please confirm this percentage against the summary table. - Page 1/1");
  });

  it("creates a new commented PDF and preserves the original bytes", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const originalHash = await sha256File(source);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "[{value}] {comment} - Page {page}/{total_pages}",
        examples: []
      }
    });
    const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
    const result = await createCommentedPdf({
      sourcePath: source,
      localJobPath: packageResult.localJobPath,
      claudeJsonText: JSON.stringify(claudeResult(localJob, "p0001:b0002")),
      outputFolder: path.join(dir, "comments"),
      outputFilename: "commented.pdf"
    });

    expect(await sha256File(source)).toBe(originalHash);
    const pdf = await PDFDocument.load(await readFile(result.outputPath));
    expect(pdf.getPageCount()).toBe(1);
    const subtypeCounts = await annotationSubtypeCounts(result.outputPath);
    expect(subtypeCounts.get("/Highlight")).toBe(1);
    expect(subtypeCounts.get("/Text")).toBe(1);
    expect(await renderedPagesMatch(source, result.outputPath, "annotations-disabled")).toBe(true);
    expect(await exists(result.reportPath)).toBe(true);
  });

  it("preserves existing annotations and does not flatten highlights into page content", async () => {
    const dir = await tempDir();
    const source = await createPdfWithExistingAnnotation(dir);
    const sourceAnnotationCount = await pageAnnotationCount(source);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "{comment}",
        examples: []
      }
    });
    const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
    const result = await createCommentedPdf({
      sourcePath: source,
      localJobPath: packageResult.localJobPath,
      claudeJsonText: JSON.stringify(claudeResult(localJob, "p0001:b0002")),
      outputFolder: path.join(dir, "comments"),
      outputFilename: "commented-existing.pdf"
    });

    expect(await pageAnnotationCount(result.outputPath)).toBeGreaterThanOrEqual(sourceAnnotationCount + 2);
    expect(await renderedPagesMatch(source, result.outputPath, "annotations-disabled")).toBe(true);
    expect(await renderedPagesMatch(source, result.outputPath, "outside-annotation-regions")).toBe(true);
  });

  it("keeps rotated and crop-box annotation rectangles inside visible page bounds", async () => {
    const dir = await tempDir();
    const rotated = await createRotatedPdf(dir);
    const rotatedOutput = await commentedOutputFor(dir, rotated, "p0001:b0001", "Rotated page text");
    for (const rect of await annotationRects(rotatedOutput)) {
      expect(await rectInsideCropBox(rotatedOutput, rect)).toBe(true);
    }

    const cropped = await createCropBoxPdf(dir);
    const croppedOutput = await commentedOutputFor(dir, cropped, "p0001:b0002", "Revenue increased by 14.2%");
    for (const rect of await annotationRects(croppedOutput)) {
      expect(await rectInsideCropBox(croppedOutput, rect)).toBe(true);
    }
  });

  it("rejects signature-like PDFs before annotation", async () => {
    const dir = await tempDir();
    const source = await createSignatureLikePdf(dir);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "out"),
      reviewInstructions: "Check numbers.",
      style: {
        wording_mode: "automatic",
        signals: [],
        formality: "automatic",
        max_words: null,
        format_template: "{comment}",
        examples: []
      }
    });
    const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
    await expect(
      createCommentedPdf({
        sourcePath: source,
        localJobPath: packageResult.localJobPath,
        claudeJsonText: JSON.stringify(claudeResult(localJob, "p0001:b0002")),
        outputFolder: path.join(dir, "comments"),
        outputFilename: "blocked.pdf"
      })
    ).rejects.toThrow(/digital signature/i);
  });

  it("retains supported bookmarks and form fields during commented output verification", async () => {
    const dir = await tempDir();
    const bookmarked = await createBookmarkedPdf(dir);
    const bookmarkedOutput = await commentedOutputFor(dir, bookmarked, "p0001:b0002", "Revenue increased by 14.2%");
    expect(await outlineCount(bookmarkedOutput)).toBeGreaterThanOrEqual(1);

    const formPdf = await createPdfWithFormField(dir);
    const formOutput = await commentedOutputFor(dir, formPdf, "p0001:b0002", "Revenue increased by 14.2%");
    expect(await formFieldCount(formOutput)).toBeGreaterThanOrEqual(1);
  });

  it("runs a multi-file preflight queue with per-file errors and cancellation", async () => {
    const dir = await tempDir();
    const good = await createTextPdf(dir, "good.pdf");
    const bad = await createCorruptPdf(dir);
    const output = path.join(dir, "preflight");
    const progress: string[] = [];

    const results = await generatePreflightFiles(
      {
        jobId: "job-1",
        files: [
          { path: good, mode: "text-only" },
          { path: bad, mode: "text-visual" }
        ],
        outputFolder: output,
        options: {}
      },
      (event) => progress.push(`${event.stage}:${event.filePath ? path.basename(event.filePath) : ""}`),
      () => false
    );

    expect(results.map((result) => result.status)).toEqual(["complete", "error"]);
    expect(await exists(results[0].markdownPath)).toBe(true);
    expect(progress.some((item) => item.startsWith("complete"))).toBe(true);

    const cancelled = await generatePreflightFiles(
      {
        jobId: "job-2",
        files: [{ path: good, mode: "text-only" }],
        outputFolder: path.join(dir, "cancelled"),
        options: {}
      },
      () => undefined,
      () => true
    );
    expect(cancelled[0].status).toBe("cancelled");
  });

  it("cleans atomic-write temporary files after success", async () => {
    const dir = await tempDir();
    await writeFileAtomic(path.join(dir, "safe.txt"), "ok");
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("cleans atomic-write temporary files after failure", async () => {
    const dir = await tempDir();
    await expect(writeFileAtomic(dir, "not a file")).rejects.toThrow();
    const entries = await readdir(path.dirname(dir));
    expect(entries.some((entry) => entry.includes(path.basename(dir)) && entry.endsWith(".tmp"))).toBe(false);
  });

  it("builds the reusable Skill ZIP with the required structure", async () => {
    const result = await buildSkillZip(process.cwd());
    expect(result.entries).toContain("hl-commenter/SKILL.md");
    expect(result.entries).toContain("hl-commenter/references/review-output.schema.json");
    expect(result.entries).toContain("hl-commenter/references/review-config.schema.json");
  });

  it("extracts JSON objects from fenced or explained pasted text", () => {
    const extracted = extractJsonObject("Intro\n```json\n{\"ok\":true}\n```\nThanks");
    expect(extracted.jsonText).toBe("{\"ok\":true}");
    expect(extracted.ignoredExtraText).toBe(true);
  });

  it("exposes verified brand tokens from supplied brand materials", () => {
    expect(brandTokens.colors.oxfordBlue).toBe("#002855");
    expect(brandTokens.colors.sapphireBlue).toBe("#0067A5");
    expect(brandTokens.typography.officeFallbacks).toContain("Segoe UI");
  });
});

function claudeResult(localJob: LocalReviewJob, blockId: string, evidence = "Revenue increased by 14.2%"): ClaudeResult {
  return {
    schema_version: "1.0",
    request_id: localJob.request_id,
    source_sha256: localJob.source.sha256,
    findings: [
      {
        id: "C001",
        anchor: {
          kind: "pdf_block",
          page: 1,
          block_id: blockId
        },
        evidence,
        value: "14.2%",
        comment_body: "Please confirm this percentage against the summary table.",
        suggested_replacement: null,
        category: "numbers",
        severity: "medium",
        confidence: 0.93
      }
    ]
  };
}

function blockAnchors(anchors: LocalReviewJob["source_map"]["anchors"]) {
  return Object.values(anchors).filter((anchor) => anchor.kind === "pdf_block");
}

async function commentedOutputFor(dir: string, source: string, blockId: string, evidence: string): Promise<string> {
  const packageResult = await prepareReviewPackage({
    sourcePath: source,
    outputFolder: path.join(dir, `out-${path.basename(source)}`),
    reviewInstructions: "Check numbers.",
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "automatic",
      max_words: null,
      format_template: "{comment}",
      examples: []
    }
  });
  const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
  const result = await createCommentedPdf({
    sourcePath: source,
    localJobPath: packageResult.localJobPath,
    claudeJsonText: JSON.stringify(claudeResult(localJob, blockId, evidence)),
    outputFolder: path.join(dir, `comments-${path.basename(source)}`),
    outputFilename: "commented.pdf"
  });
  return result.outputPath;
}

async function pageAnnotationCount(filePath: string, pageIndex = 0): Promise<number> {
  const pdf = await PDFDocument.load(await readFile(filePath));
  const annots = (pdf.getPage(pageIndex) as any).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  return annots ? annots.size() : 0;
}

async function annotationSubtypeCounts(filePath: string, pageIndex = 0): Promise<Map<string, number>> {
  const pdf = await PDFDocument.load(await readFile(filePath));
  const annots = (pdf.getPage(pageIndex) as any).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const counts = new Map<string, number>();
  if (!annots) return counts;
  for (let index = 0; index < annots.size(); index += 1) {
    const annotation = annots.lookup(index) as any;
    const subtype = annotation.get(PDFName.of("Subtype"))?.toString() ?? "unknown";
    counts.set(subtype, (counts.get(subtype) ?? 0) + 1);
  }
  return counts;
}

async function annotationRects(filePath: string, pageIndex = 0): Promise<Array<[number, number, number, number]>> {
  const pdf = await PDFDocument.load(await readFile(filePath));
  const annots = (pdf.getPage(pageIndex) as any).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return [];
  const rects: Array<[number, number, number, number]> = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const annotation = annots.lookup(index) as any;
    const rect = annotation.lookup(PDFName.of("Rect"), PDFArray);
    rects.push([rect.lookup(0).asNumber(), rect.lookup(1).asNumber(), rect.lookup(2).asNumber(), rect.lookup(3).asNumber()]);
  }
  return rects;
}

async function rectInsideCropBox(filePath: string, rect: [number, number, number, number]): Promise<boolean> {
  const pdf = await PDFDocument.load(await readFile(filePath));
  const crop = pdf.getPage(0).getCropBox();
  const [x1, y1, x2, y2] = rect;
  return x1 >= crop.x && y1 >= crop.y && x2 <= crop.x + crop.width && y2 <= crop.y + crop.height;
}

async function pdfPageText(filePath: string, pageNumber: number): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    return textContent.items.map((item: any) => item.str).join(" ");
  } finally {
    await cleanupPdfJs(loadingTask, doc);
  }
}

async function outlineCount(filePath: string): Promise<number> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const outline = await doc.getOutline();
    return countOutline(outline);
  } finally {
    await cleanupPdfJs(loadingTask, doc);
  }
}

async function formFieldCount(filePath: string): Promise<number> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const fields = await doc.getFieldObjects();
    if (!fields) return 0;
    return Object.values(fields as Record<string, unknown>).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
      0
    );
  } finally {
    await cleanupPdfJs(loadingTask, doc);
  }
}

async function renderedPagesMatch(
  sourcePath: string,
  outputPath: string,
  mode: "annotations-disabled" | "outside-annotation-regions"
): Promise<boolean> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const annotationMode = mode === "annotations-disabled" ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE;
  const source = await renderPdfPage(sourcePath, annotationMode);
  const output = await renderPdfPage(outputPath, annotationMode);
  if (source.width !== output.width || source.height !== output.height) return false;
  const ignored = mode === "outside-annotation-regions" ? await renderedAnnotationRects(outputPath) : [];
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (ignored.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)) continue;
      const index = (y * source.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        if (Math.abs(source.data[index + channel] - output.data[index + channel]) > 2) return false;
      }
    }
  }
  return true;
}

async function renderPdfPage(filePath: string, annotationMode: number) {
  const canvasModule: any = await import("@napi-rs/canvas");
  (globalThis as any).DOMMatrix ??= canvasModule.DOMMatrix;
  (globalThis as any).ImageData ??= canvasModule.ImageData;
  (globalThis as any).Path2D ??= canvasModule.Path2D;
  const { createCanvas } = await import("@napi-rs/canvas/node-canvas");
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d") as any;
    await page.render({ canvasContext: context, canvas, viewport, annotationMode }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data as Uint8ClampedArray
    };
  } finally {
    await cleanupPdfJs(loadingTask, doc);
  }
}

async function renderedAnnotationRects(filePath: string): Promise<Box[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations({ intent: "display" });
    return annotations
      .filter((annotation: any) => Array.isArray(annotation.rect))
      .map((annotation: any) => {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
        const minX = Math.max(0, Math.floor(Math.min(x1, x2)) - 8);
        const minY = Math.max(0, Math.floor(Math.min(y1, y2)) - 8);
        const maxX = Math.min(Math.ceil(viewport.width), Math.ceil(Math.max(x1, x2)) + 8);
        const maxY = Math.min(Math.ceil(viewport.height), Math.ceil(Math.max(y1, y2)) + 8);
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      });
  } finally {
    await cleanupPdfJs(loadingTask, doc);
  }
}

async function cleanupPdfJs(loadingTask: any, doc: any): Promise<void> {
  if (typeof doc?.destroy === "function") await doc.destroy();
  else if (typeof loadingTask?.destroy === "function") await loadingTask.destroy();
  else if (typeof doc?.cleanup === "function") await doc.cleanup();
}

function countOutline(items: any): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + 1 + countOutline(item.items), 0);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hl-intelligence-test-"));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
