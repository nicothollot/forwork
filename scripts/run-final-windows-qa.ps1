param(
  [switch]$SkipNpmCi,
  [switch]$SkipOfficeTests,
  [switch]$SkipVisualQa,
  [switch]$SkipPortableBuild,
  [switch]$SkipFreshLaunch,
  [switch]$NativeOfficeStress
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunningOnWindows = [System.Environment]::OSVersion.Platform -eq "Win32NT"
$ArtifactDir = Join-Path $Root "test-artifacts\final-qa"
$SummaryPath = Join-Path $ArtifactDir "final-windows-qa-summary.json"
$FinalExe = Join-Path $Root "release\windows-portable\HL Intelligence.exe"
$MaxBytes = 120MB

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
Set-Location $Root

$script:Summary = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  root = $Root.Path
  status = "running"
  steps = @()
  office = @{}
  executable = @{}
  limitations = @()
  manualSmokeChecklist = @(
    "First visible surface is the branded splash.",
    "No console window appears.",
    "Explorer, taskbar, and Alt+Tab icons show the HL Intelligence icon.",
    "Main window appears only after it is ready.",
    "Commenter and LLM Preflight open.",
    "File and folder pickers work.",
    "PDF, Word, Excel, and PowerPoint processing complete on synthetic files.",
    "Skill ZIP download works.",
    "hl_comments.json import validates automatically.",
    "Commented output opens in the correct Office application.",
    "Application exits cleanly.",
    "No orphan WINWORD.EXE, EXCEL.EXE, or POWERPNT.EXE process remains from this run."
  )
}

function Write-Summary {
  $script:Summary["finishedAt"] = (Get-Date).ToString("o")
  $script:Summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryPath -Encoding UTF8
}

function Add-Step {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail = ""
  )
  $script:Summary.steps += [ordered]@{
    name = $Name
    status = $Status
    detail = $Detail
    at = (Get-Date).ToString("o")
  }
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Block
  )
  Write-Host ""
  Write-Host "==> $Name"
  try {
    & $Block
    Add-Step -Name $Name -Status "passed"
  } catch {
    Add-Step -Name $Name -Status "failed" -Detail $_.Exception.Message
    throw
  }
}

function Invoke-External {
  param(
    [string]$Name,
    [string]$Command,
    [string[]]$Arguments,
    [hashtable]$Environment = @{}
  )
  Invoke-Step $Name {
    $oldValues = @{}
    foreach ($key in $Environment.Keys) {
      $oldValues[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
      [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
    }
    try {
      & $Command @Arguments
      if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE"
      }
    } finally {
      foreach ($key in $Environment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $oldValues[$key], "Process")
      }
    }
  }
}

function Get-NpmCommand {
  if ($RunningOnWindows) { return "npm.cmd" }
  return "npm"
}

function Test-OfficeCom {
  param(
    [string]$Name,
    [string]$ProgId
  )
  $app = $null
  try {
    $app = New-Object -ComObject $ProgId
    $version = [string]$app.Version
    $script:Summary.office[$Name] = $version
    Write-Host "  $Name $version"
  } catch {
    $script:Summary.office[$Name] = "Unavailable: $($_.Exception.Message)"
    $script:Summary.limitations += "$Name COM automation was not available for this run."
  } finally {
    if ($null -ne $app) {
      try { $app.Quit() | Out-Null } catch {}
      [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) | Out-Null
    }
  }
}

function Assert-FinalExeShape {
  if (!(Test-Path -LiteralPath $FinalExe)) {
    throw "Final executable was not found: $FinalExe"
  }
  $entries = Get-ChildItem -LiteralPath (Split-Path $FinalExe) -Force | Where-Object { $_.Name -ne ".DS_Store" }
  if ($entries.Count -ne 1 -or $entries[0].Name -ne "HL Intelligence.exe") {
    throw "Final release folder must contain exactly one user-facing executable."
  }
  $size = (Get-Item -LiteralPath $FinalExe).Length
  if ($size -gt $MaxBytes) {
    throw "Executable is $size bytes, above the 120 MiB hard maximum."
  }
  $script:Summary.executable["path"] = $FinalExe
  $script:Summary.executable["sizeBytes"] = $size
  $script:Summary.executable["sizeMiB"] = [Math]::Round($size / 1MB, 1)
}

