// The kinds of file a big upload may be, each with its own limit, and how to tell from a file's first bytes that it
// really is what its media type says.

export type UploadKind = "audio" | "image" | "file";

const audioTypes: ReadonlySet<string> = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "audio/amr",
  "audio/3gpp",
  "audio/x-caf",
  "audio/aiff",
  "audio/x-aiff",
]);

const imageTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const fileTypes: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/calendar",
  "text/vcard",
  "application/json",
  "application/rtf",
  "application/zip",
  "application/epub+zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.apple.pages",
  "application/vnd.apple.keynote",
  "application/vnd.apple.numbers",
]);

export const uploadKinds: readonly {
  readonly kind: UploadKind;
  readonly mediaTypes: ReadonlySet<string>;
}[] = [
  { kind: "audio", mediaTypes: audioTypes },
  { kind: "image", mediaTypes: imageTypes },
  { kind: "file", mediaTypes: fileTypes },
];

// The kind a big upload of this media type is, or undefined when big uploads don't take it.
export const uploadKindOf = (mediaType: string): UploadKind | undefined =>
  uploadKinds.find(({ mediaTypes }) => mediaTypes.has(mediaType))?.kind;

// How many leading bytes `looksLike` reads.
export const signatureBytes = 16;

const ascii = (bytes: Buffer, start: number, end: number): string => bytes.toString("latin1", start, end);

// An MPEG audio frame starts with eleven set bits, as an MP3 or ADTS AAC file does.
const allBits = 255;
const syncBits = 224;
const isFrameSync = (bytes: Buffer): boolean => bytes[0] === allBits && ((bytes[1] ?? 0) & syncBits) === syncBits;

// WebM and Matroska start with an EBML header.
const ebml = Buffer.from([26, 69, 223, 163]);

// Containers a recording comes in. The media type a phone gives is often a near miss (an M4A sent as audio/mp4, an
// MP3 as audio/mpeg), so any of them passes for any audio type, and the decoder works out which it is.
const isAudio = (bytes: Buffer): boolean =>
  ascii(bytes, 4, 8) === "ftyp" ||
  ascii(bytes, 0, 3) === "ID3" ||
  isFrameSync(bytes) ||
  (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") ||
  ascii(bytes, 0, 4) === "OggS" ||
  ascii(bytes, 0, 4) === "fLaC" ||
  bytes.subarray(0, 4).equals(ebml) ||
  ascii(bytes, 0, 5) === "#!AMR" ||
  ascii(bytes, 0, 4) === "caff" ||
  (ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 12)));

// Whether a file's first bytes fit its kind and media type. Only the kinds where a mislabelled file would do harm are
// checked: recordings, which the server decodes, and PDFs, which the app draws.
export const looksLike = (kind: UploadKind, mediaType: string, start: Buffer): boolean => {
  if (kind === "audio") return isAudio(start);
  if (mediaType === "application/pdf") return ascii(start, 0, 5) === "%PDF-";
  return true;
};

export const describeAudioFormats = "M4A, MP3, WAV, AAC, Ogg/Opus, FLAC, WebM, AMR, Core Audio or AIFF";
