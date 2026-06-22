import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runOfficeWorker } from "../src/engine/office/officeWorkerClient";

describe("Office process hardening", () => {
  it("removes job temp data after a successful Office worker exchange", async () => {
    const dir = await tempDir();
    const fakePowerShell = await writeFakePowerShell(dir);
    const tempRoot = path.join(dir, "office-success-temp");

    const response = await runOfficeWorker<{ ok: boolean }>(
      { schema_version: "1.0", operation: "probe" },
      { powerShellPath: fakePowerShell, tempRoot, timeoutMs: 2000 }
    );

    expect(response.ok).toBe(true);
    await expect(stat(tempRoot)).rejects.toThrow();
  });

  it("cancels a hung Office worker, reports timeout clearly, and removes temp data", async () => {
    const dir = await tempDir();
    const fakePowerShell = await writeFakePowerShell(dir);
    const tempRoot = path.join(dir, "office-timeout-temp");
    const originalMode = process.env.HL_FAKE_OFFICE_MODE;
    process.env.HL_FAKE_OFFICE_MODE = "hang";
    try {
      await expect(
        runOfficeWorker<{ ok: boolean }>(
          { schema_version: "1.0", operation: "probe" },
          { powerShellPath: fakePowerShell, tempRoot, timeoutMs: 250 }
        )
      ).rejects.toThrow(/timed out/i);
      await expect(stat(tempRoot)).rejects.toThrow();
    } finally {
      restoreEnv("HL_FAKE_OFFICE_MODE", originalMode);
    }
  });

  it("cleans temp data and sanitizes paths when the Office worker crashes", async () => {
    const dir = await tempDir();
    const fakePowerShell = await writeFakePowerShell(dir);
    const tempRoot = path.join(dir, "office-crash-temp");
    const originalMode = process.env.HL_FAKE_OFFICE_MODE;
    process.env.HL_FAKE_OFFICE_MODE = "crash";
    try {
      let message = "";
      await runOfficeWorker<{ ok: boolean }>(
        { schema_version: "1.0", operation: "probe" },
        { powerShellPath: fakePowerShell, tempRoot, timeoutMs: 2000 }
      ).catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
      });
      expect(message).toMatch(/Office worker exited|\[path\]/);
      expect(message).not.toMatch(/Sensitive|Client Folder|memo\.docx/);
      await expect(stat(tempRoot)).rejects.toThrow();
    } finally {
      restoreEnv("HL_FAKE_OFFICE_MODE", originalMode);
    }
  });
});

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hl-office-hardening-"));
}

async function writeFakePowerShell(dir: string): Promise<string> {
  const filePath = path.join(dir, "fake-powershell");
  await writeFile(
    filePath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const responseIndex = args.indexOf('-ResponsePath');",
      "const responsePath = responseIndex >= 0 ? args[responseIndex + 1] : '';",
      "const mode = process.env.HL_FAKE_OFFICE_MODE || 'success';",
      "if (mode === 'hang') setInterval(() => {}, 1000);",
      "if (mode === 'crash') { console.error('Failed opening C:\\\\Users\\\\Sensitive\\\\Client Folder\\\\memo.docx'); process.exit(17); }",
      "fs.writeFileSync(responsePath, JSON.stringify({ ok: true }));"
    ].join("\n"),
    "utf8"
  );
  await chmod(filePath, 0o755);
  return filePath;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
