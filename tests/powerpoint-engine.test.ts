import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createCommentedDocument } from "../src/engine/commentOutput";
import { documentAdapterRegistry } from "../src/engine/documentAdapterRegistry";
import { sha256File } from "../src/engine/hash";
import { runOfficeWorker } from "../src/engine/office/officeWorkerClient";
import type { PowerPointRenderResponse } from "../src/engine/office/officeTypes";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import type { ClaudeResult, DocumentAnchor, LocalReviewJob, SourceBlock } from "../src/shared/types";

describe("PowerPoint adapter foundation", () => {
  it("validates PowerPoint shape and slide anchors from the source map", async () => {
    const localJob = localPowerPointJob();
    const shape = localJob.source_map.anchors["ppt:s0001:shape:3"];
    const slide = localJob.source_map.anchors["ppt:s0002:slide:259"];
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: shape.anchor as DocumentAnchor,
          evidence: "Revenue increased by 14.2%",
          comment_body: "Please confirm this percentage."
        },
        {
          id: "C002",
          anchor: slide.anchor as DocumentAnchor,
          evidence: "visual chart evidence",
          comment_body: "Please confirm the visual chart evidence."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(true);
    expect(validation.summary.valid).toBe(2);
  });

  it("rejects PowerPoint shape anchors when evidence is not near the selected source anchor", async () => {
    const localJob = localPowerPointJob();
    const shape = localJob.source_map.anchors["ppt:s0001:shape:3"];
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: shape.anchor as DocumentAnchor,
          evidence: "not present",
          comment_body: "Please confirm this."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(false);
    expect(validation.summary.invalid).toBe(1);
  });
});

const nativePowerPointDescribe = process.env.HL_POWERPOINT_INTEGRATION === "1" ? describe : describe.skip;

