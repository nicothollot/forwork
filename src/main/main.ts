import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppSettings,
  PreflightGenerateInput,
  ProgressEvent,
  ReviewJobFile,
  ReviewSourceValidation
} from "../shared/types.js";
import type { LocalReviewJob } from "../shared/types.js";
import { PICKABLE_DOCUMENT_EXTENSIONS } from "../shared/documentTypes.js";
import {
  TrustedPathRegistry,
  assertTrustedIpcSender,
  parseCreateCommentedInput,
  parseOptionalSkillBuildInput,
  parsePreflightGenerateInput,
  parsePrepareReviewInput,
  parseSettings,
  parseStringPayload,
  parseValidateClaudeInput,
  parseValidateSourceInput
} from "./ipcValidation.js";
import { assertJsonInputWithinLimits } from "../engine/safetyLimits.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_USER_MODEL_ID = "com.houlihanlokey.hlintelligence";
const SPLASH_WIDTH = 430;
const SPLASH_HEIGHT = 270;
const MIN_SPLASH_VISIBLE_MS = 650;
const RENDERER_READY_TIMEOUT_MS = 8000;

const cancelledJobs = new Set<string>();
const activeJobs = new Set<string>();
const trustedPaths = new TrustedPathRegistry();
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
  configureSessionSecurity();
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

app.on("before-quit", () => {
  for (const jobId of activeJobs) cancelledJobs.add(jobId);
  void import("../engine/pdfWorkerClient.js").then(({ terminateAllPdfWorkers }) => terminateAllPdfWorkers()).catch(() => undefined);
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
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = window;
  configureWindowSecurity(window);

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

function configureSessionSecurity(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy(Boolean(process.env.VITE_DEV_SERVER_URL))]
      }
    });
  });
}

function configureWindowSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedRendererNavigation(url, window.webContents.getURL())) return;
    event.preventDefault();
  });
}

function contentSecurityPolicy(dev: boolean): string {
  const connect = dev ? "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*;" : "connect-src 'none';";
  return [
    "default-src 'self';",
    "script-src 'self';",
    "style-src 'self' 'unsafe-inline';",
    "img-src 'self' data:;",
    "font-src 'self';",
    connect,
    "object-src 'none';",
    "base-uri 'none';",
    "form-action 'none';",
    "frame-ancestors 'none';"
  ].join(" ");
}

function isAllowedRendererNavigation(nextUrl: string, currentUrl: string): boolean {
  if (nextUrl === currentUrl) return true;
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl && nextUrl.startsWith(devServerUrl)) return true;
  return nextUrl.startsWith("file://") && currentUrl.startsWith("file://");
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

function preloadPath(): string {
  if (!app.isPackaged && process.env.HL_VISUAL_QA === "1") {
    return path.join(__dirname, "../preload/visualQaPreload.cjs");
  }
  return path.join(__dirname, "../preload/preload.cjs");
}

function skillSourceRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "skills", "hl-commenter")
    : path.join(process.cwd(), "skills", "hl-commenter");
}

function requireTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedIpcSender({
    senderId: event.sender.id,
    mainSenderId: mainWindow?.webContents.id ?? null,
    senderUrl: event.senderFrame?.url ?? event.sender.getURL()
  });
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
    try {
      requireTrustedSender(event);
    } catch {
      return;
    }
    rendererInitialUiReady = true;
    maybeShowMainWindow();
  });

  ipcMain.handle("dialog:selectDocument", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Browse document",
      properties: ["openFile"],
      filters: [{ name: "Documents", extensions: PICKABLE_DOCUMENT_EXTENSIONS }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const { getFileMetadata } = await import("../engine/metadata.js");
    const metadata = await getFileMetadata(result.filePaths[0], true);
    if (metadata.supportStatus === "verified") trustedPaths.registerInput(metadata.path);
    return metadata;
  });

  ipcMain.handle("dialog:selectDocuments", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Browse files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Documents", extensions: PICKABLE_DOCUMENT_EXTENSIONS }]
    });
    if (result.canceled) return [];
    const { getFileMetadata } = await import("../engine/metadata.js");
    const metadata = await Promise.all(result.filePaths.map((filePath) => getFileMetadata(filePath, false)));
    metadata.filter((item) => item.supportStatus === "verified").forEach((item) => trustedPaths.registerInput(item.path));
    return metadata;
  });

  ipcMain.handle("dialog:selectJsonFile", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Import Claude result",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = result.filePaths[0];
    const text = await readFile(selectedPath, "utf8");
    assertJsonInputWithinLimits(text);
    trustedPaths.registerReadableTextFile(selectedPath);
    return { path: selectedPath, name: path.basename(selectedPath), text };
  });

  ipcMain.handle("dialog:selectReviewJobFile", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Select review-job.hlreview",
      properties: ["openFile"],
      filters: [{ name: "HL review job", extensions: ["hlreview"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    trustedPaths.registerReadableTextFile(result.filePaths[0]);
    return readReviewJobSummary(result.filePaths[0]);
  });

  ipcMain.handle("dialog:selectFolder", async (event) => {
    requireTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Select output folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    trustedPaths.registerOutputFolder(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle("file:getMetadata", async (event, rawPath: unknown) => {
    requireTrustedSender(event);
    const filePath = parseStringPayload(rawPath, "filePath");
    const { getFileMetadata } = await import("../engine/metadata.js");
    const metadata = await getFileMetadata(filePath, true);
    if (metadata.supportStatus === "verified") trustedPaths.registerInput(metadata.path);
    return metadata;
  });

  ipcMain.handle("review:validateSource", async (event, rawInput: unknown) => {
    requireTrustedSender(event);
    const input = parseValidateSourceInput(rawInput);
    const [{ readJsonFile }, { cachedSha256File }] = await Promise.all([
      import("../engine/fileSafety.js"),
      import("../engine/jobFoundation.js")
    ]);
    const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
    let actualSha256: string | undefined;
    try {
      actualSha256 = await cachedSha256File(input.sourcePath);
    } catch (error) {
      return {
        ok: false,
        expectedSha256: localJob.source.sha256,
        sourceChanged: false,
        message: `Could not read the selected source file. Select the original ${localJob.source.filename} file and try again.`
      } satisfies ReviewSourceValidation;
    }
    const ok = actualSha256 === localJob.source.sha256;
    return {
      ok,
      expectedSha256: localJob.source.sha256,
      actualSha256,
      sourceChanged: !ok,
      message: ok
        ? "Selected source matches the review job."
        : `The selected source file does not match ${localJob.source.filename}. Select the original source file used to create this review job.`
    } satisfies ReviewSourceValidation;
  });

  ipcMain.handle("review:prepare", async (event, rawInput: unknown) => {
    requireTrustedSender(event);
    const input = parsePrepareReviewInput(rawInput);
    const { prepareReviewPackage } = await import("../engine/reviewPackage.js");
    const result = await prepareReviewPackage(input);
    trustedPaths.registerReviewPackage(result);
    return result;
  });

  ipcMain.handle("review:validateClaude", async (event, rawInput: unknown) => {
    requireTrustedSender(event);
    const input = parseValidateClaudeInput(rawInput);
    const [{ readJsonFile }, { validateClaudeResultText }] = await Promise.all([
      import("../engine/fileSafety.js"),
      import("../engine/resultValidation.js")
    ]);
    const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
    return validateClaudeResultText(localJob, input.jsonText);
  });

  ipcMain.handle("review:createCommentedPdf", async (event, rawInput: unknown) => {
    requireTrustedSender(event);
    const input = parseCreateCommentedInput(rawInput);
    const { createCommentedDocument } = await import("../engine/commentOutput.js");
    const result = await createCommentedDocument(input);
    trustedPaths.registerCommentOutput(result);
    return result;
  });

  ipcMain.handle("preflight:generate", async (event, rawInput: unknown) => {
    requireTrustedSender(event);
    const input: PreflightGenerateInput = parsePreflightGenerateInput(rawInput);
    const { generatePreflightFiles } = await import("../engine/preflight.js");
    cancelledJobs.delete(input.jobId);
    activeJobs.add(input.jobId);
    const sender = event.sender;
    try {
      const results = await generatePreflightFiles(
        input,
        (progress: ProgressEvent) => sender.send("job:progress", progress),
        (jobId) => cancelledJobs.has(jobId)
      );
      results.forEach((result) => trustedPaths.registerPreflightResult(result));
      return results;
    } finally {
      activeJobs.delete(input.jobId);
    }
  });

  ipcMain.handle("job:cancel", async (event, rawJobId: unknown) => {
    requireTrustedSender(event);
    const jobId = parseStringPayload(rawJobId, "jobId");
    cancelledJobs.add(jobId);
  });

  ipcMain.handle("skill:buildZip", async (event, rawInput?: unknown) => {
    requireTrustedSender(event);
    const input = parseOptionalSkillBuildInput(rawInput);
    const { buildSkillZip } = await import("../engine/skillZip.js");
    let outputPath = input?.outputPath;
    if (!outputPath) {
      const defaultFolder = input?.defaultFolder || app.getPath("downloads");
      const result = await dialog.showSaveDialog({
        title: "Save HL Commenter Skill",
        defaultPath: path.join(defaultFolder, "HL-Commenter-Skill.zip"),
        filters: [{ name: "ZIP archive", extensions: ["zip"] }]
      });
      if (result.canceled || !result.filePath) return null;
      outputPath = result.filePath;
    }
    const result = await buildSkillZip(process.cwd(), skillSourceRoot(), outputPath);
    trustedPaths.registerJobOutput(result.zipPath);
    return result;
  });

  ipcMain.handle("shell:openPath", async (event, rawPath: unknown) => {
    requireTrustedSender(event);
    const targetPath = parseStringPayload(rawPath, "targetPath");
    trustedPaths.assertCanOpen(targetPath);
    await shell.openPath(targetPath);
  });
  ipcMain.handle("clipboard:writeText", async (event, rawText: unknown) => {
    requireTrustedSender(event);
    const text = parseStringPayload(rawText, "text");
    clipboard.writeText(text);
  });
  ipcMain.handle("file:readText", async (event, rawPath: unknown) => {
    requireTrustedSender(event);
    const filePath = parseStringPayload(rawPath, "filePath");
    try {
      trustedPaths.assertCanReadText(filePath);
    } catch (error) {
      if (path.extname(filePath).toLowerCase() !== ".json") throw error;
    }
    const text = await readFile(filePath, "utf8");
    assertJsonInputWithinLimits(text);
    return text;
  });
  ipcMain.handle("settings:get", async (event): Promise<AppSettings> => {
    requireTrustedSender(event);
    const { readSettings } = await import("../engine/settings.js");
    const settings = await readSettings(app.getPath("userData"));
    if (settings.lastOutputFolder) trustedPaths.registerOutputFolder(settings.lastOutputFolder);
    return settings;
  });
  ipcMain.handle("settings:save", async (event, rawSettings: unknown) => {
    requireTrustedSender(event);
    const settings: AppSettings = parseSettings(rawSettings);
    if (settings.lastOutputFolder) trustedPaths.registerOutputFolder(settings.lastOutputFolder);
    const { saveSettings } = await import("../engine/settings.js");
    return saveSettings(app.getPath("userData"), settings);
  });
}

async function readReviewJobSummary(filePath: string): Promise<ReviewJobFile> {
  const { readJsonFile } = await import("../engine/fileSafety.js");
  const localJob = await readJsonFile<LocalReviewJob>(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    requestId: localJob.request_id,
    createdAt: localJob.created_at,
    sourceFilename: localJob.source.filename,
    sourceSha256: localJob.source.sha256,
    documentType: localJob.source.document_type
  };
}
