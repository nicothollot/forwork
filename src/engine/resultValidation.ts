import type {
  ClaudeResult,
  ClaudeValidationResult,
  FindingValidation,
  LocalReviewJob
} from "../shared/types.js";
import { extractJsonObject } from "./jsonImport.js";
import { validateReviewOutput } from "./schemaValidation.js";
import { normalizeForEvidence, renderComment, validateTemplate } from "./template.js";

export async function validateClaudeResultText(localJob: LocalReviewJob, rawText: string): Promise<ClaudeValidationResult> {
  const errors: string[] = [];
  let parsed: ClaudeResult | undefined;
  let ignoredExtraText = false;

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
  if (parsed.request_id !== localJob.request_id) errors.push("Request ID does not match this review job.");
  if (parsed.source_sha256 !== localJob.source.sha256) errors.push("Source SHA-256 does not match the original document.");

  const templateErrors = validateTemplate(localJob.style.format_template);
  errors.push(...templateErrors);

  const validations = schemaResult.ok ? validateFindings(localJob, parsed) : [];
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

function validateFindings(localJob: LocalReviewJob, result: ClaudeResult): FindingValidation[] {
  const pageTexts = new Map<number, string>();
  for (const anchor of Object.values(localJob.source_map.anchors)) {
    if (!pageTexts.has(anchor.page)) pageTexts.set(anchor.page, "");
    pageTexts.set(anchor.page, `${pageTexts.get(anchor.page)}\n${anchor.text}`);
  }

  return result.findings.map((finding): FindingValidation => {
    if (finding.anchor.kind !== "pdf_block" && finding.anchor.kind !== "pdf_page") {
      return { finding, status: "invalid", reason: `Unsupported anchor kind: ${finding.anchor.kind}` };
    }

    const anchorId =
      finding.anchor.kind === "pdf_block"
        ? finding.anchor.block_id
        : finding.anchor.page
          ? `p${String(finding.anchor.page).padStart(4, "0")}:page`
          : undefined;

    if (!anchorId) return { finding, status: "invalid", reason: "Anchor ID is missing." };
    const anchor = localJob.source_map.anchors[anchorId];
    if (!anchor) return { finding, status: "invalid", reason: `Anchor was not found: ${anchorId}` };
    if (finding.anchor.page && finding.anchor.page !== anchor.page) {
      return { finding, status: "invalid", reason: "Anchor page does not match the source map." };
    }

    const evidence = finding.evidence?.trim();
    if (!evidence) {
      return {
        finding,
        status: "attention",
        reason: "Evidence was not provided.",
        anchorId,
        renderedComment: renderComment(finding, localJob.style, localJob.source_map, anchorId)
      };
    }

    const haystack =
      finding.anchor.kind === "pdf_block"
        ? anchor.text
        : pageTexts.get(anchor.page) ?? "";
    if (!normalizeForEvidence(haystack).includes(normalizeForEvidence(evidence))) {
      return {
        finding,
        status: "invalid",
        reason: "Evidence was not found near the referenced anchor.",
        anchorId
      };
    }

    return {
      finding,
      status: "valid",
      anchorId,
      renderedComment: renderComment(finding, localJob.style, localJob.source_map, anchorId)
    };
  });
}

function summarize(validations: FindingValidation[]): ClaudeValidationResult["summary"] {
  return {
    valid: validations.filter((validation) => validation.status === "valid").length,
    attention: validations.filter((validation) => validation.status === "attention").length,
    invalid: validations.filter((validation) => validation.status === "invalid").length
  };
}
