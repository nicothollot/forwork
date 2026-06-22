import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const artifactDir = path.join(process.cwd(), "test-artifacts", "final-qa");
const screenshotDir = path.join(artifactDir, "visual");
await mkdir(screenshotDir, { recursive: true });

const report = {
  checkedAt: new Date().toISOString(),
  status: "failed",
  environment: {
    platform: process.platform,
    display: process.env.DISPLAY ?? null,
    visualQaMock: true
  },
  requiredStates: [
    "splash",
    "main-shell-1440x900",
    "main-shell-1280x720",
    "minimum-layout-1040x720",
    "commenter-advanced-style",
    "review-package-success",
    "review-package-actions",
    "step-2-empty",
    "valid-result",
    "output-success",
    "attention-findings",
    "invalid-result",
    "preflight-empty-queue",
    "mixed-queue",
    "progress",
    "partial-failure",
    "unsupported-legacy-file",
    "missing-office-capability",
    "keyboard-focus-state"
  ],
  screenshots: [],
  missingStates: [],
  environmentLimitations: [],
  error: ""
};

try {
  const playwrightPath = findPlaywrightPath();
  if (!playwrightPath) throw new Error("Playwright is not installed locally and no cached npx Playwright package was found.");
  if (!process.env.DISPLAY && process.platform !== "win32") {
    throw new Error("Electron visual QA requires a display server or xvfb. No DISPLAY was available in this environment.");
  }

  const { _electron } = await import(pathToFileURL(path.join(playwrightPath, "index.mjs")).href);
  const electronPath = require("electron");
  const electronProbe = spawnSync(electronPath, ["--version"], { encoding: "utf8" });
  if (electronProbe.status !== 0) {
    report.environmentLimitations.push("Electron binary failed before Playwright launch in this environment.");
    throw new Error(
      [
        `Electron binary failed with status ${electronProbe.status ?? "unknown"}.`,
        electronProbe.stderr.trim(),
        electronProbe.stdout.trim()
      ].filter(Boolean).join("\n")
    );
  }
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [process.cwd(), "--no-sandbox"],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      HL_VISUAL_QA: "1"
    }
  });

  try {
    const splash = await app.firstWindow();
    await splash.waitForLoadState("domcontentloaded").catch(() => undefined);
    await splash.getByText("HL Intelligence").waitFor({ timeout: 5000 }).catch(() => undefined);
    await capture(splash, "splash", 430, 270);

    const page = await waitForMainWindow(app);

    await capture(page, "main-shell-1440x900", 1440, 900);
    await capture(page, "main-shell-1280x720", 1280, 720);
    await capture(page, "minimum-layout-1040x720", 1040, 720);

    await page.getByText("Advanced").click();
    await capture(page, "commenter-advanced-style", 1440, 900);

    await createReviewPackageState(page);
    await capture(page, "review-package-success", 1440, 900);
    await page.getByRole("button", { name: /prepare review/i }).click();
    await capture(page, "review-package-actions", 1440, 900);
    await page.getByRole("button", { name: /apply comments/i }).click();
    await capture(page, "step-2-empty", 1440, 900);

    await page.locator(".apply-json").getByRole("button", { name: /^browse$/i }).click();
    await page.getByText("Ready to apply").first().waitFor({ timeout: 5000 });
    await capture(page, "valid-result", 1440, 900);

    await page.getByRole("button", { name: /create commented file/i }).click();
    await page.getByText("Commented file created.").waitFor({ timeout: 5000 });
    await capture(page, "output-success", 1440, 900);

    await setJsonScenario(page, "attention");
    await page.getByText("f-attention").waitFor({ timeout: 5000 });
    await capture(page, "attention-findings", 1440, 900);

    await setJsonScenario(page, "invalid");
    await page.getByText("Claude result was rejected.").waitFor({ timeout: 5000 });
    await capture(page, "invalid-result", 1440, 900);

    await page.getByRole("button", { name: /llm preflight/i }).click();
    await capture(page, "preflight-empty-queue", 1440, 900);

    await page.getByRole("button", { name: /^browse files$/i }).click();
    await page.getByText("board-book.pdf").waitFor({ timeout: 5000 });
    await capture(page, "mixed-queue", 1440, 900);

    await page.locator(".folder-field").getByRole("button", { name: /^browse$/i }).click();
    await page.getByRole("button", { name: /^generate$/i }).click();
    await page.waitForTimeout(180);
    await capture(page, "progress", 1440, 900);
    await page.getByText("Preflight generation finished with files needing attention.").waitFor({ timeout: 8000 });
    await capture(page, "partial-failure", 1440, 900);

    await page.getByRole("button", { name: /clear all/i }).click();
    await page.getByRole("button", { name: /^browse files$/i }).click();
    await page.getByText("legacy-board-book.doc").waitFor({ timeout: 5000 });
    await capture(page, "unsupported-legacy-file", 1440, 900);

    await page.getByRole("button", { name: /clear all/i }).click();
    await page.getByRole("button", { name: /^browse files$/i }).click();
    await page.getByText("office-unavailable.docx").waitFor({ timeout: 5000 });
    await capture(page, "missing-office-capability", 1440, 900);

    await page.getByRole("button", { name: /^browse files$/i }).focus();
    await capture(page, "keyboard-focus-state", 1280, 720);

    report.missingStates = report.requiredStates.filter(
      (state) => !report.screenshots.some((screenshot) => screenshot.name === state)
    );
    if (process.platform !== "win32") {
      report.environmentLimitations.push(
        "Windows display scaling at 100, 125, and 150 percent was not independently captured on this non-Windows visual QA run."
      );
    }
    report.status = report.missingStates.length ? "partial" : "passed";
  } finally {
    await app.close().catch(() => undefined);
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  await writeReport();
  console.error(report.error);
  process.exit(1);
}

