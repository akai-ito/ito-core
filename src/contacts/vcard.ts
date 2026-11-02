import { randomUUID } from "node:crypto";
import { fail, ok, type Result } from "#result.ts";

// A vCard 3.0 or 4.0, as iCloud keeps contacts: read into the facts Kumo works with, and changed a property at a
// time, so everything Kumo doesn't touch, such as a photo, stays exactly as it was.

export type Parameter = { readonly name: string; readonly values: readonly string[] };

export type Line = {
  readonly group?: string;
  readonly name: string;
  readonly params: readonly Parameter[];
  // Still escaped, as written.
  readonly value: string;
  // The whole line as it came, unfolded, so an untouched line is written back exactly.
  readonly raw?: string;
};

export type VCard = { readonly version: string; readonly lines: readonly Line[] };

export type Labelled = { readonly value: string; readonly label?: string; readonly preferred?: boolean };

export type PostalAddress = {
  readonly label?: string;
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postcode: string;
  readonly country: string;
};

export type DayOfYear = { readonly month: number; readonly day: number; readonly year?: number };

export type LabelledDay = DayOfYear & { readonly label: string };

export type Related = { readonly name: string; readonly label?: string };

export type Facts = {
  readonly uid: string;
  readonly name: string;
  readonly given?: string;
  readonly family?: string;
  readonly nickname?: string;
  readonly emails: readonly Labelled[];
  readonly phones: readonly Labelled[];
  readonly addresses: readonly PostalAddress[];
  readonly birthday?: DayOfYear;
  readonly dates: readonly LabelledDay[];
  readonly organisation?: string;
  readonly title?: string;
  readonly related: readonly Related[];
  readonly note?: string;
  // An iCloud group, which lives among the contacts as a card of its own.
  readonly isGroup: boolean;
};

// What a change can do to a contact's facts. Absent means leave it; a removal names what goes.
export type Change = {
  readonly name?: string;
  readonly nickname?: string;
  readonly addEmails?: readonly Labelled[];
  readonly removeEmails?: readonly string[];
  readonly addPhones?: readonly Labelled[];
  readonly removePhones?: readonly string[];
  readonly addAddresses?: readonly PostalAddress[];
  readonly removeAddresses?: readonly string[];
  readonly birthday?: DayOfYear;
  readonly organisation?: string;
  readonly title?: string;
  readonly addRelated?: readonly Related[];
  readonly removeRelated?: readonly string[];
  // The one line Kumo keeps in the notes, such as "Last caught up: Nov 2026 · coffee in Soho".
  readonly caughtUp?: string;
  // Lines added to the notes when cards are merged, so nothing they wrote is lost.
  readonly appendNote?: string;
};

export const caughtUpPrefix = "Last caught up:";

const productId = "-//Ito//Kumo//EN";

// Apple's own labels, written _$!<Mobile>!$_, which its apps show in the person's language.
const appleLabels: Readonly<Record<string, string>> = {
  other: "Other",
  home: "Home",
  work: "Work",
  mobile: "Mobile",
  main: "Main",
  "home fax": "HomeFAX",
  "work fax": "WorkFAX",
  pager: "Pager",
  "home page": "HomePage",
  anniversary: "Anniversary",
  father: "Father",
  mother: "Mother",
  parent: "Parent",
  brother: "Brother",
  sister: "Sister",
  child: "Child",
  friend: "Friend",
  spouse: "Spouse",
  partner: "Partner",
  assistant: "Assistant",
  manager: "Manager",
};

// TYPE values that are labels, as Kumo says them; the rest, such as INTERNET or VOICE, are kinds of value.
const typeLabels: Readonly<Record<string, string>> = {
  home: "home",
  work: "work",
  cell: "mobile",
  mobile: "mobile",
  iphone: "iPhone",
  main: "main",
  pager: "pager",
  other: "other",
  school: "school",
};

