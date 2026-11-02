import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContactsSource, isConflict, type AddressBook, type ContactsSource } from "#contacts/carddav.ts";
import { applyChange, factsOf, mergeCards, newVCard, parseVCard, writeVCard, type VCard } from "#contacts/vcard.ts";
import { createCell } from "#cell.ts";
import type { Result } from "#result.ts";
import { claraCard, leoCard, photo } from "./support/contact-cards.ts";
import { startFakeCardDav, type FakeCardDav } from "./support/fake-carddav.ts";

const value = <Value>(result: Result<Value, string>): Value => {
  if (!result.ok) throw new Error(result.failure);
  return result.value;
};

const now = new Date("2026-11-01T09:00:00.000Z");

const card = (text: string): VCard => value(parseVCard(text));

describe("vCards", () => {
  it("reads an iPhone's vCard 3.0: labels, preferred values, a birthday without a year, related names and dates", () => {
    expect(factsOf(card(claraCard), "fallback")).toEqual({
      uid: "7C1D4E2A-1111-4C3B-9F00-ABCDEF012345",
      name: "Clara Voss",
      given: "Clara",
      family: "Voss",
      emails: [
        { value: "clara.voss@northwind.example", label: "work", preferred: true },
        { value: "clara@voss.example", label: "other" },
      ],
      phones: [
        { value: "+44 7700 900123", label: "mobile", preferred: true },
        { value: "020 7946 0000", label: "studio" },
      ],
      addresses: [
        {
          label: "home",
          street: "12 Harbour Row",
          city: "London",
          region: "",
          postcode: "E14 5AB",
          country: "United Kingdom",
        },
      ],
      birthday: { month: 4, day: 12 },
      dates: [{ month: 6, day: 20, year: 2019, label: "anniversary" }],
      organisation: "Northwind, Product",
      title: "Head of Product",
      related: [{ name: "Mira", label: "sister" }],
      note: "Met at the Halcyon offsite, 2024.\nLast caught up: Sep 2026 · coffee",
      isGroup: false,
    });
  });

  it("reads vCard 4.0, and knows an iCloud group isn't a person", () => {
    const group = card(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Running club\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nUID:g-1\r\nEND:VCARD\r\n",
    );

    expect(factsOf(card(leoCard), "fallback")).toMatchObject({
      uid: "urn:uuid:4f2b9a10-2222-4c3b-9f00-abcdef012345",
      name: "Leo Marsh",
      emails: [{ value: "leo@halcyon.example", label: "home" }],
      phones: [{ value: "+44-7700-900456", label: "mobile" }],
      birthday: { month: 11, day: 5 },
      related: [{ name: "Tess Harlow", label: "sibling" }],
    });
    expect(factsOf(group, "fallback").isGroup).toBe(true);
  });

  it("changes only what it's asked, keeping the photo and every line it doesn't touch exactly", () => {
    const changed = applyChange(
      card(claraCard),
      {
        addEmails: [
          { value: "clara@northwind.example", label: "work" },
          { value: "c.voss@school.example", label: "school" },
        ],
        removePhones: ["020 7946 0000"],
        addPhones: [{ value: "+44 7700 900999", label: "work" }],
        title: "VP Product",
        caughtUp: "Last caught up: Nov 2026 · lunch at Halcyon",
      },
      now,
    );
    const text = writeVCard(changed);
    const lines = text.replaceAll("\r\n ", "");
    const back = factsOf(card(text), "fallback");

    expect(lines).toContain(`${photo}\r\n`);
    expect(lines).toContain("item3.ADR;type=HOME;type=pref:;;12 Harbour Row;London;;E14 5AB;United Kingdom\r\n");
    expect(lines).toContain("EMAIL;TYPE=INTERNET,WORK:clara@northwind.example\r\n");
    expect(lines).toContain("item6.EMAIL;TYPE=INTERNET:c.voss@school.example\r\nitem6.X-ABLABEL:school\r\n");
    expect(lines).toContain("TEL;TYPE=WORK,VOICE:+44 7700 900999\r\n");
    expect(text).not.toContain("020 7946 0000");
    expect(text).not.toContain("item2.");
    expect(text).toContain("REV:2026-11-01T09:00:00Z\r\n");
    expect(text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(back.title).toBe("VP Product");
    expect(back.note).toBe("Met at the Halcyon offsite, 2024.\nLast caught up: Nov 2026 · lunch at Halcyon");
    expect(back.phones).toEqual([
      { value: "+44 7700 900123", label: "mobile", preferred: true },
      { value: "+44 7700 900999", label: "work" },
    ]);
  });

  it("merges another card's lines the kept one lacks, but never its identity, a second photo or a repeat", () => {
    const other = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Voss;Clara;;;",
      "FN:Clara Voss",
      "X-ABShowAs:COMPANY",
      "PHOTO;ENCODING=b;TYPE=JPEG:b3RoZXI=",
      "item1.X-ABDATE:2019-06-20",
      "item1.X-ABLabel:_$!<Anniversary>!$_",
      "item2.X-ABDATE:2020-02-02",
      "item2.X-ABLabel:first day at Northwind",
      "UID:CLARA-OLD",
      "END:VCARD",
      "",
    ].join("\r\n");

    const lines = writeVCard(mergeCards(card(claraCard), [card(other)], now)).replaceAll("\r\n ", "");

    expect(lines).toContain(`${photo}\r\n`);
    expect(lines).not.toContain("b3RoZXI=");
    expect(lines).not.toContain("X-ABShowAs");
    expect(lines).not.toContain("CLARA-OLD");
    expect(lines.match(/2019-06-20/gu)).toHaveLength(1);
    expect(lines).toContain("item6.X-ABDATE:2020-02-02\r\nitem6.X-ABLABEL:first day at Northwind\r\n");
  });

  it("writes a birthday and a new card the way iCloud keeps them", () => {
    const fresh = newVCard(
      "Tess Harlow",
      {
        addEmails: [{ value: "tess.harlow@halcyon.example", label: "work" }],
        birthday: { month: 3, day: 9 },
        addRelated: [{ name: "Leo Marsh", label: "brother" }],
        organisation: "Halcyon",
      },
      now,
      "NEW-UID-1",
    );
    const text = writeVCard(fresh);

    expect(text).toMatch(
      /^BEGIN:VCARD\r\nVERSION:3\.0\r\nPRODID:-\/\/Ito\/\/Kumo\/\/EN\r\nN:Harlow;Tess;;;\r\nFN:Tess Harlow\r\nUID:NEW-UID-1\r\n/u,
    );
    expect(text).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-09\r\n");
    expect(text).toContain("item1.X-ABRELATEDNAMES:Leo Marsh\r\nitem1.X-ABLABEL:_$!<Brother>!$_\r\n");
    expect(factsOf(card(text), "x")).toMatchObject({
      name: "Tess Harlow",
      birthday: { month: 3, day: 9 },
      organisation: "Halcyon",
    });
    const dated = applyChange(card(leoCard), { birthday: { year: 1994, month: 11, day: 5 } }, now);

    expect(writeVCard(dated)).toContain("BDAY:19941105\r\n");
  });
});

