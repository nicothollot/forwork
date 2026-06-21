import Ajv2020Module from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeResult, ReviewConfig } from "../shared/types.js";

const Ajv2020 = (Ajv2020Module as any).default ?? Ajv2020Module;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatorCache = new Map<string, any>();

async function readSchema(name: string): Promise<unknown> {
  const candidates = [
    path.join(process.cwd(), "src", "schemas", name),
    path.join(process.cwd(), "dist", "schemas", name),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "dist", "schemas", name),
    path.join(process.resourcesPath ?? "", "dist", "schemas", name)
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch {
      // Try the next runtime location.
    }
  }
  throw new Error(`Unable to load schema ${name}.`);
}

async function validateWithSchema<T>(name: string, value: unknown): Promise<{ ok: boolean; errors: string[]; value?: T }> {
  const schema = await readSchema(name);
  const schemaId = typeof schema === "object" && schema && "$id" in schema ? String((schema as any).$id) : name;
  let validate = validatorCache.get(schemaId);
  if (!validate) {
    validate = ajv.getSchema(schemaId) ?? ajv.compile(schema);
    validatorCache.set(schemaId, validate);
  }
  const ok = validate(value);
  if (ok) return { ok: true, errors: [], value: value as T };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((error: any) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
  };
}

export function resetSchemaCacheForTests(): void {
  ajv.removeSchema();
  validatorCache.clear();
}

export async function validateReviewConfig(value: unknown): Promise<{ ok: boolean; errors: string[]; value?: ReviewConfig }> {
  return validateWithSchema<ReviewConfig>("review-config.schema.json", value);
}

export async function validateReviewOutput(value: unknown): Promise<{ ok: boolean; errors: string[]; value?: ClaudeResult }> {
  return validateWithSchema<ClaudeResult>("review-output.schema.json", value);
}
