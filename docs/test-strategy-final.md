# Final QA Test Strategy

Last updated: June 22, 2026.

## Goal

Phase 8 verification is intended to prove that HL Intelligence preserves the completed banker workflow while hardening invisible behavior: local-only processing, renderer isolation, safe IPC, process cleanup, cancellation, bounded inputs, atomic outputs, and predictable failure handling.

All fixtures are synthetic. Real client documents are not used.

## Commands

Use these noninteractive commands:

- `npm run typecheck` - Node/Electron, renderer, and shared TypeScript checks.
- `npm run lint` - currently aliases `typecheck`.
- `npm run test:unit` - foundation, security hardening, no-network, and Office worker hardening tests.
- `npm run test:integration` - PDF, Word, Excel, and PowerPoint engine tests with native Office tests skipped unless their integration flags are set.
- `npm run test:office` - serialized native Word, Excel, and PowerPoint integration tests plus Office worker cleanup tests.
- `npm run test:ui` - React UI and accessibility-oriented component tests.
- `npm run test:ui:visual` - Electron/Playwright screenshot capture. The requested visual-state matrix is implemented; the current WSL2 shell cannot launch Electron because the Linux Electron binary aborts before app startup in the sandbox host.
- `npm run test:stress` - runtime-generated stress checks for PDF and mixed queues. Set `HL_NATIVE_OFFICE_STRESS=1` to include existing native Excel and PowerPoint stress suites.
- `npm run test:package` - build/package-layout QA without producing the final Windows executable.
- `npm run final:verify` - sequential aggregate runner for all applicable checks. In this WSL2 shell it stops at `test:ui:visual` because Electron cannot launch in the environment, not because of a known app-state regression.

Final distribution packaging was not run in this Phase 8 QA session.

## Phase 7 Caveat Closure

Native Office availability was verified on this machine:

- Microsoft Word: version `16.0`.
- Microsoft Excel: version `16.0`, build `20026`.
- Microsoft PowerPoint: version `16.0`, build `20026`.

`npm run test:office` now runs Office suites serially to avoid COM startup contention. The latest aggregate `final:verify` native run passed:

- `tests/office-hardening.test.ts`: 3 passed, about 5.48s.
- `tests/word-engine.test.ts`: 3 passed, about 143.08s.
- `tests/excel-engine.test.ts`: 4 passed, about 116.54s.
- `tests/powerpoint-engine.test.ts`: 4 passed, about 141.54s.

Process cleanup was checked after the native run. No new `EXCEL.EXE`, `POWERPNT.EXE`, PDF worker, Vitest, Electron, or Office-worker processes remained. A set of `WINWORD.EXE /Automation -Embedding` and `powershell.exe` processes existed before this pass and still exists afterward; those are documented as a pre-existing environment limitation rather than a new test leak.

Office crash and timeout cleanup are covered with a fake local worker in `tests/office-hardening.test.ts`. That test exercises timeout, crash, temp-directory removal, and path-sanitized error reporting through the same `runOfficeWorker` client cleanup path. Native Office crash injection was not automated because forcibly crashing the installed Office applications would affect unrelated user state on this machine.

## Fixture Coverage

The repository now covers broad synthetic fixture behavior without committing large binaries:

- PDF: text, columns, tables, vector charts, raster images, scans, rotation, crop boxes, existing annotations, forms/bookmark verification where exposed, corruption, unsupported signatures, queue cancellation, atomic output, and visual supplements.
- Word: sections, headers/footers, tables, footnotes/endnotes, existing comments, track-change metadata, images/shapes/charts, columns, DOCM package handling, corruption/password classification, comments, and source immutability.
- Excel: formulas, number formats, dates, tables, named ranges, hidden sheets, charts, comments/notes, external links, XLSM package handling, corruption/password classification, large-range summarization, and source immutability.
- PowerPoint: masters/layout metadata, charts, tables, images, notes, hidden slides, existing comments, animation metadata where exposed, PPTM package handling, corruption/password classification, native comments, and source immutability.

Known fixture limitations remain:

- Real encrypted Office fixtures were not produced because local Office password-save automation was not reliable in this environment.
- Real VBA macro project fixtures depend on Office Trust Center access to the VBA project object model. Macro preservation code is implemented when `vbaProject.bin` exists, but the synthetic local fixtures may not contain a real VBA project on locked-down Office installs.
- Native Word 250-page stress is not yet implemented as a dedicated stress profile.

## Round-Trip Coverage

The integration suites exercise inspect, preflight/review-package generation, JSON result validation, finding approval, comment application, output reopening, output verification, and source-byte immutability across supported formats.

The native Office suites confirm that Word, Excel, and PowerPoint outputs reopen through COM and contain expected comments/structure. PDF tests verify native annotations, highlights, supplement mapping, output integrity, page geometry, and source immutability.

Document visual-fidelity comparison is partial. PDF output integrity checks verify intended annotations and geometry. Office-to-PDF before/after visual comparison is not yet a complete automated gate for Word, Excel, and PowerPoint.

## Security And Failure Controls

The suite covers:

- IPC sender rejection and invalid payloads.
- Path traversal and restricted `openPath`.
- Unsupported file signatures.
- Oversized JSON and excessive findings.
- ZIP entry count and decompression-ratio protections.
- No-network controls around document processing.
- PDF worker cancellation and termination.
- Office worker timeout/crash cleanup through the process client.
- Partial failure isolation and repeat processing after cancellation.
- Source modification after package creation.
- Atomic output completion and corrupt-output recovery paths.

Sensitive logging expectations are documented in `docs/security-and-privacy.md`. Tests assert sanitized Office worker errors and no intended network operations from document-processing code; no OS-level network sandbox is claimed.

## Current Status

The core nonvisual verification commands pass. Native Office integration passes on the installed Office build. Package-layout QA passes without final distribution packaging.

Full native Windows QA still needs direct visual observation for screenshots, Windows scaling at 100/125/150 percent, taskbar/Alt+Tab icons, and OS picker behavior. Native Word stress is missing, and full Office visual-fidelity PDF comparison is not yet an automated gate.
