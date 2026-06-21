import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { SkillBuildResult } from "../shared/types.js";
import { writeFileAtomic } from "./fileSafety.js";

export async function buildSkillZip(projectRoot = process.cwd()): Promise<SkillBuildResult> {
  const sourceRoot = path.join(projectRoot, "skills", "hl-commenter");
  const zip = new JSZip();
  await addDirectory(zip, sourceRoot, "hl-commenter");
  const zipPath = path.join(projectRoot, "HL-Commenter-Skill.zip");
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFileAtomic(zipPath, buffer);
  const entries = Object.keys(zip.files).sort();
  return { zipPath, entries };
}

async function addDirectory(zip: JSZip, sourceDir: string, zipDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`;
    if (entry.isDirectory()) {
      zip.folder(zipPath);
      await addDirectory(zip, sourcePath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, await readFile(sourcePath));
    }
  }
}