// Unfolding: a line that starts with a space or a tab carries on the one before.
const unfold = (text: string): readonly string[] =>
  text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .reduce<readonly string[]>((lines, line) => {
      if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
        return [...lines.slice(0, -1), `${lines.at(-1) ?? ""}${line.slice(1)}`];
      }
      return line === "" ? lines : [...lines, line];
    }, []);

const codePoints = (text: string): readonly string[] => text.match(/[\s\S]/gu) ?? [];

// Splits at a character outside double quotes.
const splitOutsideQuotes = (text: string, separator: string): readonly string[] => {
  const pieces = codePoints(text).reduce<{
    readonly done: readonly string[];
    readonly current: string;
    readonly quoted: boolean;
  }>(
    ({ done, current, quoted }, character) => {
      if (character === '"') return { done, current: current + character, quoted: !quoted };
      if (character === separator && !quoted) return { done: [...done, current], current: "", quoted };
      return { done, current: current + character, quoted };
    },
    { done: [], current: "", quoted: false },
  );
  return [...pieces.done, pieces.current];
};

const unquote = (text: string): string => (text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);

const toParameter = (text: string): Parameter => {
  const equals = text.indexOf("=");
  // vCard 2.1 writes a bare type, such as TEL;CELL.
  if (equals === -1) return { name: "TYPE", values: [text.toLowerCase()] };
  return {
    name: text.slice(0, equals).toUpperCase(),
    values: splitOutsideQuotes(text.slice(equals + 1), ",").map((value) => unquote(value)),
  };
};

const toLine = (raw: string): Line | undefined => {
  const [head = "", ...rest] = splitOutsideQuotes(raw, ":");
  if (rest.length === 0) return undefined;
  const [property = "", ...parameters] = splitOutsideQuotes(head, ";");
  const dot = property.indexOf(".");
  const name = (dot === -1 ? property : property.slice(dot + 1)).toUpperCase();
  return {
    ...(dot !== -1 && { group: property.slice(0, dot) }),
    name,
    params: parameters.map((parameter) => toParameter(parameter)),
    value: rest.join(":"),
    raw,
  };
};

export const parseVCard = (text: string): Result<VCard, string> => {
  const lines = unfold(text)
    .map((line) => toLine(line))
    .filter((line) => line !== undefined);
  const begins = lines.findIndex((line) => line.name === "BEGIN" && line.value.toUpperCase() === "VCARD");
  const ends = lines.findLastIndex((line) => line.name === "END" && line.value.toUpperCase() === "VCARD");
  if (begins === -1 || ends <= begins) return fail("That isn't a vCard.");
  const inside = lines.slice(begins + 1, ends);
  const version = inside.find((line) => line.name === "VERSION")?.value.trim() ?? "3.0";
  return ok({ version, lines: inside });
};

export const unescapeText = (value: string): string =>
  value.replaceAll(/\\(.)/gu, (_match, character: string) =>
    character === "n" || character === "N" ? "\n" : character,
  );

export const escapeText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(",", String.raw`\,`)
    .replaceAll(";", String.raw`\;`)
    .replaceAll("\n", String.raw`\n`);

// A structured value's parts, such as N or ADR, split at each unescaped semicolon.
const partsOf = (value: string): readonly string[] => value.split(/(?<!\\);/u).map((part) => unescapeText(part));

const joinParts = (parts: readonly string[]): string => parts.map((part) => escapeText(part)).join(";");

const typesOf = (line: Line): readonly string[] =>
  line.params
    .filter((parameter) => parameter.name === "TYPE")
    .flatMap((parameter) => parameter.values.flatMap((value) => value.split(",")))
    .map((value) => value.toLowerCase());

const isPreferred = (line: Line): boolean =>
  typesOf(line).includes("pref") || line.params.some((parameter) => parameter.name === "PREF");

