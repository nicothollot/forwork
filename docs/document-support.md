# Document Support

Only formats with passing extraction and output tests are marked verified. A format is marked verified only after this native round trip succeeds:

```text
Inspect -> Preflight -> Review package -> JSON validation -> Native comments -> Save -> Reopen -> Property inspection
```

| Format | Type contract | Preflight text extraction | Visual supplement | Stable anchors | Native comment output | Test status |
| --- | --- | --- | --- | --- | --- | --- |
| PDF | Verified | Verified with paragraph reconstruction, reading-order handling, and warnings | Verified for selected, uncertain, forced, or all pages with multi-page indexes | Verified `pdf_page` and paragraph-level `pdf_block` | Verified native text annotations and native evidence highlights | Passing synthetic round-trip tests |
| DOCX | Verified | Verified through local Microsoft Word extraction | Verified through temporary Word PDF export for selected or all pages | Verified `docx_paragraph` and `docx_table_cell` | Verified native Word comments in new output copies | Passing native Word synthetic round-trip tests |
| DOCM | Verified | Verified through local Microsoft Word extraction with macros disabled | Verified through temporary Word PDF export for selected or all pages | Verified `docx_paragraph` and `docx_table_cell` | Verified native Word comments in new DOCM output copies; real `vbaProject.bin` preservation is implemented when present | Passing native Word synthetic round-trip tests for DOCM packages without a VBA project |
| XLSX | Verified | Verified through local Microsoft Excel extraction | Verified through temporary Excel PDF export for selected visual sheets/ranges | Verified `xlsx_cell` and `xlsx_range` | Verified native Excel notes/threaded comments in new output copies | Passing native Excel round-trip and stress tests |
| XLSM | Verified | Verified through local Microsoft Excel extraction with macros disabled | Verified through temporary Excel PDF export for selected visual sheets/ranges | Verified `xlsx_cell` and `xlsx_range` | Verified native Excel notes/threaded comments in new XLSM output copies with VBA project preservation when present | Passing native Excel round-trip tests; VBA fixture creation depends on local Trust Center access |
| PPTX | Verified | Verified through local Microsoft PowerPoint extraction | Verified through native PowerPoint PDF export for selected visual slides or all slides | Verified `pptx_shape` and `pptx_slide` with slide IDs | Verified native PowerPoint comments in new output copies | Passing native PowerPoint round-trip and stress tests |
| PPTM | Verified | Verified through local Microsoft PowerPoint extraction with macros disabled | Verified through native PowerPoint PDF export for selected visual slides or all slides | Verified `pptx_shape` and `pptx_slide` with slide IDs | Verified native PowerPoint comments in new PPTM output copies; real `vbaProject.bin` preservation is implemented when present | Passing native PowerPoint round-trip tests for PPTM packages without a VBA project |
| DOC, XLS, PPT | Legacy conversion required | Not enabled | Not enabled | Not enabled | Not enabled | Clear conversion message only; not fully supported |

## Current Verified PDF Behavior

- PDF is a registered document adapter.
- Commenter and LLM Preflight both route PDF inspection, extraction, review-package creation, result validation, comment output, and output verification through the shared adapter registry.
- Extraction now reconstructs paragraph-level blocks instead of exposing one anchor per visual line.
- Multi-column pages are ordered by detected reading columns, while full-width headings remain in document order.
- Repeated headers and footers are omitted only when they repeat across enough pages for high confidence.
- Conservative line-break hyphenation repair, ligature normalization, Unicode normalization, and evidence normalization are applied without using nearest-text fallback.
- Visual page detection considers raster imagery, vector drawing operations, chart-like geometry, text coverage, dense positioning, tables, diagrams, rotated content, scanned pages, and large non-text regions.
- Uncertain visual pages are included in the visual supplement for `text-visual` mode.
- Visual supplements preserve copied source pages as PDF pages, include complete source-page mappings across multiple index pages, and do not crop source content to add labels.
- Comment output uses native highlight annotations and native text annotations. It does not draw permanent yellow rectangles into page content.
- Existing annotations are preserved, source files are never overwritten, and signature-like PDFs are blocked before annotation.
- Output verification checks reopening, source immutability, page count, page boxes, rotation, text geometry, existing annotations, expected added annotations, bookmarks where PDF.js exposes them, and form fields where supported.

