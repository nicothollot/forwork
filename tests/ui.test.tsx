// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/renderer/App";
import type {
  AppApi,
  ClaudeValidationResult,
  FileMetadata,
  PreflightFileResult,
  ReviewJobFile,
  ReviewPackageResult
} from "../src/shared/types";

const pdfFile = file("Long client presentation name with several descriptive words and a version suffix.pdf", "pdf", "12 pages");
const reviewJob: ReviewJobFile = {
  path: "/reviews/Keep_Local/review-job.hlreview",
  name: "review-job.hlreview",
  requestId: "req-1",
  createdAt: "2026-06-22T12:00:00.000Z",
  sourceFilename: pdfFile.name,
  sourceSha256: "sha-1",
  documentType: "pdf"
};

const packageResult: ReviewPackageResult = {
  requestId: "req-1",
  sourceHash: "sha-1",
  outputRoot: "/out/review",
  uploadFolder: "/out/review/Upload_to_Claude",
  keepLocalFolder: "/out/review/Keep_Local",
  markdownPath: "/out/review/Upload_to_Claude/source.md",
  visualPdfPath: null,
  reviewConfigPath: "/out/review/Upload_to_Claude/review-config.json",
  promptPath: "/out/review/Upload_to_Claude/PROMPT_TO_COPY.txt",
  localJobPath: "/out/review/Keep_Local/review-job.hlreview",
  totalPages: 12,
  visualPages: []
};