// _$!<HomePage>!$_ reads "home page"; a label of their own reads as written.
export const readLabel = (text: string): string => {
  const apple = /^_\$!<(?<name>.+)>!\$_$/u.exec(text.trim())?.groups?.name;
  if (apple === undefined) return text.trim();
  if (apple === "HomeFAX") return "home fax";
  if (apple === "WorkFAX") return "work fax";
  return apple.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, " ").toLowerCase();
};

const labelOf = (line: Line, lines: readonly Line[]): string | undefined => {
  const named =
    line.group === undefined
      ? undefined
      : lines.find((other) => other.group?.toLowerCase() === line.group?.toLowerCase() && other.name === "X-ABLABEL");
  if (named) return readLabel(unescapeText(named.value));
  const types = typesOf(line);
  const fax = types.includes("fax");
  const label = types.map((type) => typeLabels[type]).find((found) => found !== undefined);
  if (fax) return label === undefined ? "fax" : `${label} fax`;
  return label;
};

const toDay = (value: string, parameters: readonly Parameter[]): DayOfYear | undefined => {
  const omitsYear = parameters.some((parameter) => parameter.name === "X-APPLE-OMIT-YEAR");
  const text = value.trim();
  const full = /^(?<year>\d{4})-?(?<month>\d{2})-?(?<day>\d{2})/u.exec(text)?.groups;
  const yearless = /^--(?<month>\d{2})-?(?<day>\d{2})/u.exec(text)?.groups;
  const found = full ?? yearless;
  if (!found) return undefined;
  const month = Number(found.month);
  const day = Number(found.day);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = full && !omitsYear ? Number(full.year) : undefined;
  return { month, day, ...(year !== undefined && { year }) };
};

const valueOf = (lines: readonly Line[], name: string): string | undefined => {
  const line = lines.find((candidate) => candidate.name === name);
  const text = line === undefined ? undefined : unescapeText(line.value).trim();
  return text === undefined || text === "" ? undefined : text;
};

const bareMail = (value: string): string => value.replace(/^mailto:/iu, "").trim();

const barePhone = (value: string): string => value.replace(/^tel:/iu, "").trim();

const relatedOf = (line: Line, lines: readonly Line[]): Related | undefined => {
  const name = unescapeText(line.value)
    .replace(/^urn:uuid:.*$/iu, "")
    .trim();
  if (name === "") return undefined;
  const label = labelOf(line, lines) ?? typesOf(line).find((type) => type !== "pref");
  return { name, ...(label !== undefined && { label }) };
};

