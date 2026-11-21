import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";

// A PDF's words, page by page, and the pages with no words drawn as pictures, such as a scanned ticket. pdf.js never
// runs a PDF's scripts and, since version 6, never evaluates code, so nothing in the file runs; @napi-rs/canvas draws
// with its own bundled Skia, so the server needs no system libraries.

export type PdfReading = {
  readonly pages: number;
  // The words on each page read, in order, up to the first so many pages.
  readonly texts: readonly string[];
  // Pages with too few words to stand on their own, drawn as PNGs.
  readonly drawn: readonly { readonly page: number; readonly png: Buffer }[];
};

export type PdfLimits = { readonly mostPages: number; readonly mostDrawn: number };

const defaults: PdfLimits = { mostPages: 30, mostDrawn: 5 };

// A page with fewer letters than this is likely a picture of words, such as a scan or a ticket with a QR code.
const fewLetters = 40;
// Pages are drawn at most this wide, which keeps small print readable and the picture a sensible size.
const widestPx = 1600;

const pdfjsFolder = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

const folderUrl = (name: string): string => `${pathToFileURL(path.join(pdfjsFolder, name)).href}/`;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isPassword = (error: unknown): boolean => error instanceof Error && error.name === "PasswordException";

const lettersIn = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

type TextItem = { readonly str?: string; readonly hasEOL?: boolean };

const pageText = (items: readonly unknown[]): string =>
  items
    .map((item) => {
      const { str: string_ = "", hasEOL = false } = item as TextItem;
      return hasEOL ? `${string_}\n` : string_;
    })
    .join("")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

export const readPdf = async (content: Buffer, limits: PdfLimits = defaults): Promise<Result<PdfReading, string>> => {
  const task = getDocument({
    data: new Uint8Array(content),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
    standardFontDataUrl: folderUrl("standard_fonts"),
    cMapUrl: folderUrl("cmaps"),
    cMapPacked: true,
  });
  try {
    const document = await task.promise;
    const numbers = Array.from({ length: Math.min(document.numPages, limits.mostPages) }, (_, index) => index + 1);
    const texts = createCell<readonly string[]>([]);
    const drawn = createCell<PdfReading["drawn"]>([]);
    for (const number of numbers) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      texts.update((current) => [...current, text]);
      if (lettersIn(text) >= fewLetters || drawn.get().length >= limits.mostDrawn) continue;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, widestPx / natural.width) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      const png = await canvas.encode("png");
      drawn.update((current) => [...current, { page: number, png }]);
    }
    return ok({ pages: document.numPages, texts: texts.get(), drawn: drawn.get() });
  } catch (error) {
    return fail(
      isPassword(error)
        ? "It's protected by a password, so it can't be read."
        : `It couldn't be read as a PDF: ${describeError(error)}`,
    );
  } finally {
    await task.destroy();
  }
};