try {
  Invoke-Step "Environment checks" {
    if (!$RunningOnWindows) {
      $script:Summary.limitations += "This script is intended for native Windows QA; current platform is not Windows."
    }
    & node --version
    if ($LASTEXITCODE -ne 0) { throw "node --version failed" }
    & (Get-NpmCommand) --version
    if ($LASTEXITCODE -ne 0) { throw "npm --version failed" }
    if ($RunningOnWindows) {
      Test-OfficeCom -Name "Word" -ProgId "Word.Application"
      Test-OfficeCom -Name "Excel" -ProgId "Excel.Application"
      Test-OfficeCom -Name "PowerPoint" -ProgId "PowerPoint.Application"
    }
  }

  $npm = Get-NpmCommand
  if (!$SkipNpmCi) {
    Invoke-External "npm ci" $npm @("ci")
  }
  Invoke-External "Type checking" $npm @("run", "typecheck")
  Invoke-External "Unit tests" $npm @("run", "test:unit")
  Invoke-External "Integration tests" $npm @("run", "test:integration")
  if (!$SkipOfficeTests) {
    Invoke-External "Native Office tests" $npm @("run", "test:office")
  } else {
    $script:Summary.limitations += "Native Office tests were skipped by operator flag."
  }
  Invoke-External "UI tests" $npm @("run", "test:ui")
  if (!$SkipVisualQa) {
    Invoke-External "Electron visual QA" $npm @("run", "test:ui:visual")
  } else {
    $script:Summary.limitations += "Electron visual QA was skipped by operator flag."
  }
  $stressEnv = @{}
  if ($NativeOfficeStress) {
    $stressEnv["HL_NATIVE_OFFICE_STRESS"] = "1"
  }
  Invoke-External "Stress tests" $npm @("run", "test:stress") $stressEnv
  Invoke-External "Skill ZIP build" $npm @("run", "skill:build")

  if (!$SkipPortableBuild) {
    Invoke-External "Portable build 1" $npm @("run", "package:win")
    Assert-FinalExeShape
    $firstSize = (Get-Item -LiteralPath $FinalExe).Length
    Invoke-External "Portable build 2 clean rebuild" $npm @("run", "package:win")
    Assert-FinalExeShape
    $secondSize = (Get-Item -LiteralPath $FinalExe).Length
    if ($secondSize -gt $firstSize) {
      throw "Second portable build grew from $firstSize to $secondSize bytes."
    }
    Invoke-External "Package size check" "node" @("scripts/check-windows-package-size.mjs", $FinalExe)
    if ($RunningOnWindows) {
      Invoke-External "Icon and metadata check" "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-windows-exe-icon.ps1", "-ExePath", $FinalExe)
    }
  } else {
    $script:Summary.limitations += "Portable build was skipped by operator flag."
  }

  if (!$SkipFreshLaunch -and (Test-Path -LiteralPath $FinalExe)) {
    Invoke-Step "Fresh-folder launch" {
      $freshDir = Join-Path $env:TEMP ("HL Intelligence Fresh Folder " + [Guid]::NewGuid().ToString("N"))
      New-Item -ItemType Directory -Path $freshDir | Out-Null
      $freshExe = Join-Path $freshDir "HL Intelligence.exe"
      Copy-Item -LiteralPath $FinalExe -Destination $freshExe
      $wrapper = Start-Process -FilePath $freshExe -WorkingDirectory $freshDir -PassThru
      Start-Sleep -Seconds 24
      $children = Get-Process -Name "HL Intelligence" -ErrorAction SilentlyContinue
      $mainWindow = $children | Where-Object { $_.MainWindowTitle -eq "HL Intelligence" } | Select-Object -First 1
      if ($null -eq $mainWindow) {
        if (!$wrapper.HasExited) {
          Stop-Process -Id $wrapper.Id -Force
        }
        throw "HL Intelligence main window was not found after fresh-folder launch."
      }
      $script:Summary.executable["freshLaunchPath"] = $freshExe
      $script:Summary.executable["freshLaunchPid"] = $mainWindow.Id
      $closed = $mainWindow.CloseMainWindow()
      if (!$closed) {
        throw "HL Intelligence main window did not accept a close request."
      }
      Start-Sleep -Seconds 8
      $remaining = Get-Process -Name "HL Intelligence" -ErrorAction SilentlyContinue
      if (($remaining | Measure-Object).Count -gt 0) {
        $remaining | Stop-Process -Force
        throw "HL Intelligence process remained after main-window close."
      }
    }
  } else {
    $script:Summary.limitations += "Fresh-folder launch was skipped or executable was unavailable."
  }

  $script:Summary.status = "passed"
  Write-Summary
  Write-Host ""
  Write-Host "Final Windows QA summary: $SummaryPath"
  Write-Host "Manual smoke checklist remains required for OS-modal picker behavior, Office app foregrounding, and icon surfaces."
} catch {
  $script:Summary.status = "failed"
  $script:Summary["error"] = $_.Exception.Message
  Write-Summary
  throw
}
