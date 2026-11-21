// A small, valid PDF made in the test, so no binary fixture is needed: each page either says some words in
// Helvetica or is only a drawing, as a scanned page is to a reader of words.

export type PdfPage = { readonly words: string } | { readonly drawing: true };

const escaped = (text: string): string => text.replaceAll(/[\\()]/gu, (character) => `\\${character}`);

const contentOf = (page: PdfPage): string =>
  "words" in page ? `BT /F1 14 Tf 24 120 Td (${escaped(page.words)}) Tj ET` : "0.2 0.4 0.6 rg 24 24 160 120 re f";

export const pdfOf = (pages: readonly PdfPage[]): Buffer => {
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((page, index) => {
      const content = contentOf(page);
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Contents ${String((pageIds[index] ?? 0) + 1)} 0 R ` +
          "/Resources << /Font << /F1 3 0 R >> >> >>",
        `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
      ];
    }),
  ];
  const header = "%PDF-1.4\n";
  const bodies = objects.map((body, index) => `${String(index + 1)} 0 obj\n${body}\nendobj\n`);
  const offsets = bodies.reduce<readonly number[]>(
    (all, _, index) => [...all, header.length + bodies.slice(0, index).join("").length],
    [],
  );
  const start = header.length + bodies.join("").length;
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const trailer =
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${table}` +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(start)}\n%%EOF\n`;
  return Buffer.from(`${header}${bodies.join("")}${trailer}`, "latin1");
};
