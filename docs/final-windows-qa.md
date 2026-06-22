# Final Windows QA

Run from a native Windows PowerShell session when the final release candidate is ready:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-final-windows-qa.ps1
```

The script guides or runs:

- Environment checks for Node, npm, and local Office COM availability.
- `npm ci`.
- Type checking, unit tests, integration tests, native Office tests, UI tests, Electron visual QA, and stress tests.
- Skill ZIP build.
- Two clean portable Windows builds.
- Size check against the 120 MiB hard maximum.
- Executable metadata and shell-icon check.
- Fresh-folder launch from a Windows temp path containing spaces.
- JSON summary at `test-artifacts/final-qa/final-windows-qa-summary.json`.

The script does not sign anything, change Windows security settings, clear icon caches, install Office, execute macros, upload files, or touch real client documents.

## Manual Smoke Items

Some final checks require direct Windows observation:

- First visible surface is the branded native extraction splash.
- No console window appears.
- Explorer, taskbar, and Alt+Tab use the HL Intelligence icon.
- Native file and folder pickers open and return selected paths.
- PDF, Word, Excel, and PowerPoint synthetic processing works from the final EXE.
- Skill ZIP Save As works.
- `hl_comments.json` import validates automatically.
- Commented Office output opens in the correct Office application.
- No new orphan Office process remains after app exit.

## Current Run Notes

In this WSL2 session, the final EXE was built twice. The first build was `83,923,545` bytes and the second final build was `83,923,544` bytes, so the second build did not include or grow from the first. The Windows metadata/icon script passed. A fresh-folder launch from `C:\Users\nicot\AppData\Local\Temp\HL Intelligence Fresh Smoke ...` found the `HL Intelligence` main window and closed it with zero remaining HL Intelligence processes.

Electron visual QA could not be executed in the WSL2 shell because the Linux Electron binary aborts before app startup in `content/browser/sandbox_host_linux.cc`. Run the visual command on native Windows through the script above for final visual signoff.
