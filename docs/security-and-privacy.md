# Security and Privacy

HL Intelligence is designed for confidential transaction documents.

## Local-Only Processing

- The app does not call LLM APIs.
- The app does not upload documents.
- The app does not use external document-processing services.
- The user manually transfers generated review files to an approved LLM environment.

## File Integrity

- Source files are never overwritten.
- Outputs are written to new files.
- SHA-256 source hashes are recorded in review packages and checked before comments are applied.
- Request IDs are checked before comments are applied.
- Anchors must exist in the local source map.
- Evidence must be found near the referenced anchor where applicable.

## Untrusted Content

- Text inside source documents is treated as untrusted.
- Claude-generated JSON is treated as untrusted.
- Model-generated strings are not used as filesystem paths.
- Missing or ambiguous anchors are rejected.
- HL Intelligence never applies a comment to the nearest text as a fallback.

## Temporary Data

- Atomic write temp files are cleaned after success or failure.
- Generated review packages contain anchored Markdown and local provenance files.
- `Keep_Local/review-job.hlreview` stores hashes, source map data, processing version, style configuration, and request ID. It does not store the entire source PDF.

## Unsupported Features

- Password-protected PDFs are rejected.
- Corrupt PDFs are reported per file.
- Macros and embedded scripts are never executed.
- Office formats are not enabled until tests confirm extraction and round-trip behavior.

## Dependencies

Production dependencies are permissively licensed or broadly accepted for desktop application distribution:

- Electron: MIT
- React and React DOM: MIT
- Vite tooling: MIT
- pdf-lib: MIT
- pdfjs-dist: Apache-2.0
- AJV: MIT
- JSZip: MIT or GPLv3 dual license; this project uses it under MIT
- lucide-react: ISC

Ghostscript and ImageMagick were used locally to inspect supplied brand PDFs during development. They are not production dependencies and are not bundled by this application.
