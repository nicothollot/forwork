import type { ClaudeFinding, SourceMap, StyleConfig } from "../shared/types.js";
import { DEFAULT_COMMENT_TEMPLATE, SUPPORTED_CUSTOM_TOKENS } from "./constants.js";

const tokenPattern = /\{([a-z_]+)\}/g;

export function validateTemplate(template: string): string[] {
  const errors: string[] = [];
  for (const match of template.matchAll(tokenPattern)) {
    if (!SUPPORTED_CUSTOM_TOKENS.includes(match[1] as never)) {
      errors.push(`Unsupported token: {${match[1]}}`);
    }
  }
  return errors;
}

export function maxWordsForLength(length: "brief" | "standard" | "detailed" | "automatic"): number | null {
  switch (length) {
    case "brief":
      return 25;
    case "standard":
      return 45;
    case "detailed":
      return 80;
    default:
      return null;
  }
}

export function normalizeStyle(style: Partial<StyleConfig>): StyleConfig {
  const signals = Array.isArray(style.signals) ? style.signals.filter(Boolean) : [];
  return {
    wording_mode: signals.length || style.formality !== "automatic" || style.max_words
      ? "guided"
      : style.wording_mode ?? "automatic",
    signals,
    formality: style.formality ?? "automatic",
    max_words: style.max_words ?? null,
    format_template: style.format_template?.trim() || DEFAULT_COMMENT_TEMPLATE,
    examples: Array.isArray(style.examples)
      ? style.examples.map((example) => example.trim()).filter(Boolean)
      : []
  };
}

export function renderComment(
  finding: ClaudeFinding,
  style: StyleConfig,
  sourceMap: SourceMap,
  anchorId?: string
): string {
  const anchor = anchorId ? sourceMap.anchors[anchorId] : undefined;
  const values: Record<string, string> = {
    comment: finding.comment_body ?? "",
    value: finding.value ?? "",
    page: String(anchorPage(finding.anchor) ?? anchor?.page ?? ""),
    total_pages: String(sourceMap.source.total_pages ?? ""),
    sheet: anchorSheet(finding.anchor),
    cell: anchorCell(finding.anchor),
    slide: anchorSlide(finding.anchor),
    category: finding.category ?? "",
    severity: finding.severity ?? "",
    suggested_replacement: finding.suggested_replacement ?? ""
  };

  const rendered = style.format_template.replace(tokenPattern, (_, key: string) => values[key] ?? "");
  return rendered.replace(/\s+/g, " ").replace(/\[\s*\]/g, "").trim();
}

export function normalizeForEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/(\p{L})-\s+(\p{Ll})/gu, "$1$2")
    .replace(/([$€£¥])\s+(\d)/g, "$1$2")
    .replace(/(\d)\s+(%)/g, "$1$2")
    .replace(/(\d),(\d{3})(\D|$)/g, "$1$2$3")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.%$€£¥'"-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function anchorPage(anchor: ClaudeFinding["anchor"]): number | undefined {
  return "page" in anchor ? anchor.page : undefined;
}

function anchorSheet(anchor: ClaudeFinding["anchor"]): string {
  return "sheet" in anchor ? anchor.sheet : "";
}

function anchorCell(anchor: ClaudeFinding["anchor"]): string {
  return "cell" in anchor ? anchor.cell : "range" in anchor ? anchor.range : "";
}

function anchorSlide(anchor: ClaudeFinding["anchor"]): string {
  return "slide" in anchor ? String(anchor.slide) : "";
}
