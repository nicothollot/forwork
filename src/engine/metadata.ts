import { stat } from "node:fs/promises";
import path from "node:path";
import type { DocumentType, FileMetadata } from "../shared/types.js";
import { sha256File } from "./hash.js";
import { loadPdfPageCount } from "./pdfAdapter.js";

const EXTENSION_TO_TYPE: Record<string, DocumentType | undefined> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx"
};

export async function getFileMetadata(filePath: string, includeHash = false): Promise<FileMetadata> {
  const info = await stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const mappedType = EXTENSION_TO_TYPE[extension];
  const type: FileMetadata["type"] = mappedType ?? "unsupported";
  const metadata: FileMetadata = {
    path: filePath,
    name: path.basename(filePath),
    extension,
    type,
    sizeBytes: info.size
  };

  if (type === "pdf") {
    try {
      metadata.count = await loadPdfPageCount(filePath);
      metadata.countLabel = `${metadata.count} page${metadata.count === 1 ? "" : "s"}`;
    } catch (error) {
      metadata.countLabel = error instanceof Error ? error.message : "Could not read PDF";
    }
  } else if (type !== "unsupported") {
    metadata.countLabel = "Adapter planned; not yet verified";
  }

  if (includeHash) metadata.sha256 = await sha256File(filePath);
  return metadata;
}

export function isVerifiedPdf(metadata: FileMetadata): boolean {
  return metadata.type === "pdf" && typeof metadata.count === "number" && metadata.count > 0;
}
