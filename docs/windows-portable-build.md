# Windows Portable Build Audit

Measured on 2026-06-21 from the local repository in WSL, with the final executable verified on Windows.

## Baseline

The previous `npm run package:win` flow generated Windows assets, ran the production build, invoked Electron Builder's `dir` target, and copied an unpacked application folder. It did not produce a true one-file portable application as the final deliverable.

Previous packaging settings included `dist/**`, `public/**`, `skills/**`, and `package.json` in `files`, then added `skills/hl-commenter`, `public/brand`, and icon files again as `extraResources`. Runtime dependencies were left in production `dependencies`, so Electron Builder packaged full `node_modules` trees.

Baseline sizes:

- Unpacked application folder: `469M`
- User-facing inner executable in that folder: `232,385,024` bytes
- `resources/app.asar`: `85,503,390` bytes
- `resources` directory: `115M`
- Existing generated NSIS payload from older output, when present: `123,414,075` bytes for `hl-intelligence-0.1.0-x64.nsis.7z`

Largest baseline packaged components:

- `HL Intelligence.exe`: `232,385,024` bytes
- `resources/app.asar`: `85,503,390` bytes
- `dxcompiler.dll`: `25,634,304` bytes
- `LICENSES.chromium.html`: `20,367,095` bytes
- `icudtl.dat`: `10,876,560` bytes
- `libGLESv2.dll`: `8,000,512` bytes
- `resources.pak`: `6,876,399` bytes
- `vk_swiftshader.dll`: `5,520,384` bytes
- `d3dcompiler_47.dll`: `4,741,488` bytes
- `ffmpeg.dll`: `3,057,152` bytes

Largest baseline application/runtime inclusions found through ASAR and resource inspection:

- `@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node`: `33,401,216` bytes in `app.asar.unpacked`
- Full `pdfjs-dist`, including source maps and web/viewer assets
- Full `pdf-lib` package, including source maps and source material
- Full `lucide-react` package, including icon source and source maps
- `jszip` unpacked in `app.asar.unpacked`
- All Electron locale `.pak` files

Duplicate or unnecessary runtime resources in the old package:

- `skills/hl-commenter` appeared both in the ASAR and as an extra resource.
- `public/brand` appeared through the Vite renderer output and again as an extra resource.
- Brand guide PDFs and source brand assets were available to the repository but are not runtime assets.
- Dependency source maps, package documentation, source files, and test-facing material were packaged indirectly through production `node_modules`.
- The Linux native canvas optional dependency was unpacked into the Windows package.

Root cause of the 200+ MB result: the old deliverable was an unpacked Electron folder, and the old allowlist still pulled in full production dependency directories, duplicated public and skill assets, source maps, all Electron locales, and an unpacked Linux native dependency. Compression alone would not have fixed that.

## Final Configuration

`npm run package:win` now performs a clean, deterministic portable build:

1. Removes generated `dist` and portable staging output.
2. Regenerates Windows icon and portable splash assets from the supplied official Houlihan Lokey logo SVG.
3. Builds TypeScript, static schemas, bundled Electron main/preload output, and the Vite renderer.
4. Runs `electron-builder --win portable --x64` into `release/windows-portable-staging`.
5. Copies only `HL Intelligence.exe` into `release/windows-portable`.
6. Fails the build if the final executable exceeds `120 MiB`.

Electron Builder configuration:

- `appId`: `com.houlihanlokey.hlintelligence`
- `productName`: `HL Intelligence`
- `artifactName`: `HL Intelligence.exe`
- `asar`: `true`
- `compression`: `maximum`
- `electronLanguages`: `en-US`
- Windows target: `portable`, `x64` only
- `win.icon`: `build/hl-intelligence.ico`
- `win.signAndEditExecutable`: `true`
- `win.signExecutable`: `false`
- `nsis.installerIcon`: `build/hl-intelligence.ico`
- `portable.artifactName`: `HL Intelligence.exe`
- `portable.splashImage`: `build/portable-splash.bmp`
- `portable.useZip`: `false`

Runtime packaging now uses an explicit allowlist:

- `dist/main/**`
- `dist/preload/**`
- `dist/renderer/**`
- `dist/schemas/**`
- `package.json`
- `skills/hl-commenter` as one extra resource
- `build/hl-intelligence.ico` as one extra resource

Excluded from runtime packaging:

- `node_modules/**`
- source maps
- TypeScript and TSX source files
- Markdown files in the ASAR
- root `public/**` duplicates
- root `skills/**` duplicates
- brand guide PDFs
- docs, tests, screenshots, old release output, and build reports
- non-`en-US` Electron locales

The app still uses `pdfjs-dist`, `pdf-lib`, `jszip`, `ajv`, React, and `lucide-react`, but those runtime paths are bundled into the main, preload, and renderer outputs instead of being copied as complete package directories.

## Final Sizes

Final portable executable:

