# Anchor Rules

Use the most specific stable anchor available.

## PDF

- Use `pdf_block` when the finding is tied to extractable text.
- Copy the exact `block_id` from the Markdown marker without the `HL:` prefix.
- Use `pdf_page` only for visual findings without a reliable text block.
- Do not invent block IDs.
- Do not move a finding to a nearby block when the correct anchor is uncertain.

## DOCX

- Use `docx_paragraph` for paragraph findings.
- Use `docx_table_cell` for table-cell findings.

## XLSX

- Use `xlsx_cell` for exact cell findings.
- Use `xlsx_range` only when the finding applies to a range.

## PPTX

- Use `pptx_shape` for a specific shape.
- Use `pptx_slide` for slide-level visual findings.

## Evidence

Evidence should be short source text or a concise description of the visual evidence. Do not include long rationale. Omit findings when evidence cannot be anchored defensibly.
