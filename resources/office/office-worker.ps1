param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath,

  [Parameter(Mandatory = $true)]
  [string]$ResponsePath
)

$ErrorActionPreference = "Stop"
$script:WorkerStage = ""
$script:CancelPath = ""

try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
} catch {
}

function Write-JsonResponse {
  param([object]$Value)
  $Value | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $ResponsePath -Encoding UTF8
}

function New-Failure {
  param(
    [string]$Operation,
    [string]$Code,
    [string]$Message,
    [string]$DocumentType = ""
  )

  $response = [ordered]@{
    schema_version = "1.0"
    operation = $Operation
    ok = $false
    error = [ordered]@{
      code = $Code
      message = $Message
    }
  }
  if ($DocumentType) {
    $response.document_type = $DocumentType
  }
  return $response
}

function Test-WorkerCancelled {
  if ($script:CancelPath -and (Test-Path -LiteralPath $script:CancelPath)) {
    throw "cancelled"
  }
}

function Convert-ErrorToFailure {
  param(
    [string]$Operation,
    [object]$ErrorRecord,
    [string]$DocumentType = ""
  )

  $officeApp = if ($DocumentType -eq "xlsx" -or $DocumentType -eq "xlsm") {
    "Excel"
  } elseif ($DocumentType -eq "pptx" -or $DocumentType -eq "pptm") {
    "PowerPoint"
  } else {
    "Word"
  }
  $message = "The $officeApp operation failed."
  if ($null -ne $ErrorRecord -and $null -ne $ErrorRecord.Exception -and $ErrorRecord.Exception.Message) {
    $message = [string]$ErrorRecord.Exception.Message
  } elseif ($null -ne $ErrorRecord) {
    $message = [string]$ErrorRecord
  }
  if ($script:WorkerStage -and ($env:HL_WORD_DEBUG_ERRORS -eq "1" -or $env:HL_EXCEL_DEBUG_ERRORS -eq "1" -or $env:HL_POWERPOINT_DEBUG_ERRORS -eq "1")) {
    $message = "$($script:WorkerStage): $message"
  }

  $lower = $message.ToLowerInvariant()
  if ($lower -eq "cancelled") {
    return New-Failure -Operation $Operation -Code "operation_failed" -Message "cancelled" -DocumentType $DocumentType
  }
  if ($officeApp -eq "Excel" -and $lower -match "excel is not installed|could not be started|activex component|class not registered|invalid class string|retrieving the com class factory") {
    return New-Failure -Operation $Operation -Code "excel_not_installed" -Message "Microsoft Excel is not installed or could not be started." -DocumentType $DocumentType
  }
  if ($officeApp -eq "PowerPoint" -and $lower -match "powerpoint is not installed|could not be started|activex component|class not registered|invalid class string|retrieving the com class factory") {
    return New-Failure -Operation $Operation -Code "powerpoint_not_installed" -Message "Microsoft PowerPoint is not installed or could not be started." -DocumentType $DocumentType
  }
  if ($lower -match "word is not installed|could not be started|activex component|class not registered|invalid class string|retrieving the com class factory") {
    return New-Failure -Operation $Operation -Code "word_not_installed" -Message "Microsoft Word is not installed or could not be started." -DocumentType $DocumentType
  }
  if ($lower -match "password|encrypted|protected") {
    return New-Failure -Operation $Operation -Code "password_protected" -Message "Password-protected $officeApp documents are not supported. HL Intelligence will not bypass document passwords." -DocumentType $DocumentType
  }
  if ($lower -match "corrupt|corrupted|damaged|unreadable|repair|cannot open the file") {
    return New-Failure -Operation $Operation -Code "corrupt_document" -Message "$officeApp could not open this document normally. The file may be corrupt." -DocumentType $DocumentType
  }
  if ($lower -match "unsupported|could not find the selected word anchor|could not find the selected excel anchor|could not find the selected powerpoint anchor|cannot access individual cells") {
    return New-Failure -Operation $Operation -Code "unsupported_feature" -Message "This $officeApp document contains a feature HL Intelligence cannot safely process yet." -DocumentType $DocumentType
  }
  if ($lower -match "verification") {
    return New-Failure -Operation $Operation -Code "output_verification_failed" -Message $message -DocumentType $DocumentType
  }
  if ($env:HL_WORD_DEBUG_ERRORS -eq "1" -or $env:HL_EXCEL_DEBUG_ERRORS -eq "1" -or $env:HL_POWERPOINT_DEBUG_ERRORS -eq "1") {
    return New-Failure -Operation $Operation -Code "operation_failed" -Message $message -DocumentType $DocumentType
  }

  return New-Failure -Operation $Operation -Code "operation_failed" -Message "The $officeApp operation failed. No source document was modified." -DocumentType $DocumentType
}

function Release-ComObject {
  param([object]$Value)
  if ($null -eq $Value) {
    return
  }
  try {
    if ([System.Runtime.InteropServices.Marshal]::IsComObject($Value)) {
      [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) | Out-Null
    }
  } catch {
  }
}

function Start-WordApplication {
  $word = $null
  try {
    $word = New-Object -ComObject "Word.Application"
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $word.ScreenUpdating = $false
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}
    try { $word.Options.SaveNormalPrompt = $false } catch {}
    try { $word.Options.ConfirmConversions = $false } catch {}
    return $word
  } catch {
    Release-ComObject $word
    throw "Microsoft Word is not installed or could not be started."
  }
}

function Stop-WordApplication {
  param([object]$Word)
  if ($null -eq $Word) {
    return
  }
  try {
    $saveChanges = 0
    $Word.Quit([ref]$saveChanges)
  } catch {
  } finally {
    Release-ComObject $Word
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
}

function Open-WordDocument {
  param(
    [object]$Word,
    [string]$Path,
    [bool]$ReadOnly
  )

  $fileName = $Path
  $confirmConversions = $false
  $readOnlyValue = $ReadOnly
  $addToRecentFiles = $false

  return $Word.Documents.Open(
    [ref]$fileName,
    [ref]$confirmConversions,
    [ref]$readOnlyValue,
    [ref]$addToRecentFiles
  )
}

function Close-WordDocument {
  param(
    [object]$Document,
    [bool]$Save = $false
  )
  if ($null -eq $Document) {
    return
  }
  try {
    if ($Save) {
      $Document.Save()
    }
    $saveChanges = 0
    $Document.Close([ref]$saveChanges)
  } finally {
    Release-ComObject $Document
  }
}

function Start-ExcelApplication {
  $excel = $null
  try {
    $excel = New-Object -ComObject "Excel.Application"
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AutomationSecurity = 3
    $excel.AskToUpdateLinks = $false
    $excel.EnableEvents = $false
    $excel.ScreenUpdating = $false
    try { $excel.AlertBeforeOverwriting = $false } catch {}
    try { $excel.Calculation = -4135 } catch {}
    try { $excel.CalculateBeforeSave = $false } catch {}
    return $excel
  } catch {
    Release-ComObject $excel
    throw "Microsoft Excel is not installed or could not be started."
  }
}

function Stop-ExcelApplication {
  param([object]$Excel)
  if ($null -eq $Excel) {
    return
  }
  try {
    $Excel.DisplayAlerts = $false
    $Excel.Quit()
  } catch {
  } finally {
    Release-ComObject $Excel
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
}

function Open-ExcelWorkbook {
  param(
    [object]$Excel,
    [string]$Path,
    [bool]$ReadOnly
  )

  Assert-ExcelPackageCanOpen -Path $Path
  $updateLinks = 0
  $readOnlyValue = $ReadOnly
  return $Excel.Workbooks.Open($Path, $updateLinks, $readOnlyValue, [Type]::Missing, [Type]::Missing, [Type]::Missing, $true, [Type]::Missing, [Type]::Missing, $false, [Type]::Missing, $false)
}

function Close-ExcelWorkbook {
  param(
    [object]$Workbook,
    [bool]$Save = $false
  )
  if ($null -eq $Workbook) {
    return
  }
  try {
    if ($Save) {
      $Workbook.Save()
    }
    $Workbook.Close($false)
  } finally {
    Release-ComObject $Workbook
  }
}

function Start-PowerPointApplication {
  $powerPoint = $null
  try {
    $powerPoint = New-Object -ComObject "PowerPoint.Application"
    $powerPoint.DisplayAlerts = 1
    $powerPoint.AutomationSecurity = 3
    try { $powerPoint.ShowWindowsInTaskbar = 0 } catch {}
    return $powerPoint
  } catch {
    Release-ComObject $powerPoint
    throw "Microsoft PowerPoint is not installed or could not be started."
  }
}

function Stop-PowerPointApplication {
  param([object]$PowerPoint)
  if ($null -eq $PowerPoint) {
    return
  }
  try {
    $PowerPoint.DisplayAlerts = 1
    $PowerPoint.Quit()
  } catch {
  } finally {
    Release-ComObject $PowerPoint
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
}

function Open-PowerPointPresentation {
  param(
    [object]$PowerPoint,
    [string]$Path,
    [bool]$ReadOnly
  )

  Assert-PowerPointPackageCanOpen -Path $Path
  $readOnlyValue = if ($ReadOnly) { -1 } else { 0 }
  $untitled = 0
  $withWindow = 0
  return $PowerPoint.Presentations.Open($Path, $readOnlyValue, $untitled, $withWindow)
}

function Close-PowerPointPresentation {
  param(
    [object]$Presentation,
    [bool]$Save = $false
  )
  if ($null -eq $Presentation) {
    return
  }
  try {
    if ($Save) {
      $Presentation.Save()
    }
    $Presentation.Close()
  } finally {
    Release-ComObject $Presentation
  }
}

function Clear-PowerPointRecentFile {
  param(
    [object]$PowerPoint,
    [string]$Path
  )
  if ($null -eq $PowerPoint -or -not $Path) {
    return
  }
  try {
    for ($index = $PowerPoint.RecentFiles.Count; $index -ge 1; $index -= 1) {
      $recent = $null
      try {
        $recent = $PowerPoint.RecentFiles.Item($index)
        $recentPath = ""
        try { $recentPath = [string]$recent.Path } catch {}
        if (-not $recentPath) {
          try { $recentPath = [string]$recent.Name } catch {}
        }
        if ($recentPath -and ([string]::Equals($recentPath, $Path, [System.StringComparison]::OrdinalIgnoreCase))) {
          $recent.Delete()
        }
      } finally {
        Release-ComObject $recent
      }
    }
  } catch {
  }
}

function New-Capability {
  param(
    [bool]$Available,
    [string]$Version = "",
    [string]$Message = ""
  )

  $capability = [ordered]@{
    available = $Available
  }
  if ($Version) {
    $capability.version = $Version
  }
  if ($Message) {
    $capability.message = $Message
  }
  return $capability
}

function Test-OfficeApplication {
  param(
    [string]$ProgId,
    [string]$Kind
  )

  $app = $null
  try {
    $app = New-Object -ComObject $ProgId
    $app.Visible = $false
    if ($Kind -eq "excel") {
      $app.DisplayAlerts = $false
      $app.AutomationSecurity = 3
    }
    if ($Kind -eq "word") {
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
    }
    if ($Kind -eq "powerpoint") {
      $app.DisplayAlerts = 1
      $app.AutomationSecurity = 3
    }
    return New-Capability -Available $true -Version ([string]$app.Version)
  } catch {
    return New-Capability -Available $false -Message "This Office application is not available for local automation."
  } finally {
    if ($null -ne $app) {
      try { $app.Quit() } catch {}
      Release-ComObject $app
    }
  }
}

function Get-PackageEntryExists {
  param(
    [string]$Path,
    [string]$Pattern
  )

  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match $Pattern) {
        return $true
      }
    }
  } catch {
    return $false
  } finally {
    if ($null -ne $zip) {
      $zip.Dispose()
    }
  }
  return $false
}

function Assert-ExcelPackageCanOpen {
  param([string]$Path)
  $bytes = New-Object byte[] 8
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $read = $stream.Read($bytes, 0, 8)
  } finally {
    $stream.Dispose()
  }
  if ($bytes.Length -ge 4 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B) {
    return
  }
  if (
    $read -ge 8 -and
    $bytes[0] -eq 0xD0 -and $bytes[1] -eq 0xCF -and $bytes[2] -eq 0x11 -and $bytes[3] -eq 0xE0 -and
    $bytes[4] -eq 0xA1 -and $bytes[5] -eq 0xB1 -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0xE1
  ) {
    throw "Password-protected Excel workbook."
  }
  throw "Excel could not open this workbook normally. The file may be corrupt."
}

function Assert-PowerPointPackageCanOpen {
  param([string]$Path)
  $bytes = New-Object byte[] 8
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $read = $stream.Read($bytes, 0, 8)
  } finally {
    $stream.Dispose()
  }
  if ($read -ge 4 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B) {
    return
  }
  if (
    $read -ge 8 -and
    $bytes[0] -eq 0xD0 -and $bytes[1] -eq 0xCF -and $bytes[2] -eq 0x11 -and $bytes[3] -eq 0xE0 -and
    $bytes[4] -eq 0xA1 -and $bytes[5] -eq 0xB1 -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0xE1
  ) {
    throw "Password-protected PowerPoint presentation."
  }
  throw "PowerPoint could not open this presentation normally. The file may be corrupt."
}

function Get-MacroPresence {
  param(
    [string]$Path,
    [string]$DocumentType
  )
  return (Get-PackageEntryExists -Path $Path -Pattern "(^|/)vbaProject\.bin$")
}

function Get-ExcelVisibilityLabel {
  param([object]$Sheet)
  try {
    $visible = [int]$Sheet.Visible
    if ($visible -eq 0) { return "hidden" }
    if ($visible -eq 2) { return "very-hidden" }
  } catch {
  }
  return "visible"
}

function Get-ExcelAddress {
  param([object]$Range)
  try {
    return ([string]$Range.Address($false, $false)).Replace("$", "")
  } catch {
    return ""
  }
}

function Get-ExcelSheetKind {
  param([object]$Sheet)
  try {
    $typeName = [string]$Sheet.GetType().InvokeMember("Name", "GetProperty", $null, $Sheet, $null)
    if ($typeName -match "Chart") {
      return "chart"
    }
  } catch {
  }
  try {
    $null = $Sheet.UsedRange
    return "worksheet"
  } catch {
    return "chart"
  }
}

function Get-ExcelMeaningfulUsedRange {
  param([object]$Worksheet)

  $firstRow = $null
  $firstColumn = $null
  $lastRow = $null
  $lastColumn = $null

  try {
    $lastRowCell = $Worksheet.Cells.Find("*", [Type]::Missing, -4123, [Type]::Missing, 1, 2, $false)
    if ($null -ne $lastRowCell) {
      $lastRow = [int]$lastRowCell.Row
      Release-ComObject $lastRowCell
    }
  } catch {
  }
  try {
    $lastColumnCell = $Worksheet.Cells.Find("*", [Type]::Missing, -4123, [Type]::Missing, 2, 2, $false)
    if ($null -ne $lastColumnCell) {
      $lastColumn = [int]$lastColumnCell.Column
      Release-ComObject $lastColumnCell
    }
  } catch {
  }
  try {
    $firstRowCell = $Worksheet.Cells.Find("*", [Type]::Missing, -4123, [Type]::Missing, 1, 1, $false)
    if ($null -ne $firstRowCell) {
      $firstRow = [int]$firstRowCell.Row
      Release-ComObject $firstRowCell
    }
  } catch {
  }
  try {
    $firstColumnCell = $Worksheet.Cells.Find("*", [Type]::Missing, -4123, [Type]::Missing, 2, 1, $false)
    if ($null -ne $firstColumnCell) {
      $firstColumn = [int]$firstColumnCell.Column
      Release-ComObject $firstColumnCell
    }
  } catch {
  }

  if ($null -eq $firstRow -or $null -eq $firstColumn -or $null -eq $lastRow -or $null -eq $lastColumn) {
    return $null
  }
  if ($lastRow -lt $firstRow -or $lastColumn -lt $firstColumn) {
    return $null
  }

  $topLeft = $Worksheet.Cells.Item($firstRow, $firstColumn)
  $bottomRight = $Worksheet.Cells.Item($lastRow, $lastColumn)
  try {
    $range = $Worksheet.Range($topLeft, $bottomRight)
    return [ordered]@{
      range = $range
      address = Get-ExcelAddress $range
      rows = ($lastRow - $firstRow + 1)
      columns = ($lastColumn - $firstColumn + 1)
      first_row = $firstRow
      first_column = $firstColumn
      last_row = $lastRow
      last_column = $lastColumn
    }
  } finally {
    Release-ComObject $topLeft
    Release-ComObject $bottomRight
  }
}

function Get-ExcelCommentsText {
  param([object]$Cell)
  $parts = New-Object System.Collections.Generic.List[string]
  try {
    $comment = $Cell.Comment
    if ($null -ne $comment) {
      $text = Get-OneLineText $comment.Text()
      if ($text) {
        $parts.Add($text) | Out-Null
      }
      Release-ComObject $comment
    }
  } catch {
  }
  try {
    $threaded = $Cell.CommentThreaded
    if ($null -ne $threaded) {
      $text = Get-OneLineText $threaded.Text()
      if ($text) {
        $parts.Add($text) | Out-Null
      }
      Release-ComObject $threaded
    }
  } catch {
  }
  return ($parts -join " | ")
}

