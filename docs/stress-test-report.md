# Stress Test Report

Last updated: June 22, 2026.

Artifacts are written outside the packaged runtime under `test-artifacts/final-qa/`.

## Commands

- `npm run test:stress`
- Optional native Office stress extension: `HL_NATIVE_OFFICE_STRESS=1 npm run test:stress`

The default stress command runs generated PDF and mixed-queue profiles. The optional native flag also runs the existing Excel and PowerPoint native stress suites when Microsoft Office is available.

## Results

Default stress pass:

- `tests/stress.test.ts`: 2 passed.
- 500-page PDF inspect and preflight: passed.
- 20-file mixed queue with duplicate names, Unicode paths, long paths, cancellation, repeat-after-cancel, and one corrupt input: passed.

Recorded metrics:

- 500-page PDF:
  - Elapsed: 828 ms.
  - Source size: 260,828 bytes.
  - RSS before: 158,601,216 bytes.
  - RSS after: 222,609,408 bytes.
  - Heap used before: 24,083,432 bytes.
  - Heap used after: 51,158,520 bytes.
- Mixed queue:
  - Files: 20.
  - Completed: 19.
  - Failed: 1 expected corrupt input.
  - Elapsed: 96 ms.
  - RSS at end: 224,444,416 bytes.
  - Heap used at end: 58,015,240 bytes.

Prior native Office stress hooks that remain available:

- Excel 50 sheets / 100,000 populated cells: previously passed in 162.13s with native Excel integration enabled.
- PowerPoint 200 mixed slides with cancellation, repeated runs, and process cleanup: previously passed in 87.94s with native PowerPoint integration enabled.

## What Was Verified

- Runtime-generated large PDF handling.
- Mixed queue partial-failure isolation.
- Duplicate filenames from different folders.
- Unicode and long-ish paths.
- Cancellation and repeat processing after cancellation.
- Successful files surviving another file's failure.
- Stress artifacts written outside packaged runtime.
- Memory observations did not show unbounded growth in the default profiles.

## Remaining Stress Gaps

- A native Word 250-page stress profile has not been implemented or run.
- The optional native Office stress extension was not rerun during the final serialized Office pass.
- Full UI responsiveness during the largest native Office stress profiles was not measured by an Electron automation harness.
- Long Windows paths beyond normal WSL path limits were not exhaustively tested.
