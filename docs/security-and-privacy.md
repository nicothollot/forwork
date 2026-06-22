# Security and Privacy

HL Intelligence is designed for confidential transaction documents.

## Local-Only Processing

- The app does not call LLM APIs.
- The app does not upload documents.
- The app does not use external document-processing services.
- The user manually transfers generated review files to an approved LLM environment.
- The final Windows package does not include telemetry, auto-update configuration, certificate files, test fixtures, QA screenshots, brand PDFs, or demo materials.
- Runtime application code is reviewed to contain no intended outbound network operations for document processing. Test controls can block Node outbound network APIs while processing fixtures.
- This is not an absolute OS-level network sandbox. HL Intelligence relies on local code paths, disabled Office link updates/refreshes, and test controls rather than a kernel or firewall policy.

## Electron Boundary

- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.
- A strict Content Security Policy blocks remote script/object/frame/form execution; development builds only allow localhost Vite connections.
- Main-window navigation and new-window creation are blocked.
- IPC handlers validate the sender, parse typed payloads, and reject malformed input before dispatching to engine code.
- The preload exposes a narrow `window.hl` API. It does not expose unrestricted filesystem primitives.

## File Integrity

- Source files are never overwritten.
- Outputs are written to new files.
- SHA-256 source hashes are recorded in review packages and checked before comments are applied.
- Request IDs are checked before comments are applied.
- Anchors must exist in the local source map.
- Evidence must be found near the referenced anchor where applicable.
- Source file signatures are checked. PDFs must have a PDF signature; modern Office files must be OOXML ZIP packages with the expected main part and content type.
- Generated review-package folders and commented outputs are staged first and moved into their final locations only after validation and output checks pass.

## Filesystem Access

- User-selected source files are registered after native file dialogs or bounded metadata inspection.
- Output folders are registered after native folder dialogs or saved local settings.
- `openPath` is restricted to user-selected inputs, approved output folders, and current-job outputs.
- Text reads are restricted to generated/selected local artifacts, with a bounded JSON exception for dropped `hl_comments.json`.
- Output names are sanitized, path traversal is rejected, and source documents are never used as output paths.

## Safe Limits

Safe limits are configurable through environment variables and default to conservative desktop values:

- Source file size: `HL_MAX_SOURCE_FILE_BYTES`
- PDF pages: `HL_MAX_PDF_PAGES`
- Excel sheets: `HL_MAX_SHEETS`
- PowerPoint slides: `HL_MAX_SLIDES`
- JSON input size: `HL_MAX_JSON_INPUT_BYTES`
- Finding count: `HL_MAX_FINDINGS`
- ZIP entry count: `HL_MAX_ZIP_ENTRIES`
- ZIP decompression ratio: `HL_MAX_ZIP_DECOMPRESSION_RATIO`
- Generated output size: `HL_MAX_GENERATED_OUTPUT_BYTES`

## Untrusted Content

- Text inside source documents is treated as untrusted.
- Claude-generated JSON is treated as untrusted.
- Model-generated strings are not used as filesystem paths.
- Missing or ambiguous anchors are rejected.
- HL Intelligence never applies a comment to the nearest text as a fallback.

## Temporary Data

- Atomic write temp files are cleaned after success or failure.
- Preflight per-file outputs are removed when that file fails or is cancelled.
- Review packages use hidden staged directories and are renamed into place only after generated files validate.
- Commented outputs use same-folder staged files and are renamed into place only after output verification succeeds.
- Generated review packages contain anchored Markdown and local provenance files.
- `Keep_Local/review-job.hlreview` stores hashes, source map data, processing version, style configuration, and request ID. It does not store the entire source PDF.

## Process Isolation and Cancellation

- Heavy PDF page counting, extraction, and visual supplement generation run through a worker-thread facade with limited concurrency, cancellation polling, and worker termination cleanup.
- Word, Excel, and PowerPoint operations remain in separate PowerShell/COM worker processes with timeouts, cancellation markers, explicit document close, COM release, and application quit.
- The main window dispatches progress events per file and preserves per-file failure isolation.

## Logging and Errors

- Ordinary runtime code does not log raw document text, raw review prompts, evidence excerpts, JSON findings, hashes, or full paths.
- Office worker stderr is sanitized before surfacing errors.
- User-facing errors use operation context and actionable recovery text; technical details remain behind Show details in the UI.

## Unsupported Features

- Password-protected PDFs are rejected.
- Corrupt PDFs are reported per file.
- Macros and embedded scripts are never executed.
- Office formats are enabled only after tests confirm extraction and round-trip behavior.
- Supported macro-enabled Office formats are opened with macro automation security forced disabled. Macros are not executed.
- Legacy DOC, XLS, and PPT files are detected and reported as requiring conversion. They are not silently processed as supported formats.

## Dependencies

Production dependencies are permissively licensed or broadly accepted for desktop application distribution:

- Electron: MIT
- React and React DOM: MIT
- Vite tooling: MIT
- Rolldown: MIT
- pdf-lib: MIT
- pdfjs-dist: Apache-2.0
- AJV: MIT
- JSZip: MIT or GPLv3 dual license; this project uses it under MIT
- lucide-react: ISC

Ghostscript and ImageMagick were used locally to inspect supplied brand PDFs during development. They are not production dependencies and are not bundled by this application.