export const factsOf = (card: VCard, fallbackUid: string): Facts => {
  const { lines } = card;
  const [family = "", given = ""] = partsOf(lines.find((line) => line.name === "N")?.value ?? "");
  const organisation = partsOf(lines.find((line) => line.name === "ORG")?.value ?? "")
    .filter((part) => part.trim() !== "")
    .join(", ");
  const isGroup =
    (valueOf(lines, "X-ADDRESSBOOKSERVER-KIND") ?? valueOf(lines, "KIND") ?? "").toLowerCase() === "group";
  const fullName = valueOf(lines, "FN") ?? [given, family].filter(Boolean).join(" ");
  const birthdayLine = lines.find((line) => line.name === "BDAY");
  const birthday = birthdayLine && toDay(birthdayLine.value, birthdayLine.params);
  const labelled = (name: string, clean: (value: string) => string): readonly Labelled[] =>
    lines
      .filter((line) => line.name === name)
      .flatMap((line) => {
        const value = clean(unescapeText(line.value));
        const label = labelOf(line, lines);
        return value === ""
          ? []
          : { value, ...(label !== undefined && { label }), ...(isPreferred(line) && { preferred: true }) };
      });
  const dates = lines
    .filter((line) => line.name === "X-ABDATE" || line.name === "ANNIVERSARY")
    .flatMap((line) => {
      const day = toDay(line.value, line.params);
      return day
        ? { ...day, label: line.name === "ANNIVERSARY" ? "anniversary" : (labelOf(line, lines) ?? "date") }
        : [];
    });
  return {
    uid: valueOf(lines, "UID") ?? fallbackUid,
    name: fullName || organisation,
    ...(given.trim() !== "" && { given: given.trim() }),
    ...(family.trim() !== "" && { family: family.trim() }),
    ...(valueOf(lines, "NICKNAME") !== undefined && { nickname: valueOf(lines, "NICKNAME") }),
    emails: labelled("EMAIL", bareMail),
    phones: labelled("TEL", barePhone),
    addresses: lines
      .filter((line) => line.name === "ADR")
      .flatMap((line) => {
        const [street = "", city = "", region = "", postcode = "", country = ""] = partsOf(line.value).slice(2);
        const label = labelOf(line, lines);
        const address = {
          street: street.trim(),
          city: city.trim(),
          region: region.trim(),
          postcode: postcode.trim(),
          country: country.trim(),
        };
        return Object.values(address).every((part) => part === "")
          ? []
          : { ...(label !== undefined && { label }), ...address };
      }),
    ...(birthday && { birthday }),
    dates,
    ...(organisation !== "" && { organisation }),
    ...(valueOf(lines, "TITLE") !== undefined && { title: valueOf(lines, "TITLE") }),
    related: lines
      .filter((line) => line.name === "X-ABRELATEDNAMES" || line.name === "RELATED")
      .flatMap((line) => relatedOf(line, lines) ?? []),
    ...(valueOf(lines, "NOTE") !== undefined && { note: valueOf(lines, "NOTE") }),
    isGroup,
  };
};

// Writing: one line, folded at 75 octets without splitting a character.

const encoder = new TextEncoder();

// Each piece at most 75 octets, the ones after the first after a leading space.
const fold = (line: string): string => {
  const folded = codePoints(line).reduce<{
    readonly done: readonly string[];
    readonly current: string;
    readonly bytes: number;
  }>(
    ({ done, current, bytes }, character) => {
      const size = encoder.encode(character).length;
      const limit = done.length === 0 ? 75 : 74;
      return bytes + size > limit
        ? { done: [...done, current], current: character, bytes: size }
        : { done, current: current + character, bytes: bytes + size };
    },
    { done: [], current: "", bytes: 0 },
  );
  return [...folded.done, folded.current].join("\r\n ");
};

const parameterText = ({ name, values }: Parameter): string =>
  `${name}=${values.map((value) => (/[:;,]/u.test(value) ? `"${value}"` : value)).join(",")}`;

const lineText = (line: Line): string =>
  line.raw ??
  `${line.group === undefined ? "" : `${line.group}.`}${line.name}${line.params.map((parameter) => `;${parameterText(parameter)}`).join("")}:${line.value}`;

export const writeVCard = ({ lines }: VCard): string =>
  ["BEGIN:VCARD", ...lines.map((line) => lineText(line)), "END:VCARD"]
    .map((line) => fold(line))
    .join("\r\n")
    .concat("\r\n");

// Changing: each change replaces or adds lines, and a removal takes its whole group, such as its label.

const typeParameter = (version: string, ...types: readonly string[]): Parameter => ({
  name: "TYPE",
  values: types.map((type) => (version.startsWith("4") ? type.toLowerCase() : type.toUpperCase())),
});

const labelValue = (label: string): string => {
  const apple = appleLabels[label.toLowerCase()];
  return apple === undefined ? escapeText(label) : `_$!<${apple}>!$_`;
};

const nextGroup = (lines: readonly Line[]): string => {
  const used = lines.flatMap((line) => {
    const number = /^item(?<number>\d+)$/iu.exec(line.group ?? "")?.groups?.number;
    return number === undefined ? [] : Number(number);
  });
  return `item${String(Math.max(0, ...used) + 1)}`;
};