function Get-ExcelCommentCount {
  param([object]$Workbook)
  $count = 0
  for ($index = 1; $index -le $Workbook.Worksheets.Count; $index += 1) {
    $sheet = $null
    try {
      $sheet = $Workbook.Worksheets.Item($index)
      try { $count += [int]$sheet.Comments.Count } catch {}
      try { $count += [int]$sheet.CommentsThreaded.Count } catch {}
    } finally {
      Release-ComObject $sheet
    }
  }
  return $count
}

function Get-ExcelChartCount {
  param([object]$Workbook)
  $count = 0
  try { $count += [int]$Workbook.Charts.Count } catch {}
  for ($index = 1; $index -le $Workbook.Worksheets.Count; $index += 1) {
    $sheet = $null
    try {
      $sheet = $Workbook.Worksheets.Item($index)
      try { $count += [int]$sheet.ChartObjects().Count } catch {}
    } finally {
      Release-ComObject $sheet
    }
  }
  return $count
}

function Get-ExcelFormulaCellCount {
  param([object]$Workbook)
  $count = 0
  for ($index = 1; $index -le $Workbook.Worksheets.Count; $index += 1) {
    $sheet = $null
    $formulas = $null
    $used = $null
    try {
      $sheet = $Workbook.Worksheets.Item($index)
      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -eq $used) { continue }
      try {
        $formulas = $used.range.SpecialCells(-4123)
        $count += [int]$formulas.CountLarge
      } catch {
      }
    } finally {
      Release-ComObject $formulas
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }
  return $count
}

function Get-ExcelExternalLinks {
  param([object]$Workbook)
  $links = New-Object System.Collections.Generic.List[string]
  foreach ($kind in @(1, 2)) {
    try {
      $sources = $Workbook.LinkSources($kind)
      if ($null -ne $sources) {
        foreach ($source in $sources) {
          if ($source) {
            $links.Add([string]$source) | Out-Null
          }
        }
      }
    } catch {
    }
  }
  try {
    for ($index = 1; $index -le $Workbook.Connections.Count; $index += 1) {
      $connection = $null
      try {
        $connection = $Workbook.Connections.Item($index)
        $name = Get-OneLineText $connection.Name
        if ($name) {
          $links.Add("connection:$name") | Out-Null
        }
      } finally {
        Release-ComObject $connection
      }
    }
  } catch {
  }
  return @($links | Sort-Object -Unique)
}

function Get-ExcelNamedRangeSignature {
  param([object]$Workbook)
  $parts = New-Object System.Collections.Generic.List[string]
  try {
    for ($index = 1; $index -le $Workbook.Names.Count; $index += 1) {
      $name = $null
      try {
        $name = $Workbook.Names.Item($index)
        $parts.Add("$($name.Name)|$($name.RefersTo)|$($name.Visible)") | Out-Null
      } finally {
        Release-ComObject $name
      }
    }
  } catch {
  }
  return Get-Sha256Text (($parts | Sort-Object) -join "`n")
}

function Get-ExcelHiddenStateSignature {
  param([object]$Workbook)
  $parts = New-Object System.Collections.Generic.List[string]
  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    $sheet = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      $parts.Add("$index|$($sheet.Name)|$(Get-ExcelVisibilityLabel $sheet)") | Out-Null
    } finally {
      Release-ComObject $sheet
    }
  }
  return Get-Sha256Text (($parts | Sort-Object) -join "`n")
}

function Get-Sha256Text {
  param([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256 {
  param([string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Get-ExcelNumberFormatSignature {
  param([object]$Workbook)
  $parts = New-Object System.Collections.Generic.List[string]
  for ($sheetIndex = 1; $sheetIndex -le $Workbook.Worksheets.Count; $sheetIndex += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Worksheets.Item($sheetIndex)
      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -eq $used) { continue }
      $cellCount = [int64]$used.range.CountLarge
      if ($cellCount -gt 1000) {
        $parts.Add("$sheetIndex|$($sheet.Name)|$($used.address)|large:$cellCount|$($used.range.NumberFormat)") | Out-Null
        continue
      }
      for ($row = 1; $row -le $used.rows; $row += 1) {
        Test-WorkerCancelled
        for ($column = 1; $column -le $used.columns; $column += 1) {
          $cell = $null
          try {
            $cell = $used.range.Cells.Item($row, $column)
            $address = Get-ExcelAddress $cell
            $parts.Add("$sheetIndex|$($sheet.Name)|$address|$($cell.NumberFormat)") | Out-Null
          } finally {
            Release-ComObject $cell
          }
        }
      }
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }
  return Get-Sha256Text (($parts | Sort-Object) -join "`n")
}

function Get-ExcelUsedRanges {
  param([object]$Workbook)
  $ranges = New-Object System.Collections.Generic.List[object]
  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      if ((Get-ExcelSheetKind $sheet) -ne "worksheet") { continue }
      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -eq $used) { continue }
      $ranges.Add([ordered]@{
        sheet = [string]$sheet.Name
        sheet_index = $index
        visibility = Get-ExcelVisibilityLabel $sheet
        address = [string]$used.address
        rows = [int]$used.rows
        columns = [int]$used.columns
      }) | Out-Null
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }
  return $ranges
}

function Get-ExcelWorkbookCounts {
  param([object]$Workbook)

  $sheetCount = [int]$Workbook.Sheets.Count
  $worksheetCount = [int]$Workbook.Worksheets.Count
  $chartSheetCount = 0
  try { $chartSheetCount = [int]$Workbook.Charts.Count } catch {}
  $visible = 0
  $hidden = 0
  $veryHidden = 0
  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      switch (Get-ExcelVisibilityLabel $sheet) {
        "hidden" { $hidden += 1 }
        "very-hidden" { $veryHidden += 1 }
        default { $visible += 1 }
      }
    } finally {
      Release-ComObject $sheet
    }
  }

  $tableCount = 0
  $shapeCount = 0
  $imageCount = 0
  $conditionalFormatCount = 0
  $mergedRangeCount = 0
  $hiddenRowCount = 0
  $hiddenColumnCount = 0

  for ($index = 1; $index -le $Workbook.Worksheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Worksheets.Item($index)
      try { $tableCount += [int]$sheet.ListObjects.Count } catch {}
      try { $shapeCount += [int]$sheet.Shapes.Count } catch {}
      try {
        for ($shapeIndex = 1; $shapeIndex -le $sheet.Shapes.Count; $shapeIndex += 1) {
          $shape = $null
          try {
            $shape = $sheet.Shapes.Item($shapeIndex)
            if ([int]$shape.Type -eq 13) {
              $imageCount += 1
            }
          } finally {
            Release-ComObject $shape
          }
        }
      } catch {
      }

      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -ne $used) {
        try { $conditionalFormatCount += [int]$used.range.FormatConditions.Count } catch {}
        try {
          for ($row = $used.first_row; $row -le $used.last_row; $row += 1) {
            Test-WorkerCancelled
            $rowRange = $null
            try {
              $rowRange = $sheet.Rows.Item($row)
              if ([bool]$rowRange.Hidden) { $hiddenRowCount += 1 }
            } finally {
              Release-ComObject $rowRange
            }
          }
          for ($column = $used.first_column; $column -le $used.last_column; $column += 1) {
            Test-WorkerCancelled
            $columnRange = $null
            try {
              $columnRange = $sheet.Columns.Item($column)
              if ([bool]$columnRange.Hidden) { $hiddenColumnCount += 1 }
            } finally {
              Release-ComObject $columnRange
            }
          }
        } catch {
        }
        if ([int64]$used.range.CountLarge -le 1000) {
          $seenMerges = @{}
          $scanCells = [Math]::Min([int64]$used.range.CountLarge, 20000)
          for ($cellIndex = 1; $cellIndex -le $scanCells; $cellIndex += 1) {
            Test-WorkerCancelled
            $cell = $null
            $mergeArea = $null
            try {
              $cell = $used.range.Cells.Item($cellIndex)
              if ([bool]$cell.MergeCells) {
                $mergeArea = $cell.MergeArea
                $address = Get-ExcelAddress $mergeArea
                if ($address -and -not $seenMerges.ContainsKey($address)) {
                  $seenMerges[$address] = $true
                  $mergedRangeCount += 1
                }
              }
            } finally {
              Release-ComObject $mergeArea
              Release-ComObject $cell
            }
          }
        }
      }
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }

  $links = Get-ExcelExternalLinks -Workbook $Workbook

  return [ordered]@{
    sheet_count = $sheetCount
    worksheet_count = $worksheetCount
    chart_sheet_count = $chartSheetCount
    visible_sheet_count = $visible
    hidden_sheet_count = $hidden
    very_hidden_sheet_count = $veryHidden
    table_count = $tableCount
    named_range_count = [int]$Workbook.Names.Count
    chart_count = Get-ExcelChartCount -Workbook $Workbook
    shape_count = $shapeCount
    image_count = $imageCount
    existing_comment_count = Get-ExcelCommentCount -Workbook $Workbook
    external_link_present = ($links.Count -gt 0)
    external_link_count = [int]$links.Count
    formula_cell_count = Get-ExcelFormulaCellCount -Workbook $Workbook
    conditional_format_count = $conditionalFormatCount
    merged_range_count = $mergedRangeCount
    hidden_row_count = $hiddenRowCount
    hidden_column_count = $hiddenColumnCount
    external_link_signature = Get-Sha256Text (($links | Sort-Object) -join "`n")
  }
}

function Get-ExcelInspection {
  param(
    [object]$Workbook,
    [string]$Path,
    [string]$DocumentType
  )

  $counts = Get-ExcelWorkbookCounts -Workbook $Workbook
  $usedRanges = Get-ExcelUsedRanges -Workbook $Workbook
  return [ordered]@{
    sheet_count = $counts.sheet_count
    worksheet_count = $counts.worksheet_count
    chart_sheet_count = $counts.chart_sheet_count
    visible_sheet_count = $counts.visible_sheet_count
    hidden_sheet_count = $counts.hidden_sheet_count
    very_hidden_sheet_count = $counts.very_hidden_sheet_count
    used_ranges = $usedRanges
    table_count = $counts.table_count
    named_range_count = $counts.named_range_count
    chart_count = $counts.chart_count
    shape_count = $counts.shape_count
    image_count = $counts.image_count
    existing_comment_count = $counts.existing_comment_count
    external_link_present = $counts.external_link_present
    external_link_count = $counts.external_link_count
    formula_cell_count = $counts.formula_cell_count
    macro_present = (Get-MacroPresence -Path $Path -DocumentType $DocumentType)
    password_protected = $false
    corrupt = $false
    conditional_format_count = $counts.conditional_format_count
    merged_range_count = $counts.merged_range_count
    hidden_row_count = $counts.hidden_row_count
    hidden_column_count = $counts.hidden_column_count
    hidden_state_signature = Get-ExcelHiddenStateSignature -Workbook $Workbook
    named_range_signature = Get-ExcelNamedRangeSignature -Workbook $Workbook
    number_format_signature = Get-ExcelNumberFormatSignature -Workbook $Workbook
    external_link_signature = $counts.external_link_signature
  }
}

function New-ExcelAnchorRecord {
  param(
    [string]$AnchorId,
    [string]$Kind,
    [object]$Anchor,
    [string]$Sheet,
    [string]$Text,
    [string]$Cell = "",
    [string]$Range = "",
    [string]$DisplayedValue = "",
    [string]$Formula = "",
    [string]$NumberFormat = ""
  )

  $record = [ordered]@{
    anchorId = $AnchorId
    kind = $Kind
    anchor = $Anchor
    sheet = $Sheet
    text = $Text
  }
  if ($Cell) { $record.cell = $Cell }
  if ($Range) { $record.range = $Range }
  if ($DisplayedValue) { $record.displayedValue = $DisplayedValue }
  if ($Formula) { $record.formula = $Formula }
  if ($NumberFormat) { $record.numberFormat = $NumberFormat }
  return $record
}

function Add-ExcelRangeAnchor {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [string]$AnchorId,
    [string]$Sheet,
    [string]$Range,
    [string]$Text
  )

  if (-not $Range) {
    return
  }
  $anchor = [ordered]@{
    kind = "xlsx_range"
    sheet = $Sheet
    range = $Range
  }
  $Anchors[$AnchorId] = New-ExcelAnchorRecord -AnchorId $AnchorId -Kind "xlsx_range" -Anchor $anchor -Sheet $Sheet -Text $Text -Range $Range
}

function Get-ExcelCellSummary {
  param([object]$Cell)
  $address = Get-ExcelAddress $Cell
  $displayed = Get-OneLineText $Cell.Text
  $formula = ""
  try {
    if ([bool]$Cell.HasFormula) {
      $formula = Get-OneLineText $Cell.Formula
    }
  } catch {
  }
  $numberFormat = ""
  try { $numberFormat = Get-OneLineText $Cell.NumberFormat } catch {}
  $comments = Get-ExcelCommentsText -Cell $Cell

  $parts = New-Object System.Collections.Generic.List[string]
  if ($displayed) { $parts.Add("Displayed value: $displayed") | Out-Null }
  if ($formula) { $parts.Add("Formula: $formula") | Out-Null }
  if ($numberFormat) { $parts.Add("Number format: $numberFormat") | Out-Null }
  if ($comments) { $parts.Add("Existing comment or note: $comments") | Out-Null }

  return [ordered]@{
    address = $address
    displayed = $displayed
    formula = $formula
    number_format = $numberFormat
    comments = $comments
    text = ($parts -join " | ")
  }
}

