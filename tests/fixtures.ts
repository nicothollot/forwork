import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from "pdf-lib";

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
