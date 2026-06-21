# User Workflow

HL Intelligence has two tabs.

## Commenter

1. Install the reusable HL Commenter Skill once.
2. Browse for the source PDF or drag it into Step 1.
3. Enter what Claude should review.
4. Leave comment wording on Automatic, or add optional wording signals, formality, maximum length, format template, and style examples.
5. Select an output folder.
6. Select **Create Claude Review Package**.
7. In the approved Claude environment, upload only the files in `Upload_to_Claude`, paste `PROMPT_TO_COPY.txt`, and ask Claude to create `hl_comments.json`.
8. Return to Step 2.
9. Paste or browse for `hl_comments.json`.
10. Validate the result.
11. Select **Create Commented File**.

HL Intelligence applies comments locally to a new PDF and writes a small report for skipped findings.

## LLM Preflight

1. Browse for one or more PDFs, or drag them into the queue.
2. Choose a processing mode for each file.
3. Select an output folder.
4. Select **Generate Preflight Files**.
5. Open the resulting folder.

Processing modes:

- Text only: Markdown only. Visual information may be omitted.
- Text + visual pages: Markdown plus selected visually material pages. Recommended.
- Text + every page: Markdown plus a complete visual reference.
