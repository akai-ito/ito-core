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

export const readDimensions = (bytes: Buffer, mediaType: string): Dimensions | undefined => {
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
