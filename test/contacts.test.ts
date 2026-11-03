import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { createContactsSource } from "#contacts/carddav.ts";
import { createContacts, type AddressUse, type Contacts, type PersonPage } from "#contacts/contacts.ts";
import { newVCard, writeVCard } from "#contacts/vcard.ts";
import { createDesk, type DeskKeeper } from "#desk/desk.ts";
import { randomIdentifiers } from "#identifiers.ts";
import type { DoneEntry } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Store } from "#store/store.ts";
import type { Tool } from "#tools/mcp.ts";
import { claraCard, folded, photo } from "./support/contact-cards.ts";
import { startFakeCardDav, type FakeCardDav } from "./support/fake-carddav.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const ignore = (): void => undefined;

const now = Date.parse("2026-11-01T09:00:00.000Z");

const clara = "7C1D4E2A-1111-4C3B-9F00-ABCDEF012345";

const leoWithEmail = writeVCard(
  newVCard("Leo Marsh", { addEmails: [{ value: "leo@halcyon.example", label: "home" }] }, new Date(now), "LEO-1"),
);

const leoWithPhone = writeVCard(
  newVCard(
    "Leo Marsh",
    { addPhones: [{ value: "+44 7700 900456", label: "mobile" }], birthday: { month: 11, day: 5 } },
    new Date(now),
    "LEO-2",
  ),
);

// Leo's older card, from another phone: his number, an anniversary, his site and his photo.
const leoFromOldPhone = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Marsh;Leo;;;",
  "FN:Leo Marsh",
  "TEL;type=CELL;type=VOICE:+44 7700 900456",
  "item1.X-ABDATE;type=pref:2021-09-14",
  "item1.X-ABLabel:_$!<Anniversary>!$_",
  "item2.URL;type=pref:https://leomarsh.example",
  "item2.X-ABLabel:_$!<HomePage>!$_",
  "X-SOCIALPROFILE;type=linkedin:https://www.linkedin.com/in/leomarsh",
  folded(photo),
  "UID:LEO-4",
  "END:VCARD",
  "",
].join("\r\n");

const leoChen = writeVCard(newVCard("Leo Chen", { addEmails: [{ value: "leo@acme.com" }] }, new Date(now), "LEO-3"));

// No mail with anyone yet.
const unused: AddressUse = () => Promise.resolve({});

// Mira wrote lately from her home address.
const homeLately: AddressUse = (address) =>
  Promise.resolve(address === "mira.osei@icloud.example" ? { from: "2026-10-20T10:00:00.000Z" } : {});

type Box = {
  readonly contacts: Contacts;
  readonly desk: DeskKeeper;
  readonly store: Store;
  readonly clock: VirtualClock;
  readonly prompts: () => readonly string[];
  readonly call: (name: string, input: unknown) => Promise<{ readonly text: string; readonly isError: boolean }>;
  readonly done: () => readonly DoneEntry[];
  readonly close: () => void;
};

