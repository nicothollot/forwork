import path from "node:path";
import type { DocumentType } from "../shared/types.js";
import { documentSupportForExtension, documentTypeFromExtension } from "../shared/documentTypes.js";

export function documentTypeForPath(filePath: string): DocumentType | null {
  return documentTypeFromExtension(path.extname(filePath));
}

export function documentSupportForPath(filePath: string) {
  return documentSupportForExtension(path.extname(filePath));
}

export function unsupportedDocumentMessage(filePath: string): string {
  return documentSupportForPath(filePath).message;
}
