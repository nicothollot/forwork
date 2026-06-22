import { stat } from "node:fs/promises";
import type { DocumentInspection } from "../shared/types.js";

export interface SafeProcessingLimits {
  sourceFileBytes: number;
  pdfPageCount: number;
  sheetCount: number;
  slideCount: number;
  jsonInputBytes: number;
  findingCount: number;
  zipEntryCount: number;
  zipDecompressionRatio: number;
  generatedOutputBytes: number;
}

export const DEFAULT_SAFE_LIMITS: SafeProcessingLimits = {
  sourceFileBytes: 250 * 1024 * 1024,
  pdfPageCount: 2000,
  sheetCount: 500,
  slideCount: 1000,
  jsonInputBytes: 15 * 1024 * 1024,
  findingCount: 2000,
  zipEntryCount: 12000,
  zipDecompressionRatio: 100,
  generatedOutputBytes: 500 * 1024 * 1024
};

export function currentSafeLimits(env: NodeJS.ProcessEnv = process.env): SafeProcessingLimits {
  return {
    sourceFileBytes: positiveInt(env.HL_MAX_SOURCE_FILE_BYTES, DEFAULT_SAFE_LIMITS.sourceFileBytes),
    pdfPageCount: positiveInt(env.HL_MAX_PDF_PAGES, DEFAULT_SAFE_LIMITS.pdfPageCount),
    sheetCount: positiveInt(env.HL_MAX_SHEETS, DEFAULT_SAFE_LIMITS.sheetCount),
    slideCount: positiveInt(env.HL_MAX_SLIDES, DEFAULT_SAFE_LIMITS.slideCount),
    jsonInputBytes: positiveInt(env.HL_MAX_JSON_INPUT_BYTES, DEFAULT_SAFE_LIMITS.jsonInputBytes),
    findingCount: positiveInt(env.HL_MAX_FINDINGS, DEFAULT_SAFE_LIMITS.findingCount),
    zipEntryCount: positiveInt(env.HL_MAX_ZIP_ENTRIES, DEFAULT_SAFE_LIMITS.zipEntryCount),
    zipDecompressionRatio: positiveInt(env.HL_MAX_ZIP_DECOMPRESSION_RATIO, DEFAULT_SAFE_LIMITS.zipDecompressionRatio),
    generatedOutputBytes: positiveInt(env.HL_MAX_GENERATED_OUTPUT_BYTES, DEFAULT_SAFE_LIMITS.generatedOutputBytes)
  };
}

export async function assertSourceFileWithinLimits(
  filePath: string,
  limits: SafeProcessingLimits = currentSafeLimits()
): Promise<void> {
  const info = await stat(filePath);
  if (info.size > limits.sourceFileBytes) {
    throw new Error(
      `The selected source file is too large for local processing (${formatBytes(info.size)}). The current safe limit is ${formatBytes(limits.sourceFileBytes)}.`
    );
  }
}

export function assertInspectionWithinLimits(
  inspection: DocumentInspection,
  limits: SafeProcessingLimits = currentSafeLimits()
): void {
  const pages = inspection.counts.pages ?? 0;
  const sheets = inspection.counts.sheets ?? 0;
  const slides = inspection.counts.slides ?? 0;
  if (pages > limits.pdfPageCount) {
    throw new Error(`This document has ${pages} pages, above the safe page limit of ${limits.pdfPageCount}.`);
  }
  if (sheets > limits.sheetCount) {
    throw new Error(`This workbook has ${sheets} sheets, above the safe sheet limit of ${limits.sheetCount}.`);
  }
  if (slides > limits.slideCount) {
    throw new Error(`This presentation has ${slides} slides, above the safe slide limit of ${limits.slideCount}.`);
  }
}

export function assertJsonInputWithinLimits(
  text: string,
  limits: SafeProcessingLimits = currentSafeLimits()
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limits.jsonInputBytes) {
    throw new Error(
      `The JSON file is too large to import safely (${formatBytes(bytes)}). The current JSON limit is ${formatBytes(limits.jsonInputBytes)}.`
    );
  }
}

export function assertFindingCountWithinLimits(
  count: number,
  limits: SafeProcessingLimits = currentSafeLimits()
): void {
  if (count > limits.findingCount) {
    throw new Error(`The result contains ${count} findings, above the safe finding limit of ${limits.findingCount}.`);
  }
}

export async function assertGeneratedOutputWithinLimits(
  paths: string[],
  limits: SafeProcessingLimits = currentSafeLimits()
): Promise<void> {
  let total = 0;
  for (const filePath of paths.filter(Boolean)) {
    const info = await stat(filePath);
    total += info.size;
  }
  if (total > limits.generatedOutputBytes) {
    throw new Error(
      `Generated output exceeded the safe output limit (${formatBytes(total)} generated, limit ${formatBytes(limits.generatedOutputBytes)}).`
    );
  }
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