function Add-ExcelCellAnchor {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines,
    [object]$Cell,
    [string]$Sheet,
    [int]$SheetIndex,
    [bool]$IncludeExistingComments
  )

  $summary = Get-ExcelCellSummary -Cell $Cell
  if (-not $summary.displayed -and -not $summary.formula -and -not ($IncludeExistingComments -and $summary.comments)) {
    return
  }

  $anchorId = "xl:s{0:D4}:c:{1}" -f $SheetIndex, $summary.address
  $anchor = [ordered]@{
    kind = "xlsx_cell"
    sheet = $Sheet
    cell = $summary.address
  }
  $anchorText = if ($summary.text) { $summary.text } else { "$Sheet!$($summary.address)" }
  $Anchors[$anchorId] = New-ExcelAnchorRecord `
    -AnchorId $anchorId `
    -Kind "xlsx_cell" `
    -Anchor $anchor `
    -Sheet $Sheet `
    -Text $anchorText `
    -Cell $summary.address `
    -DisplayedValue $summary.displayed `
    -Formula $summary.formula `
    -NumberFormat $summary.number_format

  $commentText = if ($IncludeExistingComments) { $summary.comments } else { "" }
  $Lines.Add("| <!-- HL:$anchorId --> $($summary.address) | $(Escape-MarkdownCell $summary.displayed) | $(Escape-MarkdownCell $summary.formula) | $(Escape-MarkdownCell $summary.number_format) | $(Escape-MarkdownCell $commentText) |") | Out-Null
}

function Add-ExcelTablesMarkdown {
  param(
    [object]$Worksheet,
    [int]$SheetIndex,
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines
  )
  try {
    if ([int]$Worksheet.ListObjects.Count -lt 1) {
      return
    }
    $Lines.Add("") | Out-Null
    $Lines.Add("Tables:") | Out-Null
    for ($index = 1; $index -le $Worksheet.ListObjects.Count; $index += 1) {
      $table = $null
      try {
        $table = $Worksheet.ListObjects.Item($index)
        $range = Get-ExcelAddress $table.Range
        $anchorId = "xl:s{0:D4}:table:{1}" -f $SheetIndex, ([string]$table.Name)
        Add-ExcelRangeAnchor -Anchors $Anchors -AnchorId $anchorId -Sheet ([string]$Worksheet.Name) -Range $range -Text "Excel table $($table.Name) on $($Worksheet.Name)!$range"
        $Lines.Add("- <!-- HL:$anchorId --> $($table.Name): $range") | Out-Null
      } finally {
        Release-ComObject $table
      }
    }
  } catch {
  }
}

function Add-ExcelMergedRangesMarkdown {
  param(
    [object]$Worksheet,
    [object]$Used,
    [int]$SheetIndex,
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines
  )

  $seen = @{}
  $ranges = New-Object System.Collections.Generic.List[string]
  if ([int64]$Used.range.CountLarge -gt 1000) {
    return
  }
  $scanCells = [Math]::Min([int64]$Used.range.CountLarge, 20000)
  for ($cellIndex = 1; $cellIndex -le $scanCells; $cellIndex += 1) {
    Test-WorkerCancelled
    $cell = $null
    $mergeArea = $null
    try {
      $cell = $Used.range.Cells.Item($cellIndex)
      if ([bool]$cell.MergeCells) {
        $mergeArea = $cell.MergeArea
        $address = Get-ExcelAddress $mergeArea
        if ($address -and -not $seen.ContainsKey($address)) {
          $seen[$address] = $true
          $ranges.Add($address) | Out-Null
          $anchorId = "xl:s{0:D4}:merge:{1}" -f $SheetIndex, ($ranges.Count)
          Add-ExcelRangeAnchor -Anchors $Anchors -AnchorId $anchorId -Sheet ([string]$Worksheet.Name) -Range $address -Text "Merged range $($Worksheet.Name)!$address"
        }
      }
    } finally {
      Release-ComObject $mergeArea
      Release-ComObject $cell
    }
  }

  if ($ranges.Count -gt 0) {
    $Lines.Add("") | Out-Null
    $Lines.Add("Merged ranges: $($ranges -join ', ')") | Out-Null
  }
}

function Get-ExcelFormulaPatternSummary {
  param([object]$Used)
  $patterns = @{}
  $formulas = $null
  try {
    $formulas = $Used.range.SpecialCells(-4123)
    $cellCount = [Math]::Min([int64]$formulas.CountLarge, 20000)
    for ($index = 1; $index -le $cellCount; $index += 1) {
      Test-WorkerCancelled
      $cell = $null
      try {
        $cell = $formulas.Cells.Item($index)
        $pattern = Get-OneLineText $cell.FormulaR1C1
        if (-not $patterns.ContainsKey($pattern)) {
          $patterns[$pattern] = [ordered]@{
            count = 0
            first = Get-ExcelAddress $cell
            last = Get-ExcelAddress $cell
          }
        }
        $patterns[$pattern].count += 1
        $patterns[$pattern].last = Get-ExcelAddress $cell
      } finally {
        Release-ComObject $cell
      }
    }
  } catch {
  } finally {
    Release-ComObject $formulas
  }

  $items = New-Object System.Collections.Generic.List[string]
  foreach ($key in ($patterns.Keys | Sort-Object)) {
    $item = $patterns[$key]
    if ($item.count -gt 1) {
      $items.Add("$($item.count) cells $($item.first):$($item.last) use R1C1 pattern $key") | Out-Null
    }
  }
  return $items
}

function Protect-CsvCell {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  $text = [string]$Value
  if ($text -match "^[=+\-@`t`r]") {
    $text = "'$text"
  }
  $escaped = $text.Replace('"', '""')
  if ($escaped -match "[,`n`r""]") {
    return '"' + $escaped + '"'
  }
  return $escaped
}

function Write-ExcelCsvSidecar {
  param(
    [object]$Worksheet,
    [object]$Used,
    [string]$Folder,
    [int]$SheetIndex
  )

  if (-not $Folder) {
    return ""
  }
  if (-not (Test-Path -LiteralPath $Folder)) {
    New-Item -ItemType Directory -Path $Folder -Force | Out-Null
  }
  $safeName = ([string]$Worksheet.Name) -replace '[^\p{L}\p{Nd}._ -]+', '_'
  if (-not $safeName) { $safeName = "sheet_$SheetIndex" }
  $path = Join-Path $Folder ("{0:D4}_{1}.csv" -f $SheetIndex, $safeName)
  $lines = New-Object System.Collections.Generic.List[string]
  for ($row = 1; $row -le $Used.rows; $row += 1) {
    Test-WorkerCancelled
    $values = New-Object System.Collections.Generic.List[string]
    for ($column = 1; $column -le $Used.columns; $column += 1) {
      $cell = $null
      try {
        $cell = $Used.range.Cells.Item($row, $column)
        $values.Add((Protect-CsvCell (Get-OneLineText $cell.Text))) | Out-Null
      } finally {
        Release-ComObject $cell
      }
    }
    $lines.Add(($values -join ",")) | Out-Null
  }
  [System.IO.File]::WriteAllLines($path, $lines, [System.Text.Encoding]::UTF8)
  return $path
}

function Add-ExcelNamedRangesMarkdown {
  param(
    [object]$Workbook,
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines
  )

  if ([int]$Workbook.Names.Count -lt 1) {
    return
  }
  $Lines.Add("") | Out-Null
  $Lines.Add("## Named Ranges") | Out-Null
  $Lines.Add("") | Out-Null
  $Lines.Add("| Name | Refers to |") | Out-Null
  $Lines.Add("| --- | --- |") | Out-Null
  for ($index = 1; $index -le $Workbook.Names.Count; $index += 1) {
    Test-WorkerCancelled
    $name = $null
    $range = $null
    try {
      $name = $Workbook.Names.Item($index)
      $label = Get-OneLineText $name.Name
      $refersTo = Get-OneLineText $name.RefersTo
      try { $range = $name.RefersToRange } catch {}
      if ($null -ne $range) {
        $sheetName = [string]$range.Worksheet.Name
        $address = Get-ExcelAddress $range
        $anchorId = "xl:name:{0:D4}" -f $index
        Add-ExcelRangeAnchor -Anchors $Anchors -AnchorId $anchorId -Sheet $sheetName -Range $address -Text "Named range $label refers to $sheetName!$address"
        $Lines.Add("| <!-- HL:$anchorId --> $(Escape-MarkdownCell $label) | $(Escape-MarkdownCell "$sheetName!$address") |") | Out-Null
      } else {
        $Lines.Add("| $(Escape-MarkdownCell $label) | $(Escape-MarkdownCell $refersTo) |") | Out-Null
      }
    } finally {
      Release-ComObject $range
      Release-ComObject $name
    }
  }
}

function Add-ExcelWorksheetMarkdown {
  param(
    [object]$Worksheet,
    [int]$SheetIndex,
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines,
    [bool]$IncludeExistingComments,
    [bool]$GenerateCsvSidecars,
    [string]$CsvFolder,
    [System.Collections.Generic.List[string]]$CsvSidecars
  )

  $used = $null
  try {
    $used = Get-ExcelMeaningfulUsedRange -Worksheet $Worksheet
    $sheetName = [string]$Worksheet.Name
    $visibility = Get-ExcelVisibilityLabel $Worksheet
    $Lines.Add("") | Out-Null
    $Lines.Add("## Sheet ${SheetIndex}: $sheetName") | Out-Null
    $Lines.Add("") | Out-Null
    $Lines.Add("Visibility: $visibility") | Out-Null
    if ($null -eq $used) {
      $Lines.Add("Meaningful used range: none") | Out-Null
      return
    }

    $cellCount = [int64]$used.range.CountLarge
    $usedAnchorId = "xl:s{0:D4}:used" -f $SheetIndex
    Add-ExcelRangeAnchor -Anchors $Anchors -AnchorId $usedAnchorId -Sheet $sheetName -Range ([string]$used.address) -Text "Used range $sheetName!$($used.address), $($used.rows) rows by $($used.columns) columns"
    $Lines.Add("Meaningful used range: <!-- HL:$usedAnchorId --> $($used.address) ($($used.rows) rows x $($used.columns) columns)") | Out-Null

    Add-ExcelTablesMarkdown -Worksheet $Worksheet -SheetIndex $SheetIndex -Anchors $Anchors -Lines $Lines
    Add-ExcelMergedRangesMarkdown -Worksheet $Worksheet -Used $used -SheetIndex $SheetIndex -Anchors $Anchors -Lines $Lines

    if ($cellCount -gt 1000) {
      $Lines.Add("") | Out-Null
      $Lines.Add("Large range summary: $cellCount cells. Inline extraction is sampled to avoid serializing large blank or repetitive regions.") | Out-Null
      $patterns = Get-ExcelFormulaPatternSummary -Used $used
      if ($patterns.Count -gt 0) {
        $Lines.Add("") | Out-Null
        $Lines.Add("Repeated formula patterns:") | Out-Null
        foreach ($pattern in $patterns) {
          $Lines.Add("- $pattern") | Out-Null
        }
      }
      if ($GenerateCsvSidecars) {
        $csv = Write-ExcelCsvSidecar -Worksheet $Worksheet -Used $used -Folder $CsvFolder -SheetIndex $SheetIndex
        if ($csv) {
          $CsvSidecars.Add($csv) | Out-Null
          $Lines.Add("CSV sidecar: $(Split-Path -Leaf $csv)") | Out-Null
        }
      }
      $Lines.Add("") | Out-Null
      $Lines.Add("| Cell | Displayed value | Formula | Number format | Existing comment or note |") | Out-Null
      $Lines.Add("| --- | --- | --- | --- | --- |") | Out-Null
      $sampleLimit = [Math]::Min($cellCount, 300)
      for ($cellIndex = 1; $cellIndex -le $sampleLimit; $cellIndex += 1) {
        Test-WorkerCancelled
        $cell = $null
        try {
          $cell = $used.range.Cells.Item($cellIndex)
          Add-ExcelCellAnchor -Anchors $Anchors -Lines $Lines -Cell $cell -Sheet $sheetName -SheetIndex $SheetIndex -IncludeExistingComments $IncludeExistingComments
        } finally {
          Release-ComObject $cell
        }
      }
      return
    }

    $Lines.Add("") | Out-Null
    $Lines.Add("| Cell | Displayed value | Formula | Number format | Existing comment or note |") | Out-Null
    $Lines.Add("| --- | --- | --- | --- | --- |") | Out-Null
    for ($row = 1; $row -le $used.rows; $row += 1) {
      Test-WorkerCancelled
      for ($column = 1; $column -le $used.columns; $column += 1) {
        $cell = $null
        try {
          $cell = $used.range.Cells.Item($row, $column)
          Add-ExcelCellAnchor -Anchors $Anchors -Lines $Lines -Cell $cell -Sheet $sheetName -SheetIndex $SheetIndex -IncludeExistingComments $IncludeExistingComments
        } finally {
          Release-ComObject $cell
        }
      }
    }
  } finally {
    if ($null -ne $used) { Release-ComObject $used.range }
  }
}

function Get-ExcelRenderTargets {
  param([object]$Workbook)
  $targets = New-Object System.Collections.Generic.List[object]
  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      $kind = Get-ExcelSheetKind $sheet
      if ($kind -eq "chart") {
        $targets.Add([ordered]@{
          sheet = [string]$sheet.Name
          sheet_index = $index
          reason = "chart sheet"
        }) | Out-Null
        continue
      }
      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -eq $used) { continue }
      $targets.Add([ordered]@{
        sheet = [string]$sheet.Name
        sheet_index = $index
        range = [string]$used.address
        reason = "meaningful used range"
      }) | Out-Null
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }
  return $targets
}

function Get-ExcelVisualCandidates {
  param([object]$Workbook)
  $candidates = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      $kind = Get-ExcelSheetKind $sheet
      if ($kind -eq "chart") {
        $key = "$index|"
        $seen[$key] = $true
        $candidates.Add([ordered]@{
          sheet = [string]$sheet.Name
          sheet_index = $index
          reason = "chart sheet"
        }) | Out-Null
        continue
      }

      $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
      if ($null -eq $used) { continue }
      $reasons = New-Object System.Collections.Generic.List[string]
      try { if ([int]$sheet.ChartObjects().Count -gt 0) { $reasons.Add("contains charts") | Out-Null } } catch {}
      try { if ([int]$sheet.Shapes.Count -gt 0) { $reasons.Add("contains images, shapes, or dashboard elements") | Out-Null } } catch {}
      try { if ([int]$used.range.FormatConditions.Count -gt 0) { $reasons.Add("contains material conditional formatting") | Out-Null } } catch {}
      try {
        if ([int64]$used.range.CountLarge -le 1000) {
          $mergeScan = [Math]::Min([int64]$used.range.CountLarge, 20000)
          for ($cellIndex = 1; $cellIndex -le $mergeScan; $cellIndex += 1) {
            Test-WorkerCancelled
            $cell = $null
            try {
              $cell = $used.range.Cells.Item($cellIndex)
              if ([bool]$cell.MergeCells) {
                $reasons.Add("contains merged-cell layout") | Out-Null
                break
              }
            } finally {
              Release-ComObject $cell
            }
          }
        }
      } catch {
      }
      if ($reasons.Count -gt 0) {
        $key = "$index|$($used.address)"
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = $true
          $candidates.Add([ordered]@{
            sheet = [string]$sheet.Name
            sheet_index = $index
            range = [string]$used.address
            reason = ($reasons -join "; ")
          }) | Out-Null
        }
      }
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }
  return $candidates
}

function Build-ExcelMarkdown {
  param(
    [object]$Workbook,
    [string]$SourcePath,
    [string]$SourceHash,
    [string]$CreatedAt,
    [bool]$IncludeExistingComments,
    [bool]$GenerateCsvSidecars,
    [string]$CsvFolder,
    [object]$Inspection
  )

  $lines = New-Object System.Collections.Generic.List[string]
  $anchors = New-Object System.Collections.Specialized.OrderedDictionary
  $csvSidecars = New-Object System.Collections.Generic.List[string]

  $lines.Add("# $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("Source filename: $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("Source SHA-256: $SourceHash") | Out-Null
  $lines.Add("Processing date: $CreatedAt") | Out-Null
  $lines.Add("Original Excel sheets: $($Inspection.sheet_count)") | Out-Null
  $lines.Add("Visible sheets: $($Inspection.visible_sheet_count); hidden sheets: $($Inspection.hidden_sheet_count); very-hidden sheets: $($Inspection.very_hidden_sheet_count)") | Out-Null
  $lines.Add("External links present: $($Inspection.external_link_present)") | Out-Null
  $lines.Add("Macro project present: $($Inspection.macro_present)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("## Workbook Overview") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("| Order | Sheet | Visibility | Used range | Tables | Charts | Shapes/images | Formulas | Comments/notes |") | Out-Null
  $lines.Add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |") | Out-Null

  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    $used = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      $kind = Get-ExcelSheetKind $sheet
      $usedText = if ($kind -eq "chart") { "chart sheet" } else { "none" }
      $tableCount = 0
      $chartCount = 0
      $shapeCount = 0
      $formulaCount = 0
      $commentCount = 0
      if ($kind -eq "worksheet") {
        $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
        if ($null -ne $used) { $usedText = [string]$used.address }
        try { $tableCount = [int]$sheet.ListObjects.Count } catch {}
        try { $chartCount = [int]$sheet.ChartObjects().Count } catch {}
        try { $shapeCount = [int]$sheet.Shapes.Count } catch {}
        try { $commentCount += [int]$sheet.Comments.Count } catch {}
        try { $commentCount += [int]$sheet.CommentsThreaded.Count } catch {}
        if ($null -ne $used) {
          $formulas = $null
          try {
            $formulas = $used.range.SpecialCells(-4123)
            $formulaCount = [int]$formulas.CountLarge
          } catch {
          } finally {
            Release-ComObject $formulas
          }
        }
      } elseif ($kind -eq "chart") {
        $chartCount = 1
      }
      $Lines.Add("| $index | $(Escape-MarkdownCell ([string]$sheet.Name)) | $(Get-ExcelVisibilityLabel $sheet) | $(Escape-MarkdownCell $usedText) | $tableCount | $chartCount | $shapeCount | $formulaCount | $commentCount |") | Out-Null
    } finally {
      if ($null -ne $used) { Release-ComObject $used.range }
      Release-ComObject $sheet
    }
  }

  Add-ExcelNamedRangesMarkdown -Workbook $Workbook -Anchors $anchors -Lines $lines

  for ($index = 1; $index -le $Workbook.Sheets.Count; $index += 1) {
    Test-WorkerCancelled
    $sheet = $null
    try {
      $sheet = $Workbook.Sheets.Item($index)
      if ((Get-ExcelSheetKind $sheet) -eq "worksheet") {
        Add-ExcelWorksheetMarkdown `
          -Worksheet $sheet `
          -SheetIndex $index `
          -Anchors $anchors `
          -Lines $lines `
          -IncludeExistingComments $IncludeExistingComments `
          -GenerateCsvSidecars $GenerateCsvSidecars `
          -CsvFolder $CsvFolder `
          -CsvSidecars $csvSidecars
      } else {
        $lines.Add("") | Out-Null
        $lines.Add("## Sheet ${index}: $($sheet.Name)") | Out-Null
        $lines.Add("") | Out-Null
        $lines.Add("Chart sheet. Use the visual supplement for chart content.") | Out-Null
      }
    } finally {
      Release-ComObject $sheet
    }
  }

  return [ordered]@{
    markdown = ($lines -join "`n").Trim() + "`n"
    anchors = $anchors
    csv_sidecars = $csvSidecars
  }
}

function Get-SignaturePresence {
  param(
    [object]$Document,
    [string]$Path
  )

  try {
    if ($Document.Signatures.Count -gt 0) {
      return $true
    }
  } catch {
  }
  return Get-PackageEntryExists -Path $Path -Pattern "(^|/)_xmlsignatures/"
}

function Get-CleanText {
  param([object]$Value)
  if ($null -eq $Value) {
    return ""
  }
  $text = [string]$Value
  $text = $text.Replace([string][char]13, "`n")
  $text = $text.Replace([string][char]7, "")
  $text = $text.Replace([string][char]11, "`n")
  $text = $text.Replace([string][char]160, " ")
  return $text.Trim()
}

