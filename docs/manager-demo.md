# Manager Demo

Prepare synthetic materials:

```bash
npm run demo:prepare
```

Output folder:

```text
test-artifacts/manager-demo/
```

The generated materials are synthetic and are not included in the production package.

## Five-Minute Flow

1. Launch `release/windows-portable/HL Intelligence.exe` and show the branded startup splash.
2. On the main window, point to the local-only privacy message: HL Intelligence processes documents locally and does not upload files or call LLM APIs.
3. Open **LLM Preflight** and add the synthetic mixed-format files from `test-artifacts/manager-demo/source-files`.
4. Show automatic mode recommendations, then generate Markdown and visual-output files into a demo output folder.
5. Open **Commenter** and show review-package creation for a synthetic source document.
6. Use **Resume existing review** with `test-artifacts/manager-demo/commenter-review/Keep_Local/review-job.hlreview`.
7. Select `test-artifacts/manager-demo/source-files/02-investment-memo.docx`.
8. Import `test-artifacts/manager-demo/pre-generated-result/hl_comments.json` and show automatic validation.
9. Create the commented output and open it in Microsoft Word.

## Talk Track

HL Intelligence prepares local review packages and applies approved structured comments back to source documents. It complements approved LLM tools by creating anchored Markdown, visual supplements, schemas, and validation files that can be transferred manually to the approved LLM environment.

It processes locally because transaction documents can contain confidential client information. The desktop app does not upload source files, call LLM APIs, refresh external workbook links, execute macros, or overwrite source documents.

Supported final formats are PDF, DOCX, DOCM, XLSX, XLSM, PPTX, and PPTM. Legacy DOC, XLS, and PPT receive a conversion-required message and are not treated as fully supported.

It intentionally does not do OCR, bypass passwords, execute macros, silently strip unsupported Office features, auto-update, install Office, or replace approved LLM governance.
