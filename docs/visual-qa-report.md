# Visual QA Report

Last updated: June 22, 2026.

Artifacts are stored under `test-artifacts/final-qa/visual/`.

## Command

`npm run test:ui:visual`

This command launches Electron through Playwright, captures screenshots, and writes `test-artifacts/final-qa/visual-qa-report.json`.

The visual-state matrix in `scripts/run-visual-qa.mjs` now covers the requested shell states, Commenter states, Preflight states, unsupported legacy state, and missing Office capability state through a separate `HL_VISUAL_QA=1` preload mock. The mock preload is built for local QA but excluded from the packaged Windows runtime.

On this WSL2 managed shell, Electron itself currently aborts before app startup with:

```text
FATAL:content/browser/sandbox_host_linux.cc:41 Check failed: . shutdown: Operation not permitted (1)
```

The same failure occurs when invoking `node_modules/electron/dist/electron --version`, before HL Intelligence code runs. This is documented as an environment limitation for the Linux/WSL visual run. The final Windows QA script includes the Electron visual command and fresh-folder launch checks for a native Windows run.

## Captured Screens

The last successful visual run before this environment limitation captured 7 screenshots:

- `splash.png`
- `main-shell-1440x900.png`
- `main-shell-1280x720.png`
- `minimum-layout-1040x720.png`
- `commenter-advanced-style.png`
- `preflight-empty-queue.png`
- `keyboard-focus-state.png`

Manual spot checks of the main shell and minimum layout screenshots showed the renderer loading correctly with no obvious overlap in those states.

## Defect Found And Fixed

Visual QA initially produced a blank main window because renderer sandboxing was enabled while the preload bundle was emitted as an ESM `.js` file. The sandboxed renderer did not expose `window.hl`, so the React app could not start.

Fixes applied:

- `scripts/build-main.mjs` now emits the preload bundle as CommonJS `.cjs`.
- `src/main/main.ts` now loads `dist/preload/preload.cjs`.
- `scripts/package-qa-check.mjs` verifies `dist/preload/preload.cjs`.

After rebuilding, Electron loaded the completed UI with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.

## Current Matrix Coverage

The current visual QA script drives and requires these states:

- Branded splash.
- Main shell at 1440x900, 1280x720, and 1040x720.
- Commenter Advanced controls.
- Review package success and review package action panel.
- Step 2 empty state.
- Valid result.
- Output success.
- Attention findings.
- Invalid result.
- Preflight empty queue.
- Mixed queue with PDF, Word, Excel, and PowerPoint formats.
- Progress state.
- Partial failure state.
- Unsupported legacy file.
- Missing Office capability.
- Keyboard focus state.

Windows display scaling at 100, 125, and 150 percent remains a native Windows QA item and is not independently verified by the current WSL2 run.

## Accessibility

`npm run test:ui` passed 11 React UI tests, including button accessible names, advanced-control labels/placeholders, reduced-motion CSS presence, and status announcement roles.

Accessibility remains partially verified. A full keyboard-only Electron pass, dialog focus-trapping pass, contrast audit, and assistive-technology status-announcement audit have not yet been completed.

## Status

Visual QA automation is implemented, but the current WSL2 execution environment cannot launch Electron. Treat visual screenshots, Windows scaling, taskbar/Alt+Tab icon appearance, and OS-modal picker visuals as final native Windows QA items.
