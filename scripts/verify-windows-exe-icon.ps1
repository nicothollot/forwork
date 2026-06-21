param(
  [string]$ExePath = (Join-Path (Resolve-Path ".") "release\windows-portable\HL Intelligence.exe"),
  [string]$IconPngPath = (Join-Path $env:TEMP "hl-intelligence-exe-icon.png")
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $ExePath)) {
  throw "Executable was not found: $ExePath"
}

$resolvedSourceExe = (Resolve-Path -LiteralPath $ExePath).Path
$verificationDir = Join-Path $env:TEMP ("hl-intelligence-verify-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $verificationDir | Out-Null
$verificationExe = Join-Path $verificationDir "HL Intelligence Renamed.exe"
Copy-Item -LiteralPath $resolvedSourceExe -Destination $verificationExe

$versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($verificationExe)

if ($versionInfo.ProductName -ne "HL Intelligence") {
  throw "Unexpected ProductName '$($versionInfo.ProductName)' in $verificationExe"
}

if ($versionInfo.FileDescription -ne "HL Intelligence") {
  throw "Unexpected FileDescription '$($versionInfo.FileDescription)' in $verificationExe"
}

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class HlShellIcon {
  [DllImport("Shell32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr ExtractAssociatedIcon(IntPtr hInst, string lpIconPath, ref ushort lpiIcon);
}
"@

$iconIndex = [UInt16]0
$iconHandle = [HlShellIcon]::ExtractAssociatedIcon([IntPtr]::Zero, $verificationExe, [ref]$iconIndex)
if ($iconHandle -eq [IntPtr]::Zero) {
  throw "Windows did not return an associated shell icon for $verificationExe"
}

$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$bitmap = $icon.ToBitmap()
$bitmap.Save($IconPngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$hlPalettePixels = 0
$nonWhitePixels = 0
for ($y = 0; $y -lt $bitmap.Height; $y++) {
  for ($x = 0; $x -lt $bitmap.Width; $x++) {
    $pixel = $bitmap.GetPixel($x, $y)
    if ($pixel.A -gt 0 -and ($pixel.R -lt 245 -or $pixel.G -lt 245 -or $pixel.B -lt 245)) {
      $nonWhitePixels += 1
    }
    $isOxford = ($pixel.R -le 80 -and $pixel.G -le 125 -and $pixel.B -ge 70 -and $pixel.B -le 175)
    $isTufts = ($pixel.R -ge 45 -and $pixel.R -le 130 -and $pixel.G -ge 95 -and $pixel.G -le 190 -and $pixel.B -ge 145 -and $pixel.B -le 245)
    $isRoman = ($pixel.R -ge 70 -and $pixel.R -le 230 -and $pixel.G -ge 85 -and $pixel.G -le 235 -and $pixel.B -ge 95 -and $pixel.B -le 245 -and $pixel.B -ge $pixel.R + 8)
    if ($isOxford -or $isTufts -or $isRoman) {
      $hlPalettePixels += 1
    }
  }
}

if ($nonWhitePixels -lt 30 -or $hlPalettePixels -lt 6) {
  throw "The extracted icon does not contain enough expected HL palette pixels; possible default Electron or installer icon. Saved icon: $IconPngPath"
}

Write-Host "Verified executable metadata and shell icon:"
Write-Host "  Source EXE: $resolvedSourceExe"
Write-Host "  Verification copy: $verificationExe"
Write-Host "  ProductName: $($versionInfo.ProductName)"
Write-Host "  FileDescription: $($versionInfo.FileDescription)"
Write-Host "  Saved icon PNG: $IconPngPath"
