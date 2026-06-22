import { contextBridge, ipcRenderer } from "electron";
import type {
  AppApi,
  AppSettings,
  ClaudeValidationResult,
  CreateCommentedPdfResult,
  FileMetadata,
  PreflightFileResult,
  PreflightGenerateInput,
  ProgressEvent,
  ReviewJobFile,
  ReviewPackageResult,
  ReviewSourceValidation
} from "../shared/types.js";

let settings: AppSettings = { skillInstalled: true, lastOutputFolder: "C:\\HL Intelligence QA\\Output" };
let selectDocumentsCallCount = 0;
const progressCallbacks = new Set<(event: ProgressEvent) => void>();

const source = visualFile("Board deck final.pdf", "pdf", "24 pages", "verified", "PDF support is verified.");
const reviewPackage: ReviewPackageResult = {
  requestId: "visual-qa-request",
  sourceHash: "visual-sha256",
  outputRoot: "C:\\HL Intelligence QA\\Review Package",
  uploadFolder: "C:\\HL Intelligence QA\\Review Package\\Upload_to_Claude",
  keepLocalFolder: "C:\\HL Intelligence QA\\Review Package\\Keep_Local",
  markdownPath: "C:\\HL Intelligence QA\\Review Package\\Upload_to_Claude\\Board deck final.md",
  visualPdfPath: "C:\\HL Intelligence QA\\Review Package\\Upload_to_Claude\\Board deck final visuals.pdf",
  reviewConfigPath: "C:\\HL Intelligence QA\\Review Package\\Upload_to_Claude\\review-config.json",
  promptPath: "C:\\HL Intelligence QA\\Review Package\\Upload_to_Claude\\PROMPT_TO_COPY.txt",
  localJobPath: "C:\\HL Intelligence QA\\Review Package\\Keep_Local\\review-job.hlreview",
  totalPages: 24,
  visualPages: [{ page: 3, supplementPage: 2, reason: "Chart or image requires visual review." }]
};
const reviewJob: ReviewJobFile = {
  path: reviewPackage.localJobPath,
  name: "review-job.hlreview",
  requestId: reviewPackage.requestId,
  createdAt: "2026-06-22T12:00:00.000Z",
  sourceFilename: source.name,
  sourceSha256: source.sha256 ?? "visual-sha256",
  documentType: "pdf"
};

const api: AppApi = {
  selectDocument: async () => source,
  selectDocuments: async () => {
    selectDocumentsCallCount += 1;
    if (selectDocumentsCallCount === 2) {
      return [
        visualFile(
          "legacy-board-book.doc",
          "unsupported",
          "Count unavailable",
          "legacy-conversion-required",
          "Legacy Office files require conversion to DOCX, XLSX, or PPTX before HL Intelligence can process them."
        )
      ];
    }
    if (selectDocumentsCallCount === 3) {
      return [
        visualFile(
          "office-unavailable.docx",
          "docx",
          "8 pages",
          "unsupported",
          "Microsoft Word was not detected. Install local Microsoft Word or convert this file on a machine with Office before processing."
        )
      ];
    }
    return [
      visualFile("board-book.pdf", "pdf", "18 pages", "verified", "PDF support is verified."),
      visualFile("investment-memo.docx", "docx", "9 pages", "verified", "DOCX support is verified when local Microsoft Word is installed."),
      visualFile("macro-model.xlsm", "xlsm", "11 sheets", "verified", "XLSM support is verified when local Microsoft Excel is installed."),
      visualFile("committee-deck.pptx", "pptx", "32 slides", "verified", "PPTX support is verified when local Microsoft PowerPoint is installed."),
      visualFile("macro-appendix.pptm", "pptm", "7 slides", "verified", "PPTM support is verified when local Microsoft PowerPoint is installed.")
    ];
  },
  selectJsonFile: async () => ({
    path: "C:\\HL Intelligence QA\\hl_comments.json",
    name: "hl_comments.json",
    text: JSON.stringify({ scenario: "valid" }, null, 2)
  }),
  selectReviewJobFile: async () => reviewJob,
  selectFolder: async () => "C:\\HL Intelligence QA\\Output",
  getDroppedFilePath: (file: File) => file.name,
  getMetadata: async (filePath: string) => visualFile(fileName(filePath), typeForName(filePath), countForName(filePath), "verified", "Support is verified."),
  validateReviewSource: async () => ({
    ok: true,
    expectedSha256: source.sha256 ?? "visual-sha256",
    actualSha256: source.sha256 ?? "visual-sha256",
    sourceChanged: false,
    message: "Selected source matches the review job."
  } satisfies ReviewSourceValidation),
  prepareReview: async () => reviewPackage,
  validateClaudeResult: async (input: { jsonText: string }) => validationForVisualQa(input.jsonText),
  createCommentedPdf: async () => ({
    outputPath: "C:\\HL Intelligence QA\\Output\\Board deck final_commented.pdf",
    reportPath: "C:\\HL Intelligence QA\\Output\\Board deck final_comment_report.json",
    summary: { valid: 2, attention: 0, invalid: 0 },
    skipped: []
  } satisfies CreateCommentedPdfResult),
  generatePreflight: async (input: PreflightGenerateInput) => {
    for (const file of input.files) {
      progressCallbacks.forEach((callback) =>
        callback({
          jobId: input.jobId,
          filePath: file.path,
          stage: "extracting",
          percent: 45,
          message: "Extracting locally"
        })
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 650));
    return input.files.map((file, index) => preflightResultForVisualQa(file.path, index === input.files.length - 1 && input.files.length > 1));
  },
  cancelJob: async () => undefined,
  buildSkillZip: async () => ({ zipPath: "C:\\HL Intelligence QA\\HL-Commenter-Skill.zip", entries: ["SKILL.md", "references/review-output.schema.json"] }),
  openPath: async () => undefined,
  copyText: async () => undefined,
  readTextFile: async () => "Use the attached review package and return hl_comments.json.",
  getSettings: async () => settings,
  saveSettings: async (next: AppSettings) => {
    settings = { ...settings, ...next };
  },
  notifyInitialUiReady: () => ipcRenderer.send("renderer:initial-ui-ready"),
  onProgress: (callback: (event: ProgressEvent) => void) => {
    progressCallbacks.add(callback);
    return () => progressCallbacks.delete(callback);
  }
};