function Get-OneLineText {
  param([object]$Value)
  return (Get-CleanText $Value) -replace "\s+", " "
}

function Escape-MarkdownCell {
  param([string]$Value)
  return (Get-OneLineText $Value).Replace("|", "\|")
}

function Get-RangePage {
  param([object]$Range)
  try {
    $page = [int]$Range.Information(3)
    if ($page -lt 1) {
      return $null
    }
    return $page
  } catch {
    return $null
  }
}

function Get-RevisionLabel {
  param([int]$Type)
  switch ($Type) {
    1 { return "inserted text" }
    2 { return "deleted text" }
    3 { return "changed property" }
    4 { return "paragraph number change" }
    5 { return "display field change" }
    6 { return "reconcile change" }
    7 { return "conflict change" }
    8 { return "style change" }
    9 { return "replaced text" }
    10 { return "paragraph property change" }
    11 { return "table property change" }
    12 { return "section property change" }
    13 { return "style definition change" }
    14 { return "moved from" }
    15 { return "moved to" }
    16 { return "cell insertion" }
    17 { return "cell deletion" }
    18 { return "cell merge" }
    default { return "tracked edit" }
  }
}

function Add-PageMarker {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [ref]$CurrentPage,
    [object]$Page
  )
  if ($null -eq $Page) {
    return
  }
  if ($CurrentPage.Value -ne $Page) {
    $CurrentPage.Value = $Page
    $Lines.Add("<!-- HL_SOURCE_PAGE: $Page -->") | Out-Null
  }
}

function Get-HyperlinkMarkdown {
  param([object]$Range)
  $items = New-Object System.Collections.Generic.List[string]
  try {
    for ($index = 1; $index -le $Range.Hyperlinks.Count; $index += 1) {
      $link = $Range.Hyperlinks.Item($index)
      $label = Get-OneLineText $link.TextToDisplay
      $target = [string]$link.Address
      if ($link.SubAddress) {
        if ($target) {
          $target = "$target#$($link.SubAddress)"
        } else {
          $target = "#$($link.SubAddress)"
        }
      }
      if ($label -and $target) {
        $items.Add("[$label]($target)") | Out-Null
      }
      Release-ComObject $link
    }
  } catch {
  }
  return $items
}

function Add-RangeSupplements {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [object]$Range,
    [bool]$IncludeExistingComments,
    [bool]$IncludeTrackChanges
  )

  $links = Get-HyperlinkMarkdown $Range
  if ($links.Count -gt 0) {
    $Lines.Add("Links: $($links -join '; ')") | Out-Null
  }

  if ($IncludeExistingComments) {
    try {
      for ($index = 1; $index -le $Range.Comments.Count; $index += 1) {
        $comment = $Range.Comments.Item($index)
        $author = Get-OneLineText $comment.Author
        $text = Get-OneLineText $comment.Range.Text
        if ($text) {
          if ($author) {
            $Lines.Add("Existing comment ($author): $text") | Out-Null
          } else {
            $Lines.Add("Existing comment: $text") | Out-Null
          }
        }
        Release-ComObject $comment
      }
    } catch {
    }
  }

  if ($IncludeTrackChanges) {
    try {
      for ($index = 1; $index -le $Range.Revisions.Count; $index += 1) {
        $revision = $Range.Revisions.Item($index)
        $kind = Get-RevisionLabel ([int]$revision.Type)
        $author = Get-OneLineText $revision.Author
        $text = Get-OneLineText $revision.Range.Text
        if ($text) {
          if ($author) {
            $Lines.Add("Tracked change ($kind by $author): $text") | Out-Null
          } else {
            $Lines.Add("Tracked change ($kind): $text") | Out-Null
          }
        }
        Release-ComObject $revision
      }
    } catch {
    }
  }
}

function Get-HeadingLevel {
  param([object]$Paragraph)
  try {
    $outline = [int]$Paragraph.OutlineLevel
    if ($outline -ge 1 -and $outline -le 9) {
      return [Math]::Min($outline + 1, 6)
    }
  } catch {
  }
  try {
    $styleName = [string]$Paragraph.Range.Style.NameLocal
    if ($styleName -match "Heading\s+([1-6])") {
      return [Math]::Min(([int]$Matches[1]) + 1, 6)
    }
  } catch {
  }
  return 0
}

function Get-ParagraphMarkdown {
  param(
    [object]$Paragraph,
    [string]$Text
  )

  $heading = Get-HeadingLevel $Paragraph
  if ($heading -gt 0) {
    return ("#" * $heading) + " " + $Text
  }

  try {
    if ([int]$Paragraph.Range.ListFormat.ListType -ne 0) {
      $listString = Get-OneLineText $Paragraph.Range.ListFormat.ListString
      if ($listString) {
        return "$listString $Text"
      }
      return "- $Text"
    }
  } catch {
  }

  return $Text
}

function New-AnchorRecord {
  param(
    [string]$AnchorId,
    [string]$Kind,
    [object]$Anchor,
    [object]$Page,
    [string]$Text,
    [string]$ParagraphId = "",
    [string]$TableId = "",
    [string]$CellId = "",
    [object]$Row = $null,
    [object]$Column = $null
  )

  $record = [ordered]@{
    anchorId = $AnchorId
    kind = $Kind
    anchor = $Anchor
    text = $Text
  }
  if ($null -ne $Page) { $record.page = $Page }
  if ($ParagraphId) { $record.paragraphId = $ParagraphId }
  if ($TableId) { $record.tableId = $TableId }
  if ($CellId) { $record.cellId = $CellId }
  if ($null -ne $Row) { $record.row = $Row }
  if ($null -ne $Column) { $record.column = $Column }
  return $record
}

function Add-TableMarkdown {
  param(
    [object]$Table,
    [int]$TableIndex,
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [System.Collections.Generic.List[string]]$Lines,
    [ref]$CurrentPage,
    [bool]$IncludeExistingComments,
    [bool]$IncludeTrackChanges
  )

  $tableId = "w:t{0:D4}" -f $TableIndex
  $page = Get-RangePage $Table.Range
  Add-PageMarker -Lines $Lines -CurrentPage $CurrentPage -Page $page
  $Lines.Add("") | Out-Null
  $Lines.Add("Table $TableIndex") | Out-Null
  $Lines.Add("") | Out-Null
  $Lines.Add("| Row | Column | Text |") | Out-Null
  $Lines.Add("| --- | --- | --- |") | Out-Null

  $cellCount = 0
  try { $cellCount = [int]$Table.Range.Cells.Count } catch { $cellCount = 0 }

  for ($cellIndex = 1; $cellIndex -le $cellCount; $cellIndex += 1) {
    $cell = $null
    try {
      $cell = $Table.Range.Cells.Item($cellIndex)
      $script:WorkerStage = "table cell $TableIndex/$cellIndex"
      $row = $null
      $column = $null
      try { $row = [int]$cell.RowIndex } catch { $row = 1 }
      try { $column = [int]$cell.ColumnIndex } catch { $column = $cellIndex }
      $cellPage = Get-RangePage $cell.Range
      $cellId = "$tableId:c{0:D4}" -f $cellIndex
      $text = Get-CleanText $cell.Range.Text
      $anchor = [ordered]@{
        kind = "docx_table_cell"
        table_id = $tableId
        row = $row
        column = $column
        cell_id = $cellId
      }
      if ($null -ne $cellPage) {
        $anchor.page = $cellPage
      }
      $Anchors[$cellId] = New-AnchorRecord -AnchorId $cellId -Kind "docx_table_cell" -Anchor $anchor -Page $cellPage -Text $text -TableId $tableId -CellId $cellId -Row $row -Column $column
      $Lines.Add("| $row | $column | <!-- HL:$cellId --> $(Escape-MarkdownCell $text) |") | Out-Null
      Add-RangeSupplements -Lines $Lines -Range $cell.Range -IncludeExistingComments $IncludeExistingComments -IncludeTrackChanges $IncludeTrackChanges
    } finally {
      Release-ComObject $cell
    }
  }

  $Lines.Add("") | Out-Null
}

function Add-HeadersAndFooters {
  param(
    [object]$Document,
    [System.Collections.Generic.List[string]]$Lines
  )

  $addedTitle = $false
  for ($sectionIndex = 1; $sectionIndex -le $Document.Sections.Count; $sectionIndex += 1) {
    $section = $null
    try {
      $section = $Document.Sections.Item($sectionIndex)
      $script:WorkerStage = "section $sectionIndex headers-footers"
      foreach ($part in @("Headers", "Footers")) {
        $collection = if ($part -eq "Headers") { $section.Headers } else { $section.Footers }
        for ($itemIndex = 1; $itemIndex -le 3; $itemIndex += 1) {
          $item = $null
          try {
            $item = $collection.Item($itemIndex)
            $script:WorkerStage = "$part item $sectionIndex/$itemIndex"
            if ($item.Exists) {
              $text = Get-CleanText $item.Range.Text
              if ($text) {
                if (-not $addedTitle) {
                  $Lines.Add("") | Out-Null
                  $Lines.Add("## Headers and Footers") | Out-Null
                  $addedTitle = $true
                }
                $label = if ($part -eq "Headers") { "Header" } else { "Footer" }
                $Lines.Add("$label, section ${sectionIndex}: $text") | Out-Null
              }
            }
          } catch {
            continue
          } finally {
            Release-ComObject $item
          }
        }
      }
    } finally {
      Release-ComObject $section
    }
  }
}

function Add-FootnotesAndEndnotes {
  param(
    [object]$Document,
    [System.Collections.Generic.List[string]]$Lines
  )

  if ($Document.Footnotes.Count -gt 0) {
    $Lines.Add("") | Out-Null
    $Lines.Add("## Footnotes") | Out-Null
    for ($index = 1; $index -le $Document.Footnotes.Count; $index += 1) {
      $note = $null
      try {
        $note = $Document.Footnotes.Item($index)
        $script:WorkerStage = "footnote $index"
        $page = Get-RangePage $note.Reference
        $text = Get-CleanText $note.Range.Text
        if ($text) {
          if ($null -ne $page) {
            $Lines.Add("$($index). Page ${page}: $text") | Out-Null
          } else {
            $Lines.Add("$($index). $text") | Out-Null
          }
        }
      } finally {
        Release-ComObject $note
      }
    }
  }

  if ($Document.Endnotes.Count -gt 0) {
    $Lines.Add("") | Out-Null
    $Lines.Add("## Endnotes") | Out-Null
    for ($index = 1; $index -le $Document.Endnotes.Count; $index += 1) {
      $note = $null
      try {
        $note = $Document.Endnotes.Item($index)
        $script:WorkerStage = "endnote $index"
        $page = Get-RangePage $note.Reference
        $text = Get-CleanText $note.Range.Text
        if ($text) {
          if ($null -ne $page) {
            $Lines.Add("$($index). Page ${page}: $text") | Out-Null
          } else {
            $Lines.Add("$($index). $text") | Out-Null
          }
        }
      } finally {
        Release-ComObject $note
      }
    }
  }
}

function Add-TextBoxes {
  param(
    [object]$Document,
    [System.Collections.Generic.List[string]]$Lines
  )

  $texts = New-Object System.Collections.Generic.List[string]
  for ($index = 1; $index -le $Document.Shapes.Count; $index += 1) {
    $shape = $null
    try {
      $shape = $Document.Shapes.Item($index)
      $script:WorkerStage = "text-box shape $index"
      $hasText = $false
      try { $hasText = ($shape.TextFrame.HasText -ne 0) } catch {}
      if ($hasText) {
        $text = Get-CleanText $shape.TextFrame.TextRange.Text
        if ($text) {
          $page = Get-RangePage $shape.Anchor
          if ($null -ne $page) {
            $texts.Add("Page ${page}: $text") | Out-Null
          } else {
            $texts.Add($text) | Out-Null
          }
        }
      }
    } finally {
      Release-ComObject $shape
    }
  }

  if ($texts.Count -gt 0) {
    $Lines.Add("") | Out-Null
    $Lines.Add("## Text Boxes") | Out-Null
    foreach ($text in $texts) {
      $Lines.Add("- $text") | Out-Null
    }
  }
}

function Add-VisualReason {
  param(
    [hashtable]$Pages,
    [object]$Page,
    [string]$Reason,
    [bool]$LowConfidence = $false
  )
  if ($null -eq $Page -or [int]$Page -lt 1) {
    return
  }
  $key = [string][int]$Page
  if (-not $Pages.ContainsKey($key)) {
    $Pages[$key] = [ordered]@{
      page = [int]$Page
      reasons = New-Object System.Collections.Generic.List[string]
      low_confidence = $false
    }
  }
  if (-not $Pages[$key].reasons.Contains($Reason)) {
    $Pages[$key].reasons.Add($Reason) | Out-Null
  }
  if ($LowConfidence) {
    $Pages[$key].low_confidence = $true
  }
}

function Get-VisualPageCandidates {
  param(
    [object]$Document,
    [int]$PageCount
  )

  $pages = @{}

  for ($index = 1; $index -le $Document.InlineShapes.Count; $index += 1) {
    $shape = $null
    try {
      $shape = $Document.InlineShapes.Item($index)
      $script:WorkerStage = "visual inline shape $index"
      $page = Get-RangePage $shape.Range
      Add-VisualReason -Pages $pages -Page $page -Reason "contains an image, chart, or embedded visual object"
    } finally {
      Release-ComObject $shape
    }
  }

  for ($index = 1; $index -le $Document.Shapes.Count; $index += 1) {
    $shape = $null
    try {
      $shape = $Document.Shapes.Item($index)
      $script:WorkerStage = "visual shape $index"
      $page = Get-RangePage $shape.Anchor
      $hasChart = $false
      $hasText = $false
      try { $hasChart = ($shape.HasChart -ne 0) } catch {}
      try { $hasText = ($shape.TextFrame.HasText -ne 0) } catch {}
      if ($hasChart) {
        Add-VisualReason -Pages $pages -Page $page -Reason "contains a chart"
      } elseif ($hasText) {
        Add-VisualReason -Pages $pages -Page $page -Reason "contains a text box"
      } else {
        Add-VisualReason -Pages $pages -Page $page -Reason "contains a drawing or positioned shape" -LowConfidence $true
      }
    } finally {
      Release-ComObject $shape
    }
  }

  for ($index = 1; $index -le $Document.Tables.Count; $index += 1) {
    $table = $null
    try {
      $table = $Document.Tables.Item($index)
      $script:WorkerStage = "visual table $index"
      $rows = 0
      $columns = 0
      try { $rows = [int]$table.Rows.Count } catch {}
      try { $columns = [int]$table.Columns.Count } catch {}
      if ($rows -ge 8 -or $columns -ge 5) {
        Add-VisualReason -Pages $pages -Page (Get-RangePage $table.Range) -Reason "contains a complex table"
      }
    } finally {
      Release-ComObject $table
    }
  }

  for ($sectionIndex = 1; $sectionIndex -le $Document.Sections.Count; $sectionIndex += 1) {
    $section = $null
    try {
      $section = $Document.Sections.Item($sectionIndex)
      $script:WorkerStage = "visual section $sectionIndex"
      $columns = 1
      try { $columns = [int]$section.PageSetup.TextColumns.Count } catch {}
      if ($columns -gt 1) {
        $startPage = Get-RangePage $section.Range
        $endRange = $section.Range.Duplicate
        $endRange.Collapse(0)
        $endPage = Get-RangePage $endRange
        if ($null -eq $endPage) { $endPage = $startPage }
        for ($page = [int]$startPage; $page -le [int]$endPage; $page += 1) {
          Add-VisualReason -Pages $pages -Page $page -Reason "contains multiple text columns" -LowConfidence $true
        }
        Release-ComObject $endRange
      }
    } finally {
      Release-ComObject $section
    }
  }

  $result = New-Object System.Collections.Generic.List[object]
  foreach ($key in ($pages.Keys | Sort-Object {[int]$_})) {
    $entry = $pages[$key]
    if ($entry.page -ge 1 -and $entry.page -le $PageCount) {
      $result.Add([ordered]@{
        page = $entry.page
        reason = ($entry.reasons -join "; ")
        low_confidence = [bool]$entry.low_confidence
      }) | Out-Null
    }
  }
  return $result
}

