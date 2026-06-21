import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const sourceRoot = path.join(process.cwd(), "skills", "hl-commenter");
const zip = new JSZip();

await addDirectory(sourceRoot, "hl-commenter");

const expected = [
  "hl-commenter/SKILL.md",
  "hl-commenter/references/anchor-rules.md",
  "hl-commenter/references/examples.json",
  "hl-commenter/references/review-config.schema.json",
  "hl-commenter/references/review-output.schema.json"
];

for (const entry of expected) {
  if (!zip.files[entry]) throw new Error(`Skill ZIP is missing ${entry}`);
}

const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const zipPath = path.join(process.cwd(), "HL-Commenter-Skill.zip");
await writeFile(zipPath, buffer);
console.log(`Created ${zipPath}`);

async function addDirectory(sourceDir, zipDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`;
    if (entry.isDirectory()) {
      zip.folder(zipPath);
      await addDirectory(sourcePath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, await readFile(sourcePath));
    }
  }
}