const contactsBook = async (source: ContactsSource): Promise<AddressBook> => {
  const found = value(await source.books()).find(({ name }) => name === "Contacts");
  if (!found) throw new Error("No Contacts book.");
  return found;
};

const tess = writeVCard(newVCard("Tess Harlow", {}, now, "TESS"));

describe("iCloud Contacts over CardDAV", () => {
  const fake = createCell<FakeCardDav | undefined>(undefined);

  const server = (): FakeCardDav => {
    const current = fake.get();
    if (!current) throw new Error("No fake CardDAV server is running.");
    return current;
  };

  const sourceFor = (appPassword = server().appPassword): ContactsSource =>
    createContactsSource({ appleId: server().appleId, appPassword, serverUrl: server().serverUrl });

  beforeEach(async () => {
    fake.set(await startFakeCardDav());
  });

  afterEach(async () => {
    await fake.get()?.close();
  });

  it("finds every address book, and says when the password is wrong", async () => {
    expect(value(await sourceFor().check()).books).toEqual([
      { url: server().bookUrl("Contacts"), name: "Contacts", readOnly: false },
      { url: server().bookUrl("Team"), name: "Team", readOnly: true },
    ]);
    expect(await sourceFor("wrong").check()).toEqual({
      ok: false,
      failure: "iCloud rejected that email address or app-specific password.",
    });
  });

  it("reads every book in full, then only what changed, and in full again when a token is refused", async () => {
    server().seed("Contacts", "clara.vcf", claraCard);
    server().seed("Team", "leo.vcf", leoCard);
    const source = sourceFor();

    const first = value(await source.changes());
    server().seed("Contacts", "tess.vcf", tess);
    const second = value(await source.changes(first.token));
    const quiet = value(await source.changes(second.token));
    server().forgetTokens();
    server().seed("Contacts", "mira.vcf", writeVCard(newVCard("Mira", {}, now, "MIRA")));
    const refused = value(await source.changes(quiet.token));

    expect(first.changed.map(({ url }) => url.split("/").at(-1))).toEqual(["clara.vcf", "leo.vcf"]);
    expect(first.full).toEqual([server().bookUrl("Contacts"), server().bookUrl("Team")]);
    expect(second.changed.map(({ url }) => url.split("/").at(-1))).toEqual(["tess.vcf"]);
    expect(second.full).toEqual([]);
    expect(quiet.changed).toEqual([]);
    expect(refused.full).toEqual([server().bookUrl("Contacts")]);
    expect(refused.changed.map(({ url }) => url.split("/").at(-1))).toEqual(["clara.vcf", "tess.vcf", "mira.vcf"]);
  });

  it("creates only new cards, and never writes over a card changed since it was read", async () => {
    const url = server().seed("Contacts", "clara.vcf", claraCard);
    const source = sourceFor();
    const book = await contactsBook(source);
    const read = value(await source.read(url, book));
    // Meanwhile, on the phone.
    server().seed("Contacts", "clara.vcf", claraCard.replace("Head of Product", "VP Product"));

    const stale = await source.update(read, claraCard.replace("Head of Product", "CPO"));
    const fresh = value(await source.read(url, book));
    const updated = value(await source.update(fresh, claraCard.replace("Head of Product", "CPO")));
    const duplicate = await source.create(book, "clara.vcf", claraCard);
    const made = value(await source.create(book, "tess.vcf", tess));

    expect(stale.ok ? "" : stale.failure).toSatisfy(isConflict);
    expect(updated.vcard).toContain("TITLE:CPO");
    expect(duplicate.ok ? "" : duplicate.failure).toSatisfy(isConflict);
    expect(made.etag).toMatch(/^"c\d+"$/u);
    expect(
      server()
        .writes()
        .map(({ method, condition = "" }) => `${method} ${condition}`),
    ).toEqual([
      `PUT if-match ${read.etag ?? ""}`,
      `PUT if-match ${fresh.etag ?? ""}`,
      "PUT if-none-match *",
      "PUT if-none-match *",
    ]);
  });

  it("removes a card only as read, and puts one back", async () => {
    const url = server().seed("Contacts", "clara.vcf", claraCard);
    const source = sourceFor();
    const book = await contactsBook(source);
    const read = value(await source.read(url, book));

    expect(await source.remove(url, '"stale"')).toEqual({
      ok: false,
      failure: expect.stringContaining("changed in iCloud") as unknown,
    });
    expect(await source.remove(url, read.etag)).toEqual({ ok: true, value: undefined });
    expect(server().stored(url)).toBeUndefined();
    expect(value(await source.restore(url, book, claraCard)).vcard).toBe(claraCard);
  });
});
