// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/renderer/App";
import type { AppApi } from "../src/shared/types";

describe("application shell", () => {
  beforeEach(() => {
    window.hl = {
      selectDocument: vi.fn(),
      selectDocuments: vi.fn(),
      selectJsonFile: vi.fn(),
      selectFolder: vi.fn(),
      getDroppedFilePath: vi.fn(),
      getMetadata: vi.fn(),
      prepareReview: vi.fn(),
      validateClaudeResult: vi.fn(),
      createCommentedPdf: vi.fn(),
      generatePreflight: vi.fn(),
      cancelJob: vi.fn(),
      buildSkillZip: vi.fn(),
      openPath: vi.fn(),
      copyText: vi.fn(),
      readTextFile: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({}),
      saveSettings: vi.fn(),
      notifyInitialUiReady: vi.fn(),
      onProgress: vi.fn().mockReturnValue(() => undefined)
    } as unknown as AppApi;
  });

  it("renders exactly two primary tabs and the local-processing statement", async () => {
    render(<App />);
    expect(screen.getByText("Processed locally. No documents are uploaded by HL Intelligence.")).toBeTruthy();
    const tabs = within(screen.getByLabelText("Primary")).getAllByRole("button");
    expect(tabs).toHaveLength(2);
  });

  it("routes Commenter file, folder, and JSON browse controls through the preload API", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /browse document or drop a pdf/i }));
    expect(window.hl.selectDocument).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: /^browse$/i })[0]);
    expect(window.hl.selectFolder).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /create commented file/i }));
    fireEvent.click(screen.getByRole("button", { name: /browse for hl_comments\.json/i }));
    expect(window.hl.selectJsonFile).toHaveBeenCalledTimes(1);
  });

  it("routes LLM Preflight file and folder browse controls through the preload API", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /llm preflight/i }));
    fireEvent.click(screen.getByRole("button", { name: /^browse files$/i }));
    expect(window.hl.selectDocuments).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: /^browse$/i })[0]);
    expect(window.hl.selectFolder).toHaveBeenCalledTimes(1);
  });
});