contextBridge.exposeInMainWorld("hl", api);

function visualFile(
  name: string,
  type: FileMetadata["type"],
  countLabel: string,
  supportStatus: FileMetadata["supportStatus"],
  supportMessage: string
): FileMetadata {
  const count = Number(countLabel.match(/\d+/)?.[0] ?? 0) || undefined;
  return {
    path: `C:\\HL Intelligence QA\\Source Files\\${name}`,
    name,
    extension: name.match(/\.[^.]+$/)?.[0] ?? "",
    type,
    supportStatus,
    supportMessage,
    sizeBytes: 524_288,
    countLabel,
    count,
    sha256: "visual-sha256"
  };
}

function validationForVisualQa(jsonText: string): ClaudeValidationResult {
  if (/invalid/i.test(jsonText)) {
    return {
      ok: false,
      ignoredExtraText: false,
      errors: ["Finding f-invalid points to a missing anchor."],
      validations: [
        {
          finding: {
            id: "f-invalid",
            anchor: { kind: "pdf_block", page: 99, block_id: "missing" },
            evidence: "Missing anchor",
            comment_body: "This comment cannot be applied."
          },
          status: "invalid",
          reason: "Anchor was not found."
        }
      ],
      summary: { valid: 0, attention: 0, invalid: 1 }
    };
  }
  if (/attention/i.test(jsonText)) {
    return {
      ok: false,
      ignoredExtraText: false,
      errors: [],
      validations: [
        ...validVisualValidations(),
        {
          finding: {
            id: "f-attention",
            anchor: { kind: "pdf_page", page: 6 },
            evidence: "Revenue bridge",
            comment_body: "Confirm the bridge reconciles to the appendix."
          },
          status: "attention",
          renderedComment: "Confirm the bridge reconciles to the appendix.",
          anchorId: "p0006:page",
          reason: "Evidence is nearby but should be reviewed."
        }
      ],
      summary: { valid: 2, attention: 1, invalid: 0 }
    };
  }
  return {
    ok: true,
    ignoredExtraText: false,
    errors: [],
    result: {
      schema_version: "1.0",
      request_id: "visual-qa-request",
      source_sha256: "visual-sha256",
      findings: validVisualValidations().map((item) => item.finding)
    },
    validations: validVisualValidations(),
    summary: { valid: 2, attention: 0, invalid: 0 }
  };
}

function validVisualValidations(): ClaudeValidationResult["validations"] {
  return [
    {
      finding: {
        id: "f-valid-1",
        anchor: { kind: "pdf_block", page: 2, block_id: "p0002-b0004" },
        evidence: "$125.0 million",
        comment_body: "Confirm this value ties to the model output."
      },
      status: "valid",
      renderedComment: "Confirm this value ties to the model output.",
      anchorId: "p0002-b0004"
    },
    {
      finding: {
        id: "f-valid-2",
        anchor: { kind: "pdf_page", page: 4 },
        evidence: "Adjusted EBITDA",
        comment_body: "Confirm Adjusted EBITDA is consistently capitalized."
      },
      status: "valid",
      renderedComment: "Confirm Adjusted EBITDA is consistently capitalized.",
      anchorId: "p0004:page"
    }
  ];
}

function preflightResultForVisualQa(sourcePath: string, fail: boolean): PreflightFileResult {
  const baseName = fileName(sourcePath).replace(/\.[^.]+$/, "");
  if (fail) {
    return {
      sourcePath,
      outputFolder: `C:\\HL Intelligence QA\\Output\\${baseName}`,
      markdownPath: "",
      visualPdfPath: null,
      manifestPath: "",
      status: "error",
      error: "Synthetic visual QA partial-failure example."
    };
  }
  return {
    sourcePath,
    outputFolder: `C:\\HL Intelligence QA\\Output\\${baseName}`,
    markdownPath: `C:\\HL Intelligence QA\\Output\\${baseName}\\${baseName}.md`,
    visualPdfPath: `C:\\HL Intelligence QA\\Output\\${baseName}\\${baseName}_visuals.pdf`,
    manifestPath: `C:\\HL Intelligence QA\\Output\\${baseName}\\${baseName}_manifest.json`,
    status: "complete",
    summary: {
      originalSizeBytes: 524_288,
      markdownSizeBytes: 48_000,
      visualSupplementSizeBytes: 220_000,
      approximateTokenEstimate: 12_000,
      approximateReductionPercent: 66,
      visualPageCount: 4,
      warningCount: 1
    }
  };
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function typeForName(name: string): FileMetadata["type"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".docm")) return "docm";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".xlsm")) return "xlsm";
  if (lower.endsWith(".pptx")) return "pptx";
  if (lower.endsWith(".pptm")) return "pptm";
  if (lower.endsWith(".pdf")) return "pdf";
  return "unsupported";
}

function countForName(name: string): string {
  const type = typeForName(name);
  if (type === "xlsx" || type === "xlsm") return "5 sheets";
  if (type === "pptx" || type === "pptm") return "18 slides";
  if (type === "unsupported") return "Count unavailable";
  return "10 pages";
}
