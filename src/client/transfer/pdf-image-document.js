// Minimal one-page PDF that shows a JPEG, so board export needs no PDF library.
// Structure follows ISO 32000-1 §7.5 (header, objects, xref table, trailer).

export const PDF_MIME_TYPE = 'application/pdf';
// A4 landscape in PDF points (1/72 inch).
export const PDF_PAGE_WIDTH_PT = 842;
export const PDF_PAGE_HEIGHT_PT = 595;
export const PDF_PAGE_MARGIN_PT = 24;

const PDF_HEADER = '%PDF-1.4\n%âãÏÓ\n';
const XREF_OFFSET_DIGITS = 10;
const XREF_GENERATION_DIGITS = 5;
const IMAGE_NAME = 'Im0';
const HALF = 0.5;
const POINT_DECIMALS = 2;

const latin1 = (text) => Uint8Array.from(text, character => character.charCodeAt(0));
const pt = (value) => Number(value.toFixed(POINT_DECIMALS));

/** Where the image lands on the page: scaled to fit inside the margins, centred. */
export function pdfImagePlacement(imageWidth, imageHeight) {
  const boxW = PDF_PAGE_WIDTH_PT - PDF_PAGE_MARGIN_PT * 2;
  const boxH = PDF_PAGE_HEIGHT_PT - PDF_PAGE_MARGIN_PT * 2;
  const scale = Math.min(boxW / imageWidth, boxH / imageHeight);
  const w = imageWidth * scale, h = imageHeight * scale;
  return { x: pt((PDF_PAGE_WIDTH_PT - w) * HALF), y: pt((PDF_PAGE_HEIGHT_PT - h) * HALF), w: pt(w), h: pt(h) };
}

function objectChunks(jpegBytes, imageWidth, imageHeight) {
  const place = pdfImagePlacement(imageWidth, imageHeight);
  const content = `q ${place.w} 0 0 ${place.h} ${place.x} ${place.y} cm /${IMAGE_NAME} Do Q\n`;
  return [
    [latin1('<< /Type /Catalog /Pages 2 0 R >>')],
    [latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH_PT} ${PDF_PAGE_HEIGHT_PT}] `
      + `/Resources << /XObject << /${IMAGE_NAME} 4 0 R >> >> /Contents 5 0 R >>`)],
    [latin1(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`), jpegBytes, latin1('\nendstream')],
    [latin1(`<< /Length ${content.length} >>\nstream\n${content}endstream`)],
  ];
}

const xrefEntry = (offset) => `${String(offset).padStart(XREF_OFFSET_DIGITS, '0')} ${'0'.repeat(XREF_GENERATION_DIGITS)} n \n`;

/** Bytes of a PDF whose single A4 landscape page shows the given JPEG. */
export function createImagePdf(jpegBytes, imageWidth, imageHeight) {
  const parts = [latin1(PDF_HEADER)];
  let length = parts[0].length;
  const offsets = [];
  const push = (bytes) => { parts.push(bytes); length += bytes.length; };
  objectChunks(jpegBytes, imageWidth, imageHeight).forEach((chunks, index) => {
    offsets.push(length);
    push(latin1(`${index + 1} 0 obj\n`));
    chunks.forEach(push);
    push(latin1('\nendobj\n'));
  });
  const xrefOffset = length;
  const objectCount = offsets.length + 1;
  push(latin1(`xref\n0 ${objectCount}\n0000000000 65535 f \n${offsets.map(xrefEntry).join('')}`
    + `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  const pdf = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) { pdf.set(part, cursor); cursor += part.length; }
  return pdf;
}
