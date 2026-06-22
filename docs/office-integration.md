# Office Integration

HL Intelligence supports Word, Excel, and PowerPoint through local Microsoft Office desktop automation. It does not bundle Office, LibreOffice, Python, or any remote conversion service.

## Worker Boundary

- Worker script: `resources/office/office-worker.ps1`.
- Client: `src/engine/office/officeWorkerClient.ts`.
- Adapters: `src/engine/wordDocumentAdapter.ts`, `src/engine/excelDocumentAdapter.ts`, and `src/engine/powerPointDocumentAdapter.ts`.
- Communication uses versioned JSON request and response files only.
- The command line contains only worker, request, and response file paths. Document content is never interpolated into PowerShell.
- Requests are schema version `1.0`.

## Enabled Operations

Word, Excel, and PowerPoint support:

- `probe`
- `inspect`
- `extract`
- `render`
- `apply-comments`
- `verify-output`

The probe checks Word, Excel, and PowerPoint availability through local COM automation.

## Word Safety Controls

- Word is launched invisible.
- `AutomationSecurity` is forced to disabled before opening documents.
- Display alerts and prompts are disabled.
- Link updates are disabled through Word options.
- Add to Recent Files is disabled on document open.
- Source documents are opened read-only.
- Output creation copies the source first and never overwrites the source.
- COM objects are explicitly released.
- Documents are closed and Word is quit in finally blocks.
- Node-side worker calls have operation timeouts and cancellation support.
- Errors are mapped to concise user messages by default.

## Excel Safety Controls

- Excel is launched invisible.
- `AutomationSecurity` is forced to disabled before opening workbooks.
- `DisplayAlerts`, `AskToUpdateLinks`, events, and screen updating are disabled.
- Workbooks are opened with `UpdateLinks=0`, no Add to Recent Files, and read-only source access.
- No macros are executed, no connections are refreshed, and no external links are updated.
- Output creation copies the source first and never overwrites the source.
- Visual rendering is done from a temporary workbook copy so source print settings are never changed.
- Workbooks are explicitly closed, COM objects are released, and Excel is quit in finally blocks.
- Node-side worker calls have operation timeouts and cancellation support. Cancellation writes a worker cancel marker and gives the worker a cleanup window before a hard kill.
- Errors are mapped to concise user messages by default.

## PowerPoint Safety Controls

- PowerPoint presentation windows are opened hidden with `WithWindow=0`.
- `AutomationSecurity` is forced to disabled before opening presentations.
- `DisplayAlerts` is set to suppress prompts.
- Read-only inspect/extract/render operations open a temporary copy so the source path is not opened directly.
- Output creation copies the source first and never overwrites the source.
- Macros are never executed, and PPTM content is preserved by copying the original package before comments are added.
- Presentations are explicitly closed, COM objects are released, and PowerPoint is quit in finally blocks.
- Node-side worker calls have operation timeouts and cancellation support. Cancellation writes a worker cancel marker and gives the worker a cleanup window before a hard kill.
- Errors are mapped to concise user messages by default.

## Inspection

Inspection reports:

- Page, section, paragraph, and table counts.
- Existing comment count.
- Track-changes state and revision count.
- Image, shape, chart, and text-box presence/counts.
- Footnote and endnote counts.
- Signature presence.
- Real macro-project presence when `word/vbaProject.bin` exists.
- Password and corruption failures when Word reports them during open.

Excel inspection reports:

- Sheet, worksheet, and chart-sheet counts.
- Visible, hidden, and very-hidden sheet counts.
- Meaningful used ranges after conservatively trimming blank styled regions.
- Table, named-range, chart, shape, image, comment/note, formula-cell, conditional-format, merged-range, hidden-row, and hidden-column counts.
- External-link presence/counts.
- Macro-project presence when `xl/vbaProject.bin` exists.
- Password and corruption failures before prompting Excel to open unsupported containers.

PowerPoint inspection reports:

- Slide count, hidden-slide count, and slide-master/design count.
- Shape, chart, table, image, speaker-note, and existing comment counts.
- Macro-project presence when `ppt/vbaProject.bin` exists.
- Signature presence.
- Password and corruption failures before prompting PowerPoint to open unsupported containers.
- Hidden-slide state and speaker-note signatures used for output verification.

## Extraction

Word extraction produces readable Markdown and a source map with stable anchors:

- `docx_paragraph`
- `docx_table_cell`

The extraction preserves document order for paragraphs and tables, heading hierarchy, list labels, table-cell text, headers and footers, footnotes, endnotes, hyperlinks, existing comments when selected, track-change metadata when selected, page references, paragraph IDs, and table-cell IDs.

Excel extraction produces readable Markdown and a source map with stable anchors:

- `xlsx_cell`
- `xlsx_range`

The extraction preserves sheet order, sheet names, visibility, meaningful used ranges, displayed values, formula expressions, number formats, dates, percentages, currencies, Excel tables, named ranges, merged cells, existing comments when selected, and stable cell/range references. Large ranges are summarized to avoid excessive Markdown, with repeated formula pattern summaries and optional protected CSV sidecars when `HL_EXCEL_CSV_SIDECARS=1`.

PowerPoint extraction produces one readable Markdown section per slide and a source map with stable anchors:

- `pptx_shape`
- `pptx_slide`

