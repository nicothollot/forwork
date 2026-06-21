import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { brandTokens } from "../src/shared/brandTokens";
import { buildSkillZip } from "../src/engine/skillZip";
import { createCommentedPdf } from "../src/engine/pdfComments";
import { writeFileAtomic } from "../src/engine/fileSafety";
import { sha256File } from "../src/engine/hash";
import { extractJsonObject } from "../src/engine/jsonImport";
import { extractPdf, loadPdfPageCount } from "../src/engine/pdfAdapter";
import { generatePreflightFiles } from "../src/engine/preflight";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import { validateReviewConfig } from "../src/engine/schemaValidation";
import { renderComment } from "../src/engine/template";
import type { ClaudeResult, LocalReviewJob } from "../src/shared/types";
import {
  createCorruptPdf,
  createPasswordProtectedStub,
  createPdfWithExistingAnnotation,
  createRotatedPdf,
  createTextPdf,
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

  it("detects vector and raster visual pages without relying only on image count", async () => {
    const dir = await tempDir();
    const source = await createVisualPdf(dir);
    const result = await extractPdf(source, { mode: "text-visual", sourceHash: await sha256File(source) });

    expect(result.visualPages.length).toBeGreaterThanOrEqual(2);
    expect(result.visualPages.some((page) => page.reason.includes("vector"))).toBe(true);
    expect(result.visualPages.some((page) => page.reason.includes("raster") || page.reason.includes("visually"))).toBe(true);
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
    const annots = (pdf.getPage(0) as any).node.Annots();
    expect(annots).toBeTruthy();
    expect(await exists(result.reportPath)).toBe(true);
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

function claudeResult(localJob: LocalReviewJob, blockId: string): ClaudeResult {
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
        evidence: "Revenue increased by 14.2%",
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
