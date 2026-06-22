import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6AO2QAAAABJRU5ErkJggg==";

export async function createTextPdf(dir: string, name = "text-only.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Operating Performance", { x: 72, y: 720, size: 18, font, color: rgb(0, 0, 0) });
  page.drawText("Revenue increased by 14.2% during the period.", { x: 72, y: 682, size: 12, font });
  page.drawText("Adjusted EBITDA was $42.0 million.", { x: 72, y: 662, size: 12, font });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createVisualPdf(dir: string, name = "visual.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Sales by Segment", { x: 72, y: 720, size: 18, font });
  for (let index = 0; index < 18; index += 1) {
    page.drawRectangle({
      x: 90 + index * 18,
      y: 240,
      width: 10,
      height: 40 + index * 12,
      color: rgb(0.1, 0.45, 0.65)
    });
    page.drawLine({ start: { x: 80, y: 220 + index * 16 }, end: { x: 430, y: 220 + index * 16 }, thickness: 0.5 });
  }
  const imagePage = pdf.addPage([612, 792]);
  const png = await pdf.embedPng(Buffer.from(pngBase64, "base64"));
  imagePage.drawText("Scanned exhibit", { x: 72, y: 720, size: 18, font });
  imagePage.drawImage(png, { x: 72, y: 180, width: 420, height: 420 });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createMultiColumnPdf(dir: string, name = "multi-column.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Two Column Discussion", { x: 72, y: 724, size: 18, font: bold });
  page.drawText("Left column starts with market commentary", { x: 72, y: 682, size: 11, font });
  page.drawText("and continues with operating context.", { x: 72, y: 666, size: 11, font });
  page.drawText("Left column closes before the right column.", { x: 72, y: 636, size: 11, font });
  page.drawText("Right column begins after the left column", { x: 326, y: 682, size: 11, font });
  page.drawText("and contains additional assumptions.", { x: 326, y: 666, size: 11, font });
  page.drawText("Right column closes last.", { x: 326, y: 636, size: 11, font });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createHyphenatedPdf(dir: string, name = "hyphenated.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Hyphenation", { x: 72, y: 724, size: 18, font: bold });
  page.drawText("Revenue in-", { x: 72, y: 682, size: 12, font });
  page.drawText("creased by 14.2% during the period.", { x: 72, y: 668, size: 12, font });
  page.drawText("Margin was stable.", { x: 72, y: 638, size: 12, font });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createRepeatedHeaderFooterPdf(dir: string, name = "headers-footers.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 3; index += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText("HL Confidential Review Draft", { x: 72, y: 758, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`Page ${index} of 3`, { x: 500, y: 34, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`Page ${index} body paragraph keeps unique source content.`, { x: 72, y: 682, size: 12, font });
  }
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createVectorChartPdf(dir: string, name = "vector-chart.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Vector Chart", { x: 72, y: 720, size: 18, font });
  for (let index = 0; index < 24; index += 1) {
    page.drawRectangle({
      x: 88 + index * 16,
      y: 230,
      width: 9,
      height: 30 + index * 8,
      color: rgb(0.1, 0.42, 0.6)
    });
    page.drawLine({ start: { x: 80, y: 220 + index * 12 }, end: { x: 500, y: 220 + index * 12 }, thickness: 0.4 });
  }
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createRasterImagePdf(dir: string, name = "raster-image.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(Buffer.from(pngBase64, "base64"));
  page.drawText("Raster exhibit", { x: 72, y: 720, size: 18, font });
  page.drawImage(png, { x: 86, y: 170, width: 440, height: 440 });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createMixedTextChartPdf(dir: string, name = "mixed-text-chart.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Mixed Text and Chart", { x: 72, y: 720, size: 18, font });
  page.drawText("Management expects volume growth to moderate in the second half.", { x: 72, y: 682, size: 12, font });
  for (let index = 0; index < 18; index += 1) {
    page.drawRectangle({
      x: 90 + index * 18,
      y: 250,
      width: 10,
      height: 40 + index * 8,
      color: rgb(0.1, 0.42, 0.6)
    });
  }
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createComplexTablePdf(dir: string, name = "complex-table.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Complex Table", { x: 72, y: 724, size: 18, font: bold });
  const xStops = [72, 190, 306, 422, 536];
  const top = 680;
  for (let row = 0; row <= 6; row += 1) {
    page.drawLine({ start: { x: xStops[0], y: top - row * 26 }, end: { x: xStops[4], y: top - row * 26 }, thickness: 0.5 });
  }
  for (const x of xStops) {
    page.drawLine({ start: { x, y: top }, end: { x, y: top - 156 }, thickness: 0.5 });
  }
  const rows = [
    ["Metric", "2024A", "2025E", "2026E"],
    ["Revenue", "$100.0", "$112.5", "$126.2"],
    ["EBITDA", "$22.0", "$25.4", "$28.1"],
    ["Margin", "22.0%", "22.6%", "22.3%"],
    ["Capex", "$4.0", "$4.2", "$4.5"],
    ["FCF", "$18.0", "$21.2", "$23.6"]
  ];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      page.drawText(cell, { x: xStops[columnIndex] + 8, y: top - 18 - rowIndex * 26, size: 10, font: rowIndex === 0 ? bold : font });
    });
  });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createRotatedPdf(dir: string, name = "rotated.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.setRotation(degrees(90));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Rotated page text", { x: 72, y: 400, size: 12, font });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createCropBoxPdf(dir: string, name = "crop-box.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.setCropBox(36, 48, 540, 696);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Crop Box Page", { x: 72, y: 700, size: 18, font });
  page.drawText("Revenue increased by 14.2% inside the visible crop box.", { x: 72, y: 662, size: 12, font });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createPdfWithExistingAnnotation(dir: string, name = "annotated.pdf"): Promise<string> {
  const filePath = await createTextPdf(dir, name);
  const bytes = await (await import("node:fs/promises")).readFile(filePath);
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0) as any;
  const context = page.doc.context;
  const annot = context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [120, 650, 140, 670],
    Contents: "Existing comment",
    Name: "Comment"
  });
  const annots = context.obj([]);
  annots.push(context.register(annot));
  page.node.set(PDFName.of("Annots"), annots);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createScannedPdf(dir: string, name = "scanned.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const png = await pdf.embedPng(Buffer.from(pngBase64, "base64"));
  page.drawImage(png, { x: 56, y: 96, width: 500, height: 610 });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createBookmarkedPdf(dir: string, name = "bookmarked.pdf"): Promise<string> {
  const filePath = await createTextPdf(dir, name);
  const pdf = await PDFDocument.load(await readFile(filePath));
  const page = pdf.getPage(0) as any;
  const context = pdf.context;
  const outlines = context.obj({
    Type: PDFName.of("Outlines"),
    Count: PDFNumber.of(1)
  }) as any;
  const outlinesRef = context.register(outlines);
  const item = context.obj({
    Title: PDFString.of("Operating Performance"),
    Parent: outlinesRef,
    Dest: [page.ref, PDFName.of("Fit")]
  }) as any;
  const itemRef = context.register(item);
  outlines.set(PDFName.of("First"), itemRef);
  outlines.set(PDFName.of("Last"), itemRef);
  pdf.catalog.set(PDFName.of("Outlines"), outlinesRef);
  pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createPdfWithFormField(dir: string, name = "form-field.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Form Field Document", { x: 72, y: 720, size: 18, font });
  page.drawText("Revenue increased by 14.2% during the period.", { x: 72, y: 682, size: 12, font });
  const form = pdf.getForm();
  const field = form.createTextField("reviewer_note");
  field.setText("Existing field");
  field.addToPage(page, { x: 72, y: 620, width: 220, height: 24 });
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createManyVisualPagesPdf(dir: string, pageCount = 48, name = "many-visual-pages.pdf"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Visual page ${pageNumber}`, { x: 72, y: 720, size: 18, font });
    for (let index = 0; index < 26; index += 1) {
      page.drawRectangle({
        x: 80 + index * 16,
        y: 210,
        width: 10,
        height: 25 + ((pageNumber + index) % 18) * 8,
        color: rgb(0.1, 0.42, 0.6)
      });
    }
  }
  const filePath = path.join(dir, name);
  await writeFile(filePath, await pdf.save({ useObjectStreams: false }));
  return filePath;
}

export async function createSignatureLikePdf(dir: string, name = "signature-like.pdf"): Promise<string> {
  const filePath = await createTextPdf(dir, name);
  const bytes = await readFile(filePath);
  await writeFile(filePath, Buffer.concat([bytes, Buffer.from("\n% /ByteRange [0 100 200 300] /FT /Sig\n")]));
  return filePath;
}

export async function createLongUnicodeFilenamePdf(dir: string): Promise<string> {
  return createTextPdf(
    dir,
    "Very long Unicode filename - café - fiancée - 会社 - １２３４５６７８９０ - operating performance review draft.pdf"
  );
}

export async function createCorruptPdf(dir: string): Promise<string> {
  const filePath = path.join(dir, "corrupt.pdf");
  await writeFile(filePath, Buffer.from("not a pdf"));
  return filePath;
}

export async function createPasswordProtectedStub(dir: string): Promise<string> {
  const filePath = path.join(dir, "password.pdf");
  await writeFile(filePath, Buffer.from("%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF"));
  return filePath;
}