The extraction preserves slide number, slide ID, hidden status, title, shape names, shape IDs, bounding boxes, shape text, table contents, speaker notes when selected, chart titles and accessible series/category labels where PowerPoint exposes them, hyperlinks, and existing comments when selected. Shape anchors include slide IDs for stable output verification.

## Visual Supplements

`text-only` writes Markdown only and warns that visual layout and images are excluded.

`text-visual` exports a temporary PDF through Word and includes pages with charts, images, shapes, text boxes, complex tables, multiple columns, or low-confidence layout signals.

`text-all-pages` exports every original Word page into the visual supplement.

The source document is not modified to create the supplement.

For Excel, `text-visual` exports chart sheets and sheets containing charts, images/shapes, dashboards, merged-cell layout, or conditional formatting through a temporary workbook copy. `text-all-pages` exports all meaningful used ranges or chart sheets and ignores stale print areas only in the temporary copy. Supplement index pages map each rendered page range to the source sheet and A1 range.

For PowerPoint, `text-only` writes Markdown only and warns that layout, charts, diagrams, images, and visual meaning are excluded. `text-visual` exports a local PowerPoint-rendered PDF and includes slides containing charts, images, diagrams, SmartArt, grouped shapes, complex tables, material positioning, sparse text with substantial graphics, or low-confidence extraction. `text-all-pages` exports every slide. Supplement index pages map each rendered supplement page to the original slide number.

## Native Comments

Approved findings are applied only after the source hash matches the review job. The worker copies the source to a new output path, opens that copy, anchors comments to the selected Word ranges, saves the copy, and then reopens it for verification.

Verification checks reopen success, expected comment count, expected comment anchors, section count, table count, existing comments, track changes, real macro-project preservation when present, and source hash immutability.

For Excel, approved findings are applied only after the source hash matches the review job. The worker copies the source to a new output path, opens that copy without updating links, adds notes to exact cell anchors, adds range comments to the top-left cell, saves the copy, and reopens it for verification.

Excel verification checks reopen success, expected comments/notes, sheet count, formula count, named ranges, chart count, hidden sheet states, existing comments/notes floor, number formats, external-link definitions, XLSM macro-project preservation when present, and source hash immutability.

For PowerPoint, approved findings are applied only after the source hash matches the review job. The worker copies the source to a new output path, opens that copy with hidden windows, adds native comments on the expected slide, places shape comments near the anchored shape where supported, saves the copy, and reopens it for verification.

PowerPoint comments use `Slide.Comments.Add2` when available. Runtime fallback uses the legacy `Slide.Comments.Add` API only if `Add2` fails. PowerPoint verification checks reopen success, expected comments and slide locations, slide count, hidden-slide states, shape count, slide-master count, speaker notes, chart count, existing comments floor, PPTM macro-project preservation when present, and source hash immutability.

## Verification Status

Verified on June 22, 2026 with native Microsoft Word `16.0`:

- DOCX inspect -> review package -> validate synthetic `hl_comments.json` -> apply comments -> reopen -> inspect.
- DOCM inspect -> review package -> validate synthetic `hl_comments.json` -> apply comments -> reopen -> inspect.
- Original and commented files exported to PDF through Word with page-count comparison.

Remaining verification gaps:

- A real encrypted DOCX fixture was not generated because local Word `SaveAs2` hangs in this environment.
- A real inert VBA project fixture was not generated because this local Word build exposed `VBProject` as null for the generated DOCM. The preservation check is implemented for documents that contain `word/vbaProject.bin`.

Verified on June 22, 2026 with native Microsoft Excel `16.0`:

- XLSX inspect -> review package -> validate synthetic `hl_comments.json` -> apply comments/notes -> reopen -> property-level verification.
- XLSM inspect -> review package -> validate synthetic `hl_comments.json` -> apply comments/notes -> reopen -> property-level verification.
- Visual supplement export for charts, images/shapes, merged-cell layout, conditional formatting, and chart sheets.
- Password-protected, corrupt, and Unicode-filename fixtures.
- Stress test: 50 sheets, 100,000 populated cells, mixed formulas, chart, hidden sheet, very-hidden sheet, and named range.

Remaining Excel verification gaps:

- Real XLSM VBA fixture creation depends on local Trust Center access to the VBA project object model. Macro-project preservation is implemented and verified when a real `xl/vbaProject.bin` exists.

Verified on June 22, 2026 with native Microsoft PowerPoint `16.0` build `20026`:

- PPTX inspect -> review package -> validate synthetic `hl_comments.json` -> apply native comments -> reopen -> property-level verification.
- PPTM inspect -> review package -> validate synthetic `hl_comments.json` -> apply native comments -> reopen -> property-level verification.
- Native comments used `Slide.Comments.Add2` in this Office build.
- Visual supplement export for charts, images, grouped shapes, diagram-like content, embedded objects, hidden slides, and speaker notes.
- Password-protected, corrupt, and Unicode-filename fixtures.
- Stress test: 200 slides with mixed charts, images, tables, and speaker notes, plus cancellation, repeated runs, and process cleanup.

Remaining PowerPoint verification gaps:

- Real PPTM VBA fixture creation depends on local Trust Center access to the VBA project object model. Macro-project preservation is implemented and verified when a real `ppt/vbaProject.bin` exists.
- This Office build required PowerPoint `SaveAs` PDF export instead of the full `ExportAsFixedFormat` COM signature; output is still rendered locally by PowerPoint.
