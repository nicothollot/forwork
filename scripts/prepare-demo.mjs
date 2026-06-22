import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = process.cwd();
const demoRoot = path.join(root, "test-artifacts", "manager-demo");
const sourceDir = path.join(demoRoot, "source-files");
const reviewDir = path.join(demoRoot, "commenter-review");
const keepLocalDir = path.join(reviewDir, "Keep_Local");
const uploadDir = path.join(reviewDir, "Upload_to_Claude");
const returnedDir = path.join(demoRoot, "pre-generated-result");
const legacyDir = path.join(demoRoot, "legacy-conversion-required");

await rm(demoRoot, { recursive: true, force: true });
await mkdir(sourceDir, { recursive: true });
await mkdir(keepLocalDir, { recursive: true });
await mkdir(uploadDir, { recursive: true });
await mkdir(returnedDir, { recursive: true });
await mkdir(legacyDir, { recursive: true });

const pdfPath = path.join(sourceDir, "01-board-summary.pdf");
const docxPath = path.join(sourceDir, "02-investment-memo.docx");
const xlsxPath = path.join(sourceDir, "03-operating-model.xlsx");
const pptxPath = path.join(sourceDir, "04-committee-deck.pptx");
const pptmPath = path.join(sourceDir, "05-macro-enabled-appendix.pptm");

await writeDemoPdf(pdfPath);
await writeDemoDocx(docxPath);
await writeDemoXlsx(xlsxPath, "xlsx");
await writeDemoPptx(pptxPath, "pptx");
await writeDemoPptx(pptmPath, "pptm");
await writeFile(path.join(legacyDir, "legacy-board-book.doc"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]));

const sourceSha256 = sha256(await readFile(docxPath));
const requestId = "manager-demo-request";
const localJob = demoLocalJob({
  requestId,
  sourcePath: docxPath,
  sourceSha256
});
const comments = {
  schema_version: "1.0",
  request_id: requestId,
  source_sha256: sourceSha256,
  findings: [
    {
      id: "DEMO-001",
      anchor: { kind: "docx_paragraph", paragraph_id: "w:p000002", page: 1 },
      evidence: "Revenue increased by 14.2%",
      comment_body: "Confirm the 14.2% revenue growth ties to the operating model."
    },
    {
      id: "DEMO-002",
      anchor: { kind: "docx_paragraph", paragraph_id: "w:p000003", page: 1 },
      evidence: "$112.5 million",
      comment_body: "Confirm this FY2025 revenue value matches the Excel model."
    }
  ]
};

await writeFile(path.join(keepLocalDir, "review-job.hlreview"), JSON.stringify(localJob, null, 2), "utf8");
await writeFile(path.join(uploadDir, "investment-memo.md"), demoMarkdown(), "utf8");
await writeFile(path.join(uploadDir, "review-config.json"), JSON.stringify(demoReviewConfig(requestId, sourceSha256), null, 2), "utf8");
await writeFile(path.join(uploadDir, "PROMPT_TO_COPY.txt"), demoPrompt(), "utf8");
await writeFile(path.join(returnedDir, "hl_comments.json"), JSON.stringify(comments, null, 2), "utf8");
await writeFile(path.join(demoRoot, "README.md"), demoReadme(), "utf8");

console.log(`Manager demo materials written to: ${demoRoot}`);
console.log(`Pre-generated hl_comments.json: ${path.join(returnedDir, "hl_comments.json")}`);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeDemoPdf(filePath) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  page.drawText("Manager Demo Board Summary", { x: 72, y: 720, size: 20, font: bold, color: rgb(0, 0.16, 0.33) });
  page.drawText("Revenue increased by 14.2% and Adjusted EBITDA was $42.0 million.", { x: 72, y: 682, size: 12, font });
  page.drawText("The chart below is synthetic and for local demonstration only.", { x: 72, y: 662, size: 11, font });
  for (let index = 0; index < 8; index += 1) {
    page.drawRectangle({
      x: 88 + index * 34,
      y: 260,
      width: 22,
      height: 60 + index * 18,
      color: rgb(0.09, 0.42, 0.64)
    });
  }
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
}

