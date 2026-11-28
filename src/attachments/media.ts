export type Dimensions = { readonly width: number; readonly height: number };

const imageTypes: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const markerByte = 255;
const startOfImage = 216;
const firstFrameMarker = 192;
const lastFrameMarker = 207;
const markersThatAreNotFrames: ReadonlySet<number> = new Set([196, 200, 204]);
const fourteenBits = 16_383;

export const isImage = (mediaType: string): boolean => imageTypes.has(mediaType.toLowerCase());

const jpegDimensions = (bytes: Buffer, offset = 2): Dimensions | undefined => {
  if (offset + 9 > bytes.length || bytes[offset] !== markerByte) return undefined;
  const marker = bytes[offset + 1] ?? 0;
  const length = bytes.readUInt16BE(offset + 2);
  const isFrame = marker >= firstFrameMarker && marker <= lastFrameMarker && !markersThatAreNotFrames.has(marker);
  return isFrame
    ? { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    : jpegDimensions(bytes, offset + 2 + length);
};

const webpDimensions = (bytes: Buffer): Dimensions | undefined => {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & fourteenBits, height: bytes.readUInt16LE(28) & fourteenBits };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & fourteenBits) + 1, height: ((bits >> 14) & fourteenBits) + 1 };
  }
  return undefined;
};

const readHeader = (bytes: Buffer, mediaType: string): Dimensions | undefined => {
  switch (mediaType.toLowerCase()) {
    case "image/jpeg": {
      return bytes[0] === markerByte && bytes[1] === startOfImage ? jpegDimensions(bytes) : undefined;
    }
    case "image/png": {
      return bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG"
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : undefined;
    }
    case "image/gif": {
      return bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF"
        ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
        : undefined;
    }
    case "image/webp": {
      return bytes.length >= 16 && bytes.toString("ascii", 8, 12) === "WEBP" ? webpDimensions(bytes) : undefined;
    }
    default: {
      return undefined;
    }
  }
};

export const readDimensions = (bytes: Buffer, mediaType: string): Dimensions | undefined => {
  const dimensions = readHeader(bytes, mediaType);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
};

const exifMarker = 225;
const startOfScan = 218;
const exifPointerTag = 0x87_69;
const takenTag = 0x90_03;
const asciiType = 2;
const entryBytes = 12;

// The EXIF block's TIFF header, from a JPEG's APP1 segment, if it has one before its image data.
const exifOf = (bytes: Buffer, offset = 2): Buffer | undefined => {
  if (offset + 4 > bytes.length || bytes[offset] !== markerByte) return undefined;
  const marker = bytes[offset + 1] ?? 0;
  if (marker === startOfScan) return undefined;
  const length = bytes.readUInt16BE(offset + 2);
  return marker === exifMarker && bytes.toString("ascii", offset + 4, offset + 8) === "Exif"
    ? bytes.subarray(offset + 10, Math.min(bytes.length, offset + 2 + length))
    : exifOf(bytes, offset + 2 + length);
};

type Tiff = { readonly bytes: Buffer; readonly isLittle: boolean };

const short = ({ bytes, isLittle }: Tiff, at: number): number =>
  isLittle ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);

const long = ({ bytes, isLittle }: Tiff, at: number): number =>
  isLittle ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);

// The value at a tag in the directory at an offset: a number for a pointer, the offset of its text otherwise.
const entryOf = (tiff: Tiff, directory: number, tag: number): number | undefined => {
  if (directory + 2 > tiff.bytes.length) return undefined;
  const count = short(tiff, directory);
  const index = Array.from({ length: count }, (_, place) => directory + 2 + place * entryBytes).find(
    (at) => at + entryBytes <= tiff.bytes.length && short(tiff, at) === tag,
  );
  if (index === undefined) return undefined;
  if (tag === takenTag && short(tiff, index + 2) !== asciiType) return undefined;
  return long(tiff, index + 8);
};

// The local day a JPEG photo was taken, from its EXIF DateTimeOriginal, such as 2026-11-22; none when it doesn't say,
// as with a screenshot or a photo stripped of it.
export const readTakenDay = (bytes: Buffer): string | undefined => {
  if (bytes[0] !== markerByte || bytes[1] !== startOfImage) return undefined;
  const exif = exifOf(bytes);
  if (!exif || exif.length < 8) return undefined;
  const order = exif.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const tiff: Tiff = { bytes: exif, isLittle: order === "II" };
  const pointer = entryOf(tiff, long(tiff, 4), exifPointerTag);
  const at = pointer === undefined ? undefined : entryOf(tiff, pointer, takenTag);
  if (at === undefined || at + 10 > exif.length) return undefined;
  const taken = /^(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})/u.exec(exif.toString("ascii", at, at + 10))?.groups;
  return taken ? `${taken.year ?? ""}-${taken.month ?? ""}-${taken.day ?? ""}` : undefined;
};
