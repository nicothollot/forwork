export const PROCESSING_VERSION = "hl-intelligence-pdf-0.1.0";

export const SUPPORTED_EXTENSIONS = new Set([".pdf"]);

export const SUPPORTED_CUSTOM_TOKENS = [
  "comment",
  "value",
  "page",
  "total_pages",
  "sheet",
  "cell",
  "slide",
  "category",
  "severity",
  "suggested_replacement"
] as const;

export const DEFAULT_COMMENT_TEMPLATE = "{comment}";

export const FORMAT_PRESETS = {
  "Comment only": "{comment}",
  "Value first": "[{value}] {comment}",
  "Page reference": "{comment} - Page {page}/{total_pages}",
  "Value and page": "[{value}] {comment} - Page {page}/{total_pages}",
  "Issue and action": "[{category}] {comment} Suggested: {suggested_replacement}"
} as const;
