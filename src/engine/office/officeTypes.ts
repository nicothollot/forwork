export type OfficeApplicationName = "word" | "excel" | "powerpoint";
export type WordDocumentType = "docx" | "docm";
export type ExcelDocumentType = "xlsx" | "xlsm";
export type PowerPointDocumentType = "pptx" | "pptm";
export type OfficeWorkerOperation = "probe" | "inspect" | "extract" | "render" | "apply-comments" | "verify-output";

interface OfficeWorkerRequestBase {
  schema_version: "1.0";
  operation: OfficeWorkerOperation;
}

export interface OfficeProbeRequest extends OfficeWorkerRequestBase {
  operation: "probe";
}

export interface OfficeWorkerError {
  code:
    | "word_not_installed"
    | "excel_not_installed"
    | "powerpoint_not_installed"
    | "password_protected"
    | "corrupt_document"
    | "unsupported_feature"
    | "word_timeout"
    | "excel_timeout"
    | "output_verification_failed"
    | "invalid_request"
    | "operation_failed";
  message: string;
}

export interface WordInspectRequest extends OfficeWorkerRequestBase {
  operation: "inspect";
  application: "word";
  document_type: WordDocumentType;
  source_path: string;
}

export interface WordExtractRequest extends OfficeWorkerRequestBase {
  operation: "extract";
  application: "word";
  document_type: WordDocumentType;
  source_path: string;
  source_sha256: string;
  created_at: string;
  options: {
    include_headers_footers: boolean;
    include_existing_comments: boolean;
    include_track_changes: boolean;
  };
}

export interface WordRenderRequest extends OfficeWorkerRequestBase {
  operation: "render";
  application: "word";
  document_type: WordDocumentType;
  source_path: string;
  output_pdf_path: string;
}

export interface WordCommentToApply {
  id: string;
  anchor_id: string;
  anchor: {
    kind: "docx_paragraph" | "docx_table_cell";
    paragraph_id?: string;
    table_id?: string;
    row?: number;
    column?: number;
    cell_id?: string;
    page?: number;
  };
  comment: string;
}

export interface WordApplyCommentsRequest extends OfficeWorkerRequestBase {
  operation: "apply-comments";
  application: "word";
  document_type: WordDocumentType;
  source_path: string;
  output_path: string;
  comments: WordCommentToApply[];
}

export interface WordVerifyOutputRequest extends OfficeWorkerRequestBase {
  operation: "verify-output";
  application: "word";
  document_type: WordDocumentType;
  source_path: string;
  output_path: string;
  expected: {
    comments_added: number;
    existing_comment_count: number;
    section_count: number;
    table_count: number;
    track_revisions_enabled: boolean;
    revision_count: number;
    macro_present: boolean;
    anchors: WordCommentToApply[];
  };
}

export interface ExcelInspectRequest extends OfficeWorkerRequestBase {
  operation: "inspect";
  application: "excel";
  document_type: ExcelDocumentType;
  source_path: string;
}

export interface ExcelExtractRequest extends OfficeWorkerRequestBase {
  operation: "extract";
  application: "excel";
  document_type: ExcelDocumentType;
  source_path: string;
  source_sha256: string;
  created_at: string;
  options: {
    include_existing_comments: boolean;
    generate_csv_sidecars: boolean;
    csv_sidecar_folder_path?: string;
  };
}

export interface ExcelRenderTarget {
  sheet: string;
  sheet_index: number;
  range?: string;
  reason: string;
}

export interface ExcelRenderRequest extends OfficeWorkerRequestBase {
  operation: "render";
  application: "excel";
  document_type: ExcelDocumentType;
  source_path: string;
  output_folder_path: string;
  render_targets: ExcelRenderTarget[];
}

export interface ExcelCommentToApply {
  id: string;
  anchor_id: string;
  anchor: {
    kind: "xlsx_cell" | "xlsx_range";
    sheet: string;
    cell?: string;
    range?: string;
  };
  comment: string;
  expected_number_format?: string;
}