await writeReport();
console.log(`Visual QA captured ${report.screenshots.length} screenshot(s); status=${report.status}.`);
if (report.status !== "passed") process.exitCode = 1;

async function capture(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  const filePath = path.join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  report.screenshots.push({ name, viewport: `${width}x${height}`, path: path.relative(process.cwd(), filePath) });
}

async function createReviewPackageState(page) {
  await page.getByRole("button", { name: /browse or drop document/i }).click();
  await page.getByText("Board deck final.pdf").waitFor({ timeout: 5000 });
  await page.locator(".folder-field").getByRole("button", { name: /^browse$/i }).click();
  await page.getByRole("button", { name: /create review package/i }).click();
  await page.getByText("Review package created.").waitFor({ timeout: 5000 });
}

async function setJsonScenario(page, scenario) {
  const textarea = page.locator(".json-textarea");
  await textarea.fill(JSON.stringify({ scenario }, null, 2));
}

async function waitForMainWindow(app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    for (const candidate of app.windows()) {
      try {
        await recordWindow(candidate);
        if (await candidate.getByText("Processed locally. No documents are uploaded by HL Intelligence.").count()) {
          return candidate;
        }
      } catch {
      }
    }
    await app.waitForEvent("window", { timeout: 500 }).catch(() => undefined);
  }
  throw new Error("Timed out waiting for the Electron main window.");
}

async function recordWindow(page) {
  const title = await page.title().catch(() => "");
  const rawUrl = page.url();
  const url = rawUrl.startsWith("data:") ? "data:<splash-html>" : rawUrl;
  const existing = report.windows ?? [];
  const key = `${title}|${url}`;
  if (!existing.some((item) => `${item.title}|${item.url}` === key)) {
    existing.push({ title, url });
    report.windows = existing;
  }
}

function findPlaywrightPath() {
  const local = path.join(process.cwd(), "node_modules", "playwright");
  if (existsSync(local)) return local;
  const npxRoot = path.join(process.env.HOME ?? "", ".npm", "_npx");
  const candidates = [
    path.join(npxRoot, "67dcf0932bafa1af", "node_modules", "playwright"),
    path.join(npxRoot, "88950a7d37a5e205", "node_modules", "playwright")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function writeReport() {
  await writeFile(path.join(artifactDir, "visual-qa-report.json"), JSON.stringify(report, null, 2), "utf8");
}