// A labelled value as lines: a type Apple knows as a parameter, any other label as a group with X-ABLabel.
const labelledLines = (
  lines: readonly Line[],
  version: string,
  name: string,
  value: string,
  label: string | undefined,
  types: Readonly<Record<string, readonly string[]>>,
  base: readonly string[],
): readonly Line[] => {
  const known = label === undefined ? undefined : types[label.toLowerCase()];
  if (label === undefined || known !== undefined) {
    const all = [...base, ...(known ?? [])];
    return [{ name, params: all.length === 0 ? [] : [typeParameter(version, ...all)], value }];
  }
  const group = nextGroup(lines);
  return [
    { group, name, params: base.length === 0 ? [] : [typeParameter(version, ...base)], value },
    { group, name: "X-ABLABEL", params: [], value: labelValue(label) },
  ];
};

const emailTypes: Readonly<Record<string, readonly string[]>> = { home: ["HOME"], work: ["WORK"] };

const phoneTypes: Readonly<Record<string, readonly string[]>> = {
  mobile: ["CELL", "VOICE"],
  iphone: ["IPHONE", "CELL", "VOICE"],
  home: ["HOME", "VOICE"],
  work: ["WORK", "VOICE"],
  main: ["MAIN"],
  "home fax": ["HOME", "FAX"],
  "work fax": ["WORK", "FAX"],
  pager: ["PAGER"],
};

const addressTypes: Readonly<Record<string, readonly string[]>> = { home: ["HOME"], work: ["WORK"] };

export const sameMail = (left: string, right: string): boolean =>
  bareMail(left).toLowerCase() === bareMail(right).toLowerCase();

const digits = (phone: string): string => barePhone(phone).replaceAll(/\D/gu, "");

// The same number written differently, such as +44 7700 900123 and 07700 900123.
export const samePhone = (left: string, right: string): boolean => {
  const [a, b] = [digits(left), digits(right)];
  if (a === "" || b === "") return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const local = shorter.replace(/^0/u, "");
  return a === b || (local.length >= 7 && longer.endsWith(local));
};

const withoutGroups = (lines: readonly Line[], doomed: readonly Line[]): readonly Line[] => {
  const groups = new Set(doomed.flatMap((line) => line.group ?? []));
  return lines.filter((line) => !doomed.includes(line) && (line.group === undefined || !groups.has(line.group)));
};

const setSingle = (lines: readonly Line[], name: string, line: Line | undefined): readonly Line[] => {
  const index = lines.findIndex((candidate) => candidate.name === name);
  if (line === undefined) return lines.filter((candidate) => candidate.name !== name);
  if (index === -1) return [...lines, line];
  return [...lines.slice(0, index), line, ...lines.slice(index + 1).filter((candidate) => candidate.name !== name)];
};

const twoDigits = (number: number): string => String(number).padStart(2, "0");

const birthdayLine = (version: string, { year, month, day }: DayOfYear): Line => {
  if (version.startsWith("4")) {
    return {
      name: "BDAY",
      params: [],
      value:
        year === undefined
          ? `--${twoDigits(month)}${twoDigits(day)}`
          : `${String(year)}${twoDigits(month)}${twoDigits(day)}`,
    };
  }
  return year === undefined
    ? {
        name: "BDAY",
        params: [{ name: "X-APPLE-OMIT-YEAR", values: ["1604"] }],
        value: `1604-${twoDigits(month)}-${twoDigits(day)}`,
      }
    : {
        name: "BDAY",
        params: [{ name: "VALUE", values: ["date"] }],
        value: `${String(year)}-${twoDigits(month)}-${twoDigits(day)}`,
      };
};

const splitName = (name: string): { readonly given: string; readonly family: string } => {
  const words = name.trim().split(/\s+/u);
  return words.length <= 1
    ? { given: words[0] ?? "", family: "" }
    : { given: words.slice(0, -1).join(" "), family: words.at(-1) ?? "" };
};

