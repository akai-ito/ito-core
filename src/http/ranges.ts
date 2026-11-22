// One byte range from a Range header, such as "bytes=0-1023", "bytes=1024-" or "bytes=-500", against a file's size.
// A header this doesn't understand, or several ranges, means the whole file, as HTTP allows.

export type ByteRange =
  | { readonly kind: "whole" }
  | { readonly kind: "part"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const pattern = /^bytes=(?<first>\d*)-(?<last>\d*)$/u;

export const parseRange = (header: string | undefined, size: number): ByteRange => {
  const groups = header === undefined ? undefined : pattern.exec(header.trim())?.groups;
  const first = groups?.first ?? "";
  const last = groups?.last ?? "";
  if (first === "" && last === "") return { kind: "whole" };
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 || size === 0
      ? { kind: "unsatisfiable" }
      : { kind: "part", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size) return { kind: "unsatisfiable" };
  return end < start ? { kind: "whole" } : { kind: "part", start, end };
};

// A Content-Disposition that keeps any name: plain ASCII for old readers, and the name itself in UTF-8.
export const inlineDisposition = (name: string): string => {
  const plain = name.replaceAll(/[^\u{20}-\u{7E}]|["\\]/gu, "_");
  return `inline; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};
