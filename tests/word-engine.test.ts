import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createCommentedDocument } from "../src/engine/commentOutput";
import { documentAdapterRegistry } from "../src/engine/documentAdapterRegistry";
import { readJsonFile } from "../src/engine/fileSafety";
import { prepareReviewPackage } from "../src/engine/reviewPackage";
import { runOfficeWorker } from "../src/engine/office/officeWorkerClient";
import { validateClaudeResultText } from "../src/engine/resultValidation";
import type { ClaudeResult, DocumentAnchor, LocalReviewJob, SourceBlock } from "../src/shared/types";
import type { WordRenderResponse } from "../src/engine/office/officeTypes";

describe("Word adapter foundation", () => {
  it("validates Word paragraph and table-cell anchors from the source map", async () => {
    const localJob = localWordJob();
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: { kind: "docx_paragraph", paragraph_id: "w:p000002", page: 1 },
          evidence: "Revenue increased by 14.2%",
          comment_body: "Please confirm this percentage."
        },
        {
          id: "C002",
          anchor: { kind: "docx_table_cell", table_id: "w:t0001", row: 2, column: 2, cell_id: "w:t0001:c0005", page: 2 },
          evidence: "$112.5",
          comment_body: "Please confirm the table value."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(true);
    expect(validation.summary.valid).toBe(2);
  });

  it("rejects Word anchors when evidence is not near the selected source anchor", async () => {
    const localJob = localWordJob();
    const result: ClaudeResult = {
      schema_version: "1.0",
      request_id: localJob.request_id,
      source_sha256: localJob.source.sha256,
      findings: [
        {
          id: "C001",
          anchor: { kind: "docx_paragraph", paragraph_id: "w:p000002", page: 1 },
          evidence: "not present in the paragraph",
          comment_body: "Please confirm this."
        }
      ]
    };

    const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
    expect(validation.ok).toBe(false);
    expect(validation.summary.invalid).toBe(1);
  });
});

const nativeWordDescribe = process.env.HL_WORD_INTEGRATION === "1" ? describe : describe.skip;

nativeWordDescribe("native Word round trip", () => {
  it("creates DOCX and DOCM review packages, applies comments, verifies output, and keeps PDF-rendered layout stable", async () => {
    const dir = await nativeWordTempDir();
    const fixtures = await createWordFixtures(dir);
    for (const sourcePath of [fixtures.docx, fixtures.docm]) {
      const adapter = documentAdapterRegistry.require(path.extname(sourcePath).toLowerCase() === ".docm" ? "docm" : "docx");
      const inspection = await adapter.inspect({ sourcePath, includeHash: true });
      expect(inspection.counts.pages).toBeGreaterThan(0);
      expect(inspection.counts.sections).toBeGreaterThan(1);

      const packageResult = await prepareReviewPackage({
        sourcePath,
        outputFolder: path.join(dir, "packages"),
        reviewInstructions: "Check numeric consistency.",
        style: {
          wording_mode: "automatic",
          signals: [],
          formality: "automatic",
          max_words: null,
          format_template: "{comment}",
          examples: []
        }
      });
      const localJob = await readJsonFile<LocalReviewJob>(packageResult.localJobPath);
      const paragraph = findAnchor(localJob, "docx_paragraph", /Revenue increased/);
      const tableCell = findAnchor(localJob, "docx_table_cell", /\$112\.5/);
      const result: ClaudeResult = {
        schema_version: "1.0",
        request_id: localJob.request_id,
        source_sha256: localJob.source.sha256,
        findings: [
          {
            id: "C001",
            anchor: paragraph.anchor as DocumentAnchor,
            evidence: "Revenue increased by 14.2%",
            comment_body: "Please confirm this percentage."
          },
          {
            id: "C002",
            anchor: tableCell.anchor as DocumentAnchor,
            evidence: "$112.5",
            comment_body: "Please confirm the table value."
          }
        ]
      };
      const validation = await validateClaudeResultText(localJob, JSON.stringify(result));
      expect(validation.ok).toBe(true);

      const output = await createCommentedDocument({
        sourcePath,
        localJobPath: packageResult.localJobPath,
        claudeJsonText: JSON.stringify(result),
        outputFolder: path.join(dir, "commented")
      });
      await stat(output.outputPath);

      const originalPdf = await renderWordPdf(sourcePath, path.join(dir, `${path.basename(sourcePath)}.original.pdf`));
      const commentedPdf = await renderWordPdf(output.outputPath, path.join(dir, `${path.basename(output.outputPath)}.pdf`));
      expect(await pageCount(originalPdf)).toBe(await pageCount(commentedPdf));
    }

    await expect(stat(fixtures.corrupt)).resolves.toBeTruthy();
    await expect(stat(fixtures.passwordProtected)).resolves.toBeTruthy();
    await expect(stat(fixtures.unicode)).resolves.toBeTruthy();
  }, 300000);
});

