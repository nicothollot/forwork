import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings, PreflightGenerateInput, ProgressEvent } from "../shared/types.js";
import type { LocalReviewJob } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_USER_MODEL_ID = "com.houlihanlokey.hlintelligence";
const SPLASH_WIDTH = 430;
const SPLASH_HEIGHT = 270;
const MIN_SPLASH_VISIBLE_MS = 650;
const RENDERER_READY_TIMEOUT_MS = 8000;

const cancelledJobs = new Set<string>();
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashShownAt = 0;
let mainWindowReadyToShow = false;
let rendererInitialUiReady = false;
let rendererReadyTimedOut = false;
let mainWindowShowQueued = false;
let rendererReadyTimer: NodeJS.Timeout | null = null;

app.setName("HL Intelligence");
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

app.whenReady().then(async () => {
  createStartupSplashWindow();
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function createWindow(): Promise<void> {
  if (!splashWindow) createStartupSplashWindow();

  clearRendererReadyTimer();
  mainWindowReadyToShow = false;
  rendererInitialUiReady = false;
  rendererReadyTimedOut = false;
  mainWindowShowQueued = false;

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 720,
    title: "HL Intelligence",
    backgroundColor: "#ffffff",
    show: false,
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = window;

  window.once("ready-to-show", () => {
    if (mainWindow !== window) return;
    mainWindowReadyToShow = true;
    maybeShowMainWindow();
  });

  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
    clearRendererReadyTimer();
  });

  rendererReadyTimer = setTimeout(() => {
    rendererReadyTimedOut = true;
    maybeShowMainWindow();
  }, RENDERER_READY_TIMEOUT_MS);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devServerUrl) {
      await window.loadURL(devServerUrl);
    } else {
      await window.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
  } catch (error) {
    clearRendererReadyTimer();
    closeStartupSplash(false);
    if (!window.isDestroyed()) window.show();
    throw error;
  }
}

function maybeShowMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.isVisible() || mainWindowShowQueued) return;
  if (!mainWindowReadyToShow || (!rendererInitialUiReady && !rendererReadyTimedOut)) return;

  mainWindowShowQueued = true;
  const visibleSince = splashShownAt || Date.now();
  const remainingSplashMs = Math.max(0, MIN_SPLASH_VISIBLE_MS - (Date.now() - visibleSince));

  setTimeout(() => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
    closeStartupSplash(true);
    mainWindowShowQueued = false;
    clearRendererReadyTimer();
  }, remainingSplashMs);
}

function createStartupSplashWindow(): BrowserWindow {
  closeStartupSplash(false);
  splashShownAt = 0;

  const window = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    backgroundColor: "#ffffff",
    title: "HL Intelligence",
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.once("did-finish-load", () => {
    if (!window.isDestroyed()) {
      splashShownAt = Date.now();
      window.show();
    }
  });

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`).catch(() => {
    if (!window.isDestroyed()) window.close();
  });

  window.once("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });

  splashWindow = window;
  return window;
}

function closeStartupSplash(animated: boolean): void {
  const window = splashWindow;
  splashWindow = null;
  if (!window || window.isDestroyed()) return;

  if (!animated) {
    window.close();
    return;
  }

  void window.webContents.executeJavaScript("document.body.classList.add('is-exiting')").catch(() => undefined);
  setTimeout(() => {
    if (!window.isDestroyed()) window.close();
  }, 180);
}

function clearRendererReadyTimer(): void {
  if (rendererReadyTimer) {
    clearTimeout(rendererReadyTimer);
    rendererReadyTimer = null;
  }
}

function appIconPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "hl-intelligence.ico")]
    : [path.join(process.cwd(), "build", "hl-intelligence.ico"), path.join(process.cwd(), "build", "icon.ico")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function skillSourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "skills", "hl-commenter")
    : path.join(process.cwd(), "skills", "hl-commenter");
}

function splashHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${SPLASH_WIDTH}, initial-scale=1" />
    <style>
      :root {
        --hl-oxford: #002855;
        --hl-sapphire: #0067a5;
        --hl-sky: #508bc9;
        --hl-roman: #7e8597;
        --line: #d7dce5;
        --soft-line: #e3e8ef;
        --status: #525766;
        font-family: "Segoe UI", Arial, Helvetica, sans-serif;
        color: #1f2530;
      }
      * { box-sizing: border-box; }
      html,
      body {
        width: ${SPLASH_WIDTH}px;
        height: ${SPLASH_HEIGHT}px;
        margin: 0;
        overflow: hidden;
        background: #f6f8fb;
      }
      body.is-exiting .splash {
        opacity: 0;
        transform: scale(.992);
        transition: opacity 170ms ease, transform 170ms ease;
      }
      .splash {
        position: relative;
        width: ${SPLASH_WIDTH}px;
        height: ${SPLASH_HEIGHT}px;
        border: 1px solid var(--line);
        background: #ffffff;
      }
      .splash::before,
      .splash::after {
        content: "";
        position: absolute;
        pointer-events: none;
      }
      .splash::before {
        inset: 22px;
        border: 1px solid var(--soft-line);
      }
      .splash::after {
        inset: 36px;
        border: 1px solid #f1f4f8;
      }
      .brand-logo {
        position: absolute;
        left: 118px;
        top: 42px;
        width: 194px;
        height: auto;
        display: block;
        animation: logo-settle 420ms cubic-bezier(.2,.8,.2,1) both;
      }
      .fallback-logo {
        position: absolute;
        left: 0;
        top: 54px;
        width: 100%;
        text-align: center;
        color: var(--hl-oxford);
        font-size: 17px;
        font-weight: 700;
      }
      h1 {
        position: absolute;
        top: 128px;
        left: 0;
        width: 100%;
        margin: 0;
        color: var(--hl-oxford);
        font-size: 19px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0;
        text-align: center;
      }
      p {
        position: absolute;
        top: 158px;
        left: 0;
        width: 100%;
        margin: 0;
        color: var(--status);
        font-size: 13px;
        line-height: 1.45;
        text-align: center;
        letter-spacing: 0;
      }
      .loader {
        position: absolute;
        left: 104px;
        top: 232px;
        width: 222px;
        height: 3px;
        background: #e6ebf2;
        overflow: hidden;
      }
      .loader span {
        display: block;
        width: 96px;
        height: 100%;
        background: var(--hl-sapphire);
        transform: translateX(0);
        animation: load 1.2s ease-in-out 320ms infinite;
      }
      @keyframes load {
        0% { transform: translateX(0); opacity: 1; }
        70% { transform: translateX(126px); opacity: .82; }
        100% { transform: translateX(222px); opacity: .52; }
      }
      @keyframes logo-settle {
        from { opacity: .96; transform: translateY(1px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .brand-logo,
        .loader span {
          animation: none;
        }
      }
    </style>
  </head>
  <body>
    <section class="splash" aria-label="HL Intelligence is loading">
      ${splashLogoMarkup()}
      <h1>HL Intelligence</h1>
      <p>Secure document preparation</p>
      <div class="loader" role="progressbar" aria-label="Loading"><span></span></div>
    </section>
  </body>
</html>`;
}

