# Windows Packaging

Primary target: Windows desktop.

## Build Portable Windows Executable

```bash
npm install
npm run package:win
```

The command runs:

1. Regenerates the Windows app icon and splash assets.
2. TypeScript checking and schema static copy.
3. Bundled Electron main and preload build.
4. Vite renderer build.
5. `electron-builder --win portable --x64`.
6. Final size check against the `120 MiB` limit.

The output is one portable executable:

```text
release/windows-portable/HL Intelligence.exe
```

This executable requires no installer wizard, no MSI, and no adjacent application folder. Electron Builder still creates an intermediate `win-unpacked` staging folder for diagnostics under `release/windows-portable-staging`, but only the portable executable is copied to the final output directory.

Set `HL_WINDOWS_DOWNLOADS` to override the destination:

```text
HL_WINDOWS_DOWNLOADS=/mnt/c/Users/nicot/Downloads npm run package:win
```

## Runtime Expectations

- The application runs locally without installation.
- No internet connection is required for PDF processing after packaging.
- Native Windows file and folder dialogs are used through Electron.
- Generated files are written to user-selected folders.
- Source documents are never overwritten.

## Packaging Notes

- Runtime packaging uses an explicit allowlist: `dist/main/**`, `dist/preload/**`, `dist/renderer/**`, `dist/schemas/**`, and `package.json`.
- `skills/hl-commenter` is included exactly once as an extra resource.
- `build/hl-intelligence.ico` is included exactly once as an extra resource and is also embedded into the outer portable executable.
- `node_modules`, source maps, docs, tests, screenshots, brand guide PDFs, old release output, and duplicate `public/brand` resources are excluded from runtime packaging.
- Electron locales are limited to `en-US`.
- `scripts/check-windows-package-size.mjs` fails the package if `HL Intelligence.exe` exceeds `120 MiB`.

## Splash Screen

Startup uses two matched stages:

1. Native portable extraction splash from `build/portable-splash.bmp`.
2. Frameless animated Electron splash with the same layout and official Houlihan Lokey logo.

The main window stays hidden until Electron reports `ready-to-show` and the renderer sends `renderer:initial-ui-ready`, with a safe timeout fallback.

## Verification

```bash
npm run test
npm run smoke
npm run package:win
```

On Windows, verify the outer executable metadata and shell icon:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/verify-windows-exe-icon.ps1 -ExePath "release/windows-portable/HL Intelligence.exe"
```

The full audit and measured component sizes are in `docs/windows-portable-build.md`.