export interface ExcelVerifyBaseline {
  sheet_count: number;
  formula_cell_count: number;
  named_range_count: number;
  chart_count: number;
  existing_comment_count: number;
  macro_present: boolean;
  hidden_state_signature: string;
  named_range_signature: string;
  number_format_signature: string;
  external_link_signature: string;
}

export interface ExcelApplyCommentsRequest extends OfficeWorkerRequestBase {
  operation: "apply-comments";
  application: "excel";
  document_type: ExcelDocumentType;
  source_path: string;
  output_path: string;
  comments: ExcelCommentToApply[];
}

export interface ExcelVerifyOutputRequest extends OfficeWorkerRequestBase {
  operation: "verify-output";
  application: "excel";
  document_type: ExcelDocumentType;
  source_path: string;
  output_path: string;
  expected: ExcelVerifyBaseline & {
    anchors: ExcelCommentToApply[];
  };
}

export interface PowerPointInspectRequest extends OfficeWorkerRequestBase {
  operation: "inspect";
  application: "powerpoint";
  document_type: PowerPointDocumentType;
  source_path: string;
}

export interface PowerPointExtractRequest extends OfficeWorkerRequestBase {
  operation: "extract";
  application: "powerpoint";
  document_type: PowerPointDocumentType;
  source_path: string;
  source_sha256: string;
  created_at: string;
  options: {
    include_speaker_notes: boolean;
    include_existing_comments: boolean;
  };
}

export interface PowerPointRenderRequest extends OfficeWorkerRequestBase {
  operation: "render";
  application: "powerpoint";
  document_type: PowerPointDocumentType;
  source_path: string;
  output_pdf_path: string;
}

export interface PowerPointCommentToApply {
  id: string;
  anchor_id: string;
  anchor: {
    kind: "pptx_shape" | "pptx_slide";
    slide: number;
    slide_id: number;
    shape_id?: string;
  };
  comment: string;
}

export interface PowerPointVerifyBaseline {
  slide_count: number;
  hidden_state_signature: string;
  shape_count: number;
  slide_master_count: number;
  notes_signature: string;
  chart_count: number;
  existing_comment_count: number;
  macro_present: boolean;
  source_sha256: string;
}

export interface PowerPointApplyCommentsRequest extends OfficeWorkerRequestBase {
  operation: "apply-comments";
  application: "powerpoint";
  document_type: PowerPointDocumentType;
  source_path: string;
  output_path: string;
  comments: PowerPointCommentToApply[];
}

export interface PowerPointVerifyOutputRequest extends OfficeWorkerRequestBase {
  operation: "verify-output";
  application: "powerpoint";
  document_type: PowerPointDocumentType;
  source_path: string;
  output_path: string;
  expected: PowerPointVerifyBaseline & {
    anchors: PowerPointCommentToApply[];
  };
}

export type OfficeWorkerRequest =
  | OfficeProbeRequest
  | WordInspectRequest
  | WordExtractRequest
  | WordRenderRequest
  | WordApplyCommentsRequest
  | WordVerifyOutputRequest
  | ExcelInspectRequest
  | ExcelExtractRequest
  | ExcelRenderRequest
  | ExcelApplyCommentsRequest
  | ExcelVerifyOutputRequest
  | PowerPointInspectRequest
  | PowerPointExtractRequest
  | PowerPointRenderRequest
  | PowerPointApplyCommentsRequest
  | PowerPointVerifyOutputRequest;

export interface OfficeWorkerResponseBase {
  schema_version: "1.0";
  operation: OfficeWorkerOperation;
  ok: boolean;
  error?: OfficeWorkerError;
}

export interface OfficeApplicationCapability {
  available: boolean;
  version?: string;
  message?: string;
}

export interface OfficeProbeResponse extends OfficeWorkerResponseBase {
  schema_version: "1.0";
  operation: "probe";
  ok: boolean;
  applications: Record<OfficeApplicationName, OfficeApplicationCapability>;
  worker: {
    platform: string;
    powerShell: string;
  };
}

