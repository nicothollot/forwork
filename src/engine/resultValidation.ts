import type {
  ClaudeResult,
  ClaudeValidationResult,
  FindingValidation,
  LocalReviewJob
} from "../shared/types.js";
import { extractJsonObject } from "./jsonImport.js";
import { documentAdapterRegistry } from "./documentAdapterRegistry.js";
import { validateReviewOutput } from "./schemaValidation.js";
import { validateTemplate } from "./template.js";
import { assertFindingCountWithinLimits, assertJsonInputWithinLimits } from "./safetyLimits.js";

export async function validateClaudeResultText(localJob: LocalReviewJob, rawText: string): Promise<ClaudeValidationResult> {
  const errors: string[] = [];
  let parsed: ClaudeResult | undefined;
  let ignoredExtraText = false;

  try {
    assertJsonInputWithinLimits(rawText);
  } catch (error) {
    return {
      ok: false,
      ignoredExtraText,
      errors: [error instanceof Error ? error.message : "JSON input exceeds the configured safe limit."],
      validations: [],
      summary: { valid: 0, attention: 0, invalid: 0 }
    };
  }

  try {
    const extracted = extractJsonObject(rawText);
    ignoredExtraText = extracted.ignoredExtraText;
    parsed = JSON.parse(extracted.jsonText) as ClaudeResult;
  } catch (error) {
    return {
      ok: false,
      ignoredExtraText,
      errors: [error instanceof Error ? error.message : "Invalid JSON."],
      validations: [],
      summary: { valid: 0, attention: 0, invalid: 0 }
    };
  }

  const schemaResult = await validateReviewOutput(parsed);
  if (!schemaResult.ok) errors.push(...schemaResult.errors);
  if (Array.isArray(parsed.findings)) {
    try {
      assertFindingCountWithinLimits(parsed.findings.length);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "The result contains too many findings.");
    }
  }
  if (parsed.request_id !== localJob.request_id) errors.push("Request ID does not match this review job.");
  if (parsed.source_sha256 !== localJob.source.sha256) errors.push("Source SHA-256 does not match the original document.");

  const templateErrors = validateTemplate(localJob.style.format_template);
  errors.push(...templateErrors);

  const validations = schemaResult.ok ? await validateFindings(localJob, parsed) : [];
  const summary = summarize(validations);
  return {
    ok: errors.length === 0 && summary.invalid === 0,
    ignoredExtraText,
    errors,
    result: parsed,
    validations,
    summary
  };
}

async function validateFindings(localJob: LocalReviewJob, result: ClaudeResult): Promise<FindingValidation[]> {
  const adapter = documentAdapterRegistry.get(localJob.source.document_type);
  if (!adapter) {
    return result.findings.map((finding) => ({
      finding,
      status: "invalid",
      reason: `${localJob.source.document_type.toUpperCase()} comment validation is not enabled in this build.`
    }));
  }
  return Promise.all(result.findings.map((finding) => adapter.validateFinding({ localJob, finding })));
}

function summarize(validations: FindingValidation[]): ClaudeValidationResult["summary"] {
  return {
    valid: validations.filter((validation) => validation.status === "valid").length,
    attention: validations.filter((validation) => validation.status === "attention").length,
    invalid: validations.filter((validation) => validation.status === "invalid").length
  };
}
