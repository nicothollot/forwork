import path from "node:path";
import type {
  AppSettings,
  CreateCommentedPdfInput,
  PrepareReviewInput,
  PreflightGenerateInput,
  ProcessingMode,
  StyleConfig
} from "../shared/types.js";

const MODES: ProcessingMode[] = ["text-only", "text-visual", "text-all-pages"];

export function assertTrustedIpcSender(input: { senderId: number; mainSenderId: number | null; senderUrl: string }): void {
  if (!input.mainSenderId || input.senderId !== input.mainSenderId) {
    throw new Error("IPC request rejected because it did not originate from the main application window.");
  }
  if (/^(https?:|file:)/i.test(input.senderUrl) || input.senderUrl === "") return;
  throw new Error("IPC request rejected because the sender URL is not trusted.");
}

export function parseStringPayload(value: unknown, label = "value"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid IPC payload: ${label} must be a non-empty string.`);
  return value;
}

export function parseOptionalSkillBuildInput(value: unknown): { outputPath?: string; defaultFolder?: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const object = plainObject(value, "skill build input");
  return {
    outputPath: optionalString(object.outputPath, "outputPath"),
    defaultFolder: optionalString(object.defaultFolder, "defaultFolder")
  };
}

export function parseValidateSourceInput(value: unknown): { localJobPath: string; sourcePath: string } {
  const object = plainObject(value, "source validation input");
  return {
    localJobPath: requiredString(object.localJobPath, "localJobPath"),
    sourcePath: requiredString(object.sourcePath, "sourcePath")
  };
}

export function parseValidateClaudeInput(value: unknown): { localJobPath: string; jsonText: string } {
  const object = plainObject(value, "Claude validation input");
  return {
    localJobPath: requiredString(object.localJobPath, "localJobPath"),
    jsonText: requiredString(object.jsonText, "jsonText", false)
  };
}

export function parsePrepareReviewInput(value: unknown): PrepareReviewInput {
  const object = plainObject(value, "prepare review input");
  return {
    sourcePath: requiredString(object.sourcePath, "sourcePath"),
    outputFolder: requiredString(object.outputFolder, "outputFolder"),
    reviewInstructions: requiredString(object.reviewInstructions, "reviewInstructions", false),
    style: parseStyleConfig(object.style),
    forceVisualSupplement: optionalBoolean(object.forceVisualSupplement, "forceVisualSupplement")
  };
}

export function parseCreateCommentedInput(value: unknown): CreateCommentedPdfInput {
  const object = plainObject(value, "comment output input");
  return {
    sourcePath: requiredString(object.sourcePath, "sourcePath"),
    localJobPath: requiredString(object.localJobPath, "localJobPath"),
    claudeJsonText: optionalString(object.claudeJsonText, "claudeJsonText", false),
    claudeJsonPath: optionalString(object.claudeJsonPath, "claudeJsonPath"),
    outputFolder: requiredString(object.outputFolder, "outputFolder"),
    outputFilename: optionalString(object.outputFilename, "outputFilename"),
    approvedFindings: Array.isArray(object.approvedFindings)
      ? object.approvedFindings.map((item, index) => {
          const finding = plainObject(item, `approvedFindings[${index}]`);
          return {
            id: requiredString(finding.id, `approvedFindings[${index}].id`),
            finalComment: optionalString(finding.finalComment, `approvedFindings[${index}].finalComment`, false)
          };
        })
      : undefined
  };
}

export function parsePreflightGenerateInput(value: unknown): PreflightGenerateInput {
  const object = plainObject(value, "preflight input");
  const files = Array.isArray(object.files) ? object.files : invalid("files must be an array");
  return {
    jobId: requiredString(object.jobId, "jobId"),
    outputFolder: requiredString(object.outputFolder, "outputFolder"),
    files: files.map((item, index) => {
      const file = plainObject(item, `files[${index}]`);
      const mode = requiredString(file.mode, `files[${index}].mode`) as ProcessingMode;
      if (!MODES.includes(mode)) throw new Error(`Invalid IPC payload: files[${index}].mode is not supported.`);
      return {
        path: requiredString(file.path, `files[${index}].path`),
        mode
      };
    }),
    options: parsePreflightOptions(object.options)
  };
}

export function parseSettings(value: unknown): AppSettings {
  const object = plainObject(value, "settings");
  const settings: AppSettings = {};
  const lastOutputFolder = optionalString(object.lastOutputFolder, "lastOutputFolder");
  if (lastOutputFolder) settings.lastOutputFolder = lastOutputFolder;
  if (typeof object.skillInstalled === "boolean") settings.skillInstalled = object.skillInstalled;
  if (object.commenter !== undefined) {
    const commenter = plainObject(object.commenter, "settings.commenter");
    settings.commenter = {
      selectedCommentStyle: optionalString(commenter.selectedCommentStyle, "selectedCommentStyle"),
      customStyle: commenter.customStyle ? parseStyleConfig(commenter.customStyle) : undefined,
      savedStylePresets: Array.isArray(commenter.savedStylePresets)
        ? commenter.savedStylePresets.map((item, index) => {
            const preset = plainObject(item, `savedStylePresets[${index}]`);
            return {
              id: requiredString(preset.id, `savedStylePresets[${index}].id`),
              name: requiredString(preset.name, `savedStylePresets[${index}].name`),
              style: parseStyleConfig(preset.style)
            };
          })
        : undefined
    };
  }
  return settings;
}

export class TrustedPathRegistry {
  private readonly inputs = new Set<string>();
  private readonly outputFolders = new Set<string>();
  private readonly jobOutputs = new Set<string>();
  private readonly readableTextFiles = new Set<string>();

  registerInput(filePath: string): void {
    this.inputs.add(normalize(filePath));
  }

  registerOutputFolder(folderPath: string): void {
    this.outputFolders.add(normalize(folderPath));
  }

  registerReadableTextFile(filePath: string): void {
    this.readableTextFiles.add(normalize(filePath));
  }

  registerJobOutput(filePath: string): void {
    this.jobOutputs.add(normalize(filePath));
  }

  registerReviewPackage(result: { outputRoot: string; promptPath: string; localJobPath: string; markdownPath: string; visualPdfPath: string | null; reviewConfigPath: string }): void {
    this.registerJobOutput(result.outputRoot);
    this.registerJobOutput(result.markdownPath);
    this.registerJobOutput(result.reviewConfigPath);
    this.registerJobOutput(result.promptPath);
    this.registerJobOutput(result.localJobPath);
    if (result.visualPdfPath) this.registerJobOutput(result.visualPdfPath);
    this.registerReadableTextFile(result.promptPath);
    this.registerReadableTextFile(result.localJobPath);
  }

  registerCommentOutput(result: { outputPath: string; reportPath: string }): void {
    this.registerJobOutput(result.outputPath);
    this.registerJobOutput(result.reportPath);
    this.registerReadableTextFile(result.reportPath);
  }

  registerPreflightResult(result: { outputFolder: string; markdownPath: string; visualPdfPath: string | null; manifestPath: string; status: string }): void {
    if (result.status !== "complete") return;
    this.registerJobOutput(result.outputFolder);
    this.registerJobOutput(result.markdownPath);
    this.registerJobOutput(result.manifestPath);
    if (result.visualPdfPath) this.registerJobOutput(result.visualPdfPath);
  }

  assertCanOpen(targetPath: string): void {
    const target = normalize(targetPath);
    if (this.inputs.has(target) || this.jobOutputs.has(target)) return;
    if ([...this.outputFolders].some((folder) => isInsideOrSame(folder, target))) return;
    throw new Error("Opening that path is not allowed. Use a selected input, current job output, or approved output folder.");
  }

  assertCanReadText(targetPath: string): void {
    const target = normalize(targetPath);
    if (this.readableTextFiles.has(target) || this.jobOutputs.has(target)) return;
    throw new Error("Reading that text file is not allowed. Select or generate it through HL Intelligence first.");
  }
}

function parsePreflightOptions(value: unknown): PreflightGenerateInput["options"] {
  if (value === undefined || value === null) return {};
  const object = plainObject(value, "preflight options");
  return {
    forceVisualSupplement: optionalBoolean(object.forceVisualSupplement, "forceVisualSupplement"),
    preserveExistingComments: optionalBoolean(object.preserveExistingComments, "preserveExistingComments"),
    runLocalOcr: optionalBoolean(object.runLocalOcr, "runLocalOcr")
  };
}

function parseStyleConfig(value: unknown): StyleConfig {
  const object = plainObject(value, "style");
  const wordingMode = requiredString(object.wording_mode, "style.wording_mode") as StyleConfig["wording_mode"];
  const formality = requiredString(object.formality, "style.formality") as StyleConfig["formality"];
  if (!["automatic", "guided"].includes(wordingMode)) throw new Error("Invalid IPC payload: style.wording_mode is not supported.");
  if (!["automatic", "professional", "formal"].includes(formality)) throw new Error("Invalid IPC payload: style.formality is not supported.");
  return {
    wording_mode: wordingMode,
    signals: Array.isArray(object.signals) ? object.signals.map((item, index) => requiredString(item, `style.signals[${index}]`)) : [],
    formality,
    max_words: object.max_words === null || object.max_words === undefined ? null : positiveNumber(object.max_words, "style.max_words"),
    format_template: requiredString(object.format_template, "style.format_template", false),
    examples: Array.isArray(object.examples) ? object.examples.map((item, index) => requiredString(item, `style.examples[${index}]`, false)) : []
  };
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid IPC payload: ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, requireContent = true): string {
  if (typeof value !== "string") throw new Error(`Invalid IPC payload: ${label} must be a string.`);
  if (requireContent && !value.trim()) throw new Error(`Invalid IPC payload: ${label} must not be empty.`);
  return value;
}

function optionalString(value: unknown, label: string, requireContent = true): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, requireContent);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid IPC payload: ${label} must be a boolean.`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid IPC payload: ${label} must be a positive number.`);
  }
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid IPC payload: ${message}.`);
}

function normalize(filePath: string): string {
  return path.resolve(filePath);
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