export interface WordInspectionProperties {
  page_count: number;
  section_count: number;
  paragraph_count: number;
  table_count: number;
  existing_comment_count: number;
  track_revisions_enabled: boolean;
  revision_count: number;
  has_images: boolean;
  image_count: number;
  has_shapes: boolean;
  shape_count: number;
  has_charts: boolean;
  chart_count: number;
  has_text_boxes: boolean;
  text_box_count: number;
  footnote_count: number;
  endnote_count: number;
  signature_present: boolean;
  macro_present: boolean;
  password_protected: boolean;
  corrupt: boolean;
}

export interface ExcelUsedRangeInfo {
  sheet: string;
  sheet_index: number;
  visibility: "visible" | "hidden" | "very-hidden";
  address: string;
  rows: number;
  columns: number;
}

export interface ExcelInspectionProperties {
  sheet_count: number;
  worksheet_count: number;
  chart_sheet_count: number;
  visible_sheet_count: number;
  hidden_sheet_count: number;
  very_hidden_sheet_count: number;
  used_ranges: ExcelUsedRangeInfo[];
  table_count: number;
  named_range_count: number;
  chart_count: number;
  shape_count: number;
  image_count: number;
  existing_comment_count: number;
  external_link_present: boolean;
  external_link_count: number;
  formula_cell_count: number;
  macro_present: boolean;
  password_protected: boolean;
  corrupt: boolean;
  conditional_format_count: number;
  merged_range_count: number;
  hidden_row_count: number;
  hidden_column_count: number;
  hidden_state_signature: string;
  named_range_signature: string;
  number_format_signature: string;
  external_link_signature: string;
}

export interface PowerPointInspectionProperties {
  slide_count: number;
  hidden_slide_count: number;
  slide_master_count: number;
  shape_count: number;
  chart_count: number;
  table_count: number;
  image_count: number;
  speaker_note_count: number;
  existing_comment_count: number;
  macro_present: boolean;
  signature_present: boolean;
  password_protected: boolean;
  corrupt: boolean;
  hidden_state_signature: string;
  notes_signature: string;
  comment_api?: string;
}

export interface ExcelVisualCandidate {
  sheet: string;
  sheet_index: number;
  range?: string;
  reason: string;
}

export interface ExcelSourceAnchor {
  anchorId: string;
  kind: "xlsx_cell" | "xlsx_range";
  anchor: ExcelCommentToApply["anchor"];
  sheet: string;
  cell?: string;
  range?: string;
  displayedValue?: string;
  formula?: string;
  numberFormat?: string;
  text: string;
}

export interface PowerPointVisualCandidate {
  slide: number;
  slide_id: number;
  reason: string;
  low_confidence: boolean;
}