nativePowerPointDescribe("native PowerPoint round trip", () => {
  it("creates PPTX and PPTM review packages, renders visual supplements, applies native comments, and verifies output", async () => {
    const dir = await nativePowerPointTempDir();
    const beforeProcesses = await powerPointProcessIds();
    const fixtures = await createPowerPointFixtures(dir, false);

    for (const sourcePath of [fixtures.pptx, fixtures.pptm]) {
      const documentType = path.extname(sourcePath).toLowerCase() === ".pptm" ? "pptm" : "pptx";
      const adapter = documentAdapterRegistry.require(documentType);
      const sourceHash = await sha256File(sourcePath);
      const inspection = await adapter.inspect({ sourcePath, includeHash: true });
      expect(inspection.counts.slides).toBeGreaterThanOrEqual(6);
      expect(inspection.sha256).toBe(sourceHash);

      const packageResult = await prepareReviewPackage({
        sourcePath,
        outputFolder: path.join(dir, "packages"),
        reviewInstructions: "Check slide values, labels, and visual exhibits.",
        style: {
          wording_mode: "automatic",
          signals: [],
          formality: "automatic",
          max_words: null,
          format_template: "{comment}",
          examples: []
        }
      });
      expect(packageResult.visualPdfPath).toBeTruthy();
      await stat(packageResult.visualPdfPath as string);

      const localJob = JSON.parse(await readFile(packageResult.localJobPath, "utf8")) as LocalReviewJob;
      expect(localJob.source.total_slides).toBeGreaterThanOrEqual(6);
      const shape = findAnchor(localJob, "pptx_shape", /Revenue increased by 14\.2%/);
      const table = findAnchor(localJob, "pptx_shape", /\$112\.5/);
      const slide = findAnchor(localJob, "pptx_slide", /Speaker note for diligence/);

      const result: ClaudeResult = {
        schema_version: "1.0",
        request_id: localJob.request_id,
        source_sha256: localJob.source.sha256,
        findings: [
          {
            id: "C001",
            anchor: shape.anchor as DocumentAnchor,
            evidence: "Revenue increased by 14.2%",
            comment_body: "Please confirm this percentage."
          },
          {
            id: "C002",
            anchor: table.anchor as DocumentAnchor,
            evidence: "$112.5",
            comment_body: "Please confirm the table value."
          },
          {
            id: "C003",
            anchor: slide.anchor as DocumentAnchor,
            evidence: "Speaker note for diligence",
            comment_body: "Please confirm the speaker-note context."
          }
        ]
      };
      const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
      expect(validation.ok).toBe(true);

      const output = await createCommentedDocument({
        sourcePath,
        localJobPath: packageResult.localJobPath,
        claudeJsonText: JSON.stringify(result),
        outputFolder: path.join(dir, "commented")
      });
      await stat(output.outputPath);
      expect(await sha256File(sourcePath)).toBe(sourceHash);

      const verified = await adapter.verifyOutput({ outputPath: output.outputPath, localJob });
      expect(verified.ok).toBe(true);

      const report = JSON.parse(await readFile(output.reportPath, "utf8")) as { comment_api?: string };
      expect(report.comment_api).toMatch(/Comments\.Add2|Comments\.Add/);

      const originalPdf = await renderPowerPointPdf(sourcePath, path.join(dir, `${path.basename(sourcePath)}.original.pdf`));
      const commentedPdf = await renderPowerPointPdf(output.outputPath, path.join(dir, `${path.basename(output.outputPath)}.pdf`));
      await expectSamePdfPageGeometry(originalPdf, commentedPdf);
    }

    const pptxAdapter = documentAdapterRegistry.require("pptx");
    await expect(pptxAdapter.inspect({ sourcePath: fixtures.passwordProtected })).rejects.toThrow(/password/i);
    await expect(pptxAdapter.inspect({ sourcePath: fixtures.corrupt })).rejects.toThrow(/corrupt|open/i);
    await expect(pptxAdapter.inspect({ sourcePath: fixtures.unicode })).resolves.toMatchObject({
      document_type: "pptx"
    });

    await wait(1000);
    const afterProcesses = await powerPointProcessIds();
    expect(afterProcesses.filter((id) => !beforeProcesses.includes(id))).toEqual([]);
    expect(fixtures.officeVersion).toMatch(/^\d+/);
  }, 600000);

  it("stress-tests 200 mixed slides, cancellation, repeated runs, and process cleanup when HL_POWERPOINT_STRESS=1", async () => {
    if (process.env.HL_POWERPOINT_STRESS !== "1") return;
    const dir = await nativePowerPointTempDir();
    const beforeProcesses = await powerPointProcessIds();
    const fixtures = await createPowerPointFixtures(dir, true);
    const adapter = documentAdapterRegistry.require("pptx");
    const sourceHash = await sha256File(fixtures.stress as string);
    const inspection = await adapter.inspect({ sourcePath: fixtures.stress as string, includeHash: true });
    expect(inspection.counts.slides).toBe(200);

    const prepared = await adapter.prepareDocument({
      sourcePath: fixtures.stress as string,
      mode: "text-only",
      sourceHash,
      outputFolder: path.join(dir, "stress-output"),
      preserveExistingComments: true
    });
    expect(prepared.source_map.source.total_slides).toBe(200);
    expect(prepared.markdown).toContain("Slide 200");
    expect(prepared.artifacts.visual_pdf_path).toBeFalsy();

    await expect(
      adapter.prepareDocument({
        sourcePath: fixtures.stress as string,
        mode: "text-only",
        sourceHash,
        outputFolder: path.join(dir, "cancel-output"),
        preserveExistingComments: true,
        isCancelled: () => true
      })
    ).rejects.toThrow(/cancelled/i);

    const repeated = await adapter.inspect({ sourcePath: fixtures.stress as string, includeHash: true });
    expect(repeated.counts.slides).toBe(200);

    await wait(1000);
    const afterProcesses = await powerPointProcessIds();
    expect(afterProcesses.filter((id) => !beforeProcesses.includes(id))).toEqual([]);
  }, 900000);
});