## Remaining PDF Limitations

- OCR is not implemented. Scanned pages are detected and included visually, but text extraction remains empty unless the PDF already contains text.
- Table extraction is compact and source-linked, but it does not attempt full semantic table reconstruction.
- Header and footer removal is intentionally conservative and may retain repeated material when confidence is not high.
- Bookmark and form verification is limited to what the current PDF libraries expose reliably.
- Digitally signed or signature-like PDFs are not modified by this build.

## Current Verified Word Behavior

- DOCX and DOCM are registered document adapters.
- Word processing uses local Microsoft Word desktop automation through `resources/office/office-worker.ps1`.
- Worker communication uses request and response JSON files. Source text is never interpolated into a PowerShell command.
- Word is launched invisible with prompts suppressed, macro automation security forced disabled, no link updates, no Add to Recent Files, read-only source opening, explicit COM cleanup, and `Quit` in finally blocks.
- Inspection returns page, section, paragraph, table, existing comment, track-change, image, shape, chart, text-box, footnote, endnote, signature, macro-project, password, and corruption properties when Word can read the file normally.
- Extraction emits source-linked Markdown with heading, paragraph, list, table-cell, header/footer, footnote, endnote, hyperlink, existing comment, track-change, page, paragraph-anchor, and table-cell-anchor data.
- Visual supplements are rendered by exporting a temporary PDF through Word without modifying the source. `text-only` emits Markdown only and warns that visual layout is excluded; `text-visual` includes visually dependent or low-confidence pages; `text-all-pages` includes every page.
- Native comments are applied to a copied output document only. The source hash is verified first, existing comments are preserved, section/table counts and track changes are verified after reopen, and the source hash is checked again.

## Remaining Word Limitations

- Native Word must be installed and locally automatable. If Word is unavailable, Word formats return a clear local-automation error.
- Real password-protected Word fixture generation was not completed in this environment because local Word `SaveAs2` hangs. Runtime password/corruption errors are still mapped to concise user messages.
- DOCM macro execution is disabled. Preservation is checked when a real `word/vbaProject.bin` exists, but the native synthetic DOCM fixture used here does not contain a real VBA project because this local Word build exposed `VBProject` as null for generated DOCM packages.
- Visual page selection is conservative and may include pages with chart, image, shape, text-box, complex table, column, or low-confidence layout signals.

## Current Verified Excel Behavior

- XLSX and XLSM are registered document adapters.
- Excel processing uses local Microsoft Excel desktop automation through `resources/office/office-worker.ps1`.
- Excel is launched invisible with `DisplayAlerts` disabled, macro automation security forced disabled, `AskToUpdateLinks` disabled, events/screen updating disabled, no Add to Recent Files, no refresh calls, explicit workbook close, COM release, and Excel `Quit` in finally blocks.
- Inspection returns sheet count, visible/hidden/very-hidden sheet counts, meaningful used ranges, table count, named-range count, chart count, shape/image counts, existing comment/note counts, external-link presence, formula-cell count, macro-project presence, hidden row/column counts, conditional-format count, and password/corruption failures.
- Extraction emits workbook overview and sheet sections with sheet order, names, visibility, meaningful used ranges, displayed values, formulas, number formats, dates/percentages/currencies as displayed by Excel, tables, named ranges, merged ranges, existing comments when selected, and stable `xlsx_cell`/`xlsx_range` anchors.
- Large sheets are summarized to avoid huge Markdown output. Repeated formula patterns are summarized, and CSV sidecars are available when `HL_EXCEL_CSV_SIDECARS=1`; CSV cells that could be interpreted as formulas are prefixed.
- Visual supplements are rendered from a temporary workbook copy. `text-only` emits Markdown only; `text-visual` includes chart sheets and sheets with charts, images/shapes, merged layouts, or conditional formatting; `text-all-pages` uses all meaningful used ranges/chart sheets. Source workbook print settings are never changed.
- Native output copies receive Excel notes for cell anchors. Range anchors use the top-left cell and include the range in the deterministic comment; table-header range comments prefer threaded comments to avoid Excel COM note crashes on header cells.
- Output verification reopens the workbook through Excel and checks expected comments/notes, sheet count, formula count, named ranges, chart count, hidden sheet states, existing comments/notes floor, number-format signature plus exact commented-cell formats, external-link definitions, XLSM macro-project presence when present, and source hash immutability.

