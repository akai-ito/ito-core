import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import type { Host } from "#capabilities/host.ts";
import type { Values } from "#capabilities/manifest.ts";
import { isConflict, isRejected, type AddressBook, type ContactsSource, type StoredCard } from "#contacts/carddav.ts";
import {
  applyChange,
  caughtUpPrefix,
  factsOf,
  mergeCards,
  newVCard,
  parseVCard,
  sameMail,
  samePhone,
  writeVCard,
  type Change,
  type DayOfYear,
  type Facts,
  type Labelled,
  type PostalAddress,
  type Related,
  type VCard,
} from "#contacts/vcard.ts";
import { dayMs, toLocal } from "#desk/day.ts";
import type { CardAnswer, DeskKeeper } from "#desk/desk.ts";
import type { Health } from "#problems/problems.ts";
import type { Card } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { icloudSource } from "#sources/sources.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Their iCloud Contacts, the source of truth for the facts about people: names, labelled emails and phones,
// addresses, birthdays, work. Kumo keeps them current on its own, each change in Done with an undo; deleting
// or merging cards waits for one question on the Desk. The story about a person stays on their People page.

export type Person = {
  readonly url: string;
  readonly book: AddressBook;
  readonly etag?: string;
  readonly facts: Facts;
};

// A People page in memory, and the contact it's linked to, if any.
export type PersonPage = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly contact?: string;
};

// When mail last came from an address, and when they last wrote to it, as instants.
export type AddressUse = (address: string) => Promise<{ readonly from?: string; readonly to?: string }>;

export type Recipient = { readonly address: string; readonly name: string; readonly why: string };

export type Contacts = {
  readonly tools: readonly Tool[];
  readonly check: (values: Values) => Promise<Result<{ readonly books: number }, string>>;
  readonly refresh: () => Promise<void>;
  // One line on who writes from an address, for reading a mail, or undefined when they aren't in Contacts.
  readonly known: (address: string) => Promise<string | undefined>;
  // The address to write to someone named, picked for the context, or why it can't be picked.
  readonly recipient: (given: string, use: AddressUse) => Promise<Result<Recipient, string>>;
  readonly close: () => void;
};

export type ContactsOptions = {
  readonly host: Pick<Host, "find" | "subscribe">;
  readonly store: Pick<Store, "setting" | "setSetting">;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly info: Info;
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly people: () => Promise<readonly PersonPage[]>;
  readonly createSource: (values: Values) => ContactsSource;
  readonly onHealth?: (health: Health) => void;
  readonly pollMs?: number;
};

type Restore = { readonly url: string; readonly book: AddressBook; readonly before?: string; readonly after?: string };

// Puts cards back as they were: a card Kumo added goes, one it changed or removed comes back.
type ContactsUndo = {
  readonly kind: "contacts_restore";
  readonly name: string;
  readonly restores: readonly Restore[];
  readonly unmerge?: readonly string[];
};

type Ask = {
  readonly card: string;
  readonly action: "merge" | "delete";
  readonly urls: readonly string[];
  readonly reason: string;
};

export const asksSetting = "contacts_asks";
export const mergedSetting = "contacts_merged";
export const datesToldSetting = "contacts_dates_told";
export const datesCheckedSetting = "contacts_dates_checked";

// How many days ahead a birthday or another date is worth a line.
export const datesAheadDays = 4;
const freshMs = 60 * 1000;
const mostResults = 25;
const recentUseMs = 2 * 365 * dayMs;

const ignore = (): void => undefined;

const listField = (description: string): Readonly<Record<string, unknown>> => ({
  type: "array",
  items: { type: "string" },
  description,
});

