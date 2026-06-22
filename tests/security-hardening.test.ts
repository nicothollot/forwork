import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  TrustedPathRegistry,
  assertTrustedIpcSender,
  parsePreflightGenerateInput,
  parsePrepareReviewInput
} from "../src/main/ipcValidation";
import { verifyDocumentSignature, assertZipSafety } from "../src/engine/documentSignatures";
import { withNetworkBlockedForTests } from "../src/engine/networkGuard";
import { extractPdf } from "../src/engine/pdfAdapter";
import { extractPdfInWorker, terminateAllPdfWorkers } from "../src/engine/pdfWorkerClient";
import { generatePreflightFiles } from "../src/engine/preflight";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { createCommentedPdf } from "../src/engine/pdfComments";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import { sha256File } from "../src/engine/hash";
import type { ClaudeResult, LocalReviewJob } from "../src/shared/types";
import { createCorruptPdf, createTextPdf } from "./fixtures";

describe("Phase 7 hardening controls", () => {
  it("rejects IPC senders that are not the main window", () => {
    expect(() =>
      assertTrustedIpcSender({ senderId: 42, mainSenderId: 7, senderUrl: "file:///app/index.html" })
    ).toThrow(/did not originate/);
  });

  it("rejects invalid IPC payloads before engine dispatch", () => {
    expect(() => parsePrepareReviewInput({ sourcePath: "", outputFolder: "/out", reviewInstructions: "", style: {} })).toThrow(
      /sourcePath/
    );
    expect(() =>
      parsePreflightGenerateInput({ jobId: "job", outputFolder: "/out", files: [{ path: "/a.pdf", mode: "ocr" }], options: {} })
    ).toThrow(/mode/);
  });

  it("blocks path traversal and arbitrary openPath targets", () => {
    const registry = new TrustedPathRegistry();
    registry.registerOutputFolder("/approved/out");
    registry.registerInput("/approved/input/source.pdf");
    expect(() => registry.assertCanOpen("/approved/out/result.pdf")).not.toThrow();
    expect(() => registry.assertCanOpen("/approved/input/source.pdf")).not.toThrow();
    expect(() => registry.assertCanOpen("/approved/out/../secret.txt")).toThrow(/not allowed/);
  });

  it("rejects unsupported file signatures instead of trusting extensions", async () => {
    const dir = await tempDir();
    const fakePdf = path.join(dir, "fake.pdf");
    await writeFile(fakePdf, "not a pdf", "utf8");
    await expect(verifyDocumentSignature(fakePdf, "pdf")).rejects.toThrow(/PDF signature/);
  });

  it("enforces oversized JSON and excessive finding limits", async () => {
    const localJob = localPdfJob();
    const originalJsonLimit = process.env.HL_MAX_JSON_INPUT_BYTES;
    const originalFindingLimit = process.env.HL_MAX_FINDINGS;
    process.env.HL_MAX_JSON_INPUT_BYTES = "32";
    process.env.HL_MAX_FINDINGS = "1";
    try {
      const oversized = await validateClaudeResultText(localJob, "x".repeat(128));
      expect(oversized.ok).toBe(false);
      expect(oversized.errors.join(" ")).toMatch(/too large/i);

      process.env.HL_MAX_JSON_INPUT_BYTES = "4096";
      const excessive = await validateClaudeResultText(localJob, JSON.stringify(resultWithFindings(localJob, 2)));
      expect(excessive.ok).toBe(false);
      expect(excessive.errors.join(" ")).toMatch(/finding limit/i);
    } finally {
      restoreEnv("HL_MAX_JSON_INPUT_BYTES", originalJsonLimit);
      restoreEnv("HL_MAX_FINDINGS", originalFindingLimit);
    }
  });

  it("detects ZIP entry-count and decompression-ratio abuse", async () => {
    const many = new JSZip();
    many.file("a.txt", "a");
    many.file("b.txt", "b");
    const manyLoaded = await JSZip.loadAsync(await many.generateAsync({ type: "nodebuffer" }));
    expect(() => assertZipSafety(manyLoaded, { ...testLimits(), zipEntryCount: 1 })).toThrow(/ZIP entries/);

    const ratio = new JSZip();
    ratio.file("large.txt", "A".repeat(4096));
    const ratioLoaded = await JSZip.loadAsync(await ratio.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    expect(() => assertZipSafety(ratioLoaded, { ...testLimits(), zipDecompressionRatio: 1 })).toThrow(/compression ratio/);
  });

  it("blocks outbound network APIs during document processing tests", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    await withNetworkBlockedForTests(async () => {
      const extracted = await extractPdf(source, { mode: "text-only", sourceHash: await sha256File(source) });
      expect(extracted.totalPages).toBe(1);
    });
  });

  it("supports cancellation and worker cleanup for PDF processing", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    await expect(
      extractPdfInWorker(source, { mode: "text-only", sourceHash: await sha256File(source) }, () => undefined, () => true)
    ).rejects.toThrow(/cancelled/i);
    await expect(terminateAllPdfWorkers()).resolves.toBeUndefined();
  });

  it("cleans partial preflight output and can run again after cancellation", async () => {
    const dir = await tempDir();
    const good = await createTextPdf(dir, "good.pdf");
    const bad = await createCorruptPdf(dir);
    const outputFolder = path.join(dir, "out");
    const failed = await generatePreflightFiles(
      {
        jobId: "partial-failure",
        files: [{ path: bad, mode: "text-only" }],
        outputFolder,
        options: {}
      },
      () => undefined,
      () => false
    );
    expect(failed[0].status).toBe("error");
    expect(await safeReaddir(outputFolder)).not.toContain("corrupt");

    const cancelled = await generatePreflightFiles(
      {
        jobId: "cancelled",
        files: [{ path: good, mode: "text-only" }],
        outputFolder,
        options: {}
      },
      () => undefined,
      () => true
    );
    expect(cancelled[0].status).toBe("cancelled");

    const repeated = await generatePreflightFiles(
      {
        jobId: "repeat",
        files: [{ path: good, mode: "text-only" }],
        outputFolder,
        options: {}
      },
      () => undefined,
      () => false
    );
    expect(repeated[0].status).toBe("complete");
    await expect(stat(repeated[0].markdownPath)).resolves.toBeTruthy();
  });

  it("rejects comment application when the source changed after package creation", async () => {
    const dir = await tempDir();
    const source = await createTextPdf(dir);
    const packageResult = await prepareReviewPackage({
      sourcePath: source,
      outputFolder: path.join(dir, "package"),
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
    await writeFile(source, Buffer.concat([await readFile(source), Buffer.from("\n% changed\n")]));

    await expect(
      createCommentedPdf({
        sourcePath: source,
        localJobPath: packageResult.localJobPath,
        claudeJsonText: JSON.stringify(resultWithFindings(localJob, 1)),
        outputFolder: path.join(dir, "comments"),
        outputFilename: "changed.pdf"
      })
    ).rejects.toThrow(/does not match|changed/i);
  });
});

function localPdfJob(): LocalReviewJob {
  return {
    schema_version: "1.0",
    processing_version: "test",
    request_id: "request-1",
    created_at: "2026-06-22T00:00:00.000Z",
    source: {
      filename: "source.pdf",
      sha256: "b".repeat(64),
      document_type: "pdf",
      total_pages: 1
    },
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "automatic",
      max_words: null,
      format_template: "{comment}",
      examples: []
    },
    source_map: {
      schema_version: "1.0",
      processing_version: "test",
      source: {
        filename: "source.pdf",
        sha256: "b".repeat(64),
        document_type: "pdf",
        total_pages: 1
      },
      anchors: {
        "p0001:b0001": {
          anchorId: "p0001:b0001",
          kind: "pdf_block",
          anchor: { kind: "pdf_block", page: 1, block_id: "p0001:b0001" },
          page: 1,
          blockId: "p0001:b0001",
          text: "Revenue increased by 14.2%."
        }
      },
      visual_pages: []
    }
  };
}

function resultWithFindings(localJob: LocalReviewJob, count: number): ClaudeResult {
  return {
    schema_version: "1.0",
    request_id: localJob.request_id,
    source_sha256: localJob.source.sha256,
    findings: Array.from({ length: count }, (_, index) => ({
      id: `C${String(index + 1).padStart(3, "0")}`,
      anchor: { kind: "pdf_block", page: 1, block_id: "p0001:b0001" },
      evidence: "Revenue increased by 14.2%",
      comment_body: "Please confirm this percentage."
    }))
  };
}

function testLimits() {
  return {
    sourceFileBytes: 1024 * 1024,
    pdfPageCount: 100,
    sheetCount: 100,
    slideCount: 100,
    jsonInputBytes: 1024,
    findingCount: 100,
    zipEntryCount: 100,
    zipDecompressionRatio: 100,
    generatedOutputBytes: 1024 * 1024
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hl-security-"));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return readdir(dir);
  } catch {
    return [];
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
