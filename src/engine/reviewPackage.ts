import type { PrepareReviewInput, ReviewPackageResult } from "../shared/types.js";
import { documentSupportForPath, documentTypeForPath } from "./documentDetection.js";
import { documentAdapterRegistry } from "./documentAdapterRegistry.js";
import { verifyDocumentSignature } from "./documentSignatures.js";
import { assertSourceFileWithinLimits } from "./safetyLimits.js";

export async function prepareReviewPackage(input: PrepareReviewInput): Promise<ReviewPackageResult> {
  const documentType = documentTypeForPath(input.sourcePath);
  if (!documentType) {
    throw new Error(documentSupportForPath(input.sourcePath).message);
  }
  const adapter = documentAdapterRegistry.get(documentType);
  if (!adapter) {
    throw new Error(documentSupportForPath(input.sourcePath).message);
  }
  await assertSourceFileWithinLimits(input.sourcePath);
  await verifyDocumentSignature(input.sourcePath, documentType);
  return adapter.createReviewPackage(input);
}
