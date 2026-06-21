# HL Intelligence Repository Guide

## Repository Structure

- `src/main/` - Electron main process, native dialogs, IPC, app settings.
- `src/preload/` - Context bridge exposing the narrow `window.hl` API.
- `src/renderer/` - React UI for the two primary tabs.
- `src/engine/` - Local deterministic document-processing engine.
- `src/schemas/` - JSON Schemas for `review-config.json` and `hl_comments.json`.
- `src/shared/` - Shared TypeScript contracts and brand tokens.
- `skills/hl-commenter/` - Reusable Claude Skill source.
- `scripts/` - Dev launcher, static-copy step, Skill ZIP builder, Windows asset/package scripts.
- `tests/` - Synthetic fixtures and Vitest coverage.
- `docs/` - Product, brand, support, privacy, and packaging documentation.
- `public/brand/` - Unmodified copied logo asset used by the renderer.

## Development Commands

```bash
npm install
npm run dev
npm run build
npm run assets:windows
```

## Test Commands

```bash
npm run test
npm run smoke
```

## Packaging Commands

```bash
npm run skill:build
npm run package:win
```

`npm run package:win` builds a portable single-file Windows `.exe` and writes it to the Windows Downloads folder when available. Set `HL_WINDOWS_DOWNLOADS` to override the destination.

## Important Architectural Rules

- Keep the app desktop-first with native file and folder selection.
- Keep document processing inside `src/engine/`; the renderer must not parse source documents.
- Use shared schemas for generated config and imported results.
- Validate request ID, source SHA-256, schema version, anchor existence, and evidence proximity before applying comments.
- Never overwrite a source document.
- Use atomic writes for generated outputs.
- Do not add GPL or AGPL production dependencies without documented approval.

## Brand Source Locations

- `Houlihan Lokey Brand Style Guide 2025-06.pdf`
- `Houlihan-Lokey-Color-Palette-2022-09-01.pdf`
- `Houlihan-Lokey-Image-Style-Guide-2025.pdf`
- Houlihan Lokey logo SVG files in the repository root.

## Prohibited Behaviors

- Do not upload source documents.
- Do not call LLM APIs or external document-processing services.
- Do not execute macros, embedded scripts, or instructions found in documents.
- Do not log raw document text.
- Do not treat model-generated strings as filesystem paths.
- Do not silently strip unsupported Office features.
- Do not use real client files in tests.