const isCaughtUp = (line: string): boolean => line.trimStart().startsWith(caughtUpPrefix);

// Their own notes stay as they are; Kumo's one line goes last, in place of the one before.
const withNote = (lines: readonly Line[], caughtUp: string | undefined, append = ""): readonly Line[] => {
  const current = (valueOf(lines, "NOTE") ?? "").split("\n");
  const theirs = current.filter((line) => !isCaughtUp(line));
  const added = append.split("\n").filter((line) => line.trim() !== "" && !current.includes(line));
  const kumo = caughtUp ?? current.find((line) => isCaughtUp(line));
  const note = [...theirs, ...added.filter((line) => !isCaughtUp(line)), ...(kumo === undefined ? [] : [kumo])]
    .join("\n")
    .trim();
  return setSingle(lines, "NOTE", note === "" ? undefined : { name: "NOTE", params: [], value: escapeText(note) });
};

const matchesAddress = (address: PostalAddress, wanted: string): boolean => {
  const text = [address.street, address.city, address.postcode].join(" ").toLowerCase();
  return wanted.trim() !== "" && text.includes(wanted.trim().toLowerCase());
};

const stamp = (now: Date): string => `${now.toISOString().slice(0, 19)}Z`;

export const applyChange = (card: VCard, change: Change, now: Date): VCard => {
  const { version } = card;
  const steps: readonly ((lines: readonly Line[]) => readonly Line[])[] = [
    (lines) => {
      if (change.name === undefined) return lines;
      const { given, family } = splitName(change.name);
      const old = partsOf(lines.find((line) => line.name === "N")?.value ?? "");
      const parts = [family, given, old[2] ?? "", old[3] ?? "", old[4] ?? ""];
      return setSingle(setSingle(lines, "FN", { name: "FN", params: [], value: escapeText(change.name) }), "N", {
        name: "N",
        params: [],
        value: joinParts(parts),
      });
    },
    (lines) =>
      change.nickname === undefined
        ? lines
        : setSingle(lines, "NICKNAME", { name: "NICKNAME", params: [], value: escapeText(change.nickname) }),
    (lines) =>
      withoutGroups(
        lines,
        lines.filter(
          (line) =>
            line.name === "EMAIL" &&
            (change.removeEmails ?? []).some((gone) => sameMail(unescapeText(line.value), gone)),
        ),
      ),
    (lines) =>
      (change.addEmails ?? []).reduce(
        (all, { value, label }) =>
          all.some((line) => line.name === "EMAIL" && sameMail(unescapeText(line.value), value))
            ? all
            : [
                ...all,
                ...labelledLines(
                  all,
                  version,
                  "EMAIL",
                  escapeText(value),
                  label,
                  emailTypes,
                  version.startsWith("4") ? [] : ["INTERNET"],
                ),
              ],
        lines,
      ),
    (lines) =>
      withoutGroups(
        lines,
        lines.filter(
          (line) =>
            line.name === "TEL" &&
            (change.removePhones ?? []).some((gone) => samePhone(unescapeText(line.value), gone)),
        ),
      ),
    (lines) =>
      (change.addPhones ?? []).reduce(
        (all, { value, label }) =>
          all.some((line) => line.name === "TEL" && samePhone(unescapeText(line.value), value))
            ? all
            : [...all, ...labelledLines(all, version, "TEL", escapeText(value), label, phoneTypes, [])],
        lines,
      ),
    (lines) =>
      withoutGroups(
        lines,
        lines.filter((line) => {
          if (line.name !== "ADR") return false;
          const [street = "", city = "", region = "", postcode = "", country = ""] = partsOf(line.value).slice(2);
          return (change.removeAddresses ?? []).some((gone) =>
            matchesAddress({ street, city, region, postcode, country }, gone),
          );
        }),
      ),
    (lines) =>
      (change.addAddresses ?? []).reduce((all, address) => {
        const value = joinParts([
          "",
          "",
          address.street,
          address.city,
          address.region,
          address.postcode,
          address.country,
        ]);
        const isThere = all.some(
          (line) =>
            line.name === "ADR" &&
            partsOf(line.value).slice(2).join("|").toLowerCase() === partsOf(value).slice(2).join("|").toLowerCase(),
        );
        return isThere ? all : [...all, ...labelledLines(all, version, "ADR", value, address.label, addressTypes, [])];
      }, lines),
    (lines) =>
      change.birthday === undefined ? lines : setSingle(lines, "BDAY", birthdayLine(version, change.birthday)),
    (lines) => {
      if (change.organisation === undefined) return lines;
      const old = partsOf(lines.find((line) => line.name === "ORG")?.value ?? "");
      return setSingle(lines, "ORG", {
        name: "ORG",
        params: [],
        value: joinParts([change.organisation, ...old.slice(1)]),
      });
    },
    (lines) =>
      change.title === undefined
        ? lines
        : setSingle(lines, "TITLE", { name: "TITLE", params: [], value: escapeText(change.title) }),
    (lines) =>
      withoutGroups(
        lines,
        lines.filter(
          (line) =>
            (line.name === "X-ABRELATEDNAMES" || line.name === "RELATED") &&
            (change.removeRelated ?? []).some(
              (gone) => unescapeText(line.value).trim().toLowerCase() === gone.trim().toLowerCase(),
            ),
        ),
      ),
    (lines) =>
      (change.addRelated ?? []).reduce(
        (all, { name, label = "other" }) =>
          all.some(
            (line) =>
              (line.name === "X-ABRELATEDNAMES" || line.name === "RELATED") &&
              unescapeText(line.value).trim().toLowerCase() === name.trim().toLowerCase(),
          )
            ? all
            : [...all, ...labelledLines(all, version, "X-ABRELATEDNAMES", escapeText(name), label, {}, [])],
        lines,
      ),
    (lines) =>
      change.caughtUp === undefined && change.appendNote === undefined
        ? lines
        : withNote(lines, change.caughtUp, change.appendNote),
  ];
  const changed = steps.reduce((lines, step) => step(lines), card.lines);
  return { version, lines: setSingle(changed, "REV", { name: "REV", params: [], value: stamp(now) }) };
};

