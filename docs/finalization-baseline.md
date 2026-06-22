# Finalization Baseline

Recorded during Phase 1 on 2026-06-21 from `/home/nicot/dev/forwork`.

## Initial Repository State

- `git status --short`: clean.
- Existing portable executable: `release/windows-portable/HL Intelligence.exe`.
- Initial executable inspection: PE32 GUI Windows executable, Nullsoft Installer self-extracting archive.
- Initial executable size: `83,495,733` bytes, `79.6 MiB`.
- Size guard result: `79.6 MiB`, under the `120 MiB` limit.

## Initial Verified Support

- PDF preflight to anchored Markdown.
- PDF visual-page detection and visual supplement generation.
- PDF review package generation.
- `review-config.json` schema validation.
- `hl_comments.json` import and validation.
- Native PDF comment/highlight output to a new file.
- Multi-file PDF preflight with per-file failure isolation.
- Skill ZIP generation.
- Portable Windows package generation.

## Initial Planned or Unsupported Support

- DOCX, XLSX, and PPTX were documented as planned, not supported.
- Macro-enabled Office files were not represented in shared types yet.
- Legacy DOC, XLS, and PPT did not have a shared conversion-required contract yet.
- The renderer and IPC exposed document pickers for PDF and modern Office extensions, but processing remained PDF-only.

## Initial Check Results

- `npx tsc -p tsconfig.node.json --noEmit`: passed.
- `npx tsc -p tsconfig.json --noEmit`: failed before Phase 1 edits.
  - `src/engine/schemaValidation.ts`: plain Node typings did not include Electron `process.resourcesPath`.
  - `src/renderer/App.tsx`: one drop-zone callback could return `""`.
- `npm run test`: passed, 2 files, 16 tests.
- `npm run build`: passed.
- `npm run skill:build`: passed, created `HL-Commenter-Skill.zip`.
- `npm run package:win`: passed, created `release/windows-portable/HL Intelligence.exe`.

## Initial Build Hygiene Gaps

- `package-lock.json` was ignored and absent.
- There was no exact dependency lockfile.
- Clean verification did not use `npm ci`.
- `scripts/build-main.mjs` directly imported `rolldown`, but `rolldown` was only available through transitive dependency hoisting.

## Phase 1 Scope Boundary

This baseline intentionally does not claim Word, Excel, or PowerPoint adapter support. Phase 1 only records the state, adds shared contracts and registry foundations, and keeps the existing PDF behavior intact.
