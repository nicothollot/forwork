import type { ApprovedFindingInput, FindingValidation } from "../shared/types.js";

export function selectFindingsForOutput(
  validations: FindingValidation[],
  approvedFindings?: ApprovedFindingInput[]
): FindingValidation[] {
  if (!approvedFindings) {
    return validations.filter((finding) => finding.status === "valid");
  }

  const approved = new Map(approvedFindings.map((finding) => [finding.id, finding.finalComment?.trim()]));
  return validations
    .filter((finding) => approved.has(finding.finding.id))
    .filter((finding) => finding.status === "valid" || (finding.status === "attention" && finding.anchorId))
    .map((finding) => {
      const finalComment = approved.get(finding.finding.id);
      return finalComment ? { ...finding, renderedComment: finalComment } : finding;
    });
}

export function skippedFindingsForOutput(
  validations: FindingValidation[],
  applied: FindingValidation[],
  approvedFindings?: ApprovedFindingInput[]
): FindingValidation[] {
  const appliedIds = new Set(applied.map((finding) => finding.finding.id));
  const approvedIds = new Set(approvedFindings?.map((finding) => finding.id) ?? []);
  return validations
    .filter((finding) => !appliedIds.has(finding.finding.id))
    .map((finding) => {
      if (approvedFindings && !approvedIds.has(finding.finding.id)) {
        return { ...finding, reason: finding.reason ?? "Finding was not approved for output." };
      }
      return finding;
    });
}
