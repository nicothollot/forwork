export type DocumentType = "pdf" | "docx" | "xlsx" | "pptx";

export type ProcessingMode = "text-only" | "text-visual" | "text-all-pages";

export type JobStage =
  | "queued"
  | "hashing"
  | "extracting"
  | "detecting-visuals"
  | "writing"
  | "validating"
  | "annotating"
  | "complete"
  | "error"
  | "cancelled";

export interface FileMetadata {
  path: string;
  name: string;
  extension: string;
  type: DocumentType | "unsupported";
  sizeBytes: number;
  countLabel?: string;
  count?: number;
  sha256?: string;
}

export interface ProgressEvent {
  jobId: string;
  filePath?: string;
  stage: JobStage;
  percent: number;
  message: string;
}

export interface StyleConfig {
  wording_mode: "automatic" | "guided";
  signals: string[];
  formality: "automatic" | "professional" | "formal";
  max_words: number | null;
  format_template: string;
  examples: string[];
}

export interface ReviewConfig {
  schema_version: "1.0";
  request_id: string;
  source: {
    filename: string;
    sha256: string;
    document_type: DocumentType;
    total_pages?: number;
    total_slides?: number;
    total_sheets?: number;
    total_sections?: number;
  };
  review_instructions: string;
  style: StyleConfig;
  required_output_filename: "hl_comments.json";
}

export interface SourceBlock {
  anchorId: string;
  kind: "pdf_block" | "pdf_page";
  page: number;
  blockId?: string;
  text: string;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VisualPageRef {
  page: number;
  supplementPage: number;
  reason: string;
}

export interface SourceMap {
  schema_version: "1.0";
  processing_version: string;
  source: {
    filename: string;
    path?: string;
    sha256: string;
    document_type: DocumentType;
    total_pages: number;
  };
  anchors: Record<string, SourceBlock>;
  visual_pages: VisualPageRef[];
}

export interface LocalReviewJob {
  schema_version: "1.0";
  processing_version: string;
  request_id: string;
  created_at: string;
  source: SourceMap["source"];
  style: StyleConfig;
  source_map: SourceMap;
}

export interface PrepareReviewInput {
  sourcePath: string;
  outputFolder: string;
  reviewInstructions: string;
  style: StyleConfig;
  forceVisualSupplement?: boolean;
}

export interface ReviewPackageResult {
  requestId: string;
  sourceHash: string;
  outputRoot: string;
  uploadFolder: string;
  keepLocalFolder: string;
  markdownPath: string;
  visualPdfPath: string | null;
  reviewConfigPath: string;
  promptPath: string;
  localJobPath: string;
  totalPages: number;
  visualPages: VisualPageRef[];
}

export interface PreflightFileInput {
  path: string;
  mode: ProcessingMode;
}

export interface PreflightGenerateInput {
  jobId: string;
  files: PreflightFileInput[];
  outputFolder: string;
  options: {
    forceVisualSupplement?: boolean;
    preserveExistingComments?: boolean;
    runLocalOcr?: boolean;
  };
}

export interface PreflightFileResult {
  sourcePath: string;
  outputFolder: string;
  markdownPath: string;
  visualPdfPath: string | null;
  manifestPath: string;
  status: "complete" | "error" | "cancelled";
  error?: string;
}

export interface ClaudeFinding {
  id: string;
  anchor: {
    kind:
      | "pdf_block"
      | "pdf_page"
      | "docx_paragraph"
      | "docx_table_cell"
      | "xlsx_cell"
      | "xlsx_range"
      | "pptx_shape"
      | "pptx_slide";
    page?: number;
    block_id?: string;
    paragraph_id?: string;
    sheet?: string;
    cell?: string;
    range?: string;
    slide?: number;
    shape_id?: string;
  };
  evidence?: string;
  value?: string | null;
  comment_body: string;
  suggested_replacement?: string | null;
  category?: string | null;
  severity?: "low" | "medium" | "high" | null;
  confidence?: number | null;
}

export interface ClaudeResult {
  schema_version: "1.0";
  request_id: string;
  source_sha256: string;
  findings: ClaudeFinding[];
}

export interface FindingValidation {
  finding: ClaudeFinding;
  status: "valid" | "attention" | "invalid";
  reason?: string;
  renderedComment?: string;
  anchorId?: string;
}

export interface ClaudeValidationResult {
  ok: boolean;
  ignoredExtraText: boolean;
  errors: string[];
  result?: ClaudeResult;
  validations: FindingValidation[];
  summary: {
    valid: number;
    attention: number;
    invalid: number;
  };
}

export interface CreateCommentedPdfInput {
  sourcePath: string;
  localJobPath: string;
  claudeJsonText?: string;
  claudeJsonPath?: string;
  outputFolder: string;
  outputFilename?: string;
}

export interface CreateCommentedPdfResult {
  outputPath: string;
  reportPath: string;
  summary: ClaudeValidationResult["summary"];
  skipped: FindingValidation[];
}

export interface AppSettings {
  lastOutputFolder?: string;
}

export interface SkillBuildResult {
  zipPath: string;
  entries: string[];
}

export interface AppApi {
  selectDocument(): Promise<FileMetadata | null>;
  selectDocuments(): Promise<FileMetadata[]>;
  selectJsonFile(): Promise<{ path: string; name: string; text: string } | null>;
  selectFolder(): Promise<string | null>;
  getDroppedFilePath(file: File): string;
  getMetadata(path: string): Promise<FileMetadata>;
  prepareReview(input: PrepareReviewInput): Promise<ReviewPackageResult>;
  validateClaudeResult(input: {
    localJobPath: string;
    jsonText: string;
  }): Promise<ClaudeValidationResult>;
  createCommentedPdf(input: CreateCommentedPdfInput): Promise<CreateCommentedPdfResult>;
  generatePreflight(input: PreflightGenerateInput): Promise<PreflightFileResult[]>;
  cancelJob(jobId: string): Promise<void>;
  buildSkillZip(): Promise<SkillBuildResult>;
  openPath(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
}
