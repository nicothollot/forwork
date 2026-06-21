export function extractJsonObject(input: string): { jsonText: string; ignoredExtraText: boolean } {
  const text = input.trim();
  if (!text) throw new Error("No JSON was provided.");

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text;
  const balanced = findBalancedObject(candidate);
  if (!balanced) throw new Error("Could not locate a JSON object.");
  const ignoredExtraText = balanced.start > 0 || balanced.end < candidate.trimEnd().length || Boolean(fenceMatch);
  return { jsonText: balanced.text, ignoredExtraText };
}

function findBalancedObject(text: string): { text: string; start: number; end: number } | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { text: text.slice(start, index + 1), start, end: index + 1 };
      }
    }
  }
  return null;
}
