# Final Architecture

This document records the Phase 1 architecture target for HL Intelligence.

## Product Boundary

- HL Intelligence remains a portable Electron desktop app.
- The app has exactly two primary tabs: Commenter and LLM Preflight.
- All document processing is local.
- The app does not call LLM APIs or remote document-processing services.
- The app does not add signing, MSI installation, cloud services, authentication, telemetry, or auto-update.

## Process Boundaries

- `src/renderer/` owns React UI state and invokes the narrow `window.hl` preload API.
- `src/preload/` exposes IPC methods through the context bridge only. The renderer has no Node integration.
- `src/main/` owns native dialogs, app windows, settings IPC, shell operations, trusted path registration, IPC sender/payload validation, and dispatch into engine workflows.
- `src/engine/` owns all document processing, validation, hashing, output paths, temporary files, and adapter dispatch.
- `src/shared/` owns versioned contracts used across renderer, main, engine, schemas, and tests.
- `resources/office/` contains the local PowerShell worker for Word, Excel, and PowerPoint probing, inspection, extraction, rendering, comment application, and output verification.

Renderer windows use context isolation, disabled Node integration, sandboxing, a strict Content Security Policy, blocked navigation, and blocked new-window creation.

## Security Boundary

- IPC handlers reject requests from anything other than the main renderer webContents.
- IPC payloads are parsed into typed inputs before engine dispatch.
- `openPath` is limited to user-selected inputs, approved output folders, and current-job outputs.
- File reads exposed to the renderer are bounded and limited to selected/generated text artifacts or dropped JSON imports.
- File signature checks sit in front of PDF and OOXML processing; extensions are not trusted alone.
- Safe limits cover source size, page/sheet/slide counts, JSON size, finding count, ZIP entry count, ZIP decompression ratio, and generated output size.

## Adapter Boundary

Document-format behavior is routed through `documentAdapterRegistry.get(documentType)`.

The shared adapter shape is:

```ts
interface DocumentAdapter {
  documentTypes: DocumentType[];
  inspect(...): Promise<DocumentInspection>;
  prepareDocument(...): Promise<PreparedDocument>;
  createReviewPackage(...): Promise<ReviewPackageResult>;
  validateFinding(...): FindingValidation | Promise<FindingValidation>;
  applyComments(...): Promise<CommentOutputResult>;
  verifyOutput(...): Promise<OutputVerification>;
}
```

PDF, DOCX, DOCM, XLSX, XLSM, PPTX, and PPTM adapters are registered.

## Shared Contracts

The shared document vocabulary includes:

- Document types: PDF, DOCX, DOCM, XLSX, XLSM, PPTX, PPTM.
- Anchors: `pdf_block`, `pdf_page`, `docx_paragraph`, `docx_table_cell`, `xlsx_cell`, `xlsx_range`, `pptx_shape`, `pptx_slide`.
- Versioned inspection, prepared-document, source-map, review-job, review-finding, validation, comment-output, output-verification, progress, and cancellation contracts.

Existing PDF review jobs remain schema version `1.0` and continue to validate.

## Job Foundation

Shared engine utilities now cover:

- SHA-256 hashing.
- Path-safe output naming and atomic output writes.
- Job-scoped temporary directories with cleanup.
- Staged final output files and staged review-package directories.
- Progress reporting.
- Cancellation tokens.
- Per-file error isolation.
- Metadata caching by path, size, and modification time.
- Configurable safe processing limits.
- PDF worker-thread dispatch and cleanup.

The metadata cache avoids repeated hash and inspection work for unchanged files during one app workflow.

## Office Foundation

The Office worker uses:

- PowerShell with `-NoProfile` and `-NonInteractive`.
- `shell: false`.
- Request and response JSON files.
- Operation timeouts.
- Temporary file cleanup.
- Hidden Word COM instances and hidden PowerPoint presentation windows when available.
- Hidden Excel instances.
- Macro automation security disabled before document open.
- Read-only source opening or temporary read-only source copies, no Add to Recent Files where the Office API exposes it, no link updates, and no prompts.
- Explicit COM cleanup and Office application quit in finally blocks.

Implemented Word, Excel, and PowerPoint operations are `probe`, `inspect`, `extract`, `render`, `apply-comments`, and `verify-output`.

Office commented outputs are written to same-folder staged paths, verified through Office, checked against the original source hash, and renamed into the final user-visible path only after verification succeeds.
