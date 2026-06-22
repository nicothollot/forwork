import { fileName } from "./format";

export interface UserFacingError {
  title: string;
  file?: string;
  sourceChanged: "No" | "Yes" | "Unknown";
  nextStep: string;
  details?: string;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userError(input: {
  action: string;
  file?: string;
  error: unknown;
  nextStep: string;
  sourceChanged?: "No" | "Yes" | "Unknown";
}): UserFacingError {
  return {
    title: input.action,
    file: input.file ? fileName(input.file) : undefined,
    sourceChanged: input.sourceChanged ?? "No",
    nextStep: input.nextStep,
    details: messageOf(input.error)
  };
}
