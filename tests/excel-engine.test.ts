import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCommentedDocument } from "../src/engine/commentOutput";
import { documentAdapterRegistry } from "../src/engine/documentAdapterRegistry";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import { sha256File } from "../src/engine/hash";
import type { ClaudeResult, DocumentAnchor, LocalReviewJob, SourceBlock } from "../src/shared/types";

describe("Excel adapter foundation", () => {
  it("validates Excel cell and range anchors from the source map", async () => {
    const localJob = localExcelJob();
    const cell = localJob.source_map.anchors["xl:s0001:c:C2"];
    const range = localJob.source_map.anchors["xl:s0001:table:Financials"];
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: cell.anchor as DocumentAnchor,
          evidence: "$1,125,000",
          comment_body: "Please confirm the FY2025 revenue value."
        },
        {
          id: "C002",
          anchor: range.anchor as DocumentAnchor,
          evidence: "Financials",
          comment_body: "Please confirm the table range."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(true);
    expect(validation.summary.valid).toBe(2);
  });

  it("rejects Excel anchors when evidence is not near the selected source anchor", async () => {
    const localJob = localExcelJob();
    const cell = localJob.source_map.anchors["xl:s0001:c:C2"];
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: cell.anchor as DocumentAnchor,
          evidence: "not present",
          comment_body: "Please confirm."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(false);
    expect(validation.summary.invalid).toBe(1);
  });
});

const nativeExcelDescribe = process.env.HL_EXCEL_INTEGRATION === "1" ? describe : describe.skip;