// A new contact, as vCard 3.0, the version iCloud keeps.
export const newVCard = (name: string, change: Change, now: Date, uid = randomUUID().toUpperCase()): VCard => {
  const { given, family } = splitName(name);
  const base: VCard = {
    version: "3.0",
    lines: [
      { name: "VERSION", params: [], value: "3.0" },
      { name: "PRODID", params: [], value: productId },
      { name: "N", params: [], value: joinParts([family, given, "", "", ""]) },
      { name: "FN", params: [], value: escapeText(name) },
      { name: "UID", params: [], value: uid },
    ],
  };
  return applyChange(base, change, now);
};

// Merging: everything the other cards say that the kept one doesn't, so no detail is lost with the cards removed.

// What the facts already merge, and what belongs to the card itself, such as its own UID or how it shows.
const ownProperties: ReadonlySet<string> = new Set([
  "VERSION",
  "PRODID",
  "UID",
  "X-ABUID",
  "REV",
  "N",
  "FN",
  "NICKNAME",
  "EMAIL",
  "TEL",
  "ADR",
  "BDAY",
  "ORG",
  "TITLE",
  "NOTE",
  "X-ABRELATEDNAMES",
  "RELATED",
  "KIND",
  "X-ADDRESSBOOKSERVER-KIND",
  "X-ADDRESSBOOKSERVER-MEMBER",
  "X-ABSHOWAS",
]);