export interface PowerPointSourceAnchor {
  anchorId: string;
  kind: "pptx_shape" | "pptx_slide";
  anchor: PowerPointCommentToApply["anchor"];
  slide: number;
  slideId: number;
  shapeId?: string;
  text: string;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface WordVisualPageCandidate {
  page: number;
  reason: string;
  low_confidence: boolean;
}

export interface WordSourceAnchor {
  anchorId: string;
  kind: "docx_paragraph" | "docx_table_cell";
  anchor: WordCommentToApply["anchor"];
  page?: number;
  paragraphId?: string;
  tableId?: string;
  cellId?: string;
  row?: number;
  column?: number;
  text: string;
}

export interface WordInspectResponse extends OfficeWorkerResponseBase {
  operation: "inspect";
  document_type: WordDocumentType;
  inspection?: WordInspectionProperties;
}

export interface WordExtractResponse extends OfficeWorkerResponseBase {
  operation: "extract";
  document_type: WordDocumentType;
  markdown?: string;
  anchors?: Record<string, WordSourceAnchor>;
  visual_pages?: WordVisualPageCandidate[];
  warnings?: string[];
  inspection?: WordInspectionProperties;
}

export interface WordRenderResponse extends OfficeWorkerResponseBase {
  operation: "render";
  document_type: WordDocumentType;
  output_pdf_path?: string;
  page_count?: number;
}

export interface WordApplyCommentsResponse extends OfficeWorkerResponseBase {
  operation: "apply-comments";
  document_type: WordDocumentType;
  output_path?: string;
  added_comment_count?: number;
}

export interface WordVerifyOutputResponse extends OfficeWorkerResponseBase {
  operation: "verify-output";
  document_type: WordDocumentType;
  output_path?: string;
  verification?: {
    expected_comment_count: number;
    actual_comment_count: number;
    section_count_preserved: boolean;
    table_count_preserved: boolean;
    existing_comments_preserved: boolean;
    track_changes_preserved: boolean;
    macro_project_preserved: boolean;
    expected_anchors_verified: boolean;
  };
}

export interface ExcelInspectResponse extends OfficeWorkerResponseBase {
  operation: "inspect";
  document_type: ExcelDocumentType;
  inspection?: ExcelInspectionProperties;
}

export interface ExcelExtractResponse extends OfficeWorkerResponseBase {
  operation: "extract";
  document_type: ExcelDocumentType;
  markdown?: string;
  anchors?: Record<string, ExcelSourceAnchor>;
  visual_pages?: ExcelVisualCandidate[];
  render_targets?: ExcelRenderTarget[];
  csv_sidecars?: string[];
  warnings?: string[];
  inspection?: ExcelInspectionProperties;
}

export interface ExcelRenderedTarget {
  sheet: string;
  sheet_index: number;
  range?: string;
  reason: string;
  output_pdf_path: string;
}

export interface ExcelRenderResponse extends OfficeWorkerResponseBase {
  operation: "render";
  document_type: ExcelDocumentType;
  rendered_targets?: ExcelRenderedTarget[];
}

export interface ExcelApplyCommentsResponse extends OfficeWorkerResponseBase {
  operation: "apply-comments";
  document_type: ExcelDocumentType;
  output_path?: string;
  added_comment_count?: number;
}

export interface ExcelVerifyOutputResponse extends OfficeWorkerResponseBase {
  operation: "verify-output";
  document_type: ExcelDocumentType;
  output_path?: string;
  verification?: {
    expected_comment_count_floor: number;
    actual_comment_count: number;
    sheet_count_preserved: boolean;
    formula_count_preserved: boolean;
    named_ranges_preserved: boolean;
    chart_count_preserved: boolean;
    existing_comments_preserved: boolean;
    hidden_states_preserved: boolean;
    number_formats_preserved: boolean;
    external_links_preserved: boolean;
    macro_project_preserved: boolean;
    expected_anchors_verified: boolean;
  };
}

export interface PowerPointInspectResponse extends OfficeWorkerResponseBase {
  operation: "inspect";
  document_type: PowerPointDocumentType;
  inspection?: PowerPointInspectionProperties;
}

export interface PowerPointExtractResponse extends OfficeWorkerResponseBase {
  operation: "extract";
  document_type: PowerPointDocumentType;
  markdown?: string;
  anchors?: Record<string, PowerPointSourceAnchor>;
  visual_pages?: PowerPointVisualCandidate[];
  warnings?: string[];
  inspection?: PowerPointInspectionProperties;
}

export interface PowerPointRenderResponse extends OfficeWorkerResponseBase {
  operation: "render";
  document_type: PowerPointDocumentType;
  output_pdf_path?: string;
  slide_count?: number;
}

export interface PowerPointApplyCommentsResponse extends OfficeWorkerResponseBase {
  operation: "apply-comments";
  document_type: PowerPointDocumentType;
  output_path?: string;
  added_comment_count?: number;
  comment_api?: string;
}

export interface PowerPointVerifyOutputResponse extends OfficeWorkerResponseBase {
  operation: "verify-output";
  document_type: PowerPointDocumentType;
  output_path?: string;
  verification?: {
    expected_comment_count_floor: number;
    actual_comment_count: number;
    slide_count_preserved: boolean;
    hidden_states_preserved: boolean;
    shape_count_preserved: boolean;
    slide_masters_preserved: boolean;
    notes_preserved: boolean;
    charts_preserved: boolean;
    existing_comments_preserved: boolean;
    macro_project_preserved: boolean;
    source_unchanged: boolean;
    expected_anchors_verified: boolean;
    comment_api?: string;
  };
}

export interface OfficeWorkerClientOptions {
  workerScriptPath?: string;
  powerShellPath?: string;
  timeoutMs?: number;
  tempRoot?: string;
  isCancelled?: () => boolean;
}