- `release/windows-portable/HL Intelligence.exe`
- `83,495,733` bytes
- `79.6 MiB`

Final diagnostic unpacked staging sizes:

- `release/windows-portable-staging/win-unpacked`: `311M`
- `resources`: `2.9M`
- `resources/app.asar`: `2,654,704` bytes

Largest remaining staged components:

- `HL Intelligence.exe`: `232,418,816` bytes
- `dxcompiler.dll`: `25,634,304` bytes
- `LICENSES.chromium.html`: `20,367,095` bytes
- `icudtl.dat`: `10,876,560` bytes
- `libGLESv2.dll`: `8,000,512` bytes
- `resources.pak`: `6,876,399` bytes
- `vk_swiftshader.dll`: `5,520,384` bytes
- `d3dcompiler_47.dll`: `4,741,488` bytes
- `ffmpeg.dll`: `3,057,152` bytes
- `resources/app.asar`: `2,654,704` bytes
- `dxil.dll`: `1,509,760` bytes
- `vulkan-1.dll`: `925,696` bytes
- `v8_context_snapshot.bin`: `721,176` bytes
- `locales/en-US.pak`: `571,518` bytes
- `libEGL.dll`: `478,208` bytes

The desired `100 MiB` goal was reached. The remaining size floor is mostly Electron and Chromium runtime content, not HL Intelligence application code or assets.

Clean rebuild reproducibility check:

- First optimized clean build: about `79.6 MiB`
- Second optimized clean build: about `79.6 MiB`
- The final output directory contained exactly one user-facing file: `HL Intelligence.exe`
- No previous executable or unpacked folder was included in the next build.

## Startup Behavior

Startup is now a two-stage splash:

1. Native Electron Builder portable extraction splash using `build/portable-splash.bmp`.
2. Frameless Electron splash window using the same dimensions, background, official logo placement, typography, border treatment, and loading-line position.
3. Hidden main window.
4. Renderer sends `renderer:initial-ui-ready` after its first usable frame.
5. Main window is shown only after the renderer signal and `ready-to-show`, or after the safe timeout.
6. Splash fades out after the main window is visible.

The static extraction splash and animated Electron splash both use the official supplied Houlihan Lokey horizontal logo asset. The Electron splash adds restrained logo and progress-line animation and respects reduced-motion preferences.

Startup-critical main-process imports were reduced. PDF processing, conversion, review-package generation, schema validation, skill ZIP creation, settings access, and result validation are imported lazily inside IPC handlers or after the splash is visible.

## Icon Verification

The canonical icon is generated from the official supplied Houlihan Lokey logo SVG. The generated ICO contains these sizes:

- `16x16`
- `20x20`
- `24x24`
- `32x32`
- `40x40`
- `48x48`
- `64x64`
- `128x128`
- `256x256`

The same ICO is used for:

- the outer portable executable
- Electron Builder Windows icon
- NSIS portable wrapper icon
- Electron splash window
- Electron main window
- taskbar and Alt+Tab identity
- packaged `resources/hl-intelligence.ico`

Application identity is set before windows are created:

```text
com.houlihanlokey.hlintelligence
```

Windows verification script:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/verify-windows-exe-icon.ps1 -ExePath "release/windows-portable/HL Intelligence.exe"
```

The script copies the executable to a fresh Windows temp folder under a renamed filename, reads version metadata from that local copy, extracts the associated Windows shell icon, saves a PNG, and confirms:

- `ProductName` is `HL Intelligence`
- `FileDescription` is `HL Intelligence`
- the shell icon has non-default HL-branded pixel content

Verified icon extraction output:

```text
\\wsl.localhost\Ubuntu\tmp\hl-intelligence-exe-icon.png
```

Windows launch verification also ran the portable executable from a fresh temp folder under both the original filename and a renamed filename. The renamed run produced the rendered main application after extraction:

```text
\\wsl.localhost\Ubuntu\tmp\hl-intelligence-portable-renamed.png
```

## Verification Commands

Commands run:

```bash
npm run test
npm run smoke
npm run package:win
node scripts/check-windows-package-size.mjs "release/windows-portable/HL Intelligence.exe"
```

Windows-native checks run from WSL through PowerShell:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/verify-windows-exe-icon.ps1 -ExePath "release/windows-portable/HL Intelligence.exe" -IconPngPath "\\wsl.localhost\Ubuntu\tmp\hl-intelligence-exe-icon.png"
```

The packaged executable was also launched on Windows from a fresh temp directory and screen-captured after startup. The capture showed the rendered main application, not an installer wizard, MSI flow, console, blank window, or partially rendered workspace.

Automated test coverage exercised the renderer tabs, file picker bridge calls, folder picker bridge calls, JSON import browse control, PDF engine paths, output generation, schema validation, skill ZIP generation, and smoke build flow. The packaged Windows screenshot pass verified startup and main-window rendering; it did not manually select a real file through an OS modal dialog.
