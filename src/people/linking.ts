import type { Person } from "#contacts/contacts.ts";
import { sameMail, samePhone } from "#contacts/vcard.ts";

// Linking a People page to its card in Contacts, by what both know: names and nicknames, and emails and phone numbers
// seen on the page, in mail they got and in the chat. Sure is an email or a phone in common with one card, or a full
// name only one card has; anything less, such as a first name two cards share, is a question for them.

export type LinkablePage = {
  readonly title: string;
  readonly aliases: readonly string[];
};

// Emails and phone numbers seen with someone.
export type Handles = { readonly emails: readonly string[]; readonly phones: readonly string[] };

export type Verdict =
  | { readonly kind: "sure"; readonly person: Person; readonly why: string }
  | { readonly kind: "unsure"; readonly candidates: readonly Person[] }
  | { readonly kind: "none" };

export const mostCandidates = 3;

const emailPattern = /[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"'.]+(?:\.[^\s@<>()[\]\\,;:"'.]+)+/gu;
// A run of at least seven digits, with the spaces, dashes, dots and brackets people write numbers with.
const phonePattern = /\+?\d[\d\s().-]{5,}\d/gu;

export const plainName = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}' -]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

export const handlesIn = (text: string): Handles => ({
  emails: [...new Set((text.match(emailPattern) ?? []).map((email) => email.toLowerCase().replace(/\.$/u, "")))],
  phones: [
    ...new Set(
      (text.match(phonePattern) ?? []).filter((phone) => phone.replaceAll(/\D/gu, "").length >= 7).map((p) => p.trim()),
    ),
  ],
});

export const joinHandles = (all: readonly Handles[]): Handles => ({
  emails: [...new Set(all.flatMap(({ emails }) => emails))],
  phones: [...new Set(all.flatMap(({ phones }) => phones))],
});

// The full names a page goes by: its title and aliases.
export const fullNames = (page: LinkablePage): readonly string[] => [
  ...new Set([page.title, ...page.aliases].map((name) => plainName(name)).filter((name) => name.length >= 2)),
];

const cardNames = ({ facts }: Person): readonly string[] =>
  [
    facts.name,
    [facts.given, facts.family].filter((part) => part !== undefined && part !== "").join(" "),
    facts.nickname ?? "",
  ]
    .map((name) => plainName(name))
    .filter((name) => name.length >= 2);

const firstNames = ({ facts }: Person): readonly string[] =>
  [facts.given ?? "", facts.nickname ?? "", facts.name.split(" ", 1)[0] ?? ""]
    .map((name) => plainName(name))
    .filter((name) => name.length >= 2);

const hasHandle = (person: Person, handles: Handles): boolean =>
  handles.emails.some((email) => person.facts.emails.some(({ value }) => sameMail(value, email))) ||
  handles.phones.some((phone) => person.facts.phones.some(({ value }) => samePhone(value, phone)));

// Which card a page is: sure, a question with the cards that could be them, or none.
export const judge = (page: LinkablePage, handles: Handles, cards: readonly Person[]): Verdict => {
  const byHandle = cards.filter((person) => hasHandle(person, handles));
  const [onlyHandle] = byHandle;
  if (onlyHandle !== undefined && byHandle.length === 1) {
    return { kind: "sure", person: onlyHandle, why: "an email or a phone number they share" };
  }
  if (byHandle.length > 1) return { kind: "unsure", candidates: byHandle.slice(0, mostCandidates) };
  const names = fullNames(page);
  const isFullName = names.some((name) => name.includes(" "));
  const byFullName = cards.filter((person) => cardNames(person).some((name) => names.includes(name)));
  const [onlyFullName] = byFullName;
  if (isFullName && onlyFullName !== undefined && byFullName.length === 1) {
    return { kind: "sure", person: onlyFullName, why: "the same full name, which no other card has" };
  }
  const firsts = new Set(names.map((name) => name.split(" ", 1)[0] ?? "").filter((name) => name.length >= 2));
  const byFirstName = cards.filter(
    (person) => !byFullName.includes(person) && firstNames(person).some((name) => firsts.has(name)),
  );
  const candidates = [...byFullName, ...byFirstName]
    .toSorted((left, right) => left.facts.name.localeCompare(right.facts.name))
    .slice(0, mostCandidates);
  return candidates.length === 0 ? { kind: "none" } : { kind: "unsure", candidates };
};

const city = ({ facts }: Person): string | undefined =>
  facts.addresses.map((address) => address.city).find((name) => name !== "");

// What tells a card apart, from the card alone: how to reach them, where they are or work, and a group they're in.
export const hintOf = (person: Person, groups: readonly string[]): string => {
  const { facts } = person;
  const reach = facts.phones[0]?.label ?? (facts.phones.length > 0 ? "phone" : undefined) ?? facts.emails[0]?.label;
  const where = city(person) ?? facts.organisation;
  const [group] = groups;
  return [reach, where, group === undefined ? undefined : `in ${group}`]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
};