nativeExcelDescribe("native Excel round trip", () => {
  it("creates XLSX and XLSM review packages, renders visual supplements, applies notes, and verifies output", async () => {
    const dir = await nativeExcelTempDir();
    const beforeExcelProcesses = await excelProcessIds();
    const fixtures = await createExcelFixtures(dir, false);

    for (const sourcePath of [fixtures.xlsx, fixtures.xlsm]) {
      const documentType = path.extname(sourcePath).toLowerCase() === ".xlsm" ? "xlsm" : "xlsx";
      const adapter = documentAdapterRegistry.require(documentType);
      const sourceHash = await sha256File(sourcePath);
      const inspection = await adapter.inspect({ sourcePath, includeHash: true });
      expect(inspection.counts.sheets).toBeGreaterThanOrEqual(4);
      expect(inspection.sha256).toBe(sourceHash);

      const packageResult = await prepareReviewPackage({
        sourcePath,
        outputFolder: path.join(dir, "packages"),
        reviewInstructions: "Check workbook values and formulas.",
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
      expect(localJob.source.total_sheets).toBeGreaterThanOrEqual(4);
      const cell = findAnchor(localJob, "xlsx_cell", /\$?1,?125,?000|1125000/);
      const table = findAnchor(localJob, "xlsx_range", /Financials/);
      expect(cell.displayedValue).toBeTruthy();
      expect(cell.numberFormat).toBeTruthy();

      const result: ClaudeResult = {
        schema_version: "1.0",
        request_id: localJob.request_id,
        source_sha256: localJob.source.sha256,
        findings: [
          {
            id: "C001",
            anchor: cell.anchor as DocumentAnchor,
            evidence: cell.displayedValue,
            comment_body: "Please confirm the FY2025 revenue value."
          },
          {
            id: "C002",
            anchor: table.anchor as DocumentAnchor,
            evidence: "Financials",
            comment_body: "Please confirm the financial table range."
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
    }

    const xlsxAdapter = documentAdapterRegistry.require("xlsx");
    await expect(xlsxAdapter.inspect({ sourcePath: fixtures.passwordProtected })).rejects.toThrow(/password/i);
    await expect(xlsxAdapter.inspect({ sourcePath: fixtures.corrupt })).rejects.toThrow(/corrupt|open/i);
    await expect(xlsxAdapter.inspect({ sourcePath: fixtures.unicode })).resolves.toMatchObject({
      document_type: "xlsx"
    });

    await wait(1000);
    const afterExcelProcesses = await excelProcessIds();
    expect(afterExcelProcesses.filter((id) => !beforeExcelProcesses.includes(id))).toEqual([]);
    expect(fixtures.officeVersion).toMatch(/^\d+/);
  }, 600000);

  it("stress-tests 50 sheets and 100,000 populated cells when HL_EXCEL_STRESS=1", async () => {
    if (process.env.HL_EXCEL_STRESS !== "1") return;
    const dir = await nativeExcelTempDir();
    const fixtures = await createExcelFixtures(dir, true);
    const adapter = documentAdapterRegistry.require("xlsx");
    const startedAt = Date.now();
    const inspection = await adapter.inspect({ sourcePath: fixtures.stress as string, includeHash: true });
    expect(inspection.counts.sheets).toBe(50);
    const prepared = await adapter.prepareDocument({
      sourcePath: fixtures.stress as string,
      mode: "text-only",
      sourceHash: await sha256File(fixtures.stress as string),
      outputFolder: path.join(dir, "stress-output"),
      preserveExistingComments: true
    });
    expect(prepared.source_map.source.total_sheets).toBe(50);
    expect(prepared.markdown).toContain("Large range summary");
    expect(prepared.artifacts.visual_pdf_path).toBeFalsy();
    expect(Date.now() - startedAt).toBeLessThan(600000);
  }, 900000);
});

function localExcelJob(): LocalReviewJob {
  const cellAnchor: DocumentAnchor = { kind: "xlsx_cell", sheet: "Summary", cell: "C2" };
  const rangeAnchor: DocumentAnchor = { kind: "xlsx_range", sheet: "Summary", range: "A1:D4" };
  return {
    schema_version: "1.0",
    processing_version: "test",
    request_id: "request-1",
    created_at: "2026-06-22T00:00:00.000Z",
    source: {
      filename: "source.xlsx",
      sha256: "a".repeat(64),
      document_type: "xlsx",
      total_sheets: 4
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
        filename: "source.xlsx",
        sha256: "a".repeat(64),
        document_type: "xlsx",
        total_sheets: 4
      },
      anchors: {
        "xl:s0001:c:C2": excelBlock(
          "xl:s0001:c:C2",
          "xlsx_cell",
          cellAnchor,
          "Summary",
          "C2",
          undefined,
          "Displayed value: $1,125,000 | Formula: =B2*1.125 | Number format: $#,##0",
          "$1,125,000",
          "=B2*1.125",
          "$#,##0"
        ),
        "xl:s0001:table:Financials": excelBlock(
          "xl:s0001:table:Financials",
          "xlsx_range",
          rangeAnchor,
          "Summary",
          undefined,
          "A1:D4",
          "Excel table Financials on Summary!A1:D4"
        )
      },
      visual_pages: []
    }
  };
}

function excelBlock(
  anchorId: string,
  kind: "xlsx_cell" | "xlsx_range",
  anchor: DocumentAnchor,
  sheet: string,
  cell: string | undefined,
  range: string | undefined,
  text: string,
  displayedValue?: string,
  formula?: string,
  numberFormat?: string
): SourceBlock {
  return {
    anchorId,
    kind,
    anchor,
    sheet,
    cell,
    range,
    text,
    displayedValue,
    formula,
    numberFormat
  };
}

function findAnchor(localJob: LocalReviewJob, kind: "xlsx_cell" | "xlsx_range", pattern: RegExp): SourceBlock {
  const anchor = Object.values(localJob.source_map.anchors).find((candidate) => candidate.kind === kind && pattern.test(candidate.text));
  if (!anchor) throw new Error(`Could not find ${kind} anchor matching ${pattern}.`);
  return anchor;
}

interface ExcelFixtures {
  xlsx: string;
  xlsm: string;
  corrupt: string;
  passwordProtected: string;
  unicode: string;
  stress?: string;
  officeVersion: string;
  macroAvailable: boolean;
}

async function createExcelFixtures(dir: string, includeStress: boolean): Promise<ExcelFixtures> {
  const scriptPath = path.join(dir, "create-excel-fixtures.ps1");
  await writeFile(scriptPath, excelFixtureScript(), "utf8");
  const result = await runPowerShell(scriptPath, ["-Dir", toWindowsPath(dir), includeStress ? "-IncludeStress" : ""]);
  const parsed = JSON.parse(result.stdout.trim()) as ExcelFixtures;
  return {
    ...parsed,
    xlsx: fromWindowsPath(parsed.xlsx),
    xlsm: fromWindowsPath(parsed.xlsm),
    corrupt: fromWindowsPath(parsed.corrupt),
    passwordProtected: fromWindowsPath(parsed.passwordProtected),
    unicode: path.join(dir, "Unicode filename - cafe - \u4f1a\u793e.xlsx"),
    stress: parsed.stress ? fromWindowsPath(parsed.stress) : undefined
  };
}

function excelFixtureScript(): string {
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
function Save-MainWorkbook([object]$Excel, [string]$XlsxPath, [string]$XlsmPath, [string]$PngPath) {
  $wb = $Excel.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 3) { $wb.Worksheets.Add() | Out-Null }
  $summary = $wb.Worksheets.Item(1)
  $summary.Name = "Summary"
  $summary.Range("A1").Value2 = "Metric"
  $summary.Range("B1").Value2 = "FY2024"
  $summary.Range("C1").Value2 = "FY2025"
  $summary.Range("D1").Value2 = "Growth"
  $summary.Range("A2").Value2 = "Revenue"
  $summary.Range("B2").Value2 = 1000000
  $summary.Range("C2").Formula = "=B2*1.125"
  $summary.Range("D2").Formula = "=(C2-B2)/B2"
  $summary.Range("A3").Value2 = "Close date"
  $summary.Range("B3").Value2 = 46000
  $summary.Range("C3").Formula = "=B3+30"
  $summary.Range("D3").Value2 = 0.075
  $summary.Range("A4").Value2 = "Total"
  $summary.Range("B4").Formula = "=SUM(B2:C2)"
  $summary.Range("C4").Formula = "=C2"
  $summary.Range("D4").Formula = "=D2"
  $summary.Range("B2:C4").NumberFormat = "$#,##0"
  $summary.Range("D2:D4").NumberFormat = "0.0%"
  $summary.Range("B3:C3").NumberFormat = "m/d/yyyy"
  $summary.Columns.Item("A:F").ColumnWidth = 18
  $summary.Range("A6:C6").Merge()
  $summary.Range("A6").Value2 = "Merged dashboard heading"
  $summary.Range("E1").Value2 = "Hidden helper"
  $summary.Range("E2").Formula = "=C2*2"
  $summary.Columns.Item("E").Hidden = $true
  $summary.Rows.Item(5).Hidden = $true
  $summary.Range("H100:J120").Interior.Color = 15773696
  $summary.Range("F2").Formula = "='C:\HL Missing\[external.xlsx]Sheet1'!A1"
  $summary.Range("C2").AddComment("Existing revenue note") | Out-Null
  $summary.Range("D2:D4").FormatConditions.AddColorScale(2) | Out-Null
  $table = $summary.ListObjects.Add(1, $summary.Range("A1:D4"), $null, 1)
  $table.Name = "Financials"
  $chartObj = $summary.ChartObjects().Add(320, 20, 360, 220)
  $chartObj.Chart.SetSourceData($summary.Range("A1:C4"))
  $summary.Shapes.AddPicture($PngPath, $false, $true, 320, 270, 100, 50) | Out-Null
  $hidden = $wb.Worksheets.Item(2)
  $hidden.Name = "HiddenData"
  $hidden.Range("A1").Value2 = "Hidden value"
  $hidden.Visible = 0
  $veryHidden = $wb.Worksheets.Item(3)
  $veryHidden.Name = "VeryHiddenData"
  $veryHidden.Range("A1").Value2 = "Very hidden value"
  $veryHidden.Visible = 2
  $wb.Names.Add("Revenue_2025", '=Summary!$C$2') | Out-Null
  $chartSheet = $wb.Charts.Add()
  $chartSheet.Name = "ChartSheet"
  $chartSheet.SetSourceData($summary.Range("A1:C4"))
  $wb.SaveAs($XlsxPath, 51)
  $macroAvailable = $false
  try {
    $component = $wb.VBProject.VBComponents.Add(1)
    $component.CodeModule.AddFromString("Sub HLInertMacro()" + [Environment]::NewLine + "End Sub")
    $macroAvailable = $true
  } catch {}
  $wb.SaveAs($XlsmPath, 52)
  $wb.Close($false)
  return $macroAvailable
}
function Save-PasswordWorkbook([object]$Excel, [string]$Path) {
  $wb = $Excel.Workbooks.Add()
  $wb.Worksheets.Item(1).Range("A1").Value2 = "Password"
  $wb.SaveAs($Path, 51, "secret")
  $wb.Close($false)
}
function Save-StressWorkbook([object]$Excel, [string]$Path) {
  $wb = $Excel.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 50) { $wb.Worksheets.Add() | Out-Null }
  for ($sheetIndex = 1; $sheetIndex -le 50; $sheetIndex += 1) {
    $ws = $wb.Worksheets.Item($sheetIndex)
    $ws.Name = "S{0:D2}" -f $sheetIndex
    $data = New-Object "object[,]" 40,50
    for ($row = 0; $row -lt 40; $row += 1) {
      for ($column = 0; $column -lt 50; $column += 1) {
        $data[$row,$column] = ($sheetIndex * 100000) + ($row * 100) + $column
      }
    }
    $ws.Range("A1:AX40").Value2 = $data
    for ($row = 1; $row -le 40; $row += 5) {
      $ws.Cells.Item($row, 50).Formula = "=SUM(A" + $row + ":AW" + $row + ")"
    }
    if ($sheetIndex -eq 1) {
      $ws.Range("A1:AX40").FormatConditions.AddColorScale(2) | Out-Null
      $chart = $ws.ChartObjects().Add(300, 20, 360, 220)
      $chart.Chart.SetSourceData($ws.Range("A1:E10"))
    }
    if ($sheetIndex -eq 2) { $ws.Visible = 0 }
    if ($sheetIndex -eq 3) { $ws.Visible = 2 }
  }
  $wb.Names.Add("StressRange", '=S01!$A$1:$AX$40') | Out-Null
  $wb.SaveAs($Path, 51)
  $wb.Close($false)
}
if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
$xlsx = Join-Path $Dir "excel-fixture.xlsx"
$xlsm = Join-Path $Dir "excel-fixture.xlsm"
$password = Join-Path $Dir "password-protected.xlsx"
$corrupt = Join-Path $Dir "corrupt.xlsx"
$unicode = Join-Path $Dir "Unicode filename - cafe - $([char]0x4f1a)$([char]0x793e).xlsx"
$stress = Join-Path $Dir "stress-50-sheets.xlsx"
$png = Join-Path $Dir "fixture-image.png"
[IO.File]::WriteAllBytes($png, [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVR42mP8z8AARLJgWIqJYVQMACk8Ah/9VQx0AAAAAElFTkSuQmCC"))
$excel = $null
try {
  $excel = New-Object -ComObject "Excel.Application"
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AutomationSecurity = 3
  $excel.AskToUpdateLinks = $false
  $excel.EnableEvents = $false
  $excel.ScreenUpdating = $false
  $version = [string]$excel.Version
  $macroAvailable = Save-MainWorkbook -Excel $excel -XlsxPath $xlsx -XlsmPath $xlsm -PngPath $png
  Copy-Item -LiteralPath $xlsx -Destination $unicode -Force
  Save-PasswordWorkbook -Excel $excel -Path $password
  [IO.File]::WriteAllText($corrupt, "not a valid workbook")
  if ($IncludeStress) { Save-StressWorkbook -Excel $excel -Path $stress }
  $result = [ordered]@{
    xlsx = $xlsx
    xlsm = $xlsm
    passwordProtected = $password
    corrupt = $corrupt
    unicode = $unicode
    stress = $(if ($IncludeStress) { $stress } else { $null })
    officeVersion = $version
    macroAvailable = $macroAvailable
  }
  $result | ConvertTo-Json -Depth 5
} finally {
  if ($null -ne $excel) {
    try { $excel.Quit() } catch {}
    Release-ComObject $excel
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}
`;
}

async function nativeExcelTempDir(): Promise<string> {
  if (process.platform !== "win32") {
    const candidate = path.join("/mnt/c/Users", os.userInfo().username, "AppData/Local/Temp");
    try {
      await mkdir(candidate, { recursive: true });
      return await mkdtemp(path.join(candidate, "hl-excel-native-"));
    } catch {
    }
  }
  return mkdtemp(path.join(os.tmpdir(), "hl-excel-native-"));
}

async function excelProcessIds(): Promise<number[]> {
  const result = await runPowerShellCommand("(Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','");
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
