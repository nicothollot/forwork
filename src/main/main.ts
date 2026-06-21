import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings, PreflightGenerateInput, ProgressEvent } from "../shared/types.js";
import { createCommentedPdf } from "../engine/pdfComments.js";
import { getFileMetadata } from "../engine/metadata.js";
import { generatePreflightFiles } from "../engine/preflight.js";
import { prepareReviewPackage } from "../engine/reviewPackage.js";
import { validateClaudeResultText } from "../engine/resultValidation.js";
import { readJsonFile } from "../engine/fileSafety.js";
import { buildSkillZip } from "../engine/skillZip.js";
import { readSettings, saveSettings } from "../engine/settings.js";
import type { LocalReviewJob } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cancelledJobs = new Set<string>();
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

if (process.platform === "win32") {
  app.setAppUserModelId("com.houlihanlokey.hl-intelligence");
}

async function createWindow(): Promise<void> {
  if (!splashWindow) createStartupSplashWindow();

  mainWindow = new BrowserWindow({
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

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    closeStartupSplash();
  });

  mainWindow.once("closed", () => {
    mainWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
  } catch (error) {
    closeStartupSplash();
    mainWindow?.show();
    throw error;
  }
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

function createStartupSplashWindow(): BrowserWindow {
  closeStartupSplash();

  const window = new BrowserWindow({
    width: 430,
    height: 270,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
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

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`).catch(() => {
    if (!window.isDestroyed()) window.close();
  });

  window.once("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });

  splashWindow = window;
  return window;
}

function closeStartupSplash(): void {
  const window = splashWindow;
  splashWindow = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
}

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "hl-intelligence.ico")
    : path.join(process.cwd(), "build", "hl-intelligence.ico");
}

function splashHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        --hl-oxford: #002855;
        --hl-sapphire: #0067a5;
        --hl-sky: #508bc9;
        --hl-roman: #7e8597;
        --line: #d7dce5;
        font-family: "Usual", "Segoe UI", Arial, sans-serif;
        color: #1f2530;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f8fb;
      }
      .splash {
        width: 100%;
        height: 100vh;
        padding: 30px 38px 28px;
        border: 1px solid var(--line);
        display: grid;
        grid-template-rows: 1fr auto;
        gap: 20px;
        background:
          linear-gradient(90deg, rgba(0,40,85,0.06) 1px, transparent 1px),
          linear-gradient(180deg, rgba(0,40,85,0.05) 1px, transparent 1px),
          #ffffff;
        background-size: 34px 34px;
        animation: splash-in 240ms cubic-bezier(.2,.8,.2,1) both;
        overflow: hidden;
        position: relative;
      }
      .splash::before {
        content: "";
        position: absolute;
        inset: 20px;
        border: 1px solid rgba(0, 103, 165, 0.16);
        pointer-events: none;
      }
      .logo-stage {
        align-self: center;
        justify-self: center;
        display: grid;
        place-items: center;
        gap: 14px;
        margin-top: 8px;
        animation: logo-in 360ms cubic-bezier(.2,.8,.2,1) 80ms both;
      }
      .icon-shell {
        width: 104px;
        height: 104px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(80, 139, 201, 0.34);
        background: rgba(255, 255, 255, 0.78);
        box-shadow: 0 18px 40px rgba(0, 40, 85, 0.16);
      }
      img {
        width: 82px;
        height: 82px;
        display: block;
      }
      .fallback-logo {
        color: var(--hl-oxford);
        font-size: 26px;
        font-weight: 750;
      }
      h1 {
        margin: 0;
        color: var(--hl-oxford);
        font-size: 19px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0;
      }
      .splash-status {
        display: grid;
        place-items: center;
        gap: 12px;
      }
      p {
        margin: 0;
        color: #525766;
        font-size: 13px;
        line-height: 1.45;
        text-align: center;
        letter-spacing: 0;
      }
      .loader {
        width: 100%;
        height: 3px;
        background: #e6ebf2;
        overflow: hidden;
      }
      .loader span {
        display: block;
        width: 38%;
        height: 100%;
        background: linear-gradient(90deg, var(--hl-sapphire), var(--hl-sky));
        animation: load 1.05s ease-in-out infinite;
      }
      @keyframes load {
        0% { transform: translateX(-105%); }
        100% { transform: translateX(270%); }
      }
      @keyframes splash-in {
        from { opacity: 0; transform: translateY(8px) scale(.985); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes logo-in {
        from { opacity: 0; transform: translateY(7px) scale(.965); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
    </style>
  </head>
  <body>
    <section class="splash" aria-label="HL Intelligence is loading">
      <div class="logo-stage">
        <div class="icon-shell">
          ${splashIconSvg()}
        </div>
        <h1>HL Intelligence</h1>
      </div>
      <div class="splash-status">
        <p>Interface is loading</p>
        <div class="loader" role="progressbar" aria-label="Loading"><span></span></div>
      </div>
    </section>
  </body>
</html>`;
}

function splashIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="82" height="82" viewBox="0 0 1024 1024" role="img" aria-label="HL Intelligence">
    <rect width="1024" height="1024" rx="176" fill="#002855"/>
    <path d="M132 266V172h760v680H132V266Z" fill="none" stroke="#508BC9" stroke-width="28" opacity="0.95"/>
    <path d="M764 214h82v82M260 810h-82v-82" fill="none" stroke="#7E8597" stroke-width="18" stroke-linecap="square" opacity="0.52"/>
    <g opacity="0.18" stroke="#FFFFFF" stroke-width="5">
      <path d="M184 358h656M184 512h656M184 666h656"/>
      <path d="M338 204v616M512 204v616M686 204v616"/>
    </g>
    <text x="512" y="594" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="310" font-weight="700" letter-spacing="0" fill="#FFFFFF">HL</text>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M706 384L760 330H838" stroke="#508BC9" stroke-width="22"/>
      <path d="M708 512H832" stroke="#508BC9" stroke-width="22"/>
      <path d="M706 640L760 694H838" stroke="#508BC9" stroke-width="22"/>
    </g>
    <g fill="#FFFFFF" stroke="#508BC9" stroke-width="13">
      <circle cx="706" cy="384" r="19"/>
      <circle cx="838" cy="330" r="19"/>
      <circle cx="832" cy="512" r="19"/>
      <circle cx="706" cy="640" r="19"/>
      <circle cx="838" cy="694" r="19"/>
    </g>
  </svg>`;
}

function registerIpc(): void {
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

  ipcMain.handle("file:getMetadata", async (_event, filePath: string) => getFileMetadata(filePath, true));
  ipcMain.handle("review:prepare", async (_event, input) => prepareReviewPackage(input));
  ipcMain.handle("review:validateClaude", async (_event, input: { localJobPath: string; jsonText: string }) => {
    const localJob = await readJsonFile<LocalReviewJob>(input.localJobPath);
    return validateClaudeResultText(localJob, input.jsonText);
  });
  ipcMain.handle("review:createCommentedPdf", async (_event, input) => createCommentedPdf(input));

  ipcMain.handle("preflight:generate", async (event, input: PreflightGenerateInput) => {
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

  ipcMain.handle("skill:buildZip", async () => buildSkillZip());
  ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });
  ipcMain.handle("clipboard:writeText", async (_event, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("file:readText", async (_event, filePath: string) => readFile(filePath, "utf8"));
  ipcMain.handle("settings:get", async (): Promise<AppSettings> => readSettings(app.getPath("userData")));
  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => saveSettings(app.getPath("userData"), settings));
}
