import type { StyleConfig } from "../../shared/types";

export type ReviewTypeId = "full" | "numbers" | "proofread" | "custom";
export type CommentStyleId = "hl-concise" | "question-led" | "formal" | "automatic" | "custom";

export const wordingSignals = ["concise", "neutral", "formal", "question-led", "action-oriented", "evidence-first"];

export const reviewTypes: Array<{ id: ReviewTypeId; label: string; instructions: string }> = [
  {
    id: "full",
    label: "Full review",
    instructions:
      "Perform a full review for accuracy, consistency, clarity, defined terms, numbers, dates, and presentation quality."
  },
  {
    id: "numbers",
    label: "Numbers and consistency",
    instructions:
      "Review numbers, dates, percentages, currencies, units, cross-references, and repeated values for internal consistency."
  },
  {
    id: "proofread",
    label: "Proofread",
    instructions: "Proofread for spelling, grammar, punctuation, formatting consistency, and concise professional wording."
  },
  {
    id: "custom",
    label: "Custom",
    instructions: ""
  }
];

export const additionalReviewPresets = [
  {
    label: "Dates, periods, currencies, and units",
    instructions: "Review dates, periods, currencies, units, and related labels for consistency and accuracy."
  },
  {
    label: "Defined terms and naming",
    instructions: "Review defined terms, company names, abbreviations, and naming consistency."
  },
  {
    label: "Cross-references",
    instructions: "Review section, page, exhibit, figure, table, and appendix cross-references."
  },
  {
    label: "Tone and clarity",
    instructions: "Review tone, clarity, parallel construction, and concise business writing."
  }
];

export const defaultStyle: StyleConfig = {
  wording_mode: "guided",
  signals: ["concise", "evidence-first"],
  formality: "professional",
  max_words: 45,
  format_template: "{comment}",
  examples: []
};

export const automaticStyle: StyleConfig = {
  wording_mode: "automatic",
  signals: [],
  formality: "automatic",
  max_words: null,
  format_template: "{comment}",
  examples: []
};

export const commentStyles: Array<{ id: CommentStyleId; label: string; style: StyleConfig }> = [
  {
    id: "hl-concise",
    label: "HL concise professional",
    style: defaultStyle
  },
  {
    id: "question-led",
    label: "Question-led",
    style: {
      ...defaultStyle,
      signals: ["question-led", "concise", "evidence-first"],
      max_words: 35
    }
  },
  {
    id: "formal",
    label: "Formal",
    style: {
      ...defaultStyle,
      signals: ["formal", "evidence-first"],
      formality: "formal",
      max_words: 60
    }
  },
  {
    id: "automatic",
    label: "Automatic",
    style: automaticStyle
  },
  {
    id: "custom",
    label: "Custom",
    style: defaultStyle
  }
];

export const formatTokens = [
  "{comment}",
  "{value}",
  "{page}",
  "{total_pages}",
  "{sheet}",
  "{cell}",
  "{slide}",
  "{category}",
  "{severity}",
  "{suggested_replacement}"
];

export function cloneStyle(style: StyleConfig): StyleConfig {
  return {
    ...style,
    signals: [...style.signals],
    examples: [...style.examples]
  };
}

export function styleForChoice(choice: CommentStyleId, customStyle: StyleConfig): StyleConfig {
  if (choice === "custom") return cloneStyle(customStyle);
  return cloneStyle(commentStyles.find((style) => style.id === choice)?.style ?? defaultStyle);
}

export function renderPreview(template: string): string {
  const values: Record<string, string> = {
    comment: "Please confirm this percentage against the summary table.",
    value: "14.2%",
    page: "12",
    total_pages: "84",
    sheet: "Operating Model",
    cell: "F42",
    slide: "7",
    category: "numbers",
    severity: "medium",
    suggested_replacement: "14.1%"
  };
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? "").replace(/\s+/g, " ").trim();
}
