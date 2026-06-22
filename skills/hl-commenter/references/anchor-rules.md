# Anchor Rules

Use the most specific stable anchor available.

## PDF

- Use `pdf_block` when the finding is tied to extractable text.
- Copy the exact `block_id` from the Markdown marker without the `HL:` prefix.
- Use `pdf_page` only for visual findings without a reliable text block.
- Do not invent block IDs.
- Do not move a finding to a nearby block when the correct anchor is uncertain.

## DOCX and DOCM

- Use `docx_paragraph` for paragraph findings. Copy the exact `paragraph_id` from the Markdown marker without the `HL:` prefix.
- Use `docx_table_cell` for table-cell findings. Copy the exact `cell_id` from the Markdown marker without the `HL:` prefix.
- For `docx_table_cell`, include `table_id`, `row`, `column`, and `cell_id`.
- Prefer paragraph and table-cell anchors over broad page descriptions. Do not invent run-level anchors.

## XLSX and XLSM

- Use `xlsx_cell` for exact cell findings.
- Copy the exact `sheet` and `cell` from the Markdown row that contains the nearby `HL:` marker.
- Use `xlsx_range` only when the finding applies to a full range, table, named range, merged range, or used-range summary.
- Copy the exact `sheet` and A1 `range` from the range marker. Do not invent workbook-level anchors.
- When visual evidence comes from a chart, image, dashboard, conditional formatting, or merged-cell layout, still anchor the finding to the most specific related `xlsx_cell` or `xlsx_range` marker in the Markdown.

## PPTX and PPTM

- Use `pptx_shape` for a finding tied to a specific text box, table, chart, image, diagram, SmartArt, or grouped shape.
- Copy the exact `slide`, `slide_id`, and `shape_id` from the Markdown section with the nearby `HL:` marker.
- Use `pptx_slide` only for slide-level visual findings where no single shape anchor is defensible.
- For `pptx_slide`, copy the exact `slide` and `slide_id` from the slide section marker.
- Prefer shape anchors for text, tables, charts, and named graphical objects. Do not invent shape IDs or use a nearby shape when the correct shape is uncertain.

## Evidence

Evidence should be short source text or a concise description of the visual evidence. Do not include long rationale. Omit findings when evidence cannot be anchored defensibly.
