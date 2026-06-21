import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "../shared/types.js";
import { ensureDirectory, writeFileAtomic } from "./fileSafety.js";

export async function readSettings(userDataPath: string): Promise<AppSettings> {
  try {
    return JSON.parse(await readFile(settingsPath(userDataPath), "utf8")) as AppSettings;
  } catch {
    return {};
  }
}

export async function saveSettings(userDataPath: string, settings: AppSettings): Promise<void> {
  await ensureDirectory(userDataPath);
  await writeFileAtomic(settingsPath(userDataPath), JSON.stringify(settings, null, 2));
}

function settingsPath(userDataPath: string): string {
  return path.join(userDataPath, "settings.json");
}
