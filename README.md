# HL Intelligence

HL Intelligence is a local desktop application for deterministic document preparation and comment application. It does not call Claude, Gemini, ChatGPT, or any other LLM or external document-processing service.

The app has exactly two primary tabs:

- Commenter
- LLM Preflight

## Current Verified Scope

- PDF preflight to anchored Markdown
- Deterministic PDF visual-page detection
- PDF visual supplement generation
- Reusable HL Commenter Skill ZIP generation
- `review-config.json` generation and JSON Schema validation
- Claude-style `hl_comments.json` import and validation
- Native PDF comment/highlight output to a new file
- Multi-file PDF preflight queue

DOCX, XLSX, and PPTX adapters are structured as planned formats but are not labeled supported until extraction and output tests are added.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts Vite at `http://127.0.0.1:5173` and launches Electron against that local dev server.

## Build and Test

```bash
npm run build
npm run test
npm run skill:build
```

## Windows Packaging

```bash
npm run package:win
```

This runs the production build and invokes `electron-builder` for an unpacked Windows app folder. In WSL, the folder is written to `/mnt/c/Users/<you>/Downloads` when that folder is available.

The Windows package embeds the compact HL Intelligence app icon and opens an in-app splash while the workspace loads.

## Security Rules

- All document processing is local.
- Source documents are never uploaded by HL Intelligence.
- No LLM APIs are called.
- Source files are never overwritten.
- Comments are written to a new PDF.
- SHA-256 hashes are retained for round-trip validation.
- Raw document text is not logged.
- Macros and embedded scripts are never executed.
