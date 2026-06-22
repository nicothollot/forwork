# User Workflow

HL Intelligence has exactly two primary tabs: **Commenter** and **LLM Preflight**. All processing is local.

## Commenter

### One-time Skill setup

1. Use **Save Skill ZIP** and choose a known save location.
2. Install or enable the ZIP in the approved Claude environment.
3. Mark the Skill installed in HL Intelligence.

After the Skill is marked installed, setup collapses to a small **Setup** action. The Skill ZIP and instructions remain available there.

### Step 1: Create a review package

1. Select or drop the source document.
   - PDF, DOCX, DOCM, XLSX, XLSM, PPTX, and PPTM are supported.
   - Legacy DOC, XLS, and PPT show a conversion-required message and cannot proceed until converted.
2. Choose a review type:
   - Full review
   - Numbers and consistency
   - Proofread
   - Custom
3. Choose a comment style:
   - HL concise professional
   - Question-led
   - Formal
   - Automatic
   - Custom
4. Select the output folder.
5. Select **Create review package**. This action is disabled until the source format is verified and the output folder is selected.

Advanced settings contain wording signals, maximum comment length, custom format tokens, style examples, saved named styles, and additional review presets. Selecting a preset replaces the current preset text rather than appending duplicates.

In the approved Claude environment, upload only the files in `Upload_to_Claude`, paste `PROMPT_TO_COPY.txt`, and ask Claude to create `hl_comments.json`.

### Resume an existing review

Use **Resume existing review** when returning later or after restarting the application.

Select:

- `review-job.hlreview`
- The original source file
- `hl_comments.json`

HL Intelligence validates the original source hash before comments can be applied.

### Step 2: Apply comments

1. Paste, browse, or drop `hl_comments.json`.
2. Confirm or browse for the original document.
3. Set the output filename.
4. Select the output folder.

Validation runs automatically after the review job, source, or JSON changes. The status is shown as **Ready to apply**, **Needs review**, or **Rejected**.

If every finding is valid, **Create commented file** is available immediately. If findings need attention, a compact review panel appears with filters, evidence, source location, approve/reject actions, final-comment editing, **Approve all valid**, and **Reject all invalid**. Only approved findings are applied. HL Intelligence always writes a new output file and does not overwrite the source document.

## LLM Preflight

1. Select or drop one or more PDF, Word, Excel, or PowerPoint files.
2. Review each file row's automatic recommendation.
3. Adjust the selected mode only when needed:
   - Text only
   - Text + visual pages
   - Text + every page or slide
4. Select an output folder.
5. Select **Generate**. This action is disabled if any queued file is unsupported or requires legacy conversion.

Each queue card shows filename, type, size, page/sheet/slide count, recommended mode, selected mode, progress, status, and remove action. Format-specific options are under **Advanced**. OCR is hidden until local OCR is implemented and tested.

Completed rows show approximate output summaries:

- Original size
- Markdown size
- Visual supplement size
- Approximate token estimate
- Approximate reduction
- Visual page or slide count
- Warning count
- Open folder

## Manager Demo

Run `npm run demo:prepare` to create synthetic demo materials under `test-artifacts/manager-demo/`. The five-minute demo flow is documented in `docs/manager-demo.md`.
