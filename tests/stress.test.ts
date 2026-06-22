import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { documentAdapterRegistry } from "../src/engine/documentAdapterRegistry";
import { generatePreflightFiles } from "../src/engine/preflight";
import { sha256File } from "../src/engine/hash";
import { createCorruptPdf, createLongUnicodeFilenamePdf, createTextPdf } from "./fixtures";

const stressDescribe = process.env.HL_STRESS === "1" ? describe : describe.skip;

stressDescribe("runtime-generated stress profiles", () => {
  it("inspects and preflights a 500-page PDF without unbounded memory growth", async () => {
    const dir = await tempDir();
    const source = await createLargePdf(dir, 500);
    const adapter = documentAdapterRegistry.require("pdf");
    const before = memorySnapshot();
    const startedAt = performance.now();

    const inspection = await adapter.inspect({ sourcePath: source, includeHash: true });
    expect(inspection.counts.pages).toBe(500);
    expect(inspection.sha256).toBe(await sha256File(source));

    const results = await generatePreflightFiles({
      jobId: "stress-pdf-500",
      files: [{ path: source, mode: "text-only" }],
      outputFolder: path.join(dir, "preflight"),
      options: {}
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("complete");
    expect(await readFile(results[0].markdownPath, "utf8")).toContain("Revenue increased by 500.0%");

    await writeStressArtifact("pdf-500.json", {
      pages: 500,
      elapsedMs: Math.round(performance.now() - startedAt),
      before,
      after: memorySnapshot(),
      sourceBytes: (await stat(source)).size
    });
  }, 900000);

  it("keeps mixed-queue successes after duplicate filenames, unicode paths, long paths, cancellation, and partial failure", async () => {
    const dir = await tempDir();
    const files: string[] = [];
    for (let index = 0; index < 18; index += 1) {
      const folderName = index % 3 === 0
        ? `duplicate-${index}`
        : `unicode-${index}-cafe-会社-${"long".repeat(8)}`;
      const folder = path.join(dir, folderName);
      files.push(await createTextPdf(folder, index % 3 === 0 ? "duplicate.pdf" : `source-${index}.pdf`));
    }
    files.push(await createLongUnicodeFilenamePdf(path.join(dir, "unicode-source")));
    const corruptDir = path.join(dir, "corrupt-source");
    await mkdir(corruptDir, { recursive: true });
    files.push(await createCorruptPdf(corruptDir));

    const startedAt = performance.now();
    const progress: string[] = [];
    const results = await generatePreflightFiles(
      {
        jobId: "stress-mixed-queue",
        files: files.map((filePath) => ({ path: filePath, mode: "text-only" })),
        outputFolder: path.join(dir, "mixed-output"),
        options: {}
      },
      (event) => progress.push(`${event.stage}:${path.basename(event.filePath ?? "")}`),
      () => false
    );

    expect(results).toHaveLength(20);
    expect(results.filter((result) => result.status === "complete")).toHaveLength(19);
    expect(results.filter((result) => result.status === "error")).toHaveLength(1);
    expect(new Set(results.filter((result) => result.status === "complete").map((result) => result.outputFolder)).size).toBe(19);
    expect(progress.some((item) => item.startsWith("complete:"))).toBe(true);

    const cancelled = await generatePreflightFiles(
      {
        jobId: "stress-cancel",
        files: [{ path: files[0], mode: "text-only" }],
        outputFolder: path.join(dir, "cancel-output"),
        options: {}
      },
      () => undefined,
      () => true
    );
    expect(cancelled[0].status).toBe("cancelled");

    const repeated = await generatePreflightFiles({
      jobId: "stress-repeat",
      files: [{ path: files[0], mode: "text-only" }],
      outputFolder: path.join(dir, "repeat-output"),
      options: {}
    });
    expect(repeated[0].status).toBe("complete");

    await writeStressArtifact("mixed-queue.json", {
      files: files.length,
      completed: results.filter((result) => result.status === "complete").length,
      failed: results.filter((result) => result.status === "error").length,
      elapsedMs: Math.round(performance.now() - startedAt),
      memory: memorySnapshot()
    });
  }, 900000);
});

async function createLargePdf(dir: string, pageCount: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Stress page ${pageNumber}`, { x: 72, y: 720, size: 14, font });
    page.drawText(`Revenue increased by ${pageNumber}.0% during the period.`, { x: 72, y: 682, size: 11, font });
  }
  const filePath = path.join(dir, "stress-500-pages.pdf");
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

function memorySnapshot(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

async function writeStressArtifact(name: string, value: unknown): Promise<void> {
  const artifactDir = path.join(process.cwd(), "test-artifacts", "final-qa");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, name), JSON.stringify(value, null, 2), "utf8");
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hl-stress-"));
}
