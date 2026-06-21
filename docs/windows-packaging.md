# Windows Packaging

Primary target: Windows desktop.

## Build Windows App Folder

```bash
npm install
npm run package:win
```

The command runs:

1. Regenerates the Windows app icon and splash assets.
2. TypeScript main-process build.
3. Schema static copy.
4. Vite renderer build.
5. `electron-builder --win dir --x64`.

The output is an unpacked Windows app folder containing `HL Intelligence.exe`. This avoids the NSIS portable/installer wrapper and launches the actual Electron application executable directly.

In WSL, the script writes the final artifact to:

```text
/mnt/c/Users/<you>/Downloads
```

Set `HL_WINDOWS_DOWNLOADS` to override the destination:

```bash
HL_WINDOWS_DOWNLOADS=/mnt/c/Users/nicot/Downloads npm run package:win
```

If a previous unpacked app folder already exists in Downloads, the package script leaves it in place and writes a timestamped folder instead of replacing it.

The script builds intermediate Electron Builder files under `release/windows-package` first, then copies only the finished unpacked app folder into Downloads.

## Runtime Expectations

- The application runs locally after installation.
- No internet connection is required for PDF processing after installation.
- Native Windows file and folder dialogs are used through Electron.
- Generated files are written to user-selected folders.

## Packaging Notes

- `dist/**`, `public/**`, `skills/**`, and `package.json` are included.
- `skills/hl-commenter` is also included as an extra resource.
- `public/brand` is included as an extra resource.
- `build/hl-intelligence.ico` is embedded as the app, EXE, and taskbar icon.
- Source documents and generated review output are not packaged.
- Electron Builder creates a temporary `win-unpacked` folder during the build; the packaging script removes that intermediate folder after copying it to Downloads.

## Splash Screen

When `HL Intelligence.exe` starts, the app shows a frameless splash window with the HL Intelligence app icon and “Interface is loading” message while the renderer loads. The main workspace stays hidden until ready, then it is shown and the splash closes immediately.