function localWordJob(): LocalReviewJob {
  const paragraphAnchor: DocumentAnchor = { kind: "docx_paragraph", paragraph_id: "w:p000002", page: 1 };
  const tableAnchor: DocumentAnchor = {
    kind: "docx_table_cell",
    table_id: "w:t0001",
    row: 2,
    column: 2,
    cell_id: "w:t0001:c0005",
    page: 2
  };
  return {
    schema_version: "1.0",
    processing_version: "test",
    request_id: "request-1",
    created_at: "2026-06-22T00:00:00.000Z",
    source: {
      filename: "source.docx",
      sha256: "c".repeat(64),
      document_type: "docx",
      total_pages: 2,
      total_sections: 2
    },
    style: {
      wording_mode: "automatic",
      signals: [],
      formality: "automatic",
      max_words: null,
      format_template: "{comment}",
      examples: []
    },
    source_map: {
      schema_version: "1.0",
      processing_version: "test",
      source: {
        filename: "source.docx",
        sha256: "c".repeat(64),
        document_type: "docx",
        total_pages: 2,
        total_sections: 2
      },
      anchors: {
        "w:p000002": wordBlock("w:p000002", "docx_paragraph", paragraphAnchor, 1, "Revenue increased by 14.2% year over year."),
        "w:t0001:c0005": wordBlock("w:t0001:c0005", "docx_table_cell", tableAnchor, 2, "FY2025 $112.5")
      },
      visual_pages: []
    }
  };
}

function wordBlock(
  anchorId: string,
  kind: "docx_paragraph" | "docx_table_cell",
  anchor: DocumentAnchor,
  page: number,
  text: string
): SourceBlock {
  return {
    anchorId,
    kind,
    anchor,
    page,
    paragraphId: kind === "docx_paragraph" ? anchorId : undefined,
    tableId: kind === "docx_table_cell" && anchor.kind === "docx_table_cell" ? anchor.table_id : undefined,
    cellId: kind === "docx_table_cell" && anchor.kind === "docx_table_cell" ? anchor.cell_id : undefined,
    row: kind === "docx_table_cell" && anchor.kind === "docx_table_cell" ? anchor.row : undefined,
    column: kind === "docx_table_cell" && anchor.kind === "docx_table_cell" ? anchor.column : undefined,
    text
  };
}

function findAnchor(localJob: LocalReviewJob, kind: SourceBlock["kind"], pattern: RegExp): SourceBlock {
  const anchor = Object.values(localJob.source_map.anchors).find((item) => item.kind === kind && pattern.test(item.text));
  if (!anchor) throw new Error(`Missing ${kind} test anchor.`);
  return anchor;
}

async function createWordFixtures(dir: string): Promise<{
  docx: string;
  docm: string;
  corrupt: string;
  passwordProtected: string;
  unicode: string;
}> {
  const fixtures = {
    docx: path.join(dir, "word-fixture.docx"),
    docm: path.join(dir, "word-fixture.docm"),
    corrupt: path.join(dir, "corrupt.docx"),
    passwordProtected: path.join(dir, "password-protected.docx"),
    unicode: path.join(dir, "Unicode filename - cafe - 会社.docx")
  };
  await writeSyntheticWordPackage(fixtures.docx, "docx");
  await writeSyntheticWordPackage(fixtures.docm, "docm");
  await writeSyntheticWordPackage(fixtures.unicode, "docx");
  await writeSyntheticWordPackage(fixtures.passwordProtected, "docx");
  await writeFile(fixtures.corrupt, "not a word document", "utf8");
  return fixtures;
}

async function renderWordPdf(sourcePath: string, outputPdfPath: string): Promise<string> {
  const documentType = path.extname(sourcePath).toLowerCase() === ".docm" ? "docm" : "docx";
  await runOfficeWorker<WordRenderResponse>(
    {
      schema_version: "1.0",
      operation: "render",
      application: "word",
      document_type: documentType,
      source_path: sourcePath,
      output_pdf_path: outputPdfPath
    },
    { timeoutMs: 180000 }
  );
  return outputPdfPath;
}

async function pageCount(filePath: string): Promise<number> {
  const pdf = await PDFDocument.load(await readFile(filePath));
  return pdf.getPageCount();
}

async function nativeWordTempDir(): Promise<string> {
  if (process.platform !== "win32") {
    const candidate = path.join("/mnt/c/Users", os.userInfo().username, "AppData/Local/Temp");
    try {
      await mkdir(candidate, { recursive: true });
      return mkdtemp(path.join(candidate, "hl-word-native-"));
    } catch {
      // Fall back to WSL temp; some local setups do not expose the Windows user temp folder.
    }
  }
  return mkdtemp(path.join(os.tmpdir(), "hl-word-native-"));
}