function Get-WordInspection {
  param(
    [object]$Document,
    [string]$Path,
    [string]$DocumentType
  )

  try { $Document.Repaginate() } catch {}

  $pageCount = 0
  try { $pageCount = [int]$Document.ComputeStatistics(2) } catch { $pageCount = 0 }
  $shapeCount = 0
  $chartCount = 0
  $textBoxCount = 0
  for ($index = 1; $index -le $Document.Shapes.Count; $index += 1) {
    $shape = $null
    try {
      $shape = $Document.Shapes.Item($index)
      $script:WorkerStage = "inspection shape $index"
      $shapeCount += 1
      try { if ($shape.HasChart -ne 0) { $chartCount += 1 } } catch {}
      try { if ($shape.TextFrame.HasText -ne 0) { $textBoxCount += 1 } } catch {}
    } finally {
      Release-ComObject $shape
    }
  }

  $inlineShapeCount = 0
  $inlineChartCount = 0
  try { $inlineShapeCount = [int]$Document.InlineShapes.Count } catch {}
  for ($index = 1; $index -le $inlineShapeCount; $index += 1) {
    $inline = $null
    try {
      $inline = $Document.InlineShapes.Item($index)
      $script:WorkerStage = "inspection inline shape $index"
      try { if ($inline.HasChart -ne 0) { $inlineChartCount += 1 } } catch {}
    } finally {
      Release-ComObject $inline
    }
  }

  $revisionCount = 0
  try { $revisionCount = [int]$Document.Revisions.Count } catch {}

  return [ordered]@{
    page_count = $pageCount
    section_count = [int]$Document.Sections.Count
    paragraph_count = [int]$Document.Paragraphs.Count
    table_count = [int]$Document.Tables.Count
    existing_comment_count = [int]$Document.Comments.Count
    track_revisions_enabled = [bool]$Document.TrackRevisions
    revision_count = $revisionCount
    has_images = (($inlineShapeCount + $shapeCount) -gt 0)
    image_count = $inlineShapeCount
    has_shapes = ($shapeCount -gt 0)
    shape_count = $shapeCount
    has_charts = (($chartCount + $inlineChartCount) -gt 0)
    chart_count = ($chartCount + $inlineChartCount)
    has_text_boxes = ($textBoxCount -gt 0)
    text_box_count = $textBoxCount
    footnote_count = [int]$Document.Footnotes.Count
    endnote_count = [int]$Document.Endnotes.Count
    signature_present = (Get-SignaturePresence -Document $Document -Path $Path)
    macro_present = (Get-MacroPresence -Path $Path -DocumentType $DocumentType)
    password_protected = $false
    corrupt = $false
  }
}

function Build-WordMarkdown {
  param(
    [object]$Document,
    [string]$SourcePath,
    [string]$SourceHash,
    [string]$CreatedAt,
    [bool]$IncludeHeadersFooters,
    [bool]$IncludeExistingComments,
    [bool]$IncludeTrackChanges,
    [object]$Inspection
  )

  $lines = New-Object System.Collections.Generic.List[string]
  $anchors = New-Object System.Collections.Specialized.OrderedDictionary
  $currentPage = $null

  $lines.Add("# $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("Source filename: $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("Source SHA-256: $SourceHash") | Out-Null
  $lines.Add("Processing date: $CreatedAt") | Out-Null
  $lines.Add("Original Word pages: $($Inspection.page_count)") | Out-Null
  $lines.Add("Original Word sections: $($Inspection.section_count)") | Out-Null
  $lines.Add("") | Out-Null

  if ($IncludeHeadersFooters) {
    Add-HeadersAndFooters -Document $Document -Lines $lines
  }

  $tableStarts = @{}
  for ($tableIndex = 1; $tableIndex -le $Document.Tables.Count; $tableIndex += 1) {
    $table = $null
    try {
      $table = $Document.Tables.Item($tableIndex)
      $script:WorkerStage = "table start $tableIndex"
      $tableStarts[[string]$table.Range.Start] = $tableIndex
    } finally {
      Release-ComObject $table
    }
  }

  $emittedTables = @{}
  for ($index = 1; $index -le $Document.Paragraphs.Count; $index += 1) {
    $paragraph = $null
    try {
      $paragraph = $Document.Paragraphs.Item($index)
      $script:WorkerStage = "paragraph $index"
      $inTable = $false
      try { $inTable = [bool]$paragraph.Range.Information(12) } catch {}
      if ($inTable) {
        $table = $null
        try {
          $table = $paragraph.Range.Tables.Item(1)
          $script:WorkerStage = "paragraph table $index"
          $tableStart = [string]$table.Range.Start
          if (-not $emittedTables.ContainsKey($tableStart)) {
            $tableIndex = $tableStarts[$tableStart]
            if ($null -eq $tableIndex) {
              $tableIndex = $emittedTables.Count + 1
            }
            Add-TableMarkdown -Table $table -TableIndex ([int]$tableIndex) -Anchors $anchors -Lines $lines -CurrentPage ([ref]$currentPage) -IncludeExistingComments $IncludeExistingComments -IncludeTrackChanges $IncludeTrackChanges
            $emittedTables[$tableStart] = $true
          }
        } catch {
          continue
        } finally {
          Release-ComObject $table
        }
        continue
      }

      $text = Get-CleanText $paragraph.Range.Text
      if (-not $text) {
        continue
      }

      $page = Get-RangePage $paragraph.Range
      Add-PageMarker -Lines $lines -CurrentPage ([ref]$currentPage) -Page $page
      $paragraphId = "w:p{0:D6}" -f $index
      $anchor = [ordered]@{
        kind = "docx_paragraph"
        paragraph_id = $paragraphId
      }
      if ($null -ne $page) {
        $anchor.page = $page
      }
      $anchors[$paragraphId] = New-AnchorRecord -AnchorId $paragraphId -Kind "docx_paragraph" -Anchor $anchor -Page $page -Text $text -ParagraphId $paragraphId
      $lines.Add("<!-- HL:$paragraphId -->") | Out-Null
      $lines.Add((Get-ParagraphMarkdown -Paragraph $paragraph -Text $text)) | Out-Null
      Add-RangeSupplements -Lines $lines -Range $paragraph.Range -IncludeExistingComments $IncludeExistingComments -IncludeTrackChanges $IncludeTrackChanges
      $lines.Add("") | Out-Null
    } finally {
      Release-ComObject $paragraph
    }
  }

  Add-FootnotesAndEndnotes -Document $Document -Lines $lines
  Add-TextBoxes -Document $Document -Lines $lines

  return [ordered]@{
    markdown = ($lines -join "`n").Trim() + "`n"
    anchors = $anchors
  }
}

function Resolve-WordAnchorRange {
  param(
    [object]$Document,
    [object]$Anchor
  )

  if ($Anchor.kind -eq "docx_paragraph") {
    $id = [string]$Anchor.paragraph_id
    if ($id -match "p(\d+)$") {
      $index = [int]$Matches[1]
      return $Document.Paragraphs.Item($index).Range
    }
  }

  if ($Anchor.kind -eq "docx_table_cell") {
    $tableIndex = $null
    $cellIndex = $null
    if ([string]$Anchor.table_id -match "t(\d+)$") {
      $tableIndex = [int]$Matches[1]
    }
    if ([string]$Anchor.cell_id -match "c(\d+)$") {
      $cellIndex = [int]$Matches[1]
    }
    if ($null -ne $tableIndex) {
      $table = $Document.Tables.Item($tableIndex)
      if ($null -ne $cellIndex) {
        return $table.Range.Cells.Item($cellIndex).Range
      }
      return $table.Cell([int]$Anchor.row, [int]$Anchor.column).Range
    }
  }

  throw "Could not find the selected Word anchor in the document."
}

function Test-CommentAtRange {
  param(
    [object]$Range,
    [string]$ExpectedText
  )
  try {
    for ($index = 1; $index -le $Range.Comments.Count; $index += 1) {
      $comment = $Range.Comments.Item($index)
      try {
        $text = Get-OneLineText $comment.Range.Text
        if ($text -eq (Get-OneLineText $ExpectedText)) {
          return $true
        }
      } finally {
        Release-ComObject $comment
      }
    }
  } catch {
  }
  return $false
}

function Assert-PowerPointRequest {
  param([object]$Request)
  if ($Request.application -ne "powerpoint") {
    throw "Invalid request."
  }
  if ($Request.document_type -ne "pptx" -and $Request.document_type -ne "pptm") {
    throw "Invalid request."
  }
}

function New-PowerPointTempCopy {
  param([string]$SourcePath)
  Assert-PowerPointPackageCanOpen -Path $SourcePath
  $extension = [System.IO.Path]::GetExtension($SourcePath)
  if (-not $extension) { $extension = ".pptx" }
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ("hl-powerpoint-source-{0}{1}" -f ([System.Guid]::NewGuid().ToString("N")), $extension)
  Copy-Item -LiteralPath $SourcePath -Destination $path -Force
  return $path
}

function Get-PptTriStateBoolean {
  param([object]$Value)
  try {
    return ([int]$Value -ne 0)
  } catch {
    return [bool]$Value
  }
}

function Get-PptShapeTypeLabel {
  param([int]$Type)
  switch ($Type) {
    1 { return "auto shape" }
    3 { return "chart" }
    6 { return "grouped shapes" }
    7 { return "embedded object" }
    10 { return "linked object" }
    11 { return "linked picture" }
    13 { return "image" }
    14 { return "placeholder" }
    17 { return "text box" }
    19 { return "table" }
    21 { return "diagram" }
    24 { return "SmartArt" }
    default { return "shape type $Type" }
  }
}

function Get-PptShapeBounds {
  param([object]$Shape)
  return [ordered]@{
    x = [Math]::Round([double]$Shape.Left, 2)
    y = [Math]::Round([double]$Shape.Top, 2)
    width = [Math]::Round([double]$Shape.Width, 2)
    height = [Math]::Round([double]$Shape.Height, 2)
  }
}

function Get-PptSlideHidden {
  param([object]$Slide)
  try {
    return Get-PptTriStateBoolean $Slide.SlideShowTransition.Hidden
  } catch {
    return $false
  }
}

function Get-PptShapeText {
  param([object]$Shape)
  try {
    if ($Shape.HasTextFrame -ne 0 -and $Shape.TextFrame.HasText -ne 0) {
      return Get-CleanText $Shape.TextFrame.TextRange.Text
    }
  } catch {
  }
  return ""
}

function Get-PptShapeHyperlinks {
  param([object]$Shape)
  $links = New-Object System.Collections.Generic.List[string]
  foreach ($action in @(1, 2)) {
    try {
      $setting = $Shape.ActionSettings.Item($action)
      $hyperlink = $setting.Hyperlink
      $target = [string]$hyperlink.Address
      if ($hyperlink.SubAddress) {
        if ($target) {
          $target = "$target#$($hyperlink.SubAddress)"
        } else {
          $target = "#$($hyperlink.SubAddress)"
        }
      }
      if ($target -and -not $links.Contains($target)) {
        $links.Add($target) | Out-Null
      }
      Release-ComObject $hyperlink
      Release-ComObject $setting
    } catch {
    }
  }
  return $links
}

function Get-PptSpeakerNotes {
  param([object]$Slide)
  $notes = New-Object System.Collections.Generic.List[string]
  try {
    $notesPage = $Slide.NotesPage
    for ($index = 1; $index -le $notesPage.Shapes.Count; $index += 1) {
      Test-WorkerCancelled
      $shape = $null
      try {
        $shape = $notesPage.Shapes.Item($index)
        $text = Get-PptShapeText $shape
        if ($text -and $text -notmatch "^\s*Click to add notes\s*$" -and -not $notes.Contains($text)) {
          $notes.Add($text) | Out-Null
        }
      } finally {
        Release-ComObject $shape
      }
    }
    Release-ComObject $notesPage
  } catch {
  }
  return ($notes -join "`n")
}

function Get-PptCommentCount {
  param([object]$Presentation)
  $count = 0
  for ($index = 1; $index -le $Presentation.Slides.Count; $index += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($index)
      try { $count += [int]$slide.Comments.Count } catch {}
    } finally {
      Release-ComObject $slide
    }
  }
  return $count
}

function Get-PptSlideMasterCount {
  param([object]$Presentation)
  try {
    $count = [int]$Presentation.Designs.Count
    if ($count -gt 0) { return $count }
  } catch {
  }
  return 1
}

function Get-PptHiddenStateSignature {
  param([object]$Presentation)
  $parts = New-Object System.Collections.Generic.List[string]
  for ($index = 1; $index -le $Presentation.Slides.Count; $index += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($index)
      $parts.Add("$index|$($slide.SlideID)|$(Get-PptSlideHidden $slide)") | Out-Null
    } finally {
      Release-ComObject $slide
    }
  }
  return Get-Sha256Text (($parts | Sort-Object) -join "`n")
}

function Get-PptNotesSignature {
  param([object]$Presentation)
  $parts = New-Object System.Collections.Generic.List[string]
  for ($index = 1; $index -le $Presentation.Slides.Count; $index += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($index)
      $parts.Add("$index|$($slide.SlideID)|$(Get-PptSpeakerNotes $slide)") | Out-Null
    } finally {
      Release-ComObject $slide
    }
  }
  return Get-Sha256Text (($parts | Sort-Object) -join "`n")
}

function Get-PptChartDetails {
  param([object]$Shape)
  $lines = New-Object System.Collections.Generic.List[string]
  try {
    if ($Shape.HasChart -eq 0) {
      return $lines
    }
    $chart = $Shape.Chart
    try {
      if ($chart.HasTitle) {
        $title = Get-OneLineText $chart.ChartTitle.Text
        if ($title) { $lines.Add("Chart title: $title") | Out-Null }
      }
    } catch {
    }
    $seriesCollection = $null
    try {
      $seriesCollection = $chart.SeriesCollection()
      $seriesCount = [Math]::Min([int]$seriesCollection.Count, 20)
      for ($index = 1; $index -le $seriesCount; $index += 1) {
        Test-WorkerCancelled
        $series = $null
        try {
          $series = $seriesCollection.Item($index)
          $name = Get-OneLineText $series.Name
          $categories = New-Object System.Collections.Generic.List[string]
          try {
            foreach ($value in $series.XValues) {
              $label = Get-OneLineText $value
              if ($label -and -not $categories.Contains($label)) {
                $categories.Add($label) | Out-Null
              }
              if ($categories.Count -ge 30) { break }
            }
          } catch {
          }
          if ($name -or $categories.Count -gt 0) {
            $categoryText = if ($categories.Count -gt 0) { "; categories: $($categories -join ', ')" } else { "" }
            $lines.Add("Series ${index}: $name$categoryText") | Out-Null
          }
        } finally {
          Release-ComObject $series
        }
      }
    } finally {
      Release-ComObject $seriesCollection
      Release-ComObject $chart
    }
  } catch {
  }
  return $lines
}

function Get-PptTableDetails {
  param([object]$Shape)
  $result = [ordered]@{
    lines = New-Object System.Collections.Generic.List[string]
    text = ""
    rows = 0
    columns = 0
  }
  try {
    if ($Shape.HasTable -eq 0) {
      return $result
    }
    $table = $Shape.Table
    $rows = [int]$table.Rows.Count
    $columns = [int]$table.Columns.Count
    $result.rows = $rows
    $result.columns = $columns
    $textParts = New-Object System.Collections.Generic.List[string]
    if ($rows -gt 0 -and $columns -gt 0) {
      $result.lines.Add("Table contents:") | Out-Null
      $header = New-Object System.Collections.Generic.List[string]
      $separator = New-Object System.Collections.Generic.List[string]
      for ($column = 1; $column -le $columns; $column += 1) {
        $header.Add("Column $column") | Out-Null
        $separator.Add("---") | Out-Null
      }
      $result.lines.Add("| $($header -join ' | ') |") | Out-Null
      $result.lines.Add("| $($separator -join ' | ') |") | Out-Null
      for ($row = 1; $row -le $rows; $row += 1) {
        Test-WorkerCancelled
        $cells = New-Object System.Collections.Generic.List[string]
        for ($column = 1; $column -le $columns; $column += 1) {
          $cell = $null
          $cellShape = $null
          try {
            $cell = $table.Cell($row, $column)
            $cellShape = $cell.Shape
            $text = Get-PptShapeText $cellShape
            $cells.Add((Escape-MarkdownCell $text)) | Out-Null
            if ($text) {
              $textParts.Add("R${row}C${column}: $text") | Out-Null
            }
          } finally {
            Release-ComObject $cellShape
            Release-ComObject $cell
          }
        }
        $result.lines.Add("| $($cells -join ' | ') |") | Out-Null
      }
    }
    $result.text = ($textParts -join " | ")
    Release-ComObject $table
  } catch {
  }
  return $result
}

function Get-PptGroupText {
  param([object]$Shape)
  $items = New-Object System.Collections.Generic.List[string]
  try {
    if ([int]$Shape.Type -ne 6) {
      return ""
    }
    for ($index = 1; $index -le $Shape.GroupItems.Count; $index += 1) {
      Test-WorkerCancelled
      $child = $null
      try {
        $child = $Shape.GroupItems.Item($index)
        $name = Get-OneLineText $child.Name
        $text = Get-PptShapeText $child
        $type = Get-PptShapeTypeLabel ([int]$child.Type)
        if ($text) {
          $items.Add("$name ($type): $text") | Out-Null
        } else {
          $items.Add("$name ($type)") | Out-Null
        }
      } finally {
        Release-ComObject $child
      }
    }
  } catch {
  }
  return ($items -join " | ")
}

