import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { documentAdapterRegistry } from "../src/engine/documentAdapterRegistry";
import { documentSupportForPath, documentTypeForPath } from "../src/engine/documentDetection";
import { safeOutputPath, createCancellationController, createJobTempDirectory, FileMetadataCache, runFileTask } from "../src/engine/jobFoundation";
import { probeOfficeCapabilities } from "../src/engine/office/officeCapabilities";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import { resetSchemaCacheForTests, validateReviewOutput } from "../src/engine/schemaValidation";
import { sha256Bytes, sha256File } from "../src/engine/hash";
import { documentSupportForExtension } from "../src/shared/documentTypes";
import type { ClaudeResult, DocumentAnchor, LocalReviewJob, ReviewJob } from "../src/shared/types";

describe("shared document foundation", () => {
  it("registers PDF, Word, Excel, and PowerPoint adapters", () => {
    expect(documentAdapterRegistry.get("pdf")).toBeTruthy();
    expect(documentAdapterRegistry.get("docx")).toBeTruthy();
    expect(documentAdapterRegistry.get("docm")).toBeTruthy();
    expect(documentAdapterRegistry.get("xlsx")).toBeTruthy();
    expect(documentAdapterRegistry.get("xlsm")).toBeTruthy();
    expect(documentAdapterRegistry.get("pptx")).toBeTruthy();
    expect(documentAdapterRegistry.get("pptm")).toBeTruthy();
    expect(documentAdapterRegistry.registeredDocumentTypes()).toEqual(["pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm"]);
  });

  it("detects verified, legacy, and unsupported file types", () => {
    expect(documentTypeForPath("example.PDF")).toBe("pdf");
    expect(documentTypeForPath("model.xlsm")).toBe("xlsm");
    expect(documentSupportForPath("memo.docm").status).toBe("verified");
    expect(documentSupportForPath("model.xlsx").status).toBe("verified");
    expect(documentSupportForPath("deck.pptm").status).toBe("verified");
    expect(documentSupportForExtension(".doc").status).toBe("legacy-conversion-required");
    expect(documentSupportForExtension(".rtf").status).toBe("unsupported");
  });

  it("hashes bytes and files with SHA-256", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "hash.txt");
    await writeFile(filePath, "HL Intelligence", "utf8");
    expect(await sha256File(filePath)).toBe(sha256Bytes(Buffer.from("HL Intelligence")));
  });

  it("caches metadata by path, size, and modification time", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "cache.txt");
    await writeFile(filePath, "one", "utf8");
    const cache = new FileMetadataCache();
    let loadCount = 0;
    const first = await cache.get(filePath, async () => {
      loadCount += 1;
      return { value: "first" };
    });
    const second = await cache.get(filePath, async () => {
      loadCount += 1;
      return { value: "second" };
    });
    expect(first).toBe(second);
    expect(loadCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(filePath, "two", "utf8");
    const third = await cache.get(filePath, async () => {
      loadCount += 1;
      return { value: "third" };
    });
    expect(third).not.toBe(first);
    expect(loadCount).toBe(2);
  });

  it("serializes generic review jobs without losing source-map data", () => {
    const job: ReviewJob = localPdfJob();
    const parsed = JSON.parse(JSON.stringify(job)) as ReviewJob;
    expect(parsed.source.document_type).toBe("pdf");
    expect(parsed.source_map.anchors["p0001:b0001"].text).toContain("Revenue");
  });

  it("validates every required anchor type in hl_comments.json", async () => {
    resetSchemaCacheForTests();
    for (const anchor of anchorExamples()) {
      const result = resultWithAnchor(anchor);
      const validation = await validateReviewOutput(result);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    }

    const missingBlockId = resultWithAnchor({ kind: "pdf_block", page: 1 } as DocumentAnchor);
    const invalid = await validateReviewOutput(missingBlockId);
    expect(invalid.ok).toBe(false);
  });

  it("keeps old PDF review jobs compatible with validation", async () => {
    const localJob = localPdfJob();
    const result: ClaudeResult = resultWithAnchor({
      kind: "pdf_block",
      page: 1,
      block_id: "p0001:b0001"
    });
    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(true);
    expect(validation.summary.valid).toBe(1);
  });

  it("keeps safe output paths inside the selected folder", async () => {
    const dir = await tempDir();
    const outputPath = await safeOutputPath(dir, "../bad:name?.txt");
    expect(path.dirname(outputPath)).toBe(dir);
    expect(path.basename(outputPath)).not.toContain("..");
  });

  it("cleans job-scoped temporary directories", async () => {
    const temp = await createJobTempDirectory("cleanup-test");
    await writeFile(path.join(temp.path, "marker.txt"), "ok", "utf8");
    await temp.cleanup();
    await expect(stat(temp.path)).rejects.toThrow();
  });

  it("exposes cancellation contracts and per-file error isolation", async () => {
    const controller = createCancellationController();
    expect(controller.cancelled).toBe(false);
    controller.cancel();
    expect(controller.cancelled).toBe(true);
    expect(() => controller.throwIfCancelled()).toThrow("cancelled");

    const ok = await runFileTask("good.pdf", async () => "done");
    const failed = await runFileTask("bad.pdf", async () => {
      throw new Error("isolated");
    });
    expect(ok.status).toBe("complete");
    expect(failed).toMatchObject({ sourcePath: "bad.pdf", status: "error", error: "isolated" });
  });

  it("probes local Office capabilities through the worker client contract", async () => {
    const dir = await tempDir();
    const tempRoot = path.join(dir, "office-probe");
    const response = await probeOfficeCapabilities({
      powerShellPath: path.join(dir, "missing-powershell"),
      tempRoot,
      timeoutMs: 1000
    });
    expect(response.ok).toBe(false);
    expect(response.applications.word.available).toBe(false);
    await expect(stat(tempRoot)).rejects.toThrow();
  });

  it("returns a clear legacy Office conversion message", () => {
    const support = documentSupportForExtension(".ppt");
    expect(support.status).toBe("legacy-conversion-required");
    expect(support.message).toMatch(/conversion/i);
  });
});

function localPdfJob(): LocalReviewJob {
  return {
    schema_version: "1.0",
    processing_version: "test",
    request_id: "request-1",
    created_at: "2026-06-21T00:00:00.000Z",
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
          page: 1,
          blockId: "p0001:b0001",
          text: "Revenue increased by 14.2%."
        }
      },
      visual_pages: []
    }
  };
}

function resultWithAnchor(anchor: DocumentAnchor): ClaudeResult {
  return {
    schema_version: "1.0",
    request_id: "request-1",
    source_sha256: "b".repeat(64),
    findings: [
      {
        id: "C001",
        anchor,
        evidence: "Revenue increased by 14.2%.",
        comment_body: "Please confirm this value."
      }
    ]
  };
}

function anchorExamples(): DocumentAnchor[] {
  return [
    { kind: "pdf_block", page: 1, block_id: "p0001:b0001" },
    { kind: "pdf_page", page: 1 },
    { kind: "docx_paragraph", paragraph_id: "para-1", page: 1 },
    { kind: "docx_table_cell", table_id: "table-1", row: 1, column: 2, cell_id: "cell-1" },
    { kind: "xlsx_cell", sheet: "Sheet1", cell: "B4" },
    { kind: "xlsx_range", sheet: "Sheet1", range: "B4:D10" },
    { kind: "pptx_shape", slide: 3, slide_id: 257, shape_id: "shape-7" },
    { kind: "pptx_slide", slide: 3, slide_id: 257 }
  ];
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hl-foundation-"));
}
