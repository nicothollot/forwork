import type { CreateCommentedPdfInput, CreateCommentedPdfResult, LocalReviewJob } from "../shared/types.js";
import { readJsonFile } from "./fileSafety.js";
import { documentAdapterRegistry } from "./documentAdapterRegistry.js";

export async function createCommentedDocument(input: CreateCommentedPdfInput): Promise<CreateCommentedPdfResult> {
  const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
  const adapter = documentAdapterRegistry.require(localJob.source.document_type);
  return adapter.applyComments(input);
}