const failed = (text: string): ToolResult => ({ text, isError: true });

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const emailAddress = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(?:\.[^\s@<>()[\]\\,;:".]+)+$/u;

const plain = (text: string): string =>
  text.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase().replaceAll(/\s+/gu, " ").trim();

const listOf = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((item) =>
    typeof item === "string" && item.trim() !== "" ? item.trim() : [],
  );

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

const dayText = ({ month, day, year }: DayOfYear): string =>
  `${String(day)} ${months[month - 1] ?? ""}${year === undefined ? "" : ` ${String(year)}`}`;

const addressText = ({ street, city, region, postcode, country }: PostalAddress): string =>
  [street, city, region, postcode, country].filter((part) => part !== "").join(", ");

const labelled = ({ value, label, preferred }: Labelled): string => {
  const marks = [...(label === undefined ? [] : [label]), ...(preferred === true ? ["preferred"] : [])];
  return marks.length === 0 ? value : `${value} (${marks.join(", ")})`;
};

const workLine = ({ title, organisation }: Facts): string | undefined => {
  return title === undefined || organisation === undefined ? (title ?? organisation) : `${title} at ${organisation}`;
};

// Input as Kumo writes it: "work: clara@northwind.example", or the value alone.
const toLabelled = (text: string): Labelled => {
  const found = /^(?<label>[\p{L}][\p{L} ]{0,29}):\s*(?<value>\S.*)$/u.exec(text.trim())?.groups;
  const label = found?.label?.trim().toLowerCase();
  const isScheme = label === "mailto" || label === "tel";
  return isScheme || label === undefined || found?.value === undefined
    ? { value: text.trim().replace(/^(?:mailto|tel):/iu, "") }
    : { label, value: found.value.trim() };
};

// "home: 12 Harbour Row; London; ; E14 5AB; United Kingdom": street, city, region, postcode, country.
const toAddress = (text: string): PostalAddress | undefined => {
  const { label, value } = toLabelled(text);
  const [street = "", city = "", region = "", postcode = "", country = ""] = value
    .split(";")
    .map((part) => part.trim());
  return [street, city, postcode, country].every((part) => part === "")
    ? undefined
    : { ...(label !== undefined && { label }), street, city, region, postcode, country };
};

const toRelated = (text: string): Related => {
  const { label, value } = toLabelled(text);
  return { name: value, ...(label !== undefined && { label }) };
};

// 1990-04-12, or 04-12 when the year isn't known.
const toBirthday = (text: string): DayOfYear | undefined => {
  const found = /^(?:(?<year>\d{4})-|-{0,2})(?<month>\d{1,2})-(?<day>\d{1,2})$/u.exec(text.trim())?.groups;
  if (!found) return undefined;
  const month = Number(found.month);
  const day = Number(found.day);
  const year = found.year === undefined ? undefined : Number(found.year);
  const check = new Date(Date.UTC(year ?? 2000, month - 1, day));
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? { month, day, ...(year !== undefined && { year }) }
    : undefined;
};

const digits = (text: string): string => text.replaceAll(/\D/gu, "");

const fileOf = (url: string): string => decodeURIComponent(url.split("/").at(-1) ?? "").replace(/\.vcf$/iu, "");

const isContactsUndo = (payload: unknown): payload is ContactsUndo => fieldOf(payload, "kind") === "contacts_restore";

// A setting's JSON, or undefined when there's none or it doesn't parse.
const jsonOf = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const parsedList = (text: string | undefined): readonly unknown[] => {
  const value = jsonOf(text);
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
};

const toAsks = (text: string | undefined): readonly Ask[] =>
  parsedList(text).flatMap((item) => {
    const action = fieldOf(item, "action");
    const card = textOf(item, "card");
    const urls = listOf(fieldOf(item, "urls"));
    return card !== "" && (action === "merge" || action === "delete") && urls.length > 0
      ? { card, action, urls, reason: textOf(item, "reason") }
      : [];
  });

const datesPrompt = (lines: readonly string[]): string =>
  [
    "These dates are coming up for people in their Contacts:",
    ...lines,
    "",
    "Judge from their People pages, and anything you remember with recall, how much each person matters to them.",
    "For someone they care about, message them with post, warm and short, such as “Leo's birthday is Thursday.",
    "Want ideas?”, if now is a good moment in their day, or set a wake-up for a better one. Say nothing about",
    "people they aren't close to. Don't record these with done.",
  ].join("\n");

const usedText = (latest: number, timeZone: string): string =>
  latest === 0
    ? "not used"
    : `last used ${new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(latest)}`;

// The words that say what a change did, for Done and for the agent.
const changeWords = (change: Change): readonly string[] => [
  ...(change.name === undefined ? [] : [`name ${change.name}`]),
  ...(change.nickname === undefined ? [] : [`nickname ${change.nickname}`]),
  ...(change.addEmails ?? []).map(({ value, label }) => `${label === undefined ? "" : `${label} `}email ${value}`),
  ...(change.removeEmails ?? []).map((value) => `no email ${value}`),
  ...(change.addPhones ?? []).map(({ value, label }) => `${label === undefined ? "" : `${label} `}phone ${value}`),
  ...(change.removePhones ?? []).map((value) => `no phone ${value}`),
  ...(change.addAddresses ?? []).map(
    (address) => `${address.label === undefined ? "" : `${address.label} `}address ${addressText(address)}`,
  ),
  ...(change.removeAddresses ?? []).map((value) => `no address at ${value}`),
  ...(change.birthday === undefined ? [] : [`birthday ${dayText(change.birthday)}`]),
  ...(change.organisation === undefined ? [] : [`organisation ${change.organisation}`]),
  ...(change.title === undefined ? [] : [`title ${change.title}`]),
  ...(change.addRelated ?? []).map(({ name, label = "related" }) => `${label} ${name}`),
  ...(change.removeRelated ?? []).map((name) => `no longer related to ${name}`),
  ...(change.caughtUp === undefined ? [] : [change.caughtUp.replace(caughtUpPrefix, "last caught up")]),
];

const sameText = (left: VCard, right: VCard): boolean => {
  const withoutRevision = (card: VCard): string =>
    writeVCard({ ...card, lines: card.lines.filter((line) => line.name !== "REV") });
  return withoutRevision(left) === withoutRevision(right);
};

export const createContacts = ({
  host,
  store,
  desk,
  clock,
  timeZone,
  info,
  work,
  people,
  createSource,
  onHealth = ignore,
  pollMs = 10 * 60 * 1000,
}: ContactsOptions): Contacts => {
  const cached = createCell<{ readonly key: string; readonly source: ContactsSource } | undefined>(undefined);
  const known = createCell<ReadonlyMap<string, Person>>(new Map());
  const token = createCell<string | undefined>(undefined);
  const pulledAt = createCell(0);
  // Why the last read failed, until one works again.
  const failure = createCell<string | undefined>(undefined);
  const timer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);
  const syncing = createCell<Promise<void>>(Promise.resolve());

  const sourceOf = (): ContactsSource | undefined => {
    const found = host.find(icloudSource);
    if (found?.state !== "on") return undefined;
    const key = JSON.stringify(found.values);
    const current = cached.get();
    if (current?.key === key) return current.source;
    const made = createSource(found.values);
    cached.set({ key, source: made });
    known.set(new Map());
    token.set(undefined);
    return made;
  };

  const toPerson = (card: StoredCard): Person | undefined => {
    const parsed = parseVCard(card.vcard);
    if (!parsed.ok) return undefined;
    const facts = factsOf(parsed.value, fileOf(card.url));
    return facts.isGroup
      ? undefined
      : { url: card.url, book: card.book, ...(card.etag !== undefined && { etag: card.etag }), facts };
  };

  const pull = async (): Promise<void> => {
    const source = sourceOf();
    if (!source) {
      known.set(new Map());
      token.set(undefined);
      onHealth({ ok: true });
      return;
    }
    const changes = await source.changes(token.get());
    if (!changes.ok) {
      info("Contacts couldn't be read", { error: changes.failure });
      failure.set(changes.failure);
      onHealth({ ok: false, reason: changes.failure, isAuth: isRejected(changes.failure) });
      return;
    }
    failure.set(undefined);
    onHealth({ ok: true });
    const full = new Set(changes.value.full);
    const removed = new Set(changes.value.removed);
    const kept = [...known.get()].filter(([url, person]) => !full.has(person.book.url) && !removed.has(url));
    const changed = changes.value.changed.flatMap((card) => toPerson(card) ?? []);
    const withoutChanged = kept.filter(([url]) => changes.value.changed.every((card) => card.url !== url));
    known.set(new Map([...withoutChanged, ...changed.map((person) => [person.url, person] as const)]));
    token.set(changes.value.token);
    pulledAt.set(clock.now());
  };

  const refresh = (): Promise<void> =>
    syncing.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await pull();
      } catch (error) {
        info("Contacts couldn't be refreshed", { error: String(error) });
      }
    });

  const fresh = async (): Promise<void> => {
    if (clock.now() - pulledAt.get() > freshMs) await refresh();
    else await syncing.get();
  };

  const everyone = (): readonly Person[] => known.get().values().toArray();

  // Contacts that have never been read can't be searched: saying no one matches would be wrong.
  const unreadable = (): string | undefined => {
    const reason = failure.get();
    return reason === undefined || pulledAt.get() > 0 ? undefined : `Their Contacts can't be read right now: ${reason}`;
  };

  // Their People pages, or none while memory can't be read.
  const pagesNow = async (): Promise<readonly PersonPage[]> => {
    try {
      return await people();
    } catch {
      return [];
    }
  };

  const merged = (): Readonly<Record<string, string>> => {
    const value = jsonOf(store.setting(mergedSetting));
    return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
  };

  // A card's UID now, following merges: a page linked to a card that was merged away finds the one kept.
  const currentUid = (uid: string, seen: ReadonlySet<string> = new Set()): string => {
    const next = merged()[uid];
    return next === undefined || seen.has(uid) ? uid : currentUid(next, new Set([...seen, uid]));
  };

  const byUid = (uid: string): Person | undefined => {
    const wanted = currentUid(uid.trim());
    return everyone().find(({ facts }) => facts.uid === wanted);
  };

  // The People page linked to a card, following merges.
  const linkedPage = (pages: readonly PersonPage[], person: Person): PersonPage | undefined =>
    pages.find((page) => page.contact !== undefined && currentUid(page.contact) === person.facts.uid);

  const pageOf = async (person: Person): Promise<PersonPage | undefined> => linkedPage(await pagesNow(), person);

  // Who a card is, in a line: name, work, emails and phones.
  const whoLine = ({ facts }: Person): string =>
    [
      facts.name,
      workLine(facts),
      [...facts.emails.map((email) => labelled(email)), ...facts.phones.map((phone) => labelled(phone))].join(", "),
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" · ");

  const summary = (person: Person, page?: PersonPage): string =>
    [whoLine(person), `uid ${person.facts.uid}`, ...(page ? [`page ${page.address}`] : [])].join(" · ");

  const describe = (person: Person, page: PersonPage | undefined): string => {
    const { facts } = person;
    const lines = [
      `${facts.name} (uid ${facts.uid}, in ${person.book.name}${person.book.readOnly ? ", read-only" : ""})`,
      ...(facts.nickname === undefined ? [] : [`Nickname: ${facts.nickname}`]),
      ...(workLine(facts) === undefined ? [] : [`Work: ${workLine(facts) ?? ""}`]),
      ...(facts.emails.length === 0 ? [] : [`Emails: ${facts.emails.map((email) => labelled(email)).join("; ")}`]),
      ...(facts.phones.length === 0 ? [] : [`Phones: ${facts.phones.map((phone) => labelled(phone)).join("; ")}`]),
      ...facts.addresses.map(
        (address) => `Address${address.label === undefined ? "" : ` (${address.label})`}: ${addressText(address)}`,
      ),
      ...(facts.birthday === undefined
        ? []
        : [`Birthday: ${dayText(facts.birthday)}${facts.birthday.year === undefined ? " (year not known)" : ""}`]),
      ...facts.dates.map((date) => `${date.label}: ${dayText(date)}`),
      ...(facts.related.length === 0
        ? []
        : [
            `Related: ${facts.related.map(({ name, label }) => (label === undefined ? name : `${name} (${label})`)).join("; ")}`,
          ]),
      ...(facts.note === undefined ? [] : [`Notes: ${facts.note}`]),
      page === undefined ? "No People page is linked to this contact." : `People page: ${page.address} (${page.title})`,
    ];
    return lines.join("\n");
  };

  const score = (person: Person, query: string): number => {
    const { facts } = person;
    const wanted = plain(query);
    const words = wanted.split(" ").filter(Boolean);
    const name = plain(facts.name);
    const fields = [
      name,
      plain(facts.nickname ?? ""),
      plain(facts.organisation ?? ""),
      plain(facts.title ?? ""),
      ...facts.emails.map(({ value }) => value.toLowerCase()),
      ...facts.related.map(({ name: related }) => plain(related)),
    ];
    const number = digits(query);
    if (number.length >= 6 && facts.phones.some(({ value }) => samePhone(value, query))) return 90;
    if (wanted.includes("@") && facts.emails.some(({ value }) => sameMail(value, wanted))) return 100;
    if (name === wanted) return 80;
    if (name.startsWith(wanted)) return 60;
    return words.length > 0 &&
      words.every((word) => fields.some((field) => field.split(/[\s@.]/u).some((part) => part.startsWith(word))))
      ? 30
      : 0;
  };

  const search = (query: string): readonly Person[] =>
    everyone()
      .map((person) => ({ person, score: score(person, query) }))
      .filter((found) => found.score > 0)
      .toSorted(
        (left, right) => right.score - left.score || left.person.facts.name.localeCompare(right.person.facts.name),
      )
      .map(({ person }) => person);

  // Cards that look like one person: the same name, or an email or a phone in common.
  const duplicates = (): readonly (readonly Person[])[] => {
    const all = everyone();
    const isSame = (left: Person, right: Person): boolean =>
      (plain(left.facts.name) !== "" && plain(left.facts.name) === plain(right.facts.name)) ||
      left.facts.emails.some(({ value }) => right.facts.emails.some((other) => sameMail(other.value, value))) ||
      left.facts.phones.some(({ value }) => right.facts.phones.some((other) => samePhone(other.value, value)));
    return all.reduce<readonly (readonly Person[])[]>((groups, person) => {
      if (groups.some((group) => group.includes(person))) return groups;
      const same = all.filter((other) => other !== person && isSame(person, other));
      return same.length === 0 ? groups : [...groups, [person, ...same]];
    }, []);
  };

  const writableBook = async (source: ContactsSource): Promise<Result<AddressBook, string>> => {
    const listed = await source.books();
    if (!listed.ok) return listed;
    const writable = listed.value.filter(({ readOnly }) => !readOnly);
    const book = writable.find(({ name }) => ["contacts", "card"].includes(name.toLowerCase())) ?? writable[0];
    return book ? ok(book) : fail("There's no address book of theirs Kumo can write to.");
  };

  const recordChange = (text: string, reason: string, undo: ContactsUndo): void => {
    desk.addDone({ text, reason, quiet: false, undo });
  };

  // Reads the card as it is now, changes it and writes it back as read, once more if it changed meanwhile.
  const rewrite = async (
    source: ContactsSource,
    person: Person,
    edit: (card: VCard, now: Date) => VCard,
    retries = 1,
  ): Promise<Result<{ readonly before: StoredCard; readonly after?: StoredCard }, string>> => {
    const current = await source.read(person.url, person.book);
    if (!current.ok) return current;
    const parsed = parseVCard(current.value.vcard);
    if (!parsed.ok) return parsed;
    const changed = edit(parsed.value, new Date(clock.now()));
    if (sameText(parsed.value, changed)) return ok({ before: current.value });
    const written = await source.update(current.value, writeVCard(changed));
    if (!written.ok && isConflict(written.failure) && retries > 0) return rewrite(source, person, edit, retries - 1);
    return written.ok ? ok({ before: current.value, after: written.value }) : written;
  };

  const caughtUpLine = (words: string): string => {
    const month = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone(), month: "short", year: "numeric" }).format(
      clock.now(),
    );
    return `${caughtUpPrefix} ${month} · ${words.replaceAll(/\s+/gu, " ").trim()}`;
  };

  // A change as Kumo asked for it, or what's wrong with what it gave.
  const toChange = (input: unknown): Result<Change, string> => {
    const emails = listOf(fieldOf(input, "email")).map((text) => toLabelled(text));
    const badEmail = [...emails.map(({ value }) => value), ...listOf(fieldOf(input, "remove_email"))].find(
      (value) => !emailAddress.test(value),
    );
    if (badEmail !== undefined)
      return fail(
        `"${badEmail}" isn't an email address. Give one each time, such as --email "work: clara@northwind.example".`,
      );
    const phones = listOf(fieldOf(input, "phone")).map((text) => toLabelled(text));
    const badPhone = phones.find(({ value }) => digits(value).length < 6);
    if (badPhone)
      return fail(
        `"${badPhone.value}" isn't a phone number. Give one each time, such as --phone "mobile: +44 7700 900123".`,
      );
    const addressTexts = listOf(fieldOf(input, "address"));
    const addresses = addressTexts.map((text) => toAddress(text));
    if (addresses.includes(undefined)) {
      return fail(
        'Give an address as street; city; region; postcode; country, such as --address "home: 12 Harbour Row; London; ; E14 5AB; United Kingdom".',
      );
    }
    const birthdayText = textOf(input, "birthday").trim();
    const birthday = birthdayText === "" ? undefined : toBirthday(birthdayText);
    if (birthdayText !== "" && birthday === undefined)
      return fail(`"${birthdayText}" isn't a date: give 1990-04-12, or 04-12 when the year isn't known.`);
    const text = (field: string): string | undefined => {
      const given = textOf(input, field).replaceAll(/\s+/gu, " ").trim();
      return given === "" ? undefined : given;
    };
    const caughtUp = text("caught_up");
    const name = text("name");
    const nickname = text("nickname");
    const organisation = text("organisation");
    const title = text("job_title");
    const goneEmails = listOf(fieldOf(input, "remove_email"));
    const gonePhones = listOf(fieldOf(input, "remove_phone"));
    const goneAddresses = listOf(fieldOf(input, "remove_address"));
    const related = listOf(fieldOf(input, "related")).map((value) => toRelated(value));
    const goneRelated = listOf(fieldOf(input, "remove_related"));
    return ok({
      ...(name !== undefined && { name }),
      ...(nickname !== undefined && { nickname }),
      ...(emails.length > 0 && { addEmails: emails }),
      ...(goneEmails.length > 0 && { removeEmails: goneEmails }),
      ...(phones.length > 0 && { addPhones: phones }),
      ...(gonePhones.length > 0 && { removePhones: gonePhones }),
      ...(addresses.length > 0 && { addAddresses: addresses.filter((address) => address !== undefined) }),
      ...(goneAddresses.length > 0 && { removeAddresses: goneAddresses }),
      ...(birthday !== undefined && { birthday }),
      ...(organisation !== undefined && { organisation }),
      ...(title !== undefined && { title }),
      ...(related.length > 0 && { addRelated: related }),
      ...(goneRelated.length > 0 && { removeRelated: goneRelated }),
      ...(caughtUp !== undefined && { caughtUp: caughtUpLine(caughtUp) }),
    });
  };

  const withSource = async (act: (source: ContactsSource) => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
    const source = sourceOf();
    if (!source)
      return failed("iCloud isn't connected, so there are no Contacts to use. It's in Settings › Capabilities.");
    await fresh();
    const problem = unreadable();
    return problem === undefined ? act(source) : failed(problem);
  };

  const asks = (): readonly Ask[] => toAsks(store.setting(asksSetting));

  // The asks still on the Desk: one whose card went without an answer, such as one Kumo cleared, is dropped.
  const waitingAsks = (): readonly Ask[] => asks().filter((ask) => desk.cards().some((card) => card.id === ask.card));

  const dropAsk = (card: string): void => {
    store.setSetting(asksSetting, JSON.stringify(asks().filter((ask) => ask.card !== card)));
  };

  // Merges the cards into the first, from each card as it is now, then removes the others. Whatever was done is
  // recorded with an undo, even when a card couldn't be removed, such as one changed on their phone meanwhile.
  const mergeNow = async (
    source: ContactsSource,
    group: readonly Person[],
    reason: string,
  ): Promise<Result<string, string>> => {
    const [kept, ...others] = group;
    if (kept === undefined || others.length === 0) return fail("There's nothing to merge.");
    const reads = await Promise.all(others.map((other) => source.read(other.url, other.book)));
    const [unread] = reads.flatMap((read) => (read.ok ? [] : read.failure));
    if (unread !== undefined) return fail(unread);
    const otherCards = reads.flatMap((read) => (read.ok ? read.value : []));
    const parsed = otherCards.flatMap((card) => {
      const vcard = parseVCard(card.vcard);
      return vcard.ok ? [vcard.value] : [];
    });
    const changed = await rewrite(source, kept, (card, now) => mergeCards(card, parsed, now));
    if (!changed.ok) return changed;
    const removals = await Promise.all(
      otherCards.map(async (card) => ({ card, removed: await source.remove(card.url, card.etag) })),
    );
    const gone = removals.flatMap(({ card, removed }) => (removed.ok ? [card] : []));
    const [unremoved] = removals.flatMap(({ removed }) => (removed.ok ? [] : removed.failure));
    const goneUids = gone.flatMap((card) => toPerson(card)?.facts.uid ?? []);
    const aliases = Object.fromEntries(goneUids.map((uid) => [uid, kept.facts.uid]));
    store.setSetting(mergedSetting, JSON.stringify({ ...merged(), ...aliases }));
    const { before, after } = changed.value;
    const name = kept.facts.name;
    const text =
      gone.length === others.length
        ? `Merged ${String(group.length)} cards for ${name} in Contacts`
        : gone.length === 0
          ? `Added the other cards' details to ${name}'s card in Contacts`
          : `Merged ${String(gone.length + 1)} of ${String(group.length)} cards for ${name} in Contacts`;
    if (after !== undefined || gone.length > 0) {
      recordChange(text, reason, {
        kind: "contacts_restore",
        name,
        restores: [
          ...(after === undefined
            ? []
            : [
                {
                  url: kept.url,
                  book: kept.book,
                  before: before.vcard,
                  ...(after.etag !== undefined && { after: after.etag }),
                },
              ]),
          ...gone.map((card) => ({ url: card.url, book: card.book, before: card.vcard })),
        ],
        unmerge: goneUids,
      });
    }
    await refresh();
    return unremoved === undefined ? ok(text) : fail(unremoved);
  };

  const deleteNow = async (source: ContactsSource, person: Person, reason: string): Promise<Result<string, string>> => {
    const current = await source.read(person.url, person.book);
    if (!current.ok) return current;
    const removed = await source.remove(person.url, current.value.etag);
    if (!removed.ok) return removed;
    const text = `Deleted ${person.facts.name} from Contacts`;
    recordChange(text, reason, {
      kind: "contacts_restore",
      name: person.facts.name,
      restores: [{ url: person.url, book: person.book, before: current.value.vcard }],
    });
    await refresh();
    return ok(text);
  };

  const answerAsk = async (card: { readonly id: string }, given: CardAnswer): Promise<undefined> => {
    const ask = asks().find((candidate) => candidate.card === card.id);
    dropAsk(card.id);
    if (!ask || (given.option !== "Merge" && given.option !== "Delete")) return undefined;
    const source = sourceOf();
    if (source) await refresh();
    const group = ask.urls.flatMap((url) => known.get().get(url) ?? []);
    const [first] = group;
    const done =
      source === undefined
        ? fail("iCloud isn't connected any more.")
        : first === undefined || group.length !== ask.urls.length
          ? fail("A card changed or went from Contacts since you were asked.")
          : ask.action === "merge"
            ? await mergeNow(source, group, `You agreed: ${ask.reason}`)
            : await deleteNow(source, first, `You agreed: ${ask.reason}`);
    if (!done.ok) {
      desk.addDone({
        text: `Couldn't ${ask.action} ${group[0]?.facts.name ?? "the contact"} in Contacts`,
        reason: done.failure,
        quiet: false,
      });
    }
    return undefined;
  };

  const askFirst = (action: Ask["action"], group: readonly Person[], reason: string): Card => {
    const [first] = group;
    const name = first?.facts.name ?? "";
    const parts = group.map((person) => whoLine(person));
    const card = desk.addCard({
      kind: "question",
      title: action === "merge" ? `Merge ${String(group.length)} cards for ${name}?` : `Delete ${name} from Contacts?`,
      options:
        action === "merge"
          ? [{ label: "Merge", acts: true }, { label: "Keep both" }]
          : [{ label: "Delete", acts: true }, { label: "Keep" }],
      allows_text: false,
      question: {
        text: [
          reason.endsWith(".") ? reason : `${reason}.`,
          action === "merge"
            ? `${listed(parts)}. Merging keeps one card with everything on them; Undo on your Done list splits them again.`
            : `${parts[0] ?? name}. Undo on your Done list brings it back.`,
        ].join(" "),
      },
    });
    store.setSetting(
      asksSetting,
      JSON.stringify([...waitingAsks(), { card: card.id, action, urls: group.map(({ url }) => url), reason }]),
    );
    desk.handleCard(card.id, answerAsk);
    return card;
  };

  const waiting = waitingAsks();
  if (waiting.length < asks().length) store.setSetting(asksSetting, JSON.stringify(waiting));
  for (const ask of waiting) desk.handleCard(ask.card, answerAsk);

  const restore = async ({ restores, unmerge = [] }: ContactsUndo): Promise<Result<undefined, string>> => {
    const source = sourceOf();
    if (!source) return fail("iCloud isn't connected any more.");
    for (const { url, book, before, after } of restores) {
      const current = await source.read(url, book);
      const exists = current.ok;
      if (exists && after !== undefined && current.value.etag !== after) {
        return fail("That contact has changed in Contacts since, so Undo would lose the newer change.");
      }
      const done =
        before === undefined
          ? exists
            ? await source.remove(url, current.value.etag)
            : ok(undefined)
          : await source.restore(url, book, before, exists ? current.value.etag : undefined);
      if (!done.ok) return fail(done.failure);
    }
    if (unmerge.length > 0) {
      const kept = Object.entries(merged()).filter(([uid]) => !unmerge.includes(uid));
      store.setSetting(mergedSetting, JSON.stringify(Object.fromEntries(kept)));
    }
    await refresh();
    return ok(undefined);
  };

  desk.onUndo((_entry, payload) => (isContactsUndo(payload) ? restore(payload) : Promise.resolve(ok(undefined))));

  const uidField = { type: "string", description: "The contact's uid, from search." };
  const factFields = {
    email: listField('An email, with its label if known, such as "work: clara@northwind.example"; repeat for more.'),
    phone: listField('A phone number, with its label, such as "mobile: +44 7700 900123"; repeat for more.'),
    address: listField(
      'A postal address as label: street; city; region; postcode; country, such as "home: 12 Harbour Row; London; ; E14 5AB; United Kingdom".',
    ),
    birthday: { type: "string", description: "Such as 1990-04-12, or 04-12 when the year isn't known." },
    organisation: { type: "string", description: "Where they work, such as Northwind." },
    job_title: { type: "string", description: "Their job, such as Head of Product." },
    related: listField('Someone related to them, such as "sister: Mira" or "partner: Leo Marsh".'),
    nickname: { type: "string" },
    reason: { type: "string", description: "Why, in a line, for their Done list, such as where you learned it." },
  };

  const tools: readonly Tool[] = [
    {
      name: "contacts_search",
      title: "Search contacts",
      audience: "work",
      description:
        "Search their iCloud Contacts by name, email, phone, company or a related person, with each card's uid and " +
        "the People page linked to it. With duplicates, list cards that look like the same person.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A name, an email, a phone number or a company." },
          duplicates: { type: "boolean", description: "List cards that look like one person, to propose merges." },
        },
        additionalProperties: false,
      },
      call: (input) =>
        withSource(async () => {
          const pages = await pagesNow();
          const pageFor = (person: Person): PersonPage | undefined => linkedPage(pages, person);
          if (fieldOf(input, "duplicates") === true) {
            const groups = duplicates();
            return {
              text:
                groups.length === 0
                  ? "No cards look like the same person."
                  : groups
                      .map(
                        (group) =>
                          `Maybe one person:\n${group.map((person) => `- ${summary(person, pageFor(person))}`).join("\n")}`,
                      )
                      .join("\n\n"),
              step: { title: "Looked for duplicates in your contacts", note: `${String(groups.length)} found` },
            };
          }
          const query = textOf(input, "query").trim();
          if (query === "") return failed("Say who to look for, with --query, or give --duplicates.");
          const found = search(query);
          return {
            text:
              found.length === 0
                ? `No one in their Contacts matches “${query}”, out of ${String(known.get().size)} cards.`
                : [
                    `${String(found.length)} in their Contacts ${found.length === 1 ? "matches" : "match"} “${query}”:`,
                    ...found.slice(0, mostResults).map((person) => `- ${summary(person, pageFor(person))}`),
                  ].join("\n"),
            step: {
              title: `Looked up “${query}” in your contacts`,
              note: found.length === 0 ? "No one matched" : `${String(found.length)} found`,
            },
          };
        }),
    },
    {
      name: "contacts_read",
      title: "Read a contact",
      audience: "work",
      description:
        "Read one card whole by its uid: labelled emails, phones and addresses, birthday and dates, work, related " +
        "people, notes, and the People page linked to it.",
      inputSchema: {
        type: "object",
        properties: { uid: uidField },
        required: ["uid"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(async () => {
          const person = byUid(textOf(input, "uid"));
          if (!person) return failed(`There's no contact ${textOf(input, "uid")}. Find it with search.`);
          return {
            text: describe(person, await pageOf(person)),
            step: { title: `Read ${person.facts.name}'s contact` },
          };
        }),
    },
    {
      name: "contacts_add",
      title: "Add a contact",
      audience: "work",
      description:
        "Add someone to their Contacts, only with details you're sure are theirs. Search first: a card with the " +
        "same email or phone is the same person, so update it instead. It's recorded in Done with an undo.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Their full name, such as Clara Voss." },
          ...factFields,
          different: {
            type: "boolean",
            description: "Someone else with the same name as a card that's there, such as a second Leo.",
          },
        },
        required: ["name", "reason"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(async (source) => {
          const change = toChange(input);
          if (!change.ok) return failed(change.failure);
          const name = textOf(input, "name").replaceAll(/\s+/gu, " ").trim();
          const reason = textOf(input, "reason").trim();
          const sharing = everyone().find(
            (person) =>
              (change.value.addEmails ?? []).some(({ value }) =>
                person.facts.emails.some((own) => sameMail(own.value, value)),
              ) ||
              (change.value.addPhones ?? []).some(({ value }) =>
                person.facts.phones.some((own) => samePhone(own.value, value)),
              ),
          );
          if (sharing) {
            return failed(
              `${sharing.facts.name} already has that email or phone (uid ${sharing.facts.uid}): add to that card with update.`,
            );
          }
          const namesake = everyone().find((person) => plain(person.facts.name) === plain(name));
          if (namesake && fieldOf(input, "different") !== true) {
            return failed(
              `${namesake.facts.name} is already in their Contacts (uid ${namesake.facts.uid}). Update that card, or ` +
                "give --different if this is someone else.",
            );
          }
          const book = await writableBook(source);
          if (!book.ok) return failed(book.failure);
          const card = newVCard(name, change.value, new Date(clock.now()));
          const uid = factsOf(card, "").uid;
          const made = await source.create(book.value, `${uid}.vcf`, writeVCard(card));
          if (!made.ok) return failed(made.failure);
          const details = changeWords(change.value);
          recordChange(`Added ${name} to Contacts${details.length === 0 ? "" : `: ${details.join("; ")}`}`, reason, {
            kind: "contacts_restore",
            name,
            restores: [
              {
                url: made.value.url,
                book: book.value,
                ...(made.value.etag !== undefined && { after: made.value.etag }),
              },
            ],
          });
          await refresh();
          return {
            text: `Added ${name} to their Contacts as uid ${uid}. If they have a People page, link it with contact ${uid}.`,
            step: { title: `Added ${name} to your contacts`, ...(reason !== "" && { note: reason }) },
          };
        }),
    },
    {
      name: "contacts_update",
      title: "Update a contact",
      audience: "work",
      description:
        "Change someone's card: add or remove an email, phone, address or related person, set their birthday, work " +
        "or name, or the one line you keep in its notes on when they last caught up. Only what you're sure of. It's " +
        "recorded in Done with an undo.",
      inputSchema: {
        type: "object",
        properties: {
          uid: uidField,
          name: { type: "string", description: "Their full name, when it's changed or was wrong." },
          ...factFields,
          remove_email: listField("An email that's no longer theirs; repeat for more."),
          remove_phone: listField("A phone number that's no longer theirs; repeat for more."),
          remove_address: listField("Words from an address that's no longer theirs, such as its street."),
          remove_related: listField("The name of someone no longer related to them."),
          caught_up: {
            type: "string",
            description: "A few words on how they last caught up, such as “coffee in Soho”; it's dated this month.",
          },
        },
        required: ["uid", "reason"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(async (source) => {
          const person = byUid(textOf(input, "uid"));
          if (!person) return failed(`There's no contact ${textOf(input, "uid")}. Find it with search.`);
          if (person.book.readOnly)
            return failed(`${person.facts.name} is in ${person.book.name}, which is read-only.`);
          const change = toChange(input);
          if (!change.ok) return failed(change.failure);
          const details = changeWords(change.value);
          if (details.length === 0) return failed("Say what to change, such as --email or --job-title.");
          const reason = textOf(input, "reason").trim();
          const changed = await rewrite(source, person, (card, now) => applyChange(card, change.value, now));
          if (!changed.ok) return failed(changed.failure);
          const { after } = changed.value;
          if (!after) return { text: `${person.facts.name}'s card already says that, so nothing changed.` };
          const text = `Updated ${person.facts.name} in Contacts: ${details.join("; ")}`;
          recordChange(text, reason, {
            kind: "contacts_restore",
            name: person.facts.name,
            restores: [
              {
                url: person.url,
                book: person.book,
                before: changed.value.before.vcard,
                ...(after.etag !== undefined && { after: after.etag }),
              },
            ],
          });
          await refresh();
          return {
            text: `${text}.`,
            step: { title: `Updated ${person.facts.name}'s contact`, note: details.join("; ") },
          };
        }),
    },
    {
      name: "contacts_merge",
      title: "Merge contacts",
      audience: "work",
      description:
        "Propose merging cards that are one person: it asks them once on the Desk, and merges when they agree, " +
        "keeping the first card with everything from the others. Don't ask again in the chat.",
      inputSchema: {
        type: "object",
        properties: {
          uid: listField("A card's uid, the one to keep first; repeat for each card."),
          reason: { type: "string", description: "Why they're one person, in a line, said to them." },
        },
        required: ["uid", "reason"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(() => {
          const uids = [...new Set(listOf(fieldOf(input, "uid")))];
          const group = uids.map((uid) => byUid(uid));
          const missing = uids.filter((_uid, index) => group[index] === undefined);
          if (missing.length > 0) return failed(`There's no contact ${listed(missing)}. Find them with search.`);
          const found = group.filter((person) => person !== undefined);
          if (found.length < 2) return failed("Give at least two cards' uids to merge.");
          const locked = found.find((person) => person.book.readOnly);
          if (locked) return failed(`${locked.facts.name} is in ${locked.book.name}, which is read-only.`);
          const card = askFirst("merge", found, textOf(input, "reason").trim());
          return {
            text: `Asked them on the Desk as ${card.id}: “${card.title}” The cards merge when they tap Merge, so don't ask again in the chat.`,
            step: {
              title: `Asked you about merging ${String(found.length)} cards for ${found[0]?.facts.name ?? ""}`,
              note: "It's on your Desk",
            },
          };
        }),
    },
    {
      name: "contacts_delete",
      title: "Delete a contact",
      audience: "work",
      description:
        "Propose deleting a card: it asks them once on the Desk, and deletes it when they agree. Don't ask again in " +
        "the chat.",
      inputSchema: {
        type: "object",
        properties: {
          uid: uidField,
          reason: { type: "string", description: "Why it should go, in a line, said to them." },
        },
        required: ["uid", "reason"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(() => {
          const person = byUid(textOf(input, "uid"));
          if (!person) return failed(`There's no contact ${textOf(input, "uid")}. Find it with search.`);
          if (person.book.readOnly)
            return failed(`${person.facts.name} is in ${person.book.name}, which is read-only.`);
          const card = askFirst("delete", [person], textOf(input, "reason").trim());
          return {
            text: `Asked them on the Desk as ${card.id}: “${card.title}” It goes when they tap Delete, so don't ask again in the chat.`,
            step: {
              title: `Asked you about deleting ${person.facts.name} from your contacts`,
              note: "It's on your Desk",
            },
          };
        }),
    },
  ];

  // Birthdays and other dates a few days off become a line from Kumo, for the people they care about.

  const datesTold = (): readonly string[] => listOf(parsedList(store.setting(datesToldSetting)));

  type Coming = {
    readonly person: Person;
    readonly label: string;
    readonly date: DayOfYear;
    readonly at: number;
    readonly days: number;
  };

  const upcoming = (now: number): readonly Coming[] => {
    const today = toLocal(now, timeZone()).day;
    const [year = 2026, month = 1, day = 1] = today.split("-").map(Number);
    const start = Date.UTC(year, month - 1, day);
    const next = ({ month: wantedMonth, day: wantedDay }: DayOfYear): number => {
      const thisYear = Date.UTC(year, wantedMonth - 1, wantedDay);
      return thisYear >= start ? thisYear : Date.UTC(year + 1, wantedMonth - 1, wantedDay);
    };
    return everyone()
      .flatMap((person) => [
        ...(person.facts.birthday === undefined ? [] : [{ person, label: "birthday", date: person.facts.birthday }]),
        ...person.facts.dates.map((date) => ({ person, label: date.label, date })),
      ])
      .map((found) => {
        const at = next(found.date);
        return { ...found, at, days: Math.round((at - start) / dayMs) };
      })
      .filter(({ days }) => days <= datesAheadDays)
      .toSorted((left, right) => left.at - right.at);
  };

  const keyOf = ({ person, label, at }: Coming): string =>
    `${person.facts.uid}:${label}:${new Date(at).toISOString().slice(0, 10)}`;

  const whenText = ({ at, days }: Coming): string => {
    const day = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(at);
    if (days === 0) return `today, ${day}`;
    if (days === 1) return `tomorrow, ${day}`;
    return `${day}, in ${String(days)} days`;
  };

  const comingLine = (coming: Coming, page: PersonPage | undefined): string => {
    const { person, label, date, at } = coming;
    const age =
      date.year === undefined
        ? ""
        : `, ${label === "birthday" ? "turning" : "years:"} ${String(new Date(at).getUTCFullYear() - date.year)}`;
    const story =
      page === undefined
        ? "No People page."
        : `People page ${page.address}${page.circle === undefined ? "" : `, circle ${page.circle}`}${page.gist === undefined ? "" : `: ${page.gist}`}.`;
    return `- ${person.facts.name}: ${label}, ${whenText(coming)}${age}. ${story}`;
  };

  const checkDates = async (): Promise<void> => {
    const now = clock.now();
    const local = toLocal(now, timeZone());
    if (store.setting(datesCheckedSetting) === local.day) return;
    await fresh();
    if (sourceOf() === undefined || pulledAt.get() === 0) return;
    const told = new Set(datesTold());
    const coming = upcoming(now).filter((found) => !told.has(keyOf(found)));
    if (coming.length > 0) {
      const pages = await pagesNow();
      const pageFor = (person: Person): PersonPage | undefined =>
        linkedPage(pages, person) ?? pages.find((page) => plain(page.title) === plain(person.facts.name));
      const done = await work(datesPrompt(coming.map((found) => comingLine(found, pageFor(found.person)))));
      if (!done.ok) {
        info("Kumo couldn't look at the dates coming up, so it tries again later", { error: done.failure });
        return;
      }
      const kept = [...told, ...coming.map((found) => keyOf(found))].slice(-500);
      store.setSetting(datesToldSetting, JSON.stringify(kept));
    }
    store.setSetting(datesCheckedSetting, local.day);
  };

  const poll = (): void => {
    if (isClosed.get()) return;
    timer.set(
      clock.after(pollMs, () => {
        void refresh()
          .then(checkDates)
          .catch((error: unknown) => {
            info("The dates coming up couldn't be checked", { error: String(error) });
          })
          .then(poll);
      }),
    );
  };

  // The address to write to someone, for a draft: by name, and a label in brackets if they gave one, such as
  // "Clara Voss (work)". Picked by that label, by the address they last used with them, or as their preferred.
  const recipient = async (given: string, use: AddressUse): Promise<Result<Recipient, string>> => {
    if (sourceOf() === undefined) {
      return fail(
        `iCloud isn't connected, so “${given.trim()}” can't be looked up in their Contacts: give an email address.`,
      );
    }
    await fresh();
    const problem = unreadable();
    if (problem !== undefined) return fail(`${problem} Give an email address instead.`);
    const found = /^(?<name>.*?)\s*(?:\((?<label>[^()]+)\))?$/u.exec(given.trim())?.groups;
    const name = (found?.name ?? given).trim();
    const label = found?.label?.trim().toLowerCase();
    const wanted = plain(name);
    const exact = everyone().filter(({ facts }) => plain(facts.name) === wanted);
    const loose = everyone().filter(({ facts }) =>
      [facts.given, facts.nickname, facts.family].some((part) => part !== undefined && plain(part) === wanted),
    );
    const matches = exact.length > 0 ? exact : loose;
    const [person] = matches;
    if (person === undefined) {
      return fail(
        `“${name}” isn't in their Contacts. Give an email address, or look them up with ito contacts search.`,
      );
    }
    if (matches.length > 1) {
      const who = matches.map(({ facts }) => `${facts.name} (${facts.emails[0]?.value ?? "no email"})`);
      return fail(`“${name}” could be ${listed(who)}. Give their full name or the address you mean.`);
    }
    const { emails } = person.facts;
    if (emails.length === 0) {
      return fail(
        `${person.facts.name} has no email address in Contacts. Ask for it, then add it with ito contacts update.`,
      );
    }
    const pick = (address: string, why: string): Result<Recipient, string> =>
      ok({ address, name: person.facts.name, why });
    const choices = label === undefined ? emails : emails.filter((email) => email.label?.toLowerCase() === label);
    const [only] = choices;
    if (label !== undefined && only === undefined) {
      return fail(`${person.facts.name} has no ${label} email: ${emails.map((email) => labelled(email)).join(", ")}.`);
    }
    if (only !== undefined && choices.length === 1) {
      return pick(only.value, label === undefined ? "their only address" : `their ${label} address`);
    }
    const uses = await Promise.all(
      choices.map(async (email) => {
        const used = await use(email.value);
        const latest = Math.max(Date.parse(used.from ?? "") || 0, Date.parse(used.to ?? "") || 0);
        return { email, latest, isFrom: (Date.parse(used.from ?? "") || 0) === latest && latest > 0 };
      }),
    );
    const ranked = uses.toSorted((left, right) => right.latest - left.latest);
    const [first, second] = ranked;
    if (first !== undefined && first.latest > clock.now() - recentUseMs && first.latest > (second?.latest ?? 0)) {
      return pick(
        first.email.value,
        first.isFrom ? "the address they last wrote from" : "the address you last wrote to",
      );
    }
    const [preferred, ...alsoPreferred] = choices.filter((email) => email.preferred === true);
    const options = ranked.map(({ email, latest }) => `${labelled(email)}, ${usedText(latest, timeZone())}`);
    return preferred !== undefined && alsoPreferred.length === 0
      ? pick(preferred.value, "their preferred address")
      : fail(
          `${person.facts.name} has ${listed(options)}. Say which, such as ` +
            `--to "${person.facts.name} (${choices[0]?.label ?? "work"})", or give the address.`,
        );
  };

  const unsubscribe = host.subscribe(() => {
    void refresh();
  });
  void refresh().then(checkDates);
  poll();

  return {
    tools,
    check: async (values) => {
      const source = createSource(values);
      const checked = await source.check();
      return checked.ok ? ok({ books: checked.value.books.length }) : checked;
    },
    refresh,
    known: async (address) => {
      await syncing.get();
      const person = everyone().find(({ facts }) => facts.emails.some(({ value }) => sameMail(value, address)));
      if (!person) return;
      const page = await pageOf(person);
      const work = workLine(person.facts);
      return [
        `In their Contacts: ${person.facts.name}${work === undefined ? "" : `, ${work}`} (uid ${person.facts.uid})`,
        ...(page === undefined ? [] : [`People page ${page.address}`]),
      ].join("; ");
    },
    recipient,
    close: () => {
      isClosed.set(true);
      timer.get()?.();
      unsubscribe();
    },
  };
};
