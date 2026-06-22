import { stat } from "node:fs/promises";
import path from "node:path";
import type { FileMetadata } from "../shared/types.js";
import { documentSupportForExtension } from "../shared/documentTypes.js";
import { documentAdapterRegistry } from "./documentAdapterRegistry.js";
import { cachedSha256File, workflowMetadataCache } from "./jobFoundation.js";

export async function getFileMetadata(filePath: string, includeHash = false): Promise<FileMetadata> {
  const metadata = await workflowMetadataCache.get<FileMetadata>(filePath, async () => {
    const info = await stat(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const support = documentSupportForExtension(extension);
    const metadata: FileMetadata = {
      path: filePath,
      name: path.basename(filePath),
      extension,
      type: support.documentType ?? "unsupported",
      supportStatus: support.status,
      supportMessage: support.message,
      sizeBytes: info.size
    };

    const documentType = support.documentType;
    const adapter = documentType ? documentAdapterRegistry.get(documentType) : undefined;
    if (adapter) {
      try {
        const inspection = await adapter.inspect({ sourcePath: filePath, includeHash });
        metadata.count = inspection.counts.pages ?? inspection.counts.slides ?? inspection.counts.sheets ?? inspection.counts.sections;
        metadata.countLabel = countLabel(inspection.counts);
        metadata.sha256 = inspection.sha256;
      } catch (error) {
        metadata.countLabel = error instanceof Error ? error.message : `Could not read ${documentType?.toUpperCase() ?? "document"}`;
      }
    } else if (support.status === "planned") {
      metadata.countLabel = "Adapter planned; not yet verified";
    } else if (support.status === "legacy-conversion-required") {
      metadata.countLabel = "Convert to a modern Office format first";
    }

    if (includeHash && !metadata.sha256) metadata.sha256 = await cachedSha256File(filePath);
    return metadata;
  });
  if (includeHash && !metadata.sha256) metadata.sha256 = await cachedSha256File(filePath);
  return metadata;
}

function countLabel(counts: { pages?: number; slides?: number; sheets?: number; sections?: number }): string | undefined {
  if (counts.pages) return `${counts.pages} page${counts.pages === 1 ? "" : "s"}`;
  if (counts.slides) return `${counts.slides} slide${counts.slides === 1 ? "" : "s"}`;
  if (counts.sheets) return `${counts.sheets} sheet${counts.sheets === 1 ? "" : "s"}`;
  if (counts.sections) return `${counts.sections} section${counts.sections === 1 ? "" : "s"}`;
  return undefined;
}