function localPowerPointJob(): LocalReviewJob {
  const shapeAnchor: DocumentAnchor = { kind: "pptx_shape", slide: 1, slide_id: 256, shape_id: "3" };
  const slideAnchor: DocumentAnchor = { kind: "pptx_slide", slide: 2, slide_id: 259 };
  return {
    schema_version: "1.0",
    processing_version: "test",
    request_id: "request-1",
    created_at: "2026-06-22T00:00:00.000Z",
    source: {
      filename: "source.pptx",
      sha256: "b".repeat(64),
      document_type: "pptx",
      total_slides: 2
    },
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "automatic",
      max_words: null,
      format_template: "{comment}",
      examples: []
    },
    source_map: {
      schema_version: "1.0",
      processing_version: "test",
      source: {
        filename: "source.pptx",
        sha256: "b".repeat(64),
        document_type: "pptx",
        total_slides: 2
      },
      anchors: {
        "ppt:s0001:shape:3": pptBlock(
          "ppt:s0001:shape:3",
          "pptx_shape",
          shapeAnchor,
          1,
          "3",
          "Shape Revenue Text | Revenue increased by 14.2% year over year."
        ),
        "ppt:s0002:slide:259": pptBlock(
          "ppt:s0002:slide:259",
          "pptx_slide",
          slideAnchor,
          2,
          undefined,
          "Slide visual chart evidence and speaker notes."
        )
      },
      visual_pages: []
    }
  };
}

function pptBlock(
  anchorId: string,
  kind: "pptx_shape" | "pptx_slide",
  anchor: DocumentAnchor,
  slide: number,
  shapeId: string | undefined,
  text: string
): SourceBlock {
  return {
    anchorId,
    kind,
    anchor,
    slide,
    slideId: anchor.kind === "pptx_shape" || anchor.kind === "pptx_slide" ? anchor.slide_id : undefined,
    shapeId,
    text,
    bbox: shapeId ? { x: 72, y: 100, width: 300, height: 80 } : undefined
  };
}

function findAnchor(localJob: LocalReviewJob, kind: "pptx_shape" | "pptx_slide", pattern: RegExp): SourceBlock {
  const anchor = Object.values(localJob.source_map.anchors).find((candidate) => candidate.kind === kind && pattern.test(candidate.text));
  if (!anchor) throw new Error(`Could not find ${kind} anchor matching ${pattern}.`);
  return anchor;
}

interface PowerPointFixtures {
  pptx: string;
  pptm: string;
  corrupt: string;
  passwordProtected: string;
  unicode: string;
  stress?: string;
  officeVersion: string;
  macroAvailable: boolean;
  embeddedAvailable: boolean;
  passwordAvailable: boolean;
}

async function createPowerPointFixtures(dir: string, includeStress: boolean): Promise<PowerPointFixtures> {
  const scriptPath = path.join(dir, "create-powerpoint-fixtures.ps1");
  await writeFile(scriptPath, powerPointFixtureScript(), "utf8");
  const result = await runPowerShell(scriptPath, ["-Dir", toWindowsPath(dir), includeStress ? "-IncludeStress" : ""]);
  const parsed = JSON.parse(result.stdout.trim()) as PowerPointFixtures;
  return {
    ...parsed,
    pptx: fromWindowsPath(parsed.pptx),
    pptm: fromWindowsPath(parsed.pptm),
    corrupt: fromWindowsPath(parsed.corrupt),
    passwordProtected: fromWindowsPath(parsed.passwordProtected),
    unicode: path.join(dir, "Unicode filename - cafe - \u4f1a\u793e.pptx"),
    stress: parsed.stress ? fromWindowsPath(parsed.stress) : undefined
  };
}