async function writeSyntheticWordPackage(filePath: string, type: "docx" | "docm"): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(type));
  zip.file("_rels/.rels", packageRelationshipsXml());
  zip.file("word/document.xml", documentXml());
  zip.file("word/_rels/document.xml.rels", documentRelationshipsXml());
  zip.file("word/styles.xml", stylesXml());
  zip.file("word/settings.xml", settingsXml());
  zip.file("word/numbering.xml", numberingXml());
  zip.file("word/comments.xml", commentsXml());
  zip.file("word/footnotes.xml", notesXml("footnotes", "footnote"));
  zip.file("word/endnotes.xml", notesXml("endnotes", "endnote"));
  zip.file("word/header1.xml", headerFooterXml("hdr", "Synthetic header"));
  zip.file("word/footer1.xml", headerFooterXml("ftr", "Synthetic footer"));
  zip.file("word/charts/chart1.xml", chartXml());
  zip.file("word/media/image1.png", Buffer.from(pngBase64, "base64"));
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function contentTypesXml(type: "docx" | "docm"): string {
  const mainType = type === "docm"
    ? "application/vnd.ms-word.document.macroEnabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="${mainType}"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
</Types>`;
}

function packageRelationshipsXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelationshipsXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdHyperlink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
  <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
</Relationships>`;
}

function documentXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" xmlns:cx2="http://schemas.microsoft.com/office/drawing/2015/10/21/chartex" xmlns:cx3="http://schemas.microsoft.com/office/drawing/2016/5/9/chartex" xmlns:cx4="http://schemas.microsoft.com/office/drawing/2016/5/10/chartex" xmlns:cx5="http://schemas.microsoft.com/office/drawing/2016/5/11/chartex" xmlns:cx6="http://schemas.microsoft.com/office/drawing/2016/5/12/chartex" xmlns:cx7="http://schemas.microsoft.com/office/drawing/2016/5/13/chartex" xmlns:cx8="http://schemas.microsoft.com/office/drawing/2016/5/14/chartex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>HL Word Fixture</w:t></w:r></w:p>
    <w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Revenue increased by 14.2% year over year.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First list item</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rIdHyperlink1" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>Example hyperlink</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:t>Footnote and endnote references</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:endnoteReference w:id="2"/></w:r></w:p>
    <w:p><w:ins w:id="1" w:author="HL Test" w:date="2026-06-22T00:00:00Z"><w:r><w:t>Tracked addition.</w:t></w:r></w:ins></w:p>
    <w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:footerReference w:type="default" r:id="rIdFooter1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr></w:p>
    ${tableXml()}
    <w:p><w:r>${imageDrawingXml()}</w:r></w:p>
    <w:p><w:r>${chartDrawingXml()}</w:r></w:p>
    <w:p><w:r><w:pict><v:shape id="TextBox1" type="#_x0000_t202" style="width:220pt;height:45pt" filled="f" stroked="t"><v:textbox><w:txbxContent><w:p><w:r><w:t>Synthetic text box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="rIdHeader1"/><w:footerReference w:type="default" r:id="rIdFooter1"/><w:cols w:num="2" w:space="720"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`;
}

function tableXml(): string {
  const cell = (text: string, extra = "") => `<w:tc><w:tcPr>${extra}<w:tcW w:w="2880" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:firstRow="1" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid><w:tr>${cell("Metric")}${cell("FY2024")}${cell("FY2025")}</w:tr><w:tr>${cell("Revenue")}${cell("$100.0")}${cell("$112.5")}</w:tr><w:tr>${cell("Merged cells", '<w:gridSpan w:val="2"/>')}${cell("Complete")}</w:tr></w:tbl>`;
}

function imageDrawingXml(): string {
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="548640" cy="548640"/><wp:docPr id="1" name="Synthetic image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="fixture-image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="548640" cy="548640"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function chartDrawingXml(): string {
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3200400" cy="1828800"/><wp:docPr id="2" name="Synthetic chart"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart1"/></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function stylesXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
}

function settingsXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/><w:updateFields w:val="false"/></w:settings>`;
}

function numberingXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
}

function commentsXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="HL Test" w:date="2026-06-22T00:00:00Z"><w:p><w:r><w:t>Existing comment</w:t></w:r></w:p></w:comment></w:comments>`;
}

function notesXml(root: "footnotes" | "endnotes", item: "footnote" | "endnote"): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:${item} w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:${item}><w:${item} w:id="2"><w:p><w:r><w:t>Synthetic ${item} text</w:t></w:r></w:p></w:${item}></w:${root}>`;
}

function headerFooterXml(root: "hdr" | "ftr", text: string): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:${root}>`;
}

function chartXml(): string {
  return xml`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Revenue</c:v></c:tx><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>FY2024</c:v></c:pt><c:pt idx="1"><c:v>FY2025</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>112.5</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
}

function xml(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.reduce((combined, part, index) => `${combined}${part}${values[index] ?? ""}`, "").trim();
}

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8+ZLwAAAABJRU5ErkJggg==";