async function writeDemoDocx(filePath) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.file("_rels/.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/_rels/document.xml.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file("word/styles.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>`);
  zip.file("word/document.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>HL Intelligence Manager Demo</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue increased by 14.2% year over year.</w:t></w:r></w:p>
    <w:p><w:r><w:t>FY2025 revenue is $112.5 million in the synthetic model.</w:t></w:r></w:p>
    <w:p><w:r><w:t>All demo material is synthetic and may be shared only for product demonstration.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`);
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function writeDemoXlsx(filePath, type) {
  const mainType =
    type === "xlsm"
      ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="${mainType}"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.file("_rels/.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file("xl/_rels/workbook.xml.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  zip.file("xl/workbook.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file("xl/worksheets/sheet1.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>FY2025</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c><c r="B2"><v>112500000</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Growth</t></is></c><c r="B3"><v>0.142</v></c></row>
  </sheetData>
</worksheet>`);
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function writeDemoPptx(filePath, type) {
  const mainType =
    type === "pptm"
      ? "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="${mainType}"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/_rels/presentation.xml.rels", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="wide"/>
</p:presentation>`);
  zip.file("ppt/slides/slide1.xml", xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Committee Deck Demo</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Revenue increased by 14.2% in the synthetic case.</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function demoLocalJob({ requestId, sourcePath, sourceSha256 }) {
  const source = {
    filename: path.basename(sourcePath),
    path: sourcePath,
    sha256: sourceSha256,
    document_type: "docx",
    total_pages: 1,
    total_sections: 1
  };
  const anchors = {
    "w:p000002": {
      anchorId: "w:p000002",
      kind: "docx_paragraph",
      anchor: { kind: "docx_paragraph", paragraph_id: "w:p000002", page: 1 },
      page: 1,
      paragraphId: "w:p000002",
      text: "Revenue increased by 14.2% year over year."
    },
    "w:p000003": {
      anchorId: "w:p000003",
      kind: "docx_paragraph",
      anchor: { kind: "docx_paragraph", paragraph_id: "w:p000003", page: 1 },
      page: 1,
      paragraphId: "w:p000003",
      text: "FY2025 revenue is $112.5 million in the synthetic model."
    }
  };
  return {
    schema_version: "1.0",
    processing_version: "manager-demo",
    request_id: requestId,
    created_at: new Date().toISOString(),
    source,
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "professional",
      max_words: 25,
      format_template: "{comment}",
      examples: []
    },
    source_map: {
      schema_version: "1.0",
      processing_version: "manager-demo",
      source,
      anchors,
      visual_pages: []
    }
  };
}

function demoReviewConfig(requestId, sourceSha256) {
  return {
    schema_version: "1.0",
    request_id: requestId,
    source: {
      filename: "02-investment-memo.docx",
      sha256: sourceSha256,
      document_type: "docx",
      total_pages: 1,
      total_sections: 1
    },
    review_instructions: "Review numbers and cross-document consistency for the synthetic manager demo.",
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "professional",
      max_words: 25,
      format_template: "{comment}",
      examples: []
    },
    required_output_filename: "hl_comments.json"
  };
}

function demoMarkdown() {
  return `# 02-investment-memo.docx

<!-- HL:w:p000002 -->
Revenue increased by 14.2% year over year.

<!-- HL:w:p000003 -->
FY2025 revenue is $112.5 million in the synthetic model.
`;
}

function demoPrompt() {
  return "Use the synthetic review package and return only hl_comments.json.";
}

function demoReadme() {
  return `# HL Intelligence Manager Demo Materials

All files in this folder are synthetic and generated outside the production package.

Recommended demo path:

1. Use source-files for the mixed-format LLM Preflight queue.
2. Use commenter-review/Keep_Local/review-job.hlreview with source-files/02-investment-memo.docx to resume a prepared synthetic review.
3. Import pre-generated-result/hl_comments.json to show automatic validation.
4. Create the commented file into an output folder and open the DOCX in Microsoft Word.
5. Use legacy-conversion-required/legacy-board-book.doc to show the conversion-required message.
`;
}

function xml(strings, ...values) {
  return String.raw({ raw: strings }, ...values).trim();
}