const toolCall = async (tools: readonly Tool[], name: string, input: unknown) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}.`);
  const result = await tool.call(input);
  return { text: result.text, isError: result.isError === true };
};

describe("their iCloud Contacts, kept by Kumo", () => {
  const fake = createCell<FakeCardDav | undefined>(undefined);
  const homes = createCell<readonly string[]>([]);
  const boxes = createCell<readonly Box[]>([]);
  const isConnected = createCell(true);

  const server = (): FakeCardDav => {
    const current = fake.get();
    if (!current) throw new Error("No fake CardDAV server is running.");
    return current;
  };

  const open = (pages: readonly PersonPage[] = [], password = server().appPassword): Box => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ito-contacts-"));
    homes.update((all) => [...all, home]);
    const clock = createVirtualClock(now);
    const store = createStore(openDatabase(databaseFile(home)), clock, randomIdentifiers);
    const desk = createDesk({
      store,
      identifiers: randomIdentifiers,
      clock,
      timeZone: "UTC",
      work: () => Promise.resolve(ok("Done.")),
      info: ignore,
    });
    const prompts = createCell<readonly string[]>([]);
    const contacts = createContacts({
      host: {
        find: (id) =>
          id === "icloud" && isConnected.get()
            ? {
                id,
                state: "on",
                values: { apple_id: server().appleId, app_password: password },
                manifest: undefined as never,
              }
            : undefined,
        subscribe: () => ignore,
      },
      store,
      desk,
      clock,
      timeZone: "UTC",
      info: ignore,
      work: (prompt) => {
        prompts.update((all) => [...all, prompt]);
        return Promise.resolve(ok("Done."));
      },
      people: () => Promise.resolve(pages),
      createSource: (values) =>
        createContactsSource({
          appleId: String(values.apple_id),
          appPassword: String(values.app_password),
          serverUrl: server().serverUrl,
        }),
    });
    const box: Box = {
      contacts,
      desk,
      store,
      clock,
      prompts: () => prompts.get(),
      call: (name, input) => toolCall(contacts.tools, name, input),
      done: () => store.listDone(undefined, 50).entries,
      close: () => {
        contacts.close();
        store.close();
      },
    };
    boxes.update((all) => [...all, box]);
    return box;
  };

  beforeEach(async () => {
    isConnected.set(true);
    fake.set(await startFakeCardDav());
  });

  afterEach(async () => {
    for (const box of boxes.get()) box.close();
    boxes.set([]);
    await fake.get()?.close();
    for (const home of homes.get()) rmSync(home, { recursive: true, force: true });
    homes.set([]);
  });

  it("finds people by name, email, phone or company, with the People page linked to each card", async () => {
    server().seed("Contacts", "clara.vcf", claraCard);
    server().seed("Team", "leo.vcf", leoWithEmail);
    const box = open([{ address: "memory:people/clara-voss", title: "Clara Voss", circle: "work", contact: clara }]);

    const byName = await box.call("contacts_search", { query: "clara" });
    const byPhone = await box.call("contacts_search", { query: "07700 900123" });
    const byCompany = await box.call("contacts_search", { query: "northwind" });
    const read = await box.call("contacts_read", { uid: clara });
    const nobody = await box.call("contacts_search", { query: "Quillfield" });

    expect(byName.text).toBe(
      "1 in their Contacts matches “clara”:\n- Clara Voss · Head of Product at Northwind, Product · " +
        "clara.voss@northwind.example (work, preferred), clara@voss.example (other), +44 7700 900123 (mobile, preferred), " +
        `020 7946 0000 (studio) · uid ${clara} · page memory:people/clara-voss`,
    );
    expect(byPhone.text).toContain(`uid ${clara}`);
    expect(byCompany.text).toContain(`uid ${clara}`);
    expect(read.text).toContain("Birthday: 12 April (year not known)");
    expect(read.text).toContain("Related: Mira (sister)");
    expect(read.text).toContain("anniversary: 20 June 2019");
    expect(read.text).toContain("People page: memory:people/clara-voss (Clara Voss)");
    expect(nobody.text).toBe("No one in their Contacts matches “Quillfield”, out of 2 cards.");
    expect(await box.contacts.known("Clara.Voss@northwind.example")).toBe(
      `In their Contacts: Clara Voss, Head of Product at Northwind, Product (uid ${clara}); People page memory:people/clara-voss`,
    );
    expect(await box.contacts.known("stranger@acme.com")).toBeUndefined();
  });

  it("says when their Contacts can't be read, rather than that no one matches", async () => {
    server().seed("Contacts", "clara.vcf", claraCard);
    const box = open([], "wrong-password");

    const searched = await box.call("contacts_search", { query: "clara" });
    const recipient = await box.contacts.recipient("Clara Voss", unused);

    expect(searched).toEqual({
      text: "Their Contacts can't be read right now: iCloud rejected that email address or app-specific password.",
      isError: true,
    });
    expect(recipient.ok ? "" : recipient.failure).toMatch(/Give an email address instead\.$/u);
  });

  it("updates a card on its own, keeping the photo, with a reason in Done and an undo that puts it back", async () => {
    const url = server().seed("Contacts", "clara.vcf", claraCard);
    const box = open();

    const updated = await box.call("contacts_update", {
      uid: clara,
      email: ["work: clara@halcyon.example"],
      remove_email: ["clara.voss@northwind.example"],
      organisation: "Halcyon",
      job_title: "VP Product",
      caught_up: "lunch at Halcyon",
      reason: "Her new signature, 1 Nov",
    });
    const card = server().stored(url) ?? "";
    const [entry] = box.done();

    expect(updated).toEqual({
      text:
        "Updated Clara Voss in Contacts: work email clara@halcyon.example; no email clara.voss@northwind.example; " +
        "organisation Halcyon; title VP Product; last caught up Nov 2026 · lunch at Halcyon.",
      isError: false,
    });
    expect(card).toContain("clara@halcyon.example");
    expect(card).not.toContain("clara.voss@northwind.example");
    expect(card).toContain("ORG:Halcyon;Product;");
    expect(card.replaceAll("\r\n ", "")).toContain("Last caught up: Nov 2026 · lunch at Halcyon");
    expect(card.replaceAll("\r\n ", "")).toContain("PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ");
    expect(entry).toMatchObject({
      text: expect.stringMatching(/^Updated Clara Voss in Contacts: work email clara@halcyon\.example/u) as unknown,
      reason: "Her new signature, 1 Nov",
      undo: true,
    });

    const undone = await box.desk.undo(entry?.id ?? "");

    expect(undone.ok).toBe(true);
    expect(server().stored(url)).toBe(claraCard);
  });

  it("won't undo over a change made on their phone since", async () => {
    const url = server().seed("Contacts", "clara.vcf", claraCard);
    const box = open();
    await box.call("contacts_update", { uid: clara, job_title: "VP Product", reason: "Her signature" });
    server().seed("Contacts", "clara.vcf", claraCard.replace("Head of Product", "Chief Product Officer"));

    const undone = await box.desk.undo(box.done()[0]?.id ?? "");

    expect(undone).toEqual({
      ok: false,
      failure: "That contact has changed in Contacts since, so Undo would lose the newer change.",
    });
    expect(server().stored(url)).toContain("Chief Product Officer");
  });

  it("adds someone new, but never a second card for someone already there", async () => {
    server().seed("Contacts", "clara.vcf", claraCard);
    const box = open();

    const added = await box.call("contacts_add", {
      name: "Tess Harlow",
      email: ["work: tess.harlow@halcyon.example"],
      phone: ["mobile: +44 7700 900777"],
      address: ["home: 4 Quay Street; Bristol; ; BS1 4DJ; United Kingdom"],
      birthday: "03-09",
      related: ["brother: Leo Marsh"],
      reason: "She introduced herself in the Halcyon thread",
    });
    const sameEmail = await box.call("contacts_add", {
      name: "Clara V",
      email: ["clara.voss@northwind.example"],
      reason: "Test",
    });
    const sameName = await box.call("contacts_add", { name: "Clara Voss", reason: "Test" });
    const badDate = await box.call("contacts_add", { name: "Mira", birthday: "31-02", reason: "Test" });
    const files = server().files("Contacts");
    const tess = server().stored(`${server().bookUrl("Contacts")}${files.find((file) => file !== "clara.vcf") ?? ""}`);

    expect(added.text).toMatch(
      /^Added Tess Harlow to their Contacts as uid [\dA-F-]{36}\. If they have a People page/u,
    );
    expect(tess).toContain("EMAIL;TYPE=INTERNET,WORK:tess.harlow@halcyon.example");
    expect(tess).toContain("TEL;TYPE=CELL,VOICE:+44 7700 900777");
    expect(tess).toContain("ADR;TYPE=HOME:;;4 Quay Street;Bristol;;BS1 4DJ;United Kingdom");
    expect(tess).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-09");
    expect(sameEmail).toEqual({
      text: `Clara Voss already has that email or phone (uid ${clara}): add to that card with update.`,
      isError: true,
    });
    expect(sameName.text).toMatch(/^Clara Voss is already in their Contacts \(uid /u);
    expect(badDate.text).toBe(`"31-02" isn't a date: give 1990-04-12, or 04-12 when the year isn't known.`);
    expect(box.done()[0]).toMatchObject({
      text: expect.stringMatching(/^Added Tess Harlow to Contacts: /u) as unknown,
    });

    const undone = await box.desk.undo(box.done()[0]?.id ?? "");

    expect(undone.ok).toBe(true);
    expect(server().files("Contacts")).toEqual(["clara.vcf"]);
  });

  it("asks once on the Desk before merging or deleting, and only then does it, with an undo", async () => {
    const kept = server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    const other = server().seed("Contacts", "leo-2.vcf", leoWithPhone);
    const box = open([{ address: "memory:people/leo", title: "Leo", contact: "LEO-2" }]);

    const duplicates = await box.call("contacts_search", { duplicates: true });
    const asked = await box.call("contacts_merge", {
      uid: ["LEO-1", "LEO-2"],
      reason: "One has his email, one his phone",
    });
    const card = box.desk.cards().find(({ title }) => title === "Merge 2 cards for Leo Marsh?");

    expect(duplicates.text).toContain("Maybe one person:\n- Leo Marsh");
    expect(asked.text).toMatch(/^Asked them on the Desk as k_\w+: “Merge 2 cards for Leo Marsh\?”/u);
    expect(card?.question?.text).toContain("One has his email, one his phone.");
    expect(server().files("Contacts")).toEqual(["leo-1.vcf", "leo-2.vcf"]);

    box.desk.answer(card?.id ?? "", { option: "Merge" });
    await box.desk.settled();
    const merged = server().stored(kept) ?? "";
    const read = await box.call("contacts_read", { uid: "LEO-2" });

    expect(server().files("Contacts")).toEqual(["leo-1.vcf"]);
    expect(merged).toContain("leo@halcyon.example");
    expect(merged).toContain("+44 7700 900456");
    expect(merged).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-11-05");
    expect(read.text).toMatch(/^Leo Marsh \(uid LEO-1, in Contacts\)/u);
    expect(read.text).toContain("People page: memory:people/leo (Leo)");
    expect(box.done()[0]).toMatchObject({
      text: "Merged 2 cards for Leo Marsh in Contacts",
      reason: "You agreed: One has his email, one his phone",
      undo: true,
    });

    const unmerged = await box.desk.undo(box.done()[0]?.id ?? "");

    expect(unmerged.ok).toBe(true);
    expect(server().stored(kept)).toBe(leoWithEmail);
    expect(server().stored(other)).toBe(leoWithPhone);

    await box.contacts.refresh();
    await box.call("contacts_delete", { uid: "LEO-2", reason: "You said it's an old card" });
    const deletion = box.desk.cards().find(({ title }) => title === "Delete Leo Marsh from Contacts?");
    box.desk.answer(deletion?.id ?? "", { option: "Keep" });
    await box.desk.settled();

    expect(server().stored(other)).toBe(leoWithPhone);
    expect(box.desk.cards()).toEqual([]);
  });

  it("merges everything a card carries, such as a photo, an anniversary and a profile, and splits it again", async () => {
    const kept = server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    const other = server().seed("Contacts", "leo-4.vcf", leoFromOldPhone);
    const box = open();
    await box.call("contacts_merge", { uid: ["LEO-1", "LEO-4"], reason: "Both are Leo" });
    const card = box.desk.cards().find(({ title }) => title === "Merge 2 cards for Leo Marsh?");

    box.desk.answer(card?.id ?? "", { option: "Merge" });
    await box.desk.settled();
    const merged = (server().stored(kept) ?? "").replaceAll("\r\n ", "");
    const read = await box.call("contacts_read", { uid: "LEO-1" });

    expect(server().files("Contacts")).toEqual(["leo-1.vcf"]);
    expect(merged).toContain("item1.X-ABDATE;TYPE=pref:2021-09-14\r\nitem1.X-ABLABEL:_$!<Anniversary>!$_");
    expect(merged).toContain("item2.URL;TYPE=pref:https://leomarsh.example\r\nitem2.X-ABLABEL:_$!<HomePage>!$_");
    expect(merged).toContain("X-SOCIALPROFILE;type=linkedin:https://www.linkedin.com/in/leomarsh");
    expect(merged).toContain(photo);
    expect(read.text).toContain("anniversary: 14 September 2021");

    const unmerged = await box.desk.undo(box.done()[0]?.id ?? "");

    expect(unmerged.ok).toBe(true);
    expect(server().stored(kept)).toBe(leoWithEmail);
    expect(server().stored(other)).toBe(leoFromOldPhone);
  });

  it("keeps an undo for what merged when a card changed on their phone meanwhile, and says what didn't", async () => {
    const kept = server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    const other = server().seed("Contacts", "leo-2.vcf", leoWithPhone);
    server().seed("Contacts", "leo-4.vcf", leoFromOldPhone);
    server().editOnDelete("Contacts", "leo-4.vcf");
    const box = open();
    await box.call("contacts_merge", { uid: ["LEO-1", "LEO-2", "LEO-4"], reason: "All three are Leo" });
    const card = box.desk.cards().find(({ title }) => title === "Merge 3 cards for Leo Marsh?");

    box.desk.answer(card?.id ?? "", { option: "Merge" });
    await box.desk.settled();
    const entry = box.done().find(({ text }) => text.startsWith("Merged"));

    expect(server().files("Contacts")).toEqual(["leo-1.vcf", "leo-4.vcf"]);
    expect(entry).toMatchObject({ text: "Merged 2 of 3 cards for Leo Marsh in Contacts", undo: true });
    expect(box.done().find(({ text }) => text.startsWith("Couldn't"))).toMatchObject({
      text: "Couldn't merge Leo Marsh in Contacts",
      reason: "That contact changed in iCloud since it was read; read it again first.",
    });

    const unmerged = await box.desk.undo(entry?.id ?? "");

    expect(unmerged.ok).toBe(true);
    expect(server().stored(kept)).toBe(leoWithEmail);
    expect(server().stored(other)).toBe(leoWithPhone);
  });

  it("forgets an ask whose card has gone without an answer", async () => {
    server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    server().seed("Contacts", "leo-2.vcf", leoWithPhone);
    const box = open();
    await box.call("contacts_merge", { uid: ["LEO-1", "LEO-2"], reason: "Both are Leo" });
    const [cleared] = box.desk.cards();
    box.desk.removeCard(cleared?.id ?? "");

    await box.call("contacts_delete", { uid: "LEO-2", reason: "An old card" });
    const [deletion] = box.desk.cards();

    expect(JSON.parse(box.store.setting("contacts_asks") ?? "[]")).toMatchObject([{ card: deletion?.id }]);
  });

  it("says so when iCloud went before they answered", async () => {
    server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    server().seed("Contacts", "leo-2.vcf", leoWithPhone);
    const box = open();
    await box.call("contacts_delete", { uid: "LEO-2", reason: "An old card" });
    const [deletion] = box.desk.cards();
    isConnected.set(false);

    box.desk.answer(deletion?.id ?? "", { option: "Delete" });
    await box.desk.settled();

    expect(box.done()).toMatchObject([
      { text: "Couldn't delete Leo Marsh in Contacts", reason: "iCloud isn't connected any more." },
    ]);
    expect(server().files("Contacts")).toEqual(["leo-1.vcf", "leo-2.vcf"]);
  });

  it("brings up a birthday a few days ahead, once, for Kumo to judge and message about at a good moment", async () => {
    server().seed("Contacts", "leo.vcf", leoWithPhone);
    server().seed("Contacts", "clara.vcf", claraCard);
    const box = open([
      { address: "memory:people/leo", title: "Leo", circle: "friends", gist: "Your oldest friend", contact: "LEO-2" },
    ]);

    await vi.waitFor(() => {
      expect(box.prompts()).toHaveLength(1);
    });
    const [prompt = ""] = box.prompts();

    expect(prompt).toContain(
      "- Leo Marsh: birthday, Thursday 5 November, in 4 days. People page memory:people/leo, circle friends: Your oldest friend.",
    );
    expect(prompt).toContain("“Leo's birthday is Thursday.");
    expect(prompt).toContain("if now is a good moment in their day, or set a wake-up for a better one");
    expect(prompt).not.toContain("Clara");

    box.clock.moveTo(now + 3 * 60 * 60 * 1000);
    box.clock.runNext(now + 3 * 60 * 60 * 1000);
    box.clock.moveTo(now + 26 * 60 * 60 * 1000);
    box.clock.runNext(now + 26 * 60 * 60 * 1000);
    await box.contacts.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(box.prompts()).toHaveLength(1);
  });

  it("picks the address to write to someone: by label, by the one last used, or as preferred, and asks otherwise", async () => {
    const both = writeVCard(
      newVCard(
        "Mira Osei",
        {
          addEmails: [
            { value: "mira@northwind.example", label: "work" },
            { value: "mira.osei@icloud.example", label: "home" },
          ],
        },
        new Date(now),
        "MIRA",
      ),
    );
    server().seed("Contacts", "mira.vcf", both);
    server().seed("Contacts", "clara.vcf", claraCard);
    server().seed("Contacts", "leo-1.vcf", leoWithEmail);
    server().seed("Contacts", "leo-2.vcf", leoChen);
    const box = open();

    expect(await box.contacts.recipient("Mira Osei (work)", unused)).toEqual({
      ok: true,
      value: { address: "mira@northwind.example", name: "Mira Osei", why: "their work address" },
    });
    expect(await box.contacts.recipient("Mira", homeLately)).toEqual({
      ok: true,
      value: { address: "mira.osei@icloud.example", name: "Mira Osei", why: "the address they last wrote from" },
    });
    expect(await box.contacts.recipient("Clara Voss", unused)).toEqual({
      ok: true,
      value: { address: "clara.voss@northwind.example", name: "Clara Voss", why: "their preferred address" },
    });
    expect(await box.contacts.recipient("Mira Osei", unused)).toEqual({
      ok: false,
      failure:
        "Mira Osei has mira@northwind.example (work), not used and mira.osei@icloud.example (home), not used. " +
        'Say which, such as --to "Mira Osei (work)", or give the address.',
    });
    expect(await box.contacts.recipient("Leo", unused)).toEqual({
      ok: false,
      failure:
        "“Leo” could be Leo Marsh (leo@halcyon.example) and Leo Chen (leo@acme.com). Give their full name or the address you mean.",
    });
    expect(await box.contacts.recipient("Quillfield Dental", unused)).toEqual({
      ok: false,
      failure:
        "“Quillfield Dental” isn't in their Contacts. Give an email address, or look them up with ito contacts search.",
    });
  });
});