## Remaining Excel Limitations

- Native Microsoft Excel must be installed and locally automatable. If Excel is unavailable, Excel formats return a clear local-automation error.
- XLSM macro execution is disabled. Preservation is verified when `xl/vbaProject.bin` exists; creating a real inert VBA project in tests depends on local Trust Center access to the VBA object model.
- Password-protected XLSX/XLSM files are detected before COM open by container header and are rejected; HL Intelligence does not bypass workbook passwords.
- Large workbook extraction prioritizes meaningful used ranges and summaries. For very large sheets, merge counts and full number-format signatures are conservative, while exact number formats are still verified at commented anchors.
- External links are preserved but never refreshed.

## Current Verified PowerPoint Behavior

- PPTX and PPTM are registered document adapters.
- PowerPoint processing uses local Microsoft PowerPoint desktop automation through `resources/office/office-worker.ps1`.
- Presentations are opened with hidden windows, alerts suppressed, macro automation security forced disabled, temporary copies for read-only inspect/extract/render paths, explicit presentation close, COM release, and PowerPoint `Quit` in finally blocks.
- Inspection returns slide count, hidden-slide count, slide-master/design count, shape count, chart count, table count, image count, speaker-note count, existing comment count, macro-project presence, signature presence, password/corruption failures, hidden-state signature, and notes signature.
- Extraction emits one Markdown section per slide with slide number, slide ID, hidden state, title, shape text, table contents, speaker notes, chart titles and accessible series/category labels where PowerPoint exposes them, hyperlinks, shape names, bounding boxes, and stable `pptx_shape`/`pptx_slide` anchors.
- Visual supplements are rendered through PowerPoint PDF export. `text-only` emits Markdown only and warns that layout, charts, diagrams, images, and visual meaning are excluded; `text-visual` includes charts, images, diagrams/SmartArt, grouped shapes, complex tables, material positioning, sparse graphical slides, and low-confidence slides; `text-all-pages` includes every slide.
- Native output copies receive PowerPoint comments through `Slide.Comments.Add2` when available and fall back to `Slide.Comments.Add` only when necessary. Comments are placed on the correct slide and positioned near the anchored shape where PowerPoint exposes shape coordinates.
- Output verification reopens the presentation through PowerPoint and checks expected comments, slide count, hidden-slide states, shape count, slide-master count, notes signature, chart count, existing comments floor, PPTM macro-project preservation when present, and source hash immutability.

## Remaining PowerPoint Limitations

- Native Microsoft PowerPoint must be installed and locally automatable. If PowerPoint is unavailable, PPTX/PPTM formats return a clear local-automation error.
- This local Office installation did not allow deterministic creation of a real PowerPoint VBA project through `VBProject`, so the native PPTM test fixture did not contain `ppt/vbaProject.bin`. Preservation is implemented and verified when a real macro project is present.
- PowerPoint chart extraction is limited to chart titles and series/category labels exposed through the PowerPoint object model. The visual supplement is the source for chart formatting and visual meaning.
- PowerPoint PDF export uses the local `SaveAs` PDF path on this Office build because the full `ExportAsFixedFormat` COM call fails here; the export remains local PowerPoint rendering.

## Office Boundary

- Word formats are supported through local Microsoft Word only.
- Excel formats are supported through local Microsoft Excel only.
- PowerPoint formats are supported through local Microsoft PowerPoint only.
- Legacy Office formats are detected as requiring conversion to modern Office formats before processing.
- Macros are never executed.
- Unsupported Office files may be selected but are reported as not verified. HL Intelligence does not silently claim support.