function powerPointFixtureScript(): string {
  return String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$Dir,
  [switch]$IncludeStress
)
$ErrorActionPreference = "Stop"
function Release-ComObject([object]$Value) {
  if ($null -ne $Value) {
    try {
      if ([System.Runtime.InteropServices.Marshal]::IsComObject($Value)) {
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) | Out-Null
      }
    } catch {}
  }
}
function Add-NativeComment([object]$Slide, [double]$Left, [double]$Top, [string]$Text) {
  try {
    $Slide.Comments.Add2($Left, $Top, "HL Test", "HL", $Text, "None", "hl-test") | Out-Null
  } catch {
    $Slide.Comments.Add($Left, $Top, "HL Test", "HL", $Text) | Out-Null
  }
}
function Set-Notes([object]$Slide, [string]$Text) {
  try {
    $Slide.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text = $Text
  } catch {}
}
function Add-BasicSlides([object]$Presentation, [string]$PngPath) {
  $Presentation.SlideMaster.Background.Fill.ForeColor.RGB = 15790320
  $slide1 = $Presentation.Slides.Add(1, 1)
  $slide1.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Operating Performance"
  $body = $slide1.Shapes.AddTextbox(1, 70, 110, 500, 70)
  $body.TextFrame.TextRange.Text = "Revenue increased by 14.2% year over year."
  $body.TextFrame.TextRange.ActionSettings.Item(1).Hyperlink.Address = "https://example.com/revenue"
  Add-NativeComment $slide1 70 110 "Existing performance comment"
  Set-Notes $slide1 "Speaker note for diligence: confirm revenue bridge."
  try { $slide1.SlideShowTransition.EntryEffect = 513 } catch {}
  try { $slide1.TimeLine.MainSequence.AddEffect($body, 1) | Out-Null } catch {}

  $slide2 = $Presentation.Slides.Add(2, 5)
  $slide2.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Financial Table"
  $tableShape = $slide2.Shapes.AddTable(3, 3, 70, 130, 520, 150)
  $values = @(
    @("Metric", "FY2024", "FY2025"),
    @("Revenue", '$100.0', '$112.5'),
    @("EBITDA", '$22.0', '$25.4')
  )
  for ($r = 1; $r -le 3; $r += 1) {
    for ($c = 1; $c -le 3; $c += 1) {
      $tableShape.Table.Cell($r, $c).Shape.TextFrame.TextRange.Text = $values[$r - 1][$c - 1]
    }
  }
  Set-Notes $slide2 "Table notes preserve diligence context."

  $slide3 = $Presentation.Slides.Add(3, 12)
  $slide3.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Revenue Chart"
  try {
    $chartShape = $slide3.Shapes.AddChart2(201, 51, 80, 110, 520, 300)
    $chartShape.Chart.HasTitle = $true
    $chartShape.Chart.ChartTitle.Text = "Revenue by Year"
  } catch {
    $slide3.Shapes.AddShape(1, 80, 120, 420, 220).TextFrame.TextRange.Text = "Chart fallback: Revenue FY2024 FY2025"
  }
  Set-Notes $slide3 "Chart notes."

  $slide4 = $Presentation.Slides.Add(4, 12)
  $slide4.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Image and Grouped Shapes"
  $slide4.Shapes.AddPicture($PngPath, $false, $true, 80, 110, 140, 100) | Out-Null
  $box1 = $slide4.Shapes.AddShape(1, 280, 120, 110, 55)
  $box1.Name = "Diagram node A"
  $box1.TextFrame.TextRange.Text = "Input"
  $box2 = $slide4.Shapes.AddShape(1, 420, 120, 110, 55)
  $box2.Name = "Diagram node B"
  $box2.TextFrame.TextRange.Text = "Output"
  $slide4.Shapes.Range(@($box1.Name, $box2.Name)).Group() | Out-Null

  $slide5 = $Presentation.Slides.Add(5, 12)
  $slide5.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Diagram and embedded object"
  $slide5.Shapes.AddShape(1, 80, 130, 150, 70).TextFrame.TextRange.Text = "Diagram-like start"
  $slide5.Shapes.AddShape(1, 360, 130, 150, 70).TextFrame.TextRange.Text = "Diagram-like end"
  $slide5.Shapes.AddLine(230, 165, 360, 165) | Out-Null
  $embeddedAvailable = $false
  try {
    $slide5.Shapes.AddOLEObject(80, 260, 180, 90, "Excel.Sheet", "", $false) | Out-Null
    $embeddedAvailable = $true
  } catch {}

  $slide6 = $Presentation.Slides.Add(6, 12)
  $slide6.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Hidden Appendix"
  $slide6.Shapes.AddTextbox(1, 80, 130, 400, 70).TextFrame.TextRange.Text = "Hidden slide content"
  $slide6.SlideShowTransition.Hidden = -1
  Set-Notes $slide6 "Hidden speaker note."

  while ($Presentation.Slides.Count -lt 7) {
    $extra = $Presentation.Slides.Add($Presentation.Slides.Count + 1, 2)
    $extra.Shapes.AddTextbox(1, 50, 35, 500, 40).TextFrame.TextRange.Text = "Additional Layout"
  }
  return $embeddedAvailable
}
function Save-MainDeck([object]$PowerPoint, [string]$PptxPath, [string]$PptmPath, [string]$UnicodePath, [string]$PasswordPath, [string]$PngPath) {
  $deck = $PowerPoint.Presentations.Add(0)
  $embeddedAvailable = Add-BasicSlides $deck $PngPath
  $deck.SaveAs($PptxPath, 24)
  $macroAvailable = $false
  try {
    $component = $deck.VBProject.VBComponents.Add(1)
    $component.CodeModule.AddFromString("Sub HLInertMacro()" + [Environment]::NewLine + "End Sub")
    $macroAvailable = $true
  } catch {}
  $deck.SaveAs($PptmPath, 25)
  $deck.SaveAs($UnicodePath, 24)
  $passwordAvailable = $false
  try {
    $deck.Password = "secret"
    $deck.SaveAs($PasswordPath, 24)
    $passwordAvailable = $true
  } catch {
    [IO.File]::WriteAllBytes($PasswordPath, [byte[]](0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1,0,0,0,0))
  }
  $deck.Close()
  return [ordered]@{ macroAvailable = $macroAvailable; embeddedAvailable = $embeddedAvailable; passwordAvailable = $passwordAvailable }
}
function Save-StressDeck([object]$PowerPoint, [string]$Path, [string]$PngPath) {
  $deck = $PowerPoint.Presentations.Add(0)
  for ($i = 1; $i -le 200; $i += 1) {
    $slide = $deck.Slides.Add($i, 12)
    $slide.Shapes.AddTextbox(1, 40, 30, 500, 35).TextFrame.TextRange.Text = "Stress slide $i"
    $slide.Shapes.AddTextbox(1, 50, 90, 380, 40).TextFrame.TextRange.Text = "Revenue increased by $i bps on stress slide $i."
    if ($i % 4 -eq 0) {
      $tbl = $slide.Shapes.AddTable(3, 3, 50, 150, 420, 120)
      $tbl.Table.Cell(2, 2).Shape.TextFrame.TextRange.Text = "Value $i"
    }
    if ($i % 5 -eq 0) { $slide.Shapes.AddPicture($PngPath, $false, $true, 450, 110, 70, 55) | Out-Null }
    if ($i % 7 -eq 0) {
      try { $slide.Shapes.AddChart2(201, 51, 100, 220, 360, 220) | Out-Null } catch {}
    }
    if ($i % 6 -eq 0) { Set-Notes $slide "Speaker note $i" }
  }
  $deck.SaveAs($Path, 24)
  $deck.Close()
}
if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$pptx = Join-Path $Dir "powerpoint-fixture.pptx"
$pptm = Join-Path $Dir "powerpoint-fixture.pptm"
$password = Join-Path $Dir "password-protected.pptx"
$corrupt = Join-Path $Dir "corrupt.pptx"
$unicode = Join-Path $Dir "Unicode filename - cafe - $([char]0x4f1a)$([char]0x793e).pptx"
$stress = Join-Path $Dir "stress-200-slides.pptx"
$png = Join-Path $Dir "fixture-image.png"
[IO.File]::WriteAllBytes($png, [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVR42mP8z8AARLJgWIqJYVQMACk8Ah/9VQx0AAAAAElFTkSuQmCC"))
$powerPoint = $null
try {
  $powerPoint = New-Object -ComObject "PowerPoint.Application"
  $powerPoint.DisplayAlerts = 1
  $powerPoint.AutomationSecurity = 3
  $version = [string]$powerPoint.Version
  $main = Save-MainDeck $powerPoint $pptx $pptm $unicode $password $png
  [IO.File]::WriteAllText($corrupt, "not a valid presentation")
  if ($IncludeStress) { Save-StressDeck $powerPoint $stress $png }
  [ordered]@{
    pptx = $pptx
    pptm = $pptm
    passwordProtected = $password
    corrupt = $corrupt
    unicode = $unicode
    stress = $(if ($IncludeStress) { $stress } else { $null })
    officeVersion = $version
    macroAvailable = [bool]$main.macroAvailable
    embeddedAvailable = [bool]$main.embeddedAvailable
    passwordAvailable = [bool]$main.passwordAvailable
  } | ConvertTo-Json -Depth 5
} finally {
  if ($null -ne $powerPoint) {
    try { $powerPoint.Quit() } catch {}
    Release-ComObject $powerPoint
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}
`;
}

async function renderPowerPointPdf(sourcePath: string, outputPdfPath: string): Promise<string> {
  const documentType = path.extname(sourcePath).toLowerCase() === ".pptm" ? "pptm" : "pptx";
  await runOfficeWorker<PowerPointRenderResponse>(
    {
      schema_version: "1.0",
      operation: "render",
      application: "powerpoint",
      document_type: documentType,
      source_path: sourcePath,
      output_pdf_path: outputPdfPath
    },
    { timeoutMs: 300000 }
  );
  return outputPdfPath;
}

async function expectSamePdfPageGeometry(leftPath: string, rightPath: string): Promise<void> {
  const left = await PDFDocument.load(await readFile(leftPath));
  const right = await PDFDocument.load(await readFile(rightPath));
  expect(right.getPageCount()).toBe(left.getPageCount());
  for (let index = 0; index < left.getPageCount(); index += 1) {
    const leftSize = left.getPage(index).getSize();
    const rightSize = right.getPage(index).getSize();
    expect(Math.round(rightSize.width)).toBe(Math.round(leftSize.width));
    expect(Math.round(rightSize.height)).toBe(Math.round(leftSize.height));
  }
}

async function nativePowerPointTempDir(): Promise<string> {
  if (process.platform !== "win32") {
    const candidate = path.join("/mnt/c/Users", os.userInfo().username, "AppData/Local/Temp");
    try {
      await mkdir(candidate, { recursive: true });
      return await mkdtemp(path.join(candidate, "hl-powerpoint-native-"));
    } catch {
    }
  }
  return mkdtemp(path.join(os.tmpdir(), "hl-powerpoint-native-"));
}

async function powerPointProcessIds(): Promise<number[]> {
  const result = await runPowerShellCommand("(Get-Process POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','");
  return result.stdout.trim() ? result.stdout.trim().split(",").map((value) => Number(value)).filter(Boolean) : [];
}

async function runPowerShell(scriptPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const filteredArgs = args.filter(Boolean);
  return runPowerShellArgs(["-ExecutionPolicy", "Bypass", "-File", toWindowsPath(scriptPath), ...filteredArgs]);
}

async function runPowerShellCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  return runPowerShellArgs(["-Command", command]);
}

async function runPowerShellArgs(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const powerShell = process.platform === "win32" ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  return new Promise((resolve, reject) => {
    const child = spawn(powerShell, ["-NoProfile", "-NonInteractive", ...args], {
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `PowerShell exited with code ${code}.`));
    });
  });
}

function toWindowsPath(filePath: string): string {
  if (process.platform === "win32") return filePath;
  if (filePath.startsWith("/mnt/") && filePath.length > 6) {
    const drive = filePath[5].toUpperCase();
    const rest = filePath.slice(7).replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
  return `\\\\wsl.localhost\\${distro}${filePath.replace(/\//g, "\\")}`;
}

function fromWindowsPath(filePath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
