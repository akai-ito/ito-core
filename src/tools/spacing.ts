// Spaces Kumo dropped next to numbers, such as "As of4 Dec", "9Jan14:00" or "squat,60kg". It learnt to squeeze
// them out to fit a page under a character cap, and copies the habit from any such text it reads, so text that stays
// (memory and wake-ups) is checked as it's written, before it can spread.

const months =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

const gluedPatterns: readonly RegExp[] = [
  // A short word run into the number after it: "of4", "until9", "at14:00", "PB41:12".
  /\b(?:of|on|by|from|to|in|at|until|since|before|after|around|PB)\d+(?:[:.]\d+)*/gu,
  // A day run into its month, or a month into what follows: "9Jan", "9January", "Dec10:30".
  new RegExp(String.raw`\d+(?:${months})(?!\p{Ll})|\b(?:${months})\d+(?:[:.h]\d+)*`, "gu"),
  // No space after a comma or semicolon: "squat,60kg", "evening,no", "6h10;12 Jan".
  /[\p{L}\p{N}]+;(?=[\p{L}\p{N}])[\p{L}\p{N}]+|\p{L}+,(?=[\p{L}\p{N}])[\p{L}\p{N}]+|\p{N}+,(?=\p{L})\p{L}+/gu,
];

// What is written as it is on purpose: code, links and addresses.
const verbatim = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\]\([^)\s]*\)|\b[a-z][\w+.-]*:\/\/\S+|\bmemory:\S+/gu;

const mostShown = 5;

// The distinct glued pieces in the text, the first few.
export const gluedIn = (text: string): readonly string[] => {
  const prose = text.replaceAll(verbatim, " ");
  const found = gluedPatterns.flatMap((pattern) =>
    prose
      .matchAll(pattern)
      .map(([piece]) => piece)
      .toArray(),
  );
  return [...new Set(found)].slice(0, mostShown);
};

// Why text can't be saved as it is, or undefined when its spaces are all there.
export const missingSpaces = (texts: readonly string[]): string | undefined => {
  const glued = [...new Set(texts.flatMap((text) => gluedIn(text)))].slice(0, mostShown);
  return glued.length === 0
    ? undefined
    : `Not saved: spaces are missing next to numbers in ${glued.map((piece) => `“${piece}”`).join(", ")}. ` +
        "Write it again with a space on each side, as in “as of 4 Dec” and “squat, 60 kg”: nothing has a length " +
        "cap, so never drop spaces to make text fit. Anything meant exactly as written goes in backticks.";
};
