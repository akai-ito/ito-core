import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isImage, readDimensions } from "#attachments/media.ts";
import { fixtureDirectory } from "#protocol/tools/transcript-files.ts";

const png = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
};

const gif = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(10);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
};

const webp = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "ascii");
  header.write("WEBP", 8, "ascii");
  header.write("VP8X", 12, "ascii");
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
};

describe("image dimensions", () => {
  it("are read from the headers of JPEG, PNG, GIF and WebP", () => {
    const photo = readFileSync(path.join(fixtureDirectory, "riverside.jpg"));
    expect(readDimensions(photo, "image/jpeg")).toEqual({
      width: 160,
      height: 120,
    });
    expect(readDimensions(png(2048, 1536), "image/png")).toEqual({ width: 2048, height: 1536 });
    expect(readDimensions(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
    expect(readDimensions(webp(1024, 768), "image/webp")).toEqual({ width: 1024, height: 768 });
  });

  it("are left out for anything else, or for bytes that don't match their type", () => {
    expect(readDimensions(png(10, 10), "image/jpeg")).toBeUndefined();
    expect(readDimensions(png(0, 0), "image/png")).toBeUndefined();
    expect(readDimensions(Buffer.from("date,km\n"), "text/csv")).toBeUndefined();
    expect(isImage("IMAGE/PNG")).toBe(true);
    expect(isImage("image/heic")).toBe(false);
  });
});