// What a card has one of: another card's comes along only when the kept card has none, such as its photo.
const singleProperties: ReadonlySet<string> = new Set([
  "PHOTO",
  "LOGO",
  "GENDER",
  "X-MAIDENNAME",
  "X-PHONETIC-FIRST-NAME",
  "X-PHONETIC-MIDDLE-NAME",
  "X-PHONETIC-LAST-NAME",
  "X-PHONETIC-ORG",
]);

// Lines that only describe the line beside them in their group, such as its label.
const describing: ReadonlySet<string> = new Set(["X-ABLABEL", "X-ABADR"]);

// A card's lines as items: a line alone, or the lines of one group, such as a date with its label.
const itemsOf = (lines: readonly Line[]): readonly (readonly Line[])[] => [
  ...lines.filter((line) => line.group === undefined).map((line) => [line]),
  ...Map.groupBy(
    lines.filter((line) => line.group !== undefined),
    (line) => line.group?.toLowerCase() ?? "",
  ).values(),
];

const sameValue = (left: Line, right: Line): boolean =>
  left.name === right.name &&
  unescapeText(left.value).trim().toLowerCase() === unescapeText(right.value).trim().toLowerCase();

// An item from another card, if the kept lines lack it, in a group of its own among them.
const carried = (lines: readonly Line[], item: readonly Line[]): readonly Line[] => {
  const main = item.find((line) => !describing.has(line.name)) ?? item[0];
  if (main === undefined || ownProperties.has(main.name)) return lines;
  const isSingle = singleProperties.has(main.name);
  if (lines.some((line) => (isSingle ? line.name === main.name : sameValue(line, main)))) return lines;
  if (main.group === undefined) return [...lines, ...item];
  // Written out anew under its new group, rather than as it came under the old one.
  const group = nextGroup(lines);
  return [...lines, ...item.map(({ name, params, value }) => ({ group, name, params, value }))];
};

// Everything the others say that the kept card doesn't, as one change to it.
const mergeChange = (kept: Facts, others: readonly Facts[]): Change => {
  const emails = others
    .flatMap(({ emails: found }) => found)
    .filter(({ value }) => kept.emails.every((own) => !sameMail(own.value, value)));
  const phones = others
    .flatMap(({ phones: found }) => found)
    .filter(({ value }) => kept.phones.every((own) => !samePhone(own.value, value)));
  const birthday = kept.birthday ?? others.find((other) => other.birthday !== undefined)?.birthday;
  const organisation = kept.organisation ?? others.find((other) => other.organisation !== undefined)?.organisation;
  const title = kept.title ?? others.find((other) => other.title !== undefined)?.title;
  const notes = others.flatMap(({ note }) => note ?? []).join("\n");
  return {
    addEmails: emails.map(({ value, label }) => ({ value, ...(label !== undefined && { label }) })),
    addPhones: phones.map(({ value, label }) => ({ value, ...(label !== undefined && { label }) })),
    addAddresses: others.flatMap(({ addresses }) => addresses),
    addRelated: others.flatMap(({ related }) => related),
    ...(kept.birthday === undefined && birthday !== undefined && { birthday }),
    ...(kept.organisation === undefined && organisation !== undefined && { organisation }),
    ...(kept.title === undefined && title !== undefined && { title }),
    ...(kept.nickname === undefined &&
      others.some(({ nickname }) => nickname !== undefined) && {
        nickname: others.find(({ nickname }) => nickname !== undefined)?.nickname ?? "",
      }),
    ...(notes !== "" && { appendNote: notes }),
  };
};

// The kept card with everything the others say: their emails, phones, addresses, people and notes as facts, and
// every other line it lacks, such as a photo, a date or a profile, as written.
export const mergeCards = (kept: VCard, others: readonly VCard[], now: Date): VCard => {
  const changed = applyChange(
    kept,
    mergeChange(
      factsOf(kept, ""),
      others.map((other) => factsOf(other, "")),
    ),
    now,
  );
  const lines = others.flatMap((other) => itemsOf(other.lines)).reduce(carried, changed.lines);
  return { ...changed, lines };
};
