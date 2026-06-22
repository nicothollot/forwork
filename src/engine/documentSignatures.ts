import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { DocumentType } from "../shared/documentTypes.js";
import { documentTypeFromExtension } from "../shared/documentTypes.js";
import { currentSafeLimits, type SafeProcessingLimits } from "./safetyLimits.js";

export interface ZipSafetySummary {
  entryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  ratio: number;
}

const OFFICE_SIGNATURE = Buffer.from([0x50, 0x4b]);
const OLE_COMPOUND_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function verifyDocumentSignature(
  filePath: string,
  expectedType: DocumentType | null = documentTypeFromExtension(path.extname(filePath)),
  limits: SafeProcessingLimits = currentSafeLimits()
): Promise<DocumentType> {
  if (!expectedType) throw new Error("This file type is not supported by HL Intelligence.");

  const bytes = await readFile(filePath);
  if (expectedType === "pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("The selected file does not have a valid PDF signature.");
    }
    return "pdf";
  }

  if (bytes.subarray(0, 8).equals(OLE_COMPOUND_SIGNATURE)) {
    throw new Error("Password-protected Office documents are not supported. HL Intelligence will not bypass document passwords.");
  }

  if (!bytes.subarray(0, 2).equals(OFFICE_SIGNATURE)) {
    throw new Error("Office could not open this document normally. The file may be corrupt or not a valid OOXML package.");
  }

  const zip = await JSZip.loadAsync(bytes);
  assertZipSafety(zip, limits);
  await assertExpectedOfficePackage(zip, expectedType);
  return expectedType;
}

export function assertZipSafety(zip: JSZip, limits: SafeProcessingLimits = currentSafeLimits()): ZipSafetySummary {
  const entries = Object.values(zip.files);
  if (entries.length > limits.zipEntryCount) {
    throw new Error(`The Office package has ${entries.length} ZIP entries, above the safe limit of ${limits.zipEntryCount}.`);
  }

  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const internal = entry as JSZip.JSZipObject & {
      _data?: {
        compressedSize?: number;
        uncompressedSize?: number;
      };
    };
    compressedBytes += nonNegative(internal._data?.compressedSize);
    uncompressedBytes += nonNegative(internal._data?.uncompressedSize);
  }

  const ratio = compressedBytes > 0 ? uncompressedBytes / compressedBytes : uncompressedBytes > 0 ? Number.POSITIVE_INFINITY : 1;
  if (ratio > limits.zipDecompressionRatio) {
    throw new Error(
      `The Office package ZIP compression ratio (${ratio.toFixed(1)}:1) exceeds the safe limit of ${limits.zipDecompressionRatio}:1.`
    );
  }

  return { entryCount: entries.length, compressedBytes, uncompressedBytes, ratio };
}

async function assertExpectedOfficePackage(zip: JSZip, documentType: DocumentType): Promise<void> {
  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes) throw new Error("The Office package is missing [Content_Types].xml.");
  const xml = await contentTypes.async("text");

  if (documentType === "docx" || documentType === "docm") {
    assertPackagePart(zip, "word/document.xml", documentType.toUpperCase());
    assertContentType(
      xml,
      documentType === "docm"
        ? "application/vnd.ms-word.document.macroEnabled.main+xml"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      documentType
    );
    return;
  }

  if (documentType === "xlsx" || documentType === "xlsm") {
    assertPackagePart(zip, "xl/workbook.xml", documentType.toUpperCase());
    assertContentType(
      xml,
      documentType === "xlsm"
        ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      documentType
    );
    return;
  }

  if (documentType === "pptx" || documentType === "pptm") {
    assertPackagePart(zip, "ppt/presentation.xml", documentType.toUpperCase());
    assertContentType(
      xml,
      documentType === "pptm"
        ? "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      documentType
    );
  }
}

function assertPackagePart(zip: JSZip, partName: string, label: string): void {
  if (!zip.file(partName)) {
    throw new Error(`The selected ${label} file is missing required OOXML part ${partName}.`);
  }
}

function assertContentType(xml: string, expectedContentType: string, documentType: DocumentType): void {
  if (!xml.includes(expectedContentType)) {
    throw new Error(`The selected file signature does not match the .${documentType} format.`);
  }
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? value : 0;
}