function Get-PptShapeExtraction {
  param([object]$Shape)
  $name = Get-OneLineText $Shape.Name
  $shapeId = [string]$Shape.Id
  $type = Get-PptShapeTypeLabel ([int]$Shape.Type)
  $bounds = Get-PptShapeBounds $Shape
  $parts = New-Object System.Collections.Generic.List[string]
  $parts.Add("Shape $name") | Out-Null
  $parts.Add("Shape ID $shapeId") | Out-Null
  $parts.Add("Type $type") | Out-Null
  $parts.Add("Bounding box x=$($bounds.x), y=$($bounds.y), width=$($bounds.width), height=$($bounds.height)") | Out-Null

  $markdownLines = New-Object System.Collections.Generic.List[string]
  $markdownLines.Add("- Shape name: $name") | Out-Null
  $markdownLines.Add("- Shape ID: $shapeId") | Out-Null
  $markdownLines.Add("- Type: $type") | Out-Null
  $markdownLines.Add("- Bounding box: x=$($bounds.x), y=$($bounds.y), width=$($bounds.width), height=$($bounds.height)") | Out-Null

  $table = Get-PptTableDetails $Shape
  if ($table.text) {
    $parts.Add($table.text) | Out-Null
    foreach ($line in $table.lines) { $markdownLines.Add($line) | Out-Null }
  } else {
    $text = Get-PptShapeText $Shape
    if ($text) {
      $parts.Add($text) | Out-Null
      $markdownLines.Add("Text: $text") | Out-Null
    }
  }

  $chartLines = Get-PptChartDetails $Shape
  foreach ($line in $chartLines) {
    $parts.Add($line) | Out-Null
    $markdownLines.Add($line) | Out-Null
  }

  $groupText = Get-PptGroupText $Shape
  if ($groupText) {
    $parts.Add("Grouped content: $groupText") | Out-Null
    $markdownLines.Add("Grouped content: $groupText") | Out-Null
  }

  $links = Get-PptShapeHyperlinks $Shape
  if ($links.Count -gt 0) {
    $parts.Add("Hyperlinks: $($links -join '; ')") | Out-Null
    $markdownLines.Add("Hyperlinks: $($links -join '; ')") | Out-Null
  }

  return [ordered]@{
    shape_id = $shapeId
    name = $name
    type = $type
    bbox = $bounds
    text = ($parts -join " | ")
    markdown_lines = $markdownLines
    table_rows = [int]$table.rows
    table_columns = [int]$table.columns
  }
}

function Get-PptSlideTitle {
  param([object]$Slide)
  try {
    $titleShape = $Slide.Shapes.Title
    $title = Get-PptShapeText $titleShape
    Release-ComObject $titleShape
    return $title
  } catch {
    return ""
  }
}

function Get-PptExistingCommentsMarkdown {
  param([object]$Slide)
  $lines = New-Object System.Collections.Generic.List[string]
  try {
    if ([int]$Slide.Comments.Count -lt 1) {
      return $lines
    }
    $lines.Add("Existing comments:") | Out-Null
    for ($index = 1; $index -le $Slide.Comments.Count; $index += 1) {
      $comment = $null
      try {
        $comment = $Slide.Comments.Item($index)
        $author = Get-OneLineText $comment.Author
        $text = Get-OneLineText $comment.Text
        if ($text) {
          $prefix = if ($author) { "${author}: " } else { "" }
          $lines.Add("- $prefix$text") | Out-Null
        }
      } finally {
        Release-ComObject $comment
      }
    }
  } catch {
  }
  return $lines
}

function Get-PptInspection {
  param(
    [object]$Presentation,
    [string]$Path,
    [string]$DocumentType
  )

  $hiddenSlideCount = 0
  $shapeCount = 0
  $chartCount = 0
  $tableCount = 0
  $imageCount = 0
  $speakerNoteCount = 0

  for ($slideIndex = 1; $slideIndex -le $Presentation.Slides.Count; $slideIndex += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($slideIndex)
      if (Get-PptSlideHidden $slide) { $hiddenSlideCount += 1 }
      if (Get-PptSpeakerNotes $slide) { $speakerNoteCount += 1 }
      for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex += 1) {
        Test-WorkerCancelled
        $shape = $null
        try {
          $shape = $slide.Shapes.Item($shapeIndex)
          $shapeCount += 1
          try { if ($shape.HasChart -ne 0) { $chartCount += 1 } } catch {}
          try { if ($shape.HasTable -ne 0) { $tableCount += 1 } } catch {}
          try {
            $type = [int]$shape.Type
            if ($type -eq 11 -or $type -eq 13) { $imageCount += 1 }
          } catch {
          }
        } finally {
          Release-ComObject $shape
        }
      }
    } finally {
      Release-ComObject $slide
    }
  }

  return [ordered]@{
    slide_count = [int]$Presentation.Slides.Count
    hidden_slide_count = $hiddenSlideCount
    slide_master_count = Get-PptSlideMasterCount -Presentation $Presentation
    shape_count = $shapeCount
    chart_count = $chartCount
    table_count = $tableCount
    image_count = $imageCount
    speaker_note_count = $speakerNoteCount
    existing_comment_count = Get-PptCommentCount -Presentation $Presentation
    macro_present = (Get-MacroPresence -Path $Path -DocumentType $DocumentType)
    signature_present = (Get-SignaturePresence -Document $Presentation -Path $Path)
    password_protected = $false
    corrupt = $false
    hidden_state_signature = Get-PptHiddenStateSignature -Presentation $Presentation
    notes_signature = Get-PptNotesSignature -Presentation $Presentation
  }
}

function Add-PptAnchorRecord {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Anchors,
    [string]$AnchorId,
    [string]$Kind,
    [object]$Anchor,
    [int]$Slide,
    [int]$SlideId,
    [string]$Text,
    [string]$ShapeId = "",
    [object]$Bbox = $null
  )

  $record = [ordered]@{
    anchorId = $AnchorId
    kind = $Kind
    anchor = $Anchor
    slide = $Slide
    slideId = $SlideId
    text = $Text
  }
  if ($ShapeId) { $record.shapeId = $ShapeId }
  if ($null -ne $Bbox) { $record.bbox = $Bbox }
  $Anchors[$AnchorId] = $record
}

function Build-PowerPointMarkdown {
  param(
    [object]$Presentation,
    [string]$SourcePath,
    [string]$SourceHash,
    [string]$CreatedAt,
    [bool]$IncludeSpeakerNotes,
    [bool]$IncludeExistingComments,
    [object]$Inspection
  )

  $lines = New-Object System.Collections.Generic.List[string]
  $anchors = New-Object System.Collections.Specialized.OrderedDictionary

  $lines.Add("# $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("Source filename: $(Split-Path -Leaf $SourcePath)") | Out-Null
  $lines.Add("Source SHA-256: $SourceHash") | Out-Null
  $lines.Add("Processing date: $CreatedAt") | Out-Null
  $lines.Add("Original PowerPoint slides: $($Inspection.slide_count)") | Out-Null
  $lines.Add("Hidden slides: $($Inspection.hidden_slide_count)") | Out-Null
  $lines.Add("Macro project present: $($Inspection.macro_present)") | Out-Null
  $lines.Add("") | Out-Null

  for ($slideIndex = 1; $slideIndex -le $Presentation.Slides.Count; $slideIndex += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($slideIndex)
      $slideId = [int]$slide.SlideID
      $hidden = Get-PptSlideHidden $slide
      $title = Get-PptSlideTitle $slide
      $slideAnchorId = "ppt:s{0:D4}:slide:{1}" -f $slideIndex, $slideId
      $slideAnchor = [ordered]@{
        kind = "pptx_slide"
        slide = $slideIndex
        slide_id = $slideId
      }
      $slideTextParts = New-Object System.Collections.Generic.List[string]
      if ($title) { $slideTextParts.Add("Title: $title") | Out-Null }

      $lines.Add("## Slide $slideIndex (slide ID $slideId)") | Out-Null
      $lines.Add("") | Out-Null
      $lines.Add("<!-- HL:$slideAnchorId -->") | Out-Null
      $lines.Add("Hidden: $hidden") | Out-Null
      if ($title) { $lines.Add("Title: $title") | Out-Null }
      $lines.Add("") | Out-Null
      $lines.Add("Shapes:") | Out-Null

      for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex += 1) {
        Test-WorkerCancelled
        $shape = $null
        try {
          $shape = $slide.Shapes.Item($shapeIndex)
          $extracted = Get-PptShapeExtraction $shape
          $shapeAnchorId = "ppt:s{0:D4}:shape:{1}" -f $slideIndex, $extracted.shape_id
          $shapeAnchor = [ordered]@{
            kind = "pptx_shape"
            slide = $slideIndex
            slide_id = $slideId
            shape_id = [string]$extracted.shape_id
          }
          Add-PptAnchorRecord `
            -Anchors $anchors `
            -AnchorId $shapeAnchorId `
            -Kind "pptx_shape" `
            -Anchor $shapeAnchor `
            -Slide $slideIndex `
            -SlideId $slideId `
            -Text ([string]$extracted.text) `
            -ShapeId ([string]$extracted.shape_id) `
            -Bbox $extracted.bbox
          $slideTextParts.Add([string]$extracted.text) | Out-Null

          $lines.Add("") | Out-Null
          $lines.Add("### Shape ${shapeIndex}: $($extracted.name)") | Out-Null
          $lines.Add("<!-- HL:$shapeAnchorId -->") | Out-Null
          foreach ($line in $extracted.markdown_lines) {
            $lines.Add($line) | Out-Null
          }
        } finally {
          Release-ComObject $shape
        }
      }

      if ($IncludeSpeakerNotes) {
        $notes = Get-PptSpeakerNotes $slide
        if ($notes) {
          $slideTextParts.Add("Speaker notes: $notes") | Out-Null
          $lines.Add("") | Out-Null
          $lines.Add("Speaker notes:") | Out-Null
          foreach ($noteLine in ($notes -split "`n")) {
            $lines.Add("- $noteLine") | Out-Null
          }
        }
      }

      if ($IncludeExistingComments) {
        $commentLines = Get-PptExistingCommentsMarkdown $slide
        if ($commentLines.Count -gt 0) {
          $lines.Add("") | Out-Null
          foreach ($line in $commentLines) {
            $lines.Add($line) | Out-Null
            $slideTextParts.Add($line) | Out-Null
          }
        }
      }

      Add-PptAnchorRecord `
        -Anchors $anchors `
        -AnchorId $slideAnchorId `
        -Kind "pptx_slide" `
        -Anchor $slideAnchor `
        -Slide $slideIndex `
        -SlideId $slideId `
        -Text (($slideTextParts -join " | ").Trim())

      $lines.Add("") | Out-Null
    } finally {
      Release-ComObject $slide
    }
  }

  return [ordered]@{
    markdown = ($lines -join "`n").Trim() + "`n"
    anchors = $anchors
  }
}

function Get-PptVisualCandidates {
  param([object]$Presentation)
  $candidates = New-Object System.Collections.Generic.List[object]
  for ($slideIndex = 1; $slideIndex -le $Presentation.Slides.Count; $slideIndex += 1) {
    Test-WorkerCancelled
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($slideIndex)
      $reasons = New-Object System.Collections.Generic.List[string]
      $lowConfidence = $false
      $textLength = 0
      $visualShapeCount = 0
      for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex += 1) {
        Test-WorkerCancelled
        $shape = $null
        try {
          $shape = $slide.Shapes.Item($shapeIndex)
          $type = [int]$shape.Type
          $text = Get-PptShapeText $shape
          $textLength += $text.Length
          try { if ($shape.HasChart -ne 0 -and -not $reasons.Contains("contains charts")) { $reasons.Add("contains charts") | Out-Null; $visualShapeCount += 1 } } catch {}
          try {
            if ($shape.HasTable -ne 0) {
              $table = $shape.Table
              if ([int]$table.Rows.Count -ge 6 -or [int]$table.Columns.Count -ge 5) {
                if (-not $reasons.Contains("contains complex tables")) { $reasons.Add("contains complex tables") | Out-Null }
              }
              Release-ComObject $table
            }
          } catch {
          }
          if ($type -eq 11 -or $type -eq 13) {
            if (-not $reasons.Contains("contains images")) { $reasons.Add("contains images") | Out-Null }
            $visualShapeCount += 1
          }
          if ($type -eq 6) {
            if (-not $reasons.Contains("contains grouped shapes")) { $reasons.Add("contains grouped shapes") | Out-Null }
            $visualShapeCount += 1
          }
          if ($type -eq 21 -or $type -eq 24) {
            if (-not $reasons.Contains("contains diagrams or SmartArt")) { $reasons.Add("contains diagrams or SmartArt") | Out-Null }
            $visualShapeCount += 1
            $lowConfidence = $true
          }
          if ($type -eq 7 -or $type -eq 10) {
            if (-not $reasons.Contains("contains embedded or linked objects")) { $reasons.Add("contains embedded or linked objects") | Out-Null }
            $visualShapeCount += 1
            $lowConfidence = $true
          }
        } finally {
          Release-ComObject $shape
        }
      }
      if ([int]$slide.Shapes.Count -ge 8 -and -not $reasons.Contains("contains material positioning")) {
        $reasons.Add("contains material positioning") | Out-Null
        $lowConfidence = $true
      }
      if ($textLength -lt 80 -and $visualShapeCount -gt 0 -and -not $reasons.Contains("sparse text with substantial graphics")) {
        $reasons.Add("sparse text with substantial graphics") | Out-Null
      }
      if ($reasons.Count -gt 0) {
        $candidates.Add([ordered]@{
          slide = $slideIndex
          slide_id = [int]$slide.SlideID
          reason = ($reasons -join "; ")
          low_confidence = [bool]$lowConfidence
        }) | Out-Null
      }
    } finally {
      Release-ComObject $slide
    }
  }
  return $candidates
}

function Resolve-PptSlide {
  param(
    [object]$Presentation,
    [object]$Anchor
  )
  $expectedSlideId = [int]$Anchor.slide_id
  $slideNumber = [int]$Anchor.slide
  try {
    if ($slideNumber -ge 1 -and $slideNumber -le $Presentation.Slides.Count) {
      $slide = $Presentation.Slides.Item($slideNumber)
      if ([int]$slide.SlideID -eq $expectedSlideId) {
        return $slide
      }
      Release-ComObject $slide
    }
  } catch {
  }
  for ($index = 1; $index -le $Presentation.Slides.Count; $index += 1) {
    $slide = $null
    try {
      $slide = $Presentation.Slides.Item($index)
      if ([int]$slide.SlideID -eq $expectedSlideId) {
        return $slide
      }
    } catch {
    }
    Release-ComObject $slide
  }
  throw "Could not find the selected PowerPoint anchor in the presentation."
}

function Resolve-PptShape {
  param(
    [object]$Slide,
    [string]$ShapeId
  )
  for ($index = 1; $index -le $Slide.Shapes.Count; $index += 1) {
    $shape = $null
    try {
      $shape = $Slide.Shapes.Item($index)
      if ([string]$shape.Id -eq $ShapeId) {
        return $shape
      }
    } catch {
    }
    Release-ComObject $shape
  }
  throw "Could not find the selected PowerPoint anchor in the presentation."
}

function Add-PptNativeComment {
  param(
    [object]$Slide,
    [double]$Left,
    [double]$Top,
    [string]$Text,
    [ref]$ApiUsed
  )

  $comment = $null
  try {
    $comment = $Slide.Comments.Add2($Left, $Top, "HL Intelligence", "HL", $Text, "None", "hl-intelligence")
    $ApiUsed.Value = "Comments.Add2"
    return
  } catch {
    Release-ComObject $comment
    $comment = $null
  }
  try {
    $comment = $Slide.Comments.Add($Left, $Top, "HL Intelligence", "HL", $Text)
    if (-not $ApiUsed.Value -or $ApiUsed.Value -eq "unknown") {
      $ApiUsed.Value = "Comments.Add"
    }
  } finally {
    Release-ComObject $comment
  }
}

function Test-PptCommentOnSlide {
  param(
    [object]$Slide,
    [string]$ExpectedText,
    [object]$ExpectedShape = $null
  )
  $expected = Get-OneLineText $ExpectedText
  for ($index = 1; $index -le $Slide.Comments.Count; $index += 1) {
    $comment = $null
    try {
      $comment = $Slide.Comments.Item($index)
      $text = Get-OneLineText $comment.Text
      if ($text.Contains($expected)) {
        if ($null -ne $ExpectedShape) {
          try {
            $dx = [Math]::Abs(([double]$comment.Left) - ([double]$ExpectedShape.Left))
            $dy = [Math]::Abs(([double]$comment.Top) - ([double]$ExpectedShape.Top))
            if ($dx -le 80 -and $dy -le 80) {
              return $true
            }
          } catch {
            return $true
          }
        } else {
          return $true
        }
      }
    } finally {
      Release-ComObject $comment
    }
  }
  return $false
}

function Invoke-PowerPointInspect {
  param([object]$Request)
  Assert-PowerPointRequest $Request
  $powerPoint = $null
  $presentation = $null
  $tempCopy = ""
  try {
    $tempCopy = New-PowerPointTempCopy -SourcePath ([string]$Request.source_path)
    $powerPoint = Start-PowerPointApplication
    $presentation = Open-PowerPointPresentation -PowerPoint $powerPoint -Path $tempCopy -ReadOnly $true
    $inspection = Get-PptInspection -Presentation $presentation -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    return [ordered]@{
      schema_version = "1.0"
      operation = "inspect"
      ok = $true
      document_type = [string]$Request.document_type
      inspection = $inspection
    }
  } finally {
    Close-PowerPointPresentation -Presentation $presentation
    Clear-PowerPointRecentFile -PowerPoint $powerPoint -Path $tempCopy
    Stop-PowerPointApplication -PowerPoint $powerPoint
    if ($tempCopy -and (Test-Path -LiteralPath $tempCopy)) { Remove-Item -LiteralPath $tempCopy -Force }
  }
}

function Invoke-PowerPointExtract {
  param([object]$Request)
  Assert-PowerPointRequest $Request
  $powerPoint = $null
  $presentation = $null
  $tempCopy = ""
  try {
    $tempCopy = New-PowerPointTempCopy -SourcePath ([string]$Request.source_path)
    $powerPoint = Start-PowerPointApplication
    $presentation = Open-PowerPointPresentation -PowerPoint $powerPoint -Path $tempCopy -ReadOnly $true
    $inspection = Get-PptInspection -Presentation $presentation -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    $built = Build-PowerPointMarkdown `
      -Presentation $presentation `
      -SourcePath ([string]$Request.source_path) `
      -SourceHash ([string]$Request.source_sha256) `
      -CreatedAt ([string]$Request.created_at) `
      -IncludeSpeakerNotes ([bool]$Request.options.include_speaker_notes) `
      -IncludeExistingComments ([bool]$Request.options.include_existing_comments) `
      -Inspection $inspection
    return [ordered]@{
      schema_version = "1.0"
      operation = "extract"
      ok = $true
      document_type = [string]$Request.document_type
      markdown = $built.markdown
      anchors = $built.anchors
      visual_pages = Get-PptVisualCandidates -Presentation $presentation
      warnings = @()
      inspection = $inspection
    }
  } finally {
    Close-PowerPointPresentation -Presentation $presentation
    Clear-PowerPointRecentFile -PowerPoint $powerPoint -Path $tempCopy
    Stop-PowerPointApplication -PowerPoint $powerPoint
    if ($tempCopy -and (Test-Path -LiteralPath $tempCopy)) { Remove-Item -LiteralPath $tempCopy -Force }
  }
}