describe("application shell", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.hl = mockApi();
  });

  it("renders exactly two primary tabs and the local-processing statement", async () => {
    render(<App />);
    expect(await screen.findByText("Processed locally. No documents are uploaded by HL Intelligence.")).toBeTruthy();
    const tabs = within(screen.getByLabelText("Primary")).getAllByRole("button");
    expect(tabs).toHaveLength(2);
  });

  it("selecting a review preset replaces instructions instead of appending duplicates", async () => {
    window.hl.selectDocument = vi.fn().mockResolvedValue(pdfFile);
    window.hl.selectFolder = vi.fn().mockResolvedValue("/out");
    window.hl.prepareReview = vi.fn().mockResolvedValue(packageResult);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /browse or drop document/i }));
    expect(await screen.findByText(pdfFile.name)).toBeTruthy();
    fireEvent.click(await screen.findByRole("radio", { name: /numbers and consistency/i }));
    fireEvent.click(screen.getByRole("radio", { name: /numbers and consistency/i }));
    fireEvent.click(screen.getByRole("button", { name: /^browse$/i }));
    await waitFor(() => expect(window.hl.selectFolder).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /create review package/i }));

    await waitFor(() => expect(window.hl.prepareReview).toHaveBeenCalledTimes(1));
    const input = vi.mocked(window.hl.prepareReview).mock.calls[0][0];
    expect(input.reviewInstructions).toBe(
      "Review numbers, dates, percentages, currencies, units, cross-references, and repeated values for internal consistency."
    );
  });

  it("persists and reapplies full style presets, including examples and maximum length", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Advanced"));
    fireEvent.change(screen.getByLabelText(/maximum comment length/i), { target: { value: "80" } });
    await waitFor(() => expect((screen.getByLabelText(/maximum comment length/i) as HTMLSelectElement).value).toBe("80"));
    fireEvent.change(screen.getByPlaceholderText(/example comment/i), { target: { value: "Use a tighter diligence phrasing." } });
    fireEvent.click(screen.getByRole("button", { name: /add example/i }));
    fireEvent.change(screen.getByPlaceholderText(/preset name/i), { target: { value: "Diligence style" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(window.hl.saveSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/maximum comment length/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    expect((screen.getByLabelText(/maximum comment length/i) as HTMLSelectElement).value).toBe("80");
    expect(screen.getByText("Use a tighter diligence phrasing.")).toBeTruthy();
  });

  it("collapses one-time Skill setup when installed state is persisted", async () => {
    window.hl.getSettings = vi.fn().mockResolvedValue({ skillInstalled: true });
    render(<App />);

    expect(await screen.findByText(/skill installed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save skill zip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /setup/i })).toBeTruthy();
  });

  it("resumes a review and automatically validates source hash and JSON changes", async () => {
    window.hl.selectReviewJobFile = vi.fn().mockResolvedValue(reviewJob);
    window.hl.selectDocument = vi.fn().mockResolvedValue(pdfFile);
    window.hl.selectJsonFile = vi.fn().mockResolvedValue({ path: "/in/hl_comments.json", name: "hl_comments.json", text: "{}" });
    window.hl.validateReviewSource = vi.fn().mockResolvedValue({
      ok: true,
      message: "Selected source matches the review job.",
      expectedSha256: "sha-1",
      actualSha256: "sha-1",
      sourceChanged: false
    });
    window.hl.validateClaudeResult = vi.fn().mockResolvedValue(validValidation());

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /resume existing review/i }));
    expect(await screen.findByText(reviewJob.name)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /browse or drop original/i }));
    expect(await screen.findByText(pdfFile.name)).toBeTruthy();
    const jsonSection = screen.getByText("Claude result JSON").closest("section") as HTMLElement;
    fireEvent.click(within(jsonSection).getByRole("button", { name: /^browse$/i }));

    await waitFor(() => expect(window.hl.validateReviewSource).toHaveBeenCalledWith({ localJobPath: reviewJob.path, sourcePath: pdfFile.path }));
    await waitFor(() => expect(window.hl.validateClaudeResult).toHaveBeenCalledWith({ localJobPath: reviewJob.path, jsonText: "{}" }));
    expect(await screen.findByText("Ready to apply")).toBeTruthy();
  });

  it("applies only approved findings after invalid findings are rejected", async () => {
    window.hl.getSettings = vi.fn().mockResolvedValue({ lastOutputFolder: "/out" });
    window.hl.selectReviewJobFile = vi.fn().mockResolvedValue(reviewJob);
    window.hl.selectDocument = vi.fn().mockResolvedValue(pdfFile);
    window.hl.selectJsonFile = vi.fn().mockResolvedValue({ path: "/in/hl_comments.json", name: "hl_comments.json", text: "{}" });
    window.hl.validateReviewSource = vi.fn().mockResolvedValue({
      ok: true,
      message: "Selected source matches the review job.",
      expectedSha256: "sha-1",
      actualSha256: "sha-1",
      sourceChanged: false
    });
    window.hl.validateClaudeResult = vi.fn().mockResolvedValue(mixedValidation());
    window.hl.createCommentedPdf = vi.fn().mockResolvedValue({ outputPath: "/out/source_commented.pdf", reportPath: "/out/report.json", summary: { valid: 1, attention: 0, invalid: 1 }, skipped: [] });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /resume existing review/i }));
    expect(await screen.findByText(reviewJob.name)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /browse or drop original/i }));
    expect(await screen.findByText(pdfFile.name)).toBeTruthy();
    const jsonSection = screen.getByText("Claude result JSON").closest("section") as HTMLElement;
    fireEvent.click(within(jsonSection).getByRole("button", { name: /^browse$/i }));
    expect((await screen.findAllByText("Needs review")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /reject all invalid/i }));
    await waitFor(() => expect(screen.getAllByText("Ready to apply").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /create commented file/i }));

    await waitFor(() => expect(window.hl.createCommentedPdf).toHaveBeenCalledTimes(1));
    const input = vi.mocked(window.hl.createCommentedPdf).mock.calls[0][0];
    expect(input.approvedFindings).toEqual([{ id: "f-valid", finalComment: "Please verify this number." }]);
  });

  it("supports a mixed-format Preflight queue without exposing OCR", async () => {
    window.hl.selectDocuments = vi.fn().mockResolvedValue([
      file("source.pdf", "pdf", "8 pages"),
      file("memo.docx", "docx", "4 pages"),
      file("model.xlsx", "xlsx", "6 sheets"),
      file("deck.pptx", "pptx", "20 slides")
    ]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /llm preflight/i }));
    fireEvent.click(screen.getByRole("button", { name: /^browse files$/i }));

    expect(await screen.findByText("source.pdf")).toBeTruthy();
    expect(screen.getByText("DOCX")).toBeTruthy();
    expect(screen.getByText("XLSX")).toBeTruthy();
    expect(screen.getByText("PPTX")).toBeTruthy();
    expect(screen.getAllByText(/Text \+ visual pages - Recommended/i)).toHaveLength(4);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByText(/include existing comments/i)).toBeTruthy();
    expect(screen.getByText(/force visual supplement/i)).toBeTruthy();
    expect(screen.queryByText(/OCR/i)).toBeNull();
    expect(document.querySelector(".queue-table")).toBeNull();
    expect(document.querySelectorAll(".preflight-card")).toHaveLength(4);
  });

  it("shows approximate Preflight result summaries and file-level error details", async () => {
    const result: PreflightFileResult = {
      sourcePath: pdfFile.path,
      outputFolder: "/out/source",
      markdownPath: "/out/source/source.md",
      visualPdfPath: "/out/source/source_visuals.pdf",
      manifestPath: "/out/source/source_manifest.json",
      status: "complete",
      summary: {
        originalSizeBytes: 10000,
        markdownSizeBytes: 2500,
        visualSupplementSizeBytes: 1200,
        approximateTokenEstimate: 625,
        approximateReductionPercent: 63,
        visualPageCount: 3,
        warningCount: 1
      }
    };
    window.hl.getSettings = vi.fn().mockResolvedValue({ lastOutputFolder: "/out" });
    window.hl.selectDocuments = vi.fn().mockResolvedValue([pdfFile]);
    window.hl.generatePreflight = vi.fn().mockResolvedValue([result]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /llm preflight/i }));
    fireEvent.click(screen.getByRole("button", { name: /^browse files$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^generate$/i }));

    expect(await screen.findByText("Approx. token estimate")).toBeTruthy();
    expect(screen.getByText("Approx. reduction")).toBeTruthy();
    expect(screen.getByText("Visual pages/slides")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /open folder/i }).length).toBeGreaterThan(0);
  });

  it("uses user-actionable error language with details collapsed", async () => {
    window.hl.getSettings = vi.fn().mockResolvedValue({ lastOutputFolder: "/out" });
    window.hl.selectDocuments = vi.fn().mockResolvedValue([pdfFile]);
    window.hl.generatePreflight = vi.fn().mockResolvedValue([
      {
        sourcePath: pdfFile.path,
        outputFolder: "/out",
        markdownPath: "",
        visualPdfPath: null,
        manifestPath: "",
        status: "error",
        error: "Unsupported encrypted file"
      }
    ]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /llm preflight/i }));
    fireEvent.click(screen.getByRole("button", { name: /^browse files$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^generate$/i }));

    expect(await screen.findByText(/source changed: no/i)).toBeTruthy();
    expect(screen.queryByText(/unsupported encrypted file/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/unsupported encrypted file/i)).toBeTruthy();
  });

  it("keeps keyboard-focusable controls for tab navigation", async () => {
    render(<App />);
    const preflightTab = await screen.findByRole("button", { name: /llm preflight/i });
    preflightTab.focus();
    expect(document.activeElement).toBe(preflightTab);
  });

  it("keeps accessible names, labels, announcements, and reduced-motion support", async () => {
    window.hl.getSettings = vi.fn().mockResolvedValue({ skillInstalled: true });
    render(<App />);

    const buttons = await screen.findAllByRole("button");
    expect(buttons.length).toBeGreaterThan(4);
    for (const button of buttons) {
      expect(button.textContent?.trim() || button.getAttribute("aria-label")).toBeTruthy();
    }

    expect(await screen.findByText(/skill installed/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByLabelText(/maximum comment length/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/example comment/i)).toBeTruthy();

    const styles = await readFile("src/renderer/styles.css", "utf8");
    const commonComponents = await readFile("src/renderer/components/common.tsx", "utf8");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(commonComponents).toContain('role="status"');
    expect(commonComponents).toContain('aria-live="polite"');
  });
});

