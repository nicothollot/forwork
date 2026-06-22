import type { DocumentAnchor, DocumentType, FileMetadata, ProcessingMode } from "../../shared/types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function extension(name: string): string {
  const match = name.match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

export function withoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function labelize(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

export function countKind(file: FileMetadata): string {
  if (file.type === "xlsx" || file.type === "xlsm") return "Sheets";
  if (file.type === "pptx" || file.type === "pptm") return "Slides";
  return "Pages";
}

export function displayDocumentType(type: DocumentType | "unsupported"): string {
  return type === "unsupported" ? "Unsupported" : type.toUpperCase();
}

export function modeLabel(mode: ProcessingMode, documentType?: DocumentType | "unsupported"): string {
  if (mode === "text-only") return "Text only";
  if (mode === "text-visual") return "Text + visual pages";
  if (documentType === "pptx" || documentType === "pptm") return "Text + every slide";
  return "Text + every page";
}

export function anchorLocation(anchor: DocumentAnchor): string {
  switch (anchor.kind) {
    case "pdf_block":
      return `Page ${anchor.page}, block ${anchor.block_id}`;
    case "pdf_page":
      return `Page ${anchor.page}`;
    case "docx_paragraph":
      return anchor.page ? `Page ${anchor.page}, paragraph ${anchor.paragraph_id}` : `Paragraph ${anchor.paragraph_id}`;
    case "docx_table_cell":
      return anchor.page
        ? `Page ${anchor.page}, table ${anchor.table_id}, row ${anchor.row}, column ${anchor.column}`
        : `Table ${anchor.table_id}, row ${anchor.row}, column ${anchor.column}`;
    case "xlsx_cell":
      return `${anchor.sheet} ${anchor.cell}`;
    case "xlsx_range":
      return `${anchor.sheet} ${anchor.range}`;
    case "pptx_shape":
      return `Slide ${anchor.slide}, shape ${anchor.shape_id}`;
    case "pptx_slide":
      return `Slide ${anchor.slide}`;
  }
}
