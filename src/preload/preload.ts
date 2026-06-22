import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppApi,
  AppSettings,
  CreateCommentedPdfInput,
  PrepareReviewInput,
  PreflightGenerateInput,
  ProgressEvent
} from "../shared/types.js";

const api: AppApi = {
  selectDocument: () => ipcRenderer.invoke("dialog:selectDocument"),
  selectDocuments: () => ipcRenderer.invoke("dialog:selectDocuments"),
  selectJsonFile: () => ipcRenderer.invoke("dialog:selectJsonFile"),
  selectReviewJobFile: () => ipcRenderer.invoke("dialog:selectReviewJobFile"),
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  getMetadata: (path: string) => ipcRenderer.invoke("file:getMetadata", path),
  validateReviewSource: (input: { localJobPath: string; sourcePath: string }) =>
    ipcRenderer.invoke("review:validateSource", input),
  prepareReview: (input: PrepareReviewInput) => ipcRenderer.invoke("review:prepare", input),
  validateClaudeResult: (input: { localJobPath: string; jsonText: string }) =>
    ipcRenderer.invoke("review:validateClaude", input),
  createCommentedPdf: (input: CreateCommentedPdfInput) => ipcRenderer.invoke("review:createCommentedPdf", input),
  generatePreflight: (input: PreflightGenerateInput) => ipcRenderer.invoke("preflight:generate", input),
  cancelJob: (jobId: string) => ipcRenderer.invoke("job:cancel", jobId),
  buildSkillZip: (input?: { outputPath?: string; defaultFolder?: string }) => ipcRenderer.invoke("skill:buildZip", input),
  openPath: (path: string) => ipcRenderer.invoke("shell:openPath", path),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:writeText", text),
  readTextFile: (path: string) => ipcRenderer.invoke("file:readText", path),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:save", settings),
  notifyInitialUiReady: () => ipcRenderer.send("renderer:initial-ui-ready"),
  onProgress: (callback: (event: ProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProgressEvent) => callback(progress);
    ipcRenderer.on("job:progress", listener);
    return () => ipcRenderer.removeListener("job:progress", listener);
  }
};

contextBridge.exposeInMainWorld("hl", api);
