import type { ClaudeValidationResult, FindingValidation } from "../../shared/types";
import { useEffect, useState } from "react";
import { anchorLocation } from "../lib/format";

export type DecisionState = "approved" | "rejected" | "pending";

export interface FindingDecision {
  state: DecisionState;
  finalComment: string;
}

type Filter = "all" | "ready" | "needs-review" | "rejected";

export function defaultDecisions(validation: ClaudeValidationResult): Record<string, FindingDecision> {
  return Object.fromEntries(
    validation.validations.map((item) => [
      item.finding.id,
      {
        state: item.status === "valid" ? "approved" : "pending",
        finalComment: item.renderedComment ?? item.finding.comment_body
      } satisfies FindingDecision
    ])
  );
}

export function hasPendingDecisions(validation: ClaudeValidationResult | null, decisions: Record<string, FindingDecision>): boolean {
  if (!validation) return false;
  return validation.validations.some((item) => (decisions[item.finding.id]?.state ?? "pending") === "pending");
}

export function approvedFindingInputs(validation: ClaudeValidationResult, decisions: Record<string, FindingDecision>) {
  return validation.validations
    .filter((item) => decisions[item.finding.id]?.state === "approved")
    .map((item) => ({
      id: item.finding.id,
      finalComment: decisions[item.finding.id]?.finalComment || item.renderedComment || item.finding.comment_body
    }));
}

export function ReviewFindingsPanel({
  validation,
  decisions,
  onDecisionChange
}: {
  validation: ClaudeValidationResult;
  decisions: Record<string, FindingDecision>;
  onDecisionChange: (next: Record<string, FindingDecision>) => void;
}) {
  const [filter, setFilter] = useReviewFilter(validation);
  const visible = validation.validations.filter((item) => matchesFilter(item, decisions[item.finding.id], filter));

  function update(id: string, patch: Partial<FindingDecision>) {
    onDecisionChange({
      ...decisions,
      [id]: {
        state: decisions[id]?.state ?? "pending",
        finalComment: decisions[id]?.finalComment ?? "",
        ...patch
      }
    });
  }

  function updateMany(items: FindingValidation[], state: DecisionState) {
    const next = { ...decisions };
    for (const item of items) {
      next[item.finding.id] = {
        state,
        finalComment: next[item.finding.id]?.finalComment || item.renderedComment || item.finding.comment_body
      };
    }
    onDecisionChange(next);
  }

  return (
    <section className="review-panel" aria-label="Review findings">
      <div className="review-toolbar">
        <div className="filter-tabs" aria-label="Finding filters">
          {(["all", "ready", "needs-review", "rejected"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={filter === option ? "active" : ""}
              onClick={() => setFilter(option)}
            >
              {filterLabel(option)}
            </button>
          ))}
        </div>
        <div className="inline-actions">
          <button type="button" className="secondary" onClick={() => updateMany(validation.validations.filter((item) => item.status === "valid"), "approved")}>
            Approve all valid
          </button>
          <button type="button" className="secondary" onClick={() => updateMany(validation.validations.filter((item) => item.status === "invalid"), "rejected")}>
            Reject all invalid
          </button>
        </div>
      </div>
      <div className="finding-list">
        {visible.map((item) => {
          const decision = decisions[item.finding.id] ?? {
            state: "pending" as const,
            finalComment: item.renderedComment ?? item.finding.comment_body
          };
          const canApprove = item.status !== "invalid" && Boolean(item.anchorId);
          return (
            <article key={item.finding.id} className={`finding-card ${decision.state}`}>
              <div className="finding-head">
                <div>
                  <strong>{item.finding.id}</strong>
                  <span>{validationLabel(item.status)}</span>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!canApprove}
                    onClick={() => update(item.finding.id, { state: "approved" })}
                  >
                    Approve
                  </button>
                  <button type="button" className="secondary" onClick={() => update(item.finding.id, { state: "rejected" })}>
                    Reject
                  </button>
                </div>
              </div>
              <label className="field">
                <span>Edit final comment</span>
                <textarea
                  className="compact-textarea"
                  value={decision.finalComment}
                  onChange={(event) => update(item.finding.id, { finalComment: event.target.value })}
                />
              </label>
              <dl className="finding-meta">
                <div>
                  <dt>Evidence</dt>
                  <dd>{item.finding.evidence || "Not provided"}</dd>
                </div>
                <div>
                  <dt>Source location</dt>
                  <dd>{anchorLocation(item.finding.anchor)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{item.reason || validationLabel(item.status)}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function useReviewFilter(validation: ClaudeValidationResult): [Filter, (filter: Filter) => void] {
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    setFilter(validation.summary.invalid || validation.summary.attention ? "needs-review" : "all");
  }, [validation]);
  return [filter, setFilter];
}

function matchesFilter(item: FindingValidation, decision: FindingDecision | undefined, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return item.status === "valid";
  if (filter === "rejected") return item.status === "invalid" || decision?.state === "rejected";
  return item.status === "attention" || item.status === "invalid" || decision?.state === "pending";
}

function filterLabel(filter: Filter): string {
  if (filter === "ready") return "Ready to apply";
  if (filter === "needs-review") return "Needs review";
  if (filter === "rejected") return "Rejected";
  return "All";
}

function validationLabel(status: FindingValidation["status"]): string {
  if (status === "valid") return "Ready to apply";
  if (status === "attention") return "Needs review";
  return "Rejected";
}