function Invoke-PowerPointRender {
  param([object]$Request)
  Assert-PowerPointRequest $Request
  $powerPoint = $null
  $presentation = $null
  $tempCopy = ""
  try {
    $tempCopy = New-PowerPointTempCopy -SourcePath ([string]$Request.source_path)
    $powerPoint = Start-PowerPointApplication
    $presentation = Open-PowerPointPresentation -PowerPoint $powerPoint -Path $tempCopy -ReadOnly $true
    $output = [string]$Request.output_pdf_path
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    $presentation.SaveAs($output, 32) | Out-Null
    return [ordered]@{
      schema_version = "1.0"
      operation = "render"
      ok = $true
      document_type = [string]$Request.document_type
      output_pdf_path = $output
      slide_count = [int]$presentation.Slides.Count
    }
  } finally {
    Close-PowerPointPresentation -Presentation $presentation
    Clear-PowerPointRecentFile -PowerPoint $powerPoint -Path $tempCopy
    Stop-PowerPointApplication -PowerPoint $powerPoint
    if ($tempCopy -and (Test-Path -LiteralPath $tempCopy)) { Remove-Item -LiteralPath $tempCopy -Force }
  }
}

function Invoke-PowerPointApplyComments {
  param([object]$Request)
  Assert-PowerPointRequest $Request
  $powerPoint = $null
  $presentation = $null
  try {
    if ($Request.comments.Count -lt 1) {
      throw "No valid comments are available to apply."
    }
    if (Test-Path -LiteralPath ([string]$Request.output_path)) {
      throw "HL Intelligence will not overwrite an existing output presentation."
    }
    Assert-PowerPointPackageCanOpen -Path ([string]$Request.source_path)
    Copy-Item -LiteralPath ([string]$Request.source_path) -Destination ([string]$Request.output_path) -ErrorAction Stop

    $powerPoint = Start-PowerPointApplication
    $presentation = Open-PowerPointPresentation -PowerPoint $powerPoint -Path ([string]$Request.output_path) -ReadOnly $false
    $added = 0
    $apiUsed = "unknown"
    foreach ($item in $Request.comments) {
      Test-WorkerCancelled
      $slide = $null
      $shape = $null
      try {
        $slide = Resolve-PptSlide -Presentation $presentation -Anchor $item.anchor
        $left = 18.0
        $top = 18.0
        if ($item.anchor.kind -eq "pptx_shape") {
          $shape = Resolve-PptShape -Slide $slide -ShapeId ([string]$item.anchor.shape_id)
          $left = [Math]::Max(0, [double]$shape.Left)
          $top = [Math]::Max(0, [double]$shape.Top)
        }
        Add-PptNativeComment -Slide $slide -Left $left -Top $top -Text ([string]$item.comment) -ApiUsed ([ref]$apiUsed)
        $added += 1
      } finally {
        Release-ComObject $shape
        Release-ComObject $slide
      }
    }
    Close-PowerPointPresentation -Presentation $presentation -Save $true
    $presentation = $null
    return [ordered]@{
      schema_version = "1.0"
      operation = "apply-comments"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      added_comment_count = $added
      comment_api = $apiUsed
    }
  } finally {
    Close-PowerPointPresentation -Presentation $presentation
    Clear-PowerPointRecentFile -PowerPoint $powerPoint -Path ([string]$Request.output_path)
    Stop-PowerPointApplication -PowerPoint $powerPoint
  }
}

function Invoke-PowerPointVerifyOutput {
  param([object]$Request)
  Assert-PowerPointRequest $Request
  $powerPoint = $null
  $presentation = $null
  try {
    $sourceHash = Get-FileSha256 ([string]$Request.source_path)
    if ($sourceHash -ne [string]$Request.expected.source_sha256) {
      throw "Output verification failed: source presentation changed."
    }

    $powerPoint = Start-PowerPointApplication
    $presentation = Open-PowerPointPresentation -PowerPoint $powerPoint -Path ([string]$Request.output_path) -ReadOnly $true
    $inspection = Get-PptInspection -Presentation $presentation -Path ([string]$Request.output_path) -DocumentType ([string]$Request.document_type)
    if ([int]$inspection.slide_count -ne [int]$Request.expected.slide_count) {
      throw "Output verification failed: slide count changed."
    }
    if ([string]$inspection.hidden_state_signature -ne [string]$Request.expected.hidden_state_signature) {
      throw "Output verification failed: hidden slide states changed."
    }
    if ([int]$inspection.shape_count -ne [int]$Request.expected.shape_count) {
      throw "Output verification failed: shape count changed."
    }
    if ([int]$inspection.slide_master_count -ne [int]$Request.expected.slide_master_count) {
      throw "Output verification failed: slide master count changed."
    }
    if ([string]$inspection.notes_signature -ne [string]$Request.expected.notes_signature) {
      throw "Output verification failed: speaker notes changed."
    }
    if ([int]$inspection.chart_count -ne [int]$Request.expected.chart_count) {
      throw "Output verification failed: chart count changed."
    }
    if ([int]$inspection.existing_comment_count -lt ([int]$Request.expected.existing_comment_count + [int]$Request.expected.anchors.Count)) {
      throw "Output verification failed: expected PowerPoint comments were not preserved."
    }
    if ([bool]$Request.expected.macro_present -and -not [bool]$inspection.macro_present) {
      throw "Output verification failed: PPTM macro project was not preserved."
    }

    foreach ($item in $Request.expected.anchors) {
      Test-WorkerCancelled
      $slide = $null
      $shape = $null
      try {
        $slide = Resolve-PptSlide -Presentation $presentation -Anchor $item.anchor
        if ($item.anchor.kind -eq "pptx_shape") {
          $shape = Resolve-PptShape -Slide $slide -ShapeId ([string]$item.anchor.shape_id)
        }
        if (-not (Test-PptCommentOnSlide -Slide $slide -ExpectedText ([string]$item.comment) -ExpectedShape $shape)) {
          throw "Output verification failed: expected PowerPoint comment anchor was not found."
        }
      } finally {
        Release-ComObject $shape
        Release-ComObject $slide
      }
    }

    return [ordered]@{
      schema_version = "1.0"
      operation = "verify-output"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      verification = [ordered]@{
        expected_comment_count_floor = ([int]$Request.expected.existing_comment_count + [int]$Request.expected.anchors.Count)
        actual_comment_count = [int]$inspection.existing_comment_count
        slide_count_preserved = $true
        hidden_states_preserved = $true
        shape_count_preserved = $true
        slide_masters_preserved = $true
        notes_preserved = $true
        charts_preserved = $true
        existing_comments_preserved = $true
        macro_project_preserved = $true
        source_unchanged = $true
        expected_anchors_verified = $true
      }
    }
  } finally {
    Close-PowerPointPresentation -Presentation $presentation
    Clear-PowerPointRecentFile -PowerPoint $powerPoint -Path ([string]$Request.output_path)
    Stop-PowerPointApplication -PowerPoint $powerPoint
  }
}

function Assert-ExcelRequest {
  param([object]$Request)
  if ($Request.application -ne "excel") {
    throw "Invalid request."
  }
  if ($Request.document_type -ne "xlsx" -and $Request.document_type -ne "xlsm") {
    throw "Invalid request."
  }
}

function Get-SafeFilePart {
  param([string]$Value)
  $safe = $Value -replace '[^\p{L}\p{Nd}._ -]+', '_'
  if (-not $safe) { return "item" }
  return $safe
}

function Resolve-ExcelAnchorCell {
  param(
    [object]$Workbook,
    [object]$Anchor
  )

  if ($Anchor.kind -ne "xlsx_cell" -and $Anchor.kind -ne "xlsx_range") {
    throw "Could not find the selected Excel anchor in the workbook."
  }

  $sheet = $null
  try {
    $sheet = $Workbook.Worksheets.Item([string]$Anchor.sheet)
    if ($Anchor.kind -eq "xlsx_cell") {
      return $sheet.Range([string]$Anchor.cell)
    }
    $topLeft = (([string]$Anchor.range) -split ":")[0]
    return $sheet.Range($topLeft)
  } catch {
    throw "Could not find the selected Excel anchor in the workbook."
  } finally {
    Release-ComObject $sheet
  }
}

function Add-ExcelNote {
  param(
    [object]$Cell,
    [string]$Text,
    [bool]$AppendExisting = $true,
    [bool]$PreferThreaded = $false
  )

  $existing = $null
  if ($AppendExisting) {
    try {
      $existing = $Cell.Comment
      if ($null -ne $existing) {
        $oldText = [string]$existing.Text()
        $separator = if ($oldText.Trim()) { "`r`n`r`nHL Intelligence: " } else { "HL Intelligence: " }
        $existing.Text($oldText + $separator + $Text) | Out-Null
        return
      }
    } catch {
    } finally {
      Release-ComObject $existing
    }
  }

  if ($PreferThreaded) {
    try {
      $Cell.AddCommentThreaded($Text) | Out-Null
      return
    } catch {
    }
  }

  try {
    $Cell.AddComment($Text) | Out-Null
  } catch {
    try {
      $Cell.AddCommentThreaded($Text) | Out-Null
    } catch {
      throw
    }
  }
}

function Test-ExcelCommentAtCell {
  param(
    [object]$Cell,
    [string]$ExpectedText
  )
  $expected = Get-OneLineText $ExpectedText
  try {
    $comment = $Cell.Comment
    if ($null -ne $comment) {
      try {
        $text = Get-OneLineText $comment.Text()
        if ($text.Contains($expected)) {
          return $true
        }
      } finally {
        Release-ComObject $comment
      }
    }
  } catch {
  }
  try {
    $threaded = $Cell.CommentThreaded
    if ($null -ne $threaded) {
      try {
        $text = Get-OneLineText $threaded.Text()
        if ($text.Contains($expected)) {
          return $true
        }
      } finally {
        Release-ComObject $threaded
      }
    }
  } catch {
  }
  return $false
}

function Invoke-ExcelInspect {
  param([object]$Request)
  Assert-ExcelRequest $Request
  $excel = $null
  $workbook = $null
  try {
    $excel = Start-ExcelApplication
    $workbook = Open-ExcelWorkbook -Excel $excel -Path ([string]$Request.source_path) -ReadOnly $true
    $inspection = Get-ExcelInspection -Workbook $workbook -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    return [ordered]@{
      schema_version = "1.0"
      operation = "inspect"
      ok = $true
      document_type = [string]$Request.document_type
      inspection = $inspection
    }
  } finally {
    Close-ExcelWorkbook -Workbook $workbook
    Stop-ExcelApplication -Excel $excel
  }
}

function Invoke-ExcelExtract {
  param([object]$Request)
  Assert-ExcelRequest $Request
  $excel = $null
  $workbook = $null
  try {
    $excel = Start-ExcelApplication
    $workbook = Open-ExcelWorkbook -Excel $excel -Path ([string]$Request.source_path) -ReadOnly $true
    $inspection = Get-ExcelInspection -Workbook $workbook -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    $csvFolder = ""
    if ($Request.options.csv_sidecar_folder_path) {
      $csvFolder = [string]$Request.options.csv_sidecar_folder_path
    }
    $built = Build-ExcelMarkdown `
      -Workbook $workbook `
      -SourcePath ([string]$Request.source_path) `
      -SourceHash ([string]$Request.source_sha256) `
      -CreatedAt ([string]$Request.created_at) `
      -IncludeExistingComments ([bool]$Request.options.include_existing_comments) `
      -GenerateCsvSidecars ([bool]$Request.options.generate_csv_sidecars) `
      -CsvFolder $csvFolder `
      -Inspection $inspection
    return [ordered]@{
      schema_version = "1.0"
      operation = "extract"
      ok = $true
      document_type = [string]$Request.document_type
      markdown = $built.markdown
      anchors = $built.anchors
      visual_pages = Get-ExcelVisualCandidates -Workbook $workbook
      render_targets = Get-ExcelRenderTargets -Workbook $workbook
      csv_sidecars = $built.csv_sidecars
      warnings = @()
      inspection = $inspection
    }
  } finally {
    Close-ExcelWorkbook -Workbook $workbook
    Stop-ExcelApplication -Excel $excel
  }
}

function Invoke-ExcelRender {
  param([object]$Request)
  Assert-ExcelRequest $Request
  $excel = $null
  $workbook = $null
  $tempCopy = ""
  try {
    if (-not (Test-Path -LiteralPath ([string]$Request.output_folder_path))) {
      New-Item -ItemType Directory -Path ([string]$Request.output_folder_path) -Force | Out-Null
    }
    $extension = [System.IO.Path]::GetExtension([string]$Request.source_path)
    $tempCopy = Join-Path ([string]$Request.output_folder_path) ("excel-render-source" + $extension)
    Copy-Item -LiteralPath ([string]$Request.source_path) -Destination $tempCopy -Force

    $excel = Start-ExcelApplication
    $workbook = Open-ExcelWorkbook -Excel $excel -Path $tempCopy -ReadOnly $false
    $rendered = New-Object System.Collections.Generic.List[object]
    $targetIndex = 0
    foreach ($target in $Request.render_targets) {
      Test-WorkerCancelled
      $targetIndex += 1
      $sheet = $null
      try {
        $sheet = $workbook.Sheets.Item([string]$target.sheet)
        try { $sheet.Visible = -1 } catch {}
        $safeSheet = Get-SafeFilePart ([string]$target.sheet)
        $output = Join-Path ([string]$Request.output_folder_path) ("render_{0:D4}_{1}.pdf" -f $targetIndex, $safeSheet)
        if (Test-Path -LiteralPath $output) {
          Remove-Item -LiteralPath $output -Force
        }
        if ((Get-ExcelSheetKind $sheet) -eq "worksheet") {
          $printArea = ""
          if ($target.range) {
            $printArea = [string]$target.range
          } else {
            $used = Get-ExcelMeaningfulUsedRange -Worksheet $sheet
            if ($null -ne $used) {
              $printArea = [string]$used.address
              Release-ComObject $used.range
            }
          }
          if ($printArea) {
            $sheet.PageSetup.PrintArea = $printArea
          } else {
            $sheet.PageSetup.PrintArea = ""
          }
          try {
            $sheet.PageSetup.Zoom = $false
            $sheet.PageSetup.FitToPagesWide = 1
            $sheet.PageSetup.FitToPagesTall = $false
          } catch {
          }
        }
        $sheet.ExportAsFixedFormat(0, $output, 0, $true, $false)
        $entry = [ordered]@{
          sheet = [string]$target.sheet
          sheet_index = [int]$target.sheet_index
          reason = [string]$target.reason
          output_pdf_path = $output
        }
        if ($target.range) {
          $entry.range = [string]$target.range
        }
        $rendered.Add($entry) | Out-Null
      } finally {
        Release-ComObject $sheet
      }
    }
    return [ordered]@{
      schema_version = "1.0"
      operation = "render"
      ok = $true
      document_type = [string]$Request.document_type
      rendered_targets = $rendered
    }
  } finally {
    Close-ExcelWorkbook -Workbook $workbook
    Stop-ExcelApplication -Excel $excel
    if ($tempCopy -and (Test-Path -LiteralPath $tempCopy)) {
      Remove-Item -LiteralPath $tempCopy -Force
    }
  }
}

