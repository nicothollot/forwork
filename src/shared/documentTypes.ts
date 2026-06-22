export const DOCUMENT_TYPES = ["pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const VERIFIED_DOCUMENT_TYPES = ["pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm"] as const satisfies readonly DocumentType[];
export const PLANNED_DOCUMENT_TYPES = [] as const satisfies readonly DocumentType[];

export const DOCUMENT_TYPE_EXTENSIONS: Record<DocumentType, string> = {
  pdf: ".pdf",
  docx: ".docx",
  docm: ".docm",
  xlsx: ".xlsx",
  xlsm: ".xlsm",
  pptx: ".pptx",
  pptm: ".pptm"
};

export const LEGACY_OFFICE_EXTENSIONS = [".doc", ".xls", ".ppt"] as const;
export const PICKABLE_DOCUMENT_EXTENSIONS = [
  ...Object.values(DOCUMENT_TYPE_EXTENSIONS),
  ...LEGACY_OFFICE_EXTENSIONS
].map((extension) => extension.slice(1));

export type DocumentSupportStatus = "verified" | "planned" | "legacy-conversion-required" | "unsupported";

export interface DocumentSupportInfo {
  status: DocumentSupportStatus;
  documentType: DocumentType | null;
  message: string;
}

export function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

export function documentTypeFromExtension(extension: string): DocumentType | null {
  const normalized = normalizeExtension(extension);
  const entry = Object.entries(DOCUMENT_TYPE_EXTENSIONS).find(([, value]) => value === normalized);
  return entry ? (entry[0] as DocumentType) : null;
}

export function documentSupportForExtension(extension: string): DocumentSupportInfo {
  const normalized = normalizeExtension(extension);
  const documentType = documentTypeFromExtension(normalized);
  if (documentType === "pdf") {
    return {
      status: "verified",
      documentType,
      message: "PDF support is verified."
    };
  }
  if (documentType === "docx" || documentType === "docm") {
    return {
      status: "verified",
      documentType,
      message: `${documentType.toUpperCase()} support is verified when local Microsoft Word is installed.`
    };
  }
  if (documentType === "xlsx" || documentType === "xlsm") {
    return {
      status: "verified",
      documentType,
      message: `${documentType.toUpperCase()} support is verified when local Microsoft Excel is installed.`
    };
  }
  if (documentType === "pptx" || documentType === "pptm") {
    return {
      status: "verified",
      documentType,
      message:
        documentType === "pptm"
          ? "PPTM support is verified when local Microsoft PowerPoint is installed; macro execution is disabled and VBA project preservation is checked when present."
          : "PPTX support is verified when local Microsoft PowerPoint is installed."
    };
  }
  if ((LEGACY_OFFICE_EXTENSIONS as readonly string[]).includes(normalized)) {
    return {
      status: "legacy-conversion-required",
      documentType: null,
      message: "Legacy Office files require conversion to DOCX, XLSX, or PPTX before HL Intelligence can process them."
    };
  }
  return {
    status: "unsupported",
    documentType: null,
    message: "This file type is not supported by HL Intelligence."
  };
}

export interface PdfBlockAnchor {
  kind: "pdf_block";
  page: number;
  block_id: string;
}

export interface PdfPageAnchor {
  kind: "pdf_page";
  page: number;
}

export interface DocxParagraphAnchor {
  kind: "docx_paragraph";
  paragraph_id: string;
  page?: number;
}

export interface DocxTableCellAnchor {
  kind: "docx_table_cell";
  table_id: string;
  row: number;
  column: number;
  cell_id?: string;
  page?: number;
}

export interface XlsxCellAnchor {
  kind: "xlsx_cell";
  sheet: string;
  cell: string;
}

export interface XlsxRangeAnchor {
  kind: "xlsx_range";
  sheet: string;
  range: string;
}

export interface PptxShapeAnchor {
  kind: "pptx_shape";
  slide: number;
  slide_id: number;
  shape_id: string;
}

export interface PptxSlideAnchor {
  kind: "pptx_slide";
  slide: number;
  slide_id: number;
}

export type DocumentAnchor =
  | PdfBlockAnchor
  | PdfPageAnchor
  | DocxParagraphAnchor
  | DocxTableCellAnchor
  | XlsxCellAnchor
  | XlsxRangeAnchor
  | PptxShapeAnchor
  | PptxSlideAnchor;

export type AnchorKind = DocumentAnchor["kind"];