function mockApi(): AppApi {
  return {
    selectDocument: vi.fn().mockResolvedValue(null),
    selectDocuments: vi.fn().mockResolvedValue([]),
    selectJsonFile: vi.fn().mockResolvedValue(null),
    selectReviewJobFile: vi.fn().mockResolvedValue(null),
    selectFolder: vi.fn().mockResolvedValue(null),
    getDroppedFilePath: vi.fn(),
    getMetadata: vi.fn().mockImplementation(async (path: string) => file(path.split(/[\\/]/).pop() || path, "pdf", "1 page")),
    validateReviewSource: vi.fn().mockResolvedValue({
      ok: true,
      message: "Selected source matches the review job.",
      expectedSha256: "sha-1",
      actualSha256: "sha-1",
      sourceChanged: false
    }),
    prepareReview: vi.fn().mockResolvedValue(packageResult),
    validateClaudeResult: vi.fn().mockResolvedValue(validValidation()),
    createCommentedPdf: vi.fn(),
    generatePreflight: vi.fn().mockResolvedValue([]),
    cancelJob: vi.fn(),
    buildSkillZip: vi.fn().mockResolvedValue({ zipPath: "/out/HL-Commenter-Skill.zip", entries: [] }),
    openPath: vi.fn(),
    copyText: vi.fn(),
    readTextFile: vi.fn().mockResolvedValue("{}"),
    getSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn(),
    notifyInitialUiReady: vi.fn(),
    onProgress: vi.fn().mockReturnValue(() => undefined)
  } as unknown as AppApi;
}

function file(name: string, type: FileMetadata["type"], countLabel: string): FileMetadata {
  return {
    path: `/documents/${name}`,
    name,
    extension: name.slice(name.lastIndexOf(".")),
    type,
    supportStatus: "verified",
    supportMessage: `${String(type).toUpperCase()} support is verified.`,
    sizeBytes: 123456,
    countLabel,
    count: Number(countLabel.match(/\d+/)?.[0] ?? 1),
    sha256: "sha-1"
  };
}

function validValidation(): ClaudeValidationResult {
  return {
    ok: true,
    ignoredExtraText: false,
    errors: [],
    validations: [
      {
        finding: {
          id: "f-valid",
          anchor: { kind: "pdf_page", page: 1 },
          evidence: "Revenue",
          comment_body: "Please verify this number."
        },
        status: "valid",
        renderedComment: "Please verify this number.",
        anchorId: "p0001:page"
      }
    ],
    summary: { valid: 1, attention: 0, invalid: 0 }
  };
}

function mixedValidation(): ClaudeValidationResult {
  return {
    ok: false,
    ignoredExtraText: false,
    errors: [],
    validations: [
      ...validValidation().validations,
      {
        finding: {
          id: "f-invalid",
          anchor: { kind: "pdf_block", page: 99, block_id: "missing" },
          evidence: "Missing",
          comment_body: "Invalid comment."
        },
        status: "invalid",
        reason: "Anchor was not found."
      }
    ],
    summary: { valid: 1, attention: 0, invalid: 1 }
  };
}