function Invoke-ExcelApplyComments {
  param([object]$Request)
  Assert-ExcelRequest $Request
  $excel = $null
  $sourceWorkbook = $null
  $outputWorkbook = $null
  try {
    if ($Request.comments.Count -lt 1) {
      throw "No valid comments are available to apply."
    }
    if (Test-Path -LiteralPath ([string]$Request.output_path)) {
      throw "HL Intelligence will not overwrite an existing output workbook."
    }

    $script:WorkerStage = "excel apply start"
    $excel = Start-ExcelApplication
    $script:WorkerStage = "excel apply open source"
    $sourceWorkbook = Open-ExcelWorkbook -Excel $excel -Path ([string]$Request.source_path) -ReadOnly $true
    $script:WorkerStage = "excel apply close source"
    Close-ExcelWorkbook -Workbook $sourceWorkbook
    $sourceWorkbook = $null

    $script:WorkerStage = "excel apply copy source"
    Copy-Item -LiteralPath ([string]$Request.source_path) -Destination ([string]$Request.output_path) -ErrorAction Stop
    $script:WorkerStage = "excel apply open output"
    $outputWorkbook = Open-ExcelWorkbook -Excel $excel -Path ([string]$Request.output_path) -ReadOnly $false
    $added = 0
    foreach ($item in $Request.comments) {
      Test-WorkerCancelled
      $cell = $null
      try {
        $script:WorkerStage = "excel apply comment $($item.id)"
        $cell = Resolve-ExcelAnchorCell -Workbook $outputWorkbook -Anchor $item.anchor
        Add-ExcelNote -Cell $cell -Text ([string]$item.comment) -AppendExisting ($item.anchor.kind -eq "xlsx_cell") -PreferThreaded ($item.anchor.kind -eq "xlsx_range")
        $added += 1
      } finally {
        Release-ComObject $cell
      }
    }
    $script:WorkerStage = "excel apply save output"
    Close-ExcelWorkbook -Workbook $outputWorkbook -Save $true
    $outputWorkbook = $null
    return [ordered]@{
      schema_version = "1.0"
      operation = "apply-comments"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      added_comment_count = $added
    }
  } finally {
    Close-ExcelWorkbook -Workbook $sourceWorkbook
    Close-ExcelWorkbook -Workbook $outputWorkbook
    Stop-ExcelApplication -Excel $excel
  }
}

function Invoke-ExcelVerifyOutput {
  param([object]$Request)
  Assert-ExcelRequest $Request
  $excel = $null
  $workbook = $null
  try {
    $excel = Start-ExcelApplication
    $workbook = Open-ExcelWorkbook -Excel $excel -Path ([string]$Request.output_path) -ReadOnly $true
    $inspection = Get-ExcelInspection -Workbook $workbook -Path ([string]$Request.output_path) -DocumentType ([string]$Request.document_type)

    if ([int]$inspection.sheet_count -ne [int]$Request.expected.sheet_count) {
      throw "Output verification failed: sheet count changed."
    }
    if ([int]$inspection.formula_cell_count -ne [int]$Request.expected.formula_cell_count) {
      throw "Output verification failed: formula cell count changed."
    }
    if ([int]$inspection.named_range_count -ne [int]$Request.expected.named_range_count) {
      throw "Output verification failed: named range count changed."
    }
    if ([int]$inspection.chart_count -ne [int]$Request.expected.chart_count) {
      throw "Output verification failed: chart count changed."
    }
    if ([int]$inspection.existing_comment_count -lt [int]$Request.expected.existing_comment_count) {
      throw "Output verification failed: existing comments or notes were not preserved."
    }
    if ([string]$inspection.hidden_state_signature -ne [string]$Request.expected.hidden_state_signature) {
      throw "Output verification failed: hidden sheet states changed."
    }
    if ([string]$inspection.named_range_signature -ne [string]$Request.expected.named_range_signature) {
      throw "Output verification failed: named range definitions changed."
    }
    if ([string]$inspection.number_format_signature -ne [string]$Request.expected.number_format_signature) {
      throw "Output verification failed: number formats changed."
    }
    if ([string]$inspection.external_link_signature -ne [string]$Request.expected.external_link_signature) {
      throw "Output verification failed: external link definitions changed."
    }
    if ([bool]$Request.expected.macro_present -and -not [bool]$inspection.macro_present) {
      throw "Output verification failed: XLSM macro project was not preserved."
    }

    foreach ($item in $Request.expected.anchors) {
      Test-WorkerCancelled
      $cell = $null
      try {
        $cell = Resolve-ExcelAnchorCell -Workbook $workbook -Anchor $item.anchor
        if ($item.expected_number_format) {
          $actualFormat = Get-OneLineText $cell.NumberFormat
          if ($actualFormat -ne (Get-OneLineText $item.expected_number_format)) {
            throw "Output verification failed: number format changed at the expected comment cell."
          }
        }
        if (-not (Test-ExcelCommentAtCell -Cell $cell -ExpectedText ([string]$item.comment))) {
          throw "Output verification failed: expected Excel comment or note anchor was not found."
        }
      } finally {
        Release-ComObject $cell
      }
    }

    return [ordered]@{
      schema_version = "1.0"
      operation = "verify-output"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      verification = [ordered]@{
        expected_comment_count_floor = [int]$Request.expected.existing_comment_count
        actual_comment_count = [int]$inspection.existing_comment_count
        sheet_count_preserved = $true
        formula_count_preserved = $true
        named_ranges_preserved = $true
        chart_count_preserved = $true
        existing_comments_preserved = $true
        hidden_states_preserved = $true
        number_formats_preserved = $true
        external_links_preserved = $true
        macro_project_preserved = $true
        expected_anchors_verified = $true
      }
    }
  } finally {
    Close-ExcelWorkbook -Workbook $workbook
    Stop-ExcelApplication -Excel $excel
  }
}

function Assert-WordRequest {
  param([object]$Request)
  if ($Request.application -ne "word") {
    throw "Invalid request."
  }
  if ($Request.document_type -ne "docx" -and $Request.document_type -ne "docm") {
    throw "Invalid request."
  }
}

function Invoke-Probe {
  return [ordered]@{
    schema_version = "1.0"
    operation = "probe"
    ok = $true
    applications = [ordered]@{
      word = Test-OfficeApplication -ProgId "Word.Application" -Kind "word"
      excel = Test-OfficeApplication -ProgId "Excel.Application" -Kind "excel"
      powerpoint = Test-OfficeApplication -ProgId "PowerPoint.Application" -Kind "powerpoint"
    }
    worker = [ordered]@{
      platform = [System.Environment]::OSVersion.Platform.ToString()
      powerShell = $PSVersionTable.PSVersion.ToString()
    }
  }
}

function Invoke-WordInspect {
  param([object]$Request)
  Assert-WordRequest $Request
  $word = $null
  $doc = $null
  try {
    $word = Start-WordApplication
    $doc = Open-WordDocument -Word $word -Path ([string]$Request.source_path) -ReadOnly $true
    $inspection = Get-WordInspection -Document $doc -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    return [ordered]@{
      schema_version = "1.0"
      operation = "inspect"
      ok = $true
      document_type = [string]$Request.document_type
      inspection = $inspection
    }
  } finally {
    Close-WordDocument -Document $doc
    Stop-WordApplication -Word $word
  }
}

function Invoke-WordExtract {
  param([object]$Request)
  Assert-WordRequest $Request
  $word = $null
  $doc = $null
  try {
    $word = Start-WordApplication
    $doc = Open-WordDocument -Word $word -Path ([string]$Request.source_path) -ReadOnly $true
    $inspection = Get-WordInspection -Document $doc -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    $built = Build-WordMarkdown `
      -Document $doc `
      -SourcePath ([string]$Request.source_path) `
      -SourceHash ([string]$Request.source_sha256) `
      -CreatedAt ([string]$Request.created_at) `
      -IncludeHeadersFooters ([bool]$Request.options.include_headers_footers) `
      -IncludeExistingComments ([bool]$Request.options.include_existing_comments) `
      -IncludeTrackChanges ([bool]$Request.options.include_track_changes) `
      -Inspection $inspection
    $visualPages = Get-VisualPageCandidates -Document $doc -PageCount $inspection.page_count
    return [ordered]@{
      schema_version = "1.0"
      operation = "extract"
      ok = $true
      document_type = [string]$Request.document_type
      markdown = $built.markdown
      anchors = $built.anchors
      visual_pages = $visualPages
      warnings = @()
      inspection = $inspection
    }
  } finally {
    Close-WordDocument -Document $doc
    Stop-WordApplication -Word $word
  }
}

function Invoke-WordRender {
  param([object]$Request)
  Assert-WordRequest $Request
  $word = $null
  $doc = $null
  try {
    $word = Start-WordApplication
    $doc = Open-WordDocument -Word $word -Path ([string]$Request.source_path) -ReadOnly $true
    $inspection = Get-WordInspection -Document $doc -Path ([string]$Request.source_path) -DocumentType ([string]$Request.document_type)
    $output = [string]$Request.output_pdf_path
    if (Test-Path -LiteralPath $output) {
      Remove-Item -LiteralPath $output -Force
    }
    $outputFormat = 17
    $openAfterExport = $false
    $optimizeFor = 0
    $range = 0
    $from = 1
    $to = 1
    $item = 0
    $includeDocProps = $true
    $keepIrm = $true
    $createBookmarks = 0
    $docStructureTags = $true
    $bitmapMissingFonts = $true
    $useIso19005 = $false
    $doc.ExportAsFixedFormat(
      $output,
      $outputFormat,
      $openAfterExport,
      $optimizeFor,
      $range,
      $from,
      $to,
      $item,
      $includeDocProps,
      $keepIrm,
      $createBookmarks,
      $docStructureTags,
      $bitmapMissingFonts,
      $useIso19005
    )
    return [ordered]@{
      schema_version = "1.0"
      operation = "render"
      ok = $true
      document_type = [string]$Request.document_type
      output_pdf_path = $output
      page_count = $inspection.page_count
    }
  } finally {
    Close-WordDocument -Document $doc
    Stop-WordApplication -Word $word
  }
}

function Invoke-WordApplyComments {
  param([object]$Request)
  Assert-WordRequest $Request
  $word = $null
  $sourceDoc = $null
  $outputDoc = $null
  try {
    if ($Request.comments.Count -lt 1) {
      throw "No valid comments are available to apply."
    }
    if (Test-Path -LiteralPath ([string]$Request.output_path)) {
      throw "HL Intelligence will not overwrite an existing output document."
    }

    $word = Start-WordApplication
    $sourceDoc = Open-WordDocument -Word $word -Path ([string]$Request.source_path) -ReadOnly $true
    Close-WordDocument -Document $sourceDoc
    $sourceDoc = $null

    Copy-Item -LiteralPath ([string]$Request.source_path) -Destination ([string]$Request.output_path) -ErrorAction Stop
    $outputDoc = Open-WordDocument -Word $word -Path ([string]$Request.output_path) -ReadOnly $false
    $added = 0
    foreach ($item in $Request.comments) {
      $range = $null
      try {
        $range = Resolve-WordAnchorRange -Document $outputDoc -Anchor $item.anchor
        $outputDoc.Comments.Add($range, [string]$item.comment) | Out-Null
        $added += 1
      } finally {
        Release-ComObject $range
      }
    }
    Close-WordDocument -Document $outputDoc -Save $true
    $outputDoc = $null
    return [ordered]@{
      schema_version = "1.0"
      operation = "apply-comments"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      added_comment_count = $added
    }
  } finally {
    Close-WordDocument -Document $sourceDoc
    Close-WordDocument -Document $outputDoc
    Stop-WordApplication -Word $word
  }
}

function Invoke-WordVerifyOutput {
  param([object]$Request)
  Assert-WordRequest $Request
  $word = $null
  $doc = $null
  try {
    $word = Start-WordApplication
    $doc = Open-WordDocument -Word $word -Path ([string]$Request.output_path) -ReadOnly $true
    $inspection = Get-WordInspection -Document $doc -Path ([string]$Request.output_path) -DocumentType ([string]$Request.document_type)
    $expectedCommentCount = [int]$Request.expected.existing_comment_count + [int]$Request.expected.comments_added
    $actualCommentCount = [int]$inspection.existing_comment_count
    if ($actualCommentCount -lt $expectedCommentCount) {
      throw "Output verification failed: expected Word comments were not preserved."
    }
    if ([int]$inspection.section_count -ne [int]$Request.expected.section_count) {
      throw "Output verification failed: section count changed."
    }
    if ([int]$inspection.table_count -ne [int]$Request.expected.table_count) {
      throw "Output verification failed: table count changed."
    }
    if ([bool]$inspection.track_revisions_enabled -ne [bool]$Request.expected.track_revisions_enabled) {
      throw "Output verification failed: track changes state changed."
    }
    if ([int]$inspection.revision_count -ne [int]$Request.expected.revision_count) {
      throw "Output verification failed: tracked changes changed."
    }
    if ([bool]$Request.expected.macro_present -and -not [bool]$inspection.macro_present) {
      throw "Output verification failed: DOCM macro project was not preserved."
    }

    foreach ($item in $Request.expected.anchors) {
      $range = $null
      try {
        $range = Resolve-WordAnchorRange -Document $doc -Anchor $item.anchor
        if (-not (Test-CommentAtRange -Range $range -ExpectedText ([string]$item.comment))) {
          throw "Output verification failed: expected comment anchor was not found."
        }
      } finally {
        Release-ComObject $range
      }
    }

    return [ordered]@{
      schema_version = "1.0"
      operation = "verify-output"
      ok = $true
      document_type = [string]$Request.document_type
      output_path = [string]$Request.output_path
      verification = [ordered]@{
        expected_comment_count = $expectedCommentCount
        actual_comment_count = $actualCommentCount
        section_count_preserved = $true
        table_count_preserved = $true
        existing_comments_preserved = $true
        track_changes_preserved = $true
        macro_project_preserved = $true
        expected_anchors_verified = $true
      }
    }
  } finally {
    Close-WordDocument -Document $doc
    Stop-WordApplication -Word $word
  }
}

$request = $null
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.cancel_path) {
    $script:CancelPath = [string]$request.cancel_path
  }
  if ($request.schema_version -ne "1.0") {
    Write-JsonResponse (New-Failure -Operation "unknown" -Code "invalid_request" -Message "Unsupported Office worker request schema version.")
    exit 0
  }

  switch ([string]$request.operation) {
    "probe" { Write-JsonResponse (Invoke-Probe) }
    "inspect" {
      if ($request.application -eq "excel") { Write-JsonResponse (Invoke-ExcelInspect -Request $request) }
      elseif ($request.application -eq "powerpoint") { Write-JsonResponse (Invoke-PowerPointInspect -Request $request) }
      else { Write-JsonResponse (Invoke-WordInspect -Request $request) }
    }
    "extract" {
      if ($request.application -eq "excel") { Write-JsonResponse (Invoke-ExcelExtract -Request $request) }
      elseif ($request.application -eq "powerpoint") { Write-JsonResponse (Invoke-PowerPointExtract -Request $request) }
      else { Write-JsonResponse (Invoke-WordExtract -Request $request) }
    }
    "render" {
      if ($request.application -eq "excel") { Write-JsonResponse (Invoke-ExcelRender -Request $request) }
      elseif ($request.application -eq "powerpoint") { Write-JsonResponse (Invoke-PowerPointRender -Request $request) }
      else { Write-JsonResponse (Invoke-WordRender -Request $request) }
    }
    "apply-comments" {
      if ($request.application -eq "excel") { Write-JsonResponse (Invoke-ExcelApplyComments -Request $request) }
      elseif ($request.application -eq "powerpoint") { Write-JsonResponse (Invoke-PowerPointApplyComments -Request $request) }
      else { Write-JsonResponse (Invoke-WordApplyComments -Request $request) }
    }
    "verify-output" {
      if ($request.application -eq "excel") { Write-JsonResponse (Invoke-ExcelVerifyOutput -Request $request) }
      elseif ($request.application -eq "powerpoint") { Write-JsonResponse (Invoke-PowerPointVerifyOutput -Request $request) }
      else { Write-JsonResponse (Invoke-WordVerifyOutput -Request $request) }
    }
    default { Write-JsonResponse (New-Failure -Operation ([string]$request.operation) -Code "invalid_request" -Message "Unsupported Office worker operation.") }
  }
} catch {
  $operation = "unknown"
  $documentType = ""
  if ($null -ne $request) {
    if ($request.operation) { $operation = [string]$request.operation }
    if ($request.document_type) { $documentType = [string]$request.document_type }
  }
  Write-JsonResponse (Convert-ErrorToFailure -Operation $operation -ErrorRecord $_ -DocumentType $documentType)
}