function splashLogoMarkup(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "app.asar", "dist", "renderer", "brand", "hl-logo-horizontal.svg")]
    : [
        path.join(process.cwd(), "public", "brand", "hl-logo-horizontal.svg"),
        path.join(__dirname, "../renderer/brand/hl-logo-horizontal.svg")
      ];

  for (const candidate of candidates) {
    try {
      const svg = readFileSync(candidate);
      return `<img class="brand-logo" alt="Houlihan Lokey" src="data:image/svg+xml;base64,${svg.toString("base64")}" />`;
    } catch {
      // Try the next bundled logo location.
    }
  }

  return `<div class="fallback-logo">Houlihan Lokey</div>`;
}

function registerIpc(): void {
  ipcMain.on("renderer:initial-ui-ready", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    rendererInitialUiReady = true;
    maybeShowMainWindow();
  });

  ipcMain.handle("dialog:selectDocument", async () => {
    const result = await dialog.showOpenDialog({
      title: "Browse document",
      properties: ["openFile"],
      filters: [
        { name: "Documents", extensions: ["pdf", "docx", "xlsx", "pptx"] },
        { name: "PDF", extensions: ["pdf"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const { getFileMetadata } = await import("../engine/metadata.js");
    return getFileMetadata(result.filePaths[0], true);
  });

  ipcMain.handle("dialog:selectDocuments", async () => {
    const result = await dialog.showOpenDialog({
      title: "Browse files",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Documents", extensions: ["pdf", "docx", "xlsx", "pptx"] },
        { name: "PDF", extensions: ["pdf"] }
      ]
    });
    if (result.canceled) return [];
    const { getFileMetadata } = await import("../engine/metadata.js");
    return Promise.all(result.filePaths.map((filePath) => getFileMetadata(filePath, false)));
  });

  ipcMain.handle("dialog:selectJsonFile", async () => {
    const result = await dialog.showOpenDialog({
      title: "Import Claude result",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = result.filePaths[0];
    return { path: selectedPath, name: path.basename(selectedPath), text: await readFile(selectedPath, "utf8") };
  });

  ipcMain.handle("dialog:selectFolder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select output folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("file:getMetadata", async (_event, filePath: string) => {
    const { getFileMetadata } = await import("../engine/metadata.js");
    return getFileMetadata(filePath, true);
  });

  ipcMain.handle("review:prepare", async (_event, input) => {
    const { prepareReviewPackage } = await import("../engine/reviewPackage.js");
    return prepareReviewPackage(input);
  });

  ipcMain.handle("review:validateClaude", async (_event, input: { localJobPath: string; jsonText: string }) => {
    const [{ readJsonFile }, { validateClaudeResultText }] = await Promise.all([
      import("../engine/fileSafety.js"),
      import("../engine/resultValidation.js")
    ]);
    const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
    return validateClaudeResultText(localJob, input.jsonText);
  });

  ipcMain.handle("review:createCommentedPdf", async (_event, input) => {
    const { createCommentedPdf } = await import("../engine/pdfComments.js");
    return createCommentedPdf(input);
  });

  ipcMain.handle("preflight:generate", async (event, input: PreflightGenerateInput) => {
    const { generatePreflightFiles } = await import("../engine/preflight.js");
    cancelledJobs.delete(input.jobId);
    const sender = event.sender;
    return generatePreflightFiles(
      input,
      (progress: ProgressEvent) => sender.send("job:progress", progress),
      (jobId) => cancelledJobs.has(jobId)
    );
  });

  ipcMain.handle("job:cancel", async (_event, jobId: string) => {
    cancelledJobs.add(jobId);
  });

  ipcMain.handle("skill:buildZip", async () => {
    const { buildSkillZip } = await import("../engine/skillZip.js");
    return buildSkillZip(process.cwd(), skillSourceRoot());
  });

  ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });
  ipcMain.handle("clipboard:writeText", async (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("file:readText", async (_event, filePath: string) => readFile(filePath, "utf8"));
  ipcMain.handle("settings:get", async (): Promise<AppSettings> => {
    const { readSettings } = await import("../engine/settings.js");
    return readSettings(app.getPath("userData"));
  });
  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => {
    const { saveSettings } = await import("../engine/settings.js");
    return saveSettings(app.getPath("userData"), settings);
  });
}
