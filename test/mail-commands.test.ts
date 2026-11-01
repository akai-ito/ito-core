import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CalendarSource } from "#calendar/caldav.ts";
import { createCell } from "#cell.ts";
import { onSetting, valuesSetting } from "#capabilities/host.ts";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import type { EngineContext } from "#server.ts";
import type { TimedEvent } from "#engine/scripted/script-engine.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { commandsPath } from "#http/tools.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { foldersSetting } from "#mail/folders.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Card, Step } from "#protocol/types.ts";
import { fail } from "#result.ts";
import { createServer, databaseFile, type Server } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { createContactsSource } from "#contacts/carddav.ts";
import { claraCard } from "./support/contact-cards.ts";
import { startFakeCardDav, type FakeCardDav } from "./support/fake-carddav.ts";
import { createFakeMail } from "./support/fake-mail.ts";
import { draftShape } from "./support/mime.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-mail-commands-"));
const launcher = path.join(home, "bin", "ito");
const appToken = "ito_mail_commands_app";

const offer = {
  account: "icloud",
  message_id: "role-1@northwind.example",
  from: "Clara Voss <clara.voss@northwind.example>",
  to: ["sam@icloud.com"],
  subject: "AI Engineer at Northwind",
  text: "Hi Sam, would you be open to a chat about our AI Engineer role this week?",
};

const promo = {
  account: "icloud",
  message_id: "deal-9@pizza.example",
  from: "Pizza Place <deals@pizza.example>",
  to: ["sam@icloud.com"],
  subject: "Two for one tonight",
  text: "Order now.",
};

// Thirty receipts in a folder an earlier assistant made.
const oldReceipts = Array.from({ length: 30 }, (_, index) => ({
  account: "icloud",
  message_id: `receipt-${String(index + 1)}@quillfield.example`,
  from: index % 3 === 0 ? "Halcyon <billing@halcyon.example>" : "Quillfield Dental <hello@quillfield.example>",
  to: ["sam@icloud.com"],
  subject: `Receipt ${String(index + 1)}`,
  text: "Paid, thank you.",
}));

const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);

const signature = "Sam\nProduct Engineer, Halcyon";

const absent = (): Promise<never> => Promise.resolve(fail("No calendar in this test.") as never);

const noCalendar = (): CalendarSource => ({
  check: absent,
  calendars: absent,
  ensureKumo: absent,
  events: absent,
  create: absent,
  update: absent,
  remove: absent,
  respond: absent,
  changes: absent,
});

// One turn's script: a command step that runs `ito mail search` and a tool step from the MCP door, both held
// open long enough to see their titles while running, then a short reply.
const searchTurn = (now: number): readonly TimedEvent[] => [
  {
    at: now + 50,
    event: {
      type: "step.started",
      key: "shell",
      kind: "command",
      facts: { command: `${launcher} mail search --from northwind.example` },
    },
  },
  {
    at: now + 50,
    event: {
      type: "step.started",
      key: "mcp",
      kind: "tool",
      facts: { capability: "ito", operation: "mail_thread", arguments: { message_id: offer.message_id } },
    },
  },
  {
    at: now + 1500,
    event: {
      type: "step.ended",
      key: "shell",
      outcome: "completed",
      facts: { exit_code: 0, output: "- 2026-11-01 · Clara Voss · AI Engineer at Northwind" },
    },
  },
  { at: now + 1500, event: { type: "step.ended", key: "mcp", outcome: "completed", facts: {} } },
  { at: now + 1550, event: { type: "text.started", kind: "reply" } },
  { at: now + 1560, event: { type: "text", text: "Northwind wrote about an AI Engineer role." } },
  { at: now + 1570, event: { type: "text.ended" } },
  { at: now + 1580, event: { type: "ended" } },
];

describe("mail in the conversation, through ito mail commands", () => {
  const mail = createFakeMail(() => new Date().toISOString());
  const server = createCell<Server | undefined>(undefined);
  const context = createCell<EngineContext | undefined>(undefined);
  const carddav = createCell<FakeCardDav | undefined>(undefined);

  const running = (): { readonly server: Server; readonly context: EngineContext } => {
    const current = server.get();
    const given = context.get();
    if (!current || !given) throw new Error("The server isn't running.");
    return { server: current, context: given };
  };

  const command = async (
    words: readonly string[],
    token = running().context.tools()?.token ?? "",
    capability = "mail",
  ): Promise<{ readonly status: number; readonly text: string }> => {
    const origin = running().context.tools()?.origin ?? "";
    const response = await fetch(`${origin}${commandsPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ capability, arguments: words }),
    });
    const body = response.status === 401 ? { text: "" } : ((await response.json()) as { readonly text: string });
    return { status: response.status, text: body.text };
  };

  const drafts = (): readonly Card[] =>
    running()
      .server.store.desk()
      .waiting.filter((card) => card.kind === "draft");

  const inApp = (url: string, payload?: Readonly<Record<string, unknown>>) =>
    running().server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${appToken}` },
      ...(payload && { payload }),
    });

  beforeAll(async () => {
    const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
    store.setSetting(onSetting("icloud"), "true");
    store.setSetting(valuesSetting("icloud"), JSON.stringify({ apple_id: "sam@icloud.com", app_password: "test" }));
    store.setSetting(foldersSetting, JSON.stringify(["Money & receipts", "Newsletters"]));
    store.setSetting(tokenSetting, hashToken(appToken));
    store.close();
    // A skill file an earlier version wrote for the mail account, which has no commands of its own.
    mkdirSync(path.join(home, "skills", "icloud"), { recursive: true });
    writeFileSync(path.join(home, "skills", "icloud", "SKILL.md"), "---\nname: icloud\n---\n");
    // A picture they attached in the chat, as the engine saves it in the workspace, and a file Kumo made.
    mkdirSync(path.join(home, "workspace", "uploads"), { recursive: true });
    writeFileSync(path.join(home, "workspace", "uploads", "beach.jpg"), jpeg);
    writeFileSync(path.join(home, "workspace", "plan.pdf"), "%PDF-1.7");
    // What they sent lately, which ends with their signature.
    mail.sentWhole("icloud", { text: `Sounds good.\n\nCheers,\nSam\n\n${signature}`, images: [] });
    mail.sentWhole("icloud", { text: `Thursday works.\n\n${signature}`, images: [] });
    // In the inbox before the server watches it, so neither mail arrives as new.
    mail.arrive(offer);
    mail.arrive(promo);
    for (const receipt of oldReceipts) mail.keep("Receipts (old)", receipt);
    // Their contacts, in a fake iCloud.
    const contacts = await startFakeCardDav();
    carddav.set(contacts);
    contacts.seed("Contacts", "clara.vcf", claraCard);
    const started = createServer({
      embedder: wordEmbedder,
      dataDirectory: home,
      name: "mail-commands",
      timeZone: "UTC",
      createMailSource: mail.create,
      createCalendarSource: noCalendar,
      createContactsSource: () =>
        createContactsSource({
          appleId: contacts.appleId,
          appPassword: contacts.appPassword,
          serverUrl: contacts.serverUrl,
        }),
      createEngine: (given) => {
        context.set(given);
        return createScriptEngine(systemClock, (_turn, _inputs, now) => ({
          events: searchTurn(now),
          steer: () => ({ outcome: "refused" }),
          stoppedAt: (at) => at,
        }));
      },
    });
    server.set(started);
    await started.app.listen({ host: "127.0.0.1", port: 0 });
    await started.host.ready;
    await vi.waitFor(() => {
      expect(started.mail.accounts()).not.toHaveLength(0);
    });
  });

  afterAll(async () => {
    await server.get()?.close();
    await carddav.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists mail in the instructions' skills, with a skill file that has its commands", () => {
    const skillFile = path.join(home, "skills", "mail", "SKILL.md");
    const instructions = running().context.instructions();

    expect(instructions).toContain(`- mail: their mail: find it, go through the inbox a page at a time`);
    expect(instructions).toContain(`(file: ${skillFile})`);
    expect(existsSync(skillFile)).toBe(true);
    const skill = readFileSync(skillFile, "utf8");
    expect(skill).toContain("name: mail");
    expect(skill).toContain(`${launcher} mail search: Search their mail`);
    expect(skill).toContain(`${launcher} mail draft: Write a draft`);
    expect(skill).toContain(`${launcher} mail inbox: List what's in their inbox now`);
    expect(skill).toContain(`${launcher} mail move: Move many mails at once`);
    expect(skill).toContain("  --to <string> (repeat for more): One email address, or a name in their Contacts");
    expect(skill).toContain("ito mail draft --to clara.voss@northwind.example --to tess.harlow@halcyon.example");
  });

  it("leaves out mail accounts, which have no commands of their own, from the agent's skills", async () => {
    const instructions = running().context.instructions();
    const icloud = await command(["--help"], undefined, "icloud");

    expect(instructions).not.toMatch(/^- icloud:/mu);
    expect(existsSync(path.join(home, "skills", "icloud", "SKILL.md"))).toBe(false);
    expect(icloud).toEqual({ status: 422, text: "iCloud has no commands of its own; Ito's own tools use it." });
  });

  it("goes through the inbox a page at a time, saying what's there and what's left", async () => {
    const first = await command(["inbox", "--limit", "1"]);
    const second = await command(["inbox", "--limit", "1", "--more", "1"]);
    const scoped = await command(["search", "--from", "northwind.example", "--folder", "inbox"]);

    expect(first.text.split("\n")).toEqual([
      "Their inbox holds 2 mails now. These are 1–1, newest first.",
      expect.stringContaining(`Pizza Place · Two for one tonight (icloud ${promo.message_id})`),
      "1 more: run it again with --more 1 for the next page.",
    ]);
    expect(second.text).toContain(`Clara Voss · AI Engineer at Northwind (icloud ${offer.message_id})`);
    expect(second.text).toContain("That's all of them.");
    expect(scoped.text).toMatch(
      /^Searched Inbox for northwind\.example: 1 mail matches\. These are 1–1, newest first\./u,
    );
  });

  it("refuses a recipient that isn't one email address, and says to repeat --to", async () => {
    const before = mail.drafts().length;
    const listed = await command([
      "draft",
      "--to",
      '["clara.voss@northwind.example","tess.harlow@halcyon.example"]',
      "--subject",
      "Intro",
      "--body",
      "Hello",
    ]);
    const commas = await command([
      "draft",
      "--to",
      "clara.voss@northwind.example, tess.harlow@halcyon.example",
      "--subject",
      "Intro",
      "--body",
      "Hello",
    ]);

    expect(listed.status).toBe(422);
    expect(listed.text).toContain("--to takes one value each time: repeat --to for each, rather than giving a list.");
    expect(commas.status).toBe(422);
    expect(commas.text).toBe(
      '"clara.voss@northwind.example, tess.harlow@halcyon.example" isn\'t an email address. Give one address each ' +
        "time and repeat --to for each, such as --to clara.voss@northwind.example --to tess.harlow@halcyon.example.",
    );
    expect(mail.drafts()).toHaveLength(before);
  });

  it("replaces any draft on the Desk by its card, keeping what isn't given again", async () => {
    await command([
      "draft",
      "--to",
      "clara.voss@northwind.example",
      "--subject",
      "Coffee next week?",
      "--body",
      "Free Tuesday?",
    ]);
    const first = drafts().find((card) => card.draft?.subject === "Coffee next week?");
    const fixed = await command(["draft", "--replaces", first?.id ?? "", "--to", "tess.harlow@halcyon.example"]);
    const missing = await command(["draft", "--replaces", "card_gone", "--body", "Hello"]);

    expect(fixed.text).toBe(
      `Saved the draft in Drafts and put it on the Desk as ${first?.id ?? ""}, in place of the earlier one. ` +
        "Their signature from their sent mail is at the end.",
    );
    expect(drafts().filter((card) => card.draft?.subject === "Coffee next week?")).toEqual([
      expect.objectContaining({
        id: first?.id,
        title: first?.title,
        changed_at: expect.any(String) as unknown,
        draft: expect.objectContaining({ to: ["tess.harlow@halcyon.example"], body: "Free Tuesday?" }) as unknown,
      }),
    ]);
    expect(mail.removedDrafts()).toContain(first?.draft?.message_id);
    expect(missing.text).toMatch(/^There's no draft card_gone on the Desk to replace\. Drafts there: /u);
  });

  it("drafts formatted mail with a picture from the chat, a file and their signature, kept when redrafted", async () => {
    const body = "Here's **the plan**:\n\n- Fly out Friday\n- Back Sunday\n\n![Leo at the beach](uploads/beach.jpg)";
    const drafted = await command([
      "draft",
      "--to",
      "leo@halcyon.example",
      "--subject",
      "The weekend",
      "--body",
      body,
      "--attach",
      "plan.pdf",
      "--title",
      "Weekend plan for Leo",
    ]);
    const card = drafts().find(({ title }) => title === "Weekend plan for Leo");
    const saved = mail.drafts().at(-1);
    if (!card || !saved) throw new Error("The draft wasn't saved.");

    expect(drafted.text).toBe(
      `Saved the draft in Drafts and put it on the Desk as ${card.id}. Their signature from their sent mail is at ` +
        "the end. It carries beach.jpg (inline) and plan.pdf.",
    );
    expect(card.draft).toMatchObject({
      body,
      signature,
      attachments: [
        { name: "beach.jpg", kind: "image", inline: true },
        { name: "plan.pdf", kind: "file", inline: false },
      ],
    });
    expect(saved.body).toBe(
      `Here's the plan:\n\n- Fly out Friday\n- Back Sunday\n\n[image: Leo at the beach]\n\n${signature}`,
    );
    expect(saved.html).toContain("<strong>the plan</strong>");
    expect(saved.html).toContain("<div>Sam<br>Product Engineer, Halcyon</div>");
    expect(await draftShape(saved)).toEqual([
      "multipart/mixed",
      [
        ["multipart/alternative", ["text/plain", ["multipart/related", ["text/html", "image/jpeg"]]]],
        "application/pdf",
      ],
    ]);

    await command(["draft", "--replaces", card.id, "--body", "Here's the *new* plan."]);
    const redrafted = mail.drafts().at(-1);
    await command(["draft", "--replaces", card.id, "--no-signature"]);
    const unsigned = mail.drafts().at(-1);
    const unsignedCard = drafts().find(({ id }) => id === card.id);

    expect(redrafted?.body).toBe(`Here's the new plan.\n\n${signature}`);
    expect(redrafted?.attachments?.map(({ filename }) => filename)).toEqual(["plan.pdf"]);
    expect(redrafted?.inline).toEqual([]);
    expect(unsigned?.body).toBe("Here's the new plan.");
    expect(unsigned?.attachments?.map(({ filename }) => filename)).toEqual(["plan.pdf"]);
    expect(unsignedCard?.draft?.signature).toBeUndefined();
    expect(unsignedCard?.draft?.attachments).toEqual([{ name: "plan.pdf", kind: "file", inline: false }]);
  });

  it("drafts to someone by name, with the address their Contacts and their mail point to", async () => {
    const drafted = await command([
      "draft",
      "--to",
      "Clara Voss",
      "--subject",
      "Lunch?",
      "--body",
      "Free Thursday?",
      "--title",
      "Lunch with Clara",
    ]);
    const unknown = await command(["draft", "--to", "Quillfield", "--subject", "Hi", "--body", "Hello"]);
    const card = drafts().find(({ title }) => title === "Lunch with Clara");

    expect(card?.draft?.to).toEqual(["clara.voss@northwind.example"]);
    expect(mail.drafts().at(-1)?.to).toEqual([{ address: "clara.voss@northwind.example", name: "Clara Voss" }]);
    expect(drafted.text).toContain(
      "From Contacts, Clara Voss: clara.voss@northwind.example, the address they last wrote from.",
    );
    expect(unknown.text).toBe(
      "“Quillfield” isn't in their Contacts. Give an email address, or look them up with ito contacts search.",
    );
  });

  it("looks people up with ito contacts commands, from a skill file of their own", async () => {
    const found = await command(["search", "--query", "clara"], undefined, "contacts");
    const instructions = running().context.instructions();
    const skill = readFileSync(path.join(home, "skills", "contacts", "SKILL.md"), "utf8");

    expect(found.text).toContain("Clara Voss · Head of Product at Northwind, Product");
    expect(instructions).toContain("- contacts: their iCloud Contacts, the source of truth");
    expect(skill).toContain(`${launcher} contacts update: Change someone's card`);
  });

  it("refuses a picture or a file from outside the workspace, saying so", async () => {
    const before = mail.drafts().length;
    const outside = await command([
      "draft",
      "--to",
      "leo@halcyon.example",
      "--subject",
      "Hi",
      "--body",
      "Here.",
      "--attach",
      "../ito.db",
    ]);
    const missing = await command([
      "draft",
      "--to",
      "leo@halcyon.example",
      "--subject",
      "Hi",
      "--body",
      "![Leo](uploads/gone.jpg)",
    ]);

    expect(outside.text).toBe("../ito.db isn't in your workspace, so it can't go in a mail.");
    expect(missing.text).toBe("There's no uploads/gone.jpg in your workspace.");
    expect(mail.drafts()).toHaveLength(before);
  });

  it("moves a few mails at once, as one line in the Done list", async () => {
    const moved = await command(["move", "--message-id", promo.message_id, "--into", "bin", "--reason", "A promotion"]);

    expect(moved.text).toBe("Moved 1 mail from Inbox to the bin.");
    expect(mail.folderOf("icloud", promo.message_id)).toBe("Trash");
    expect(running().server.store.listDone(undefined, 5).entries[0]).toMatchObject({
      text: "Moved 1 mail from Inbox to the bin",
      reason: "A promotion",
      undo: true,
    });
  });

  it("lists the account's folders, and moves an old one into theirs once they agree on the Desk", async () => {
    const listed = await command(["folders"]);
    const asked = await command(["move", "--folder", "Receipts (old)", "--into", "money & receipts"]);
    const card = running()
      .server.store.desk()
      .waiting.find(({ title }) => title === "Move 30 mails from Receipts (old) into Money & receipts?");

    expect(listed.text).toContain("- Receipts (old): 30 mails");
    expect(listed.text).toContain(
      "Their folders not made yet (the first mail filed makes one): Money & receipts, Newsletters.",
    );
    expect(asked.text).toContain("That's 30 mails, so they're asked once on the Desk first");
    expect(card).toMatchObject({
      kind: "question",
      options: [{ label: "Apply" }, { label: "Not now" }],
      question: {
        text: "They're from Quillfield Dental and Halcyon. They go in one move, and Undo on your Done list puts them back.",
      },
    });
    expect(mail.folderOf("icloud", "receipt-1@quillfield.example")).toBe("Receipts (old)");

    const answered = await inApp(`/v0/desk/cards/${card?.id ?? "none"}/answer`, { option: "Apply" });
    expect(answered.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(mail.folderOf("icloud", "receipt-1@quillfield.example")).toBe("Money & receipts");
    });
    const [entry] = running().server.store.listDone(undefined, 5).entries;
    expect(entry).toMatchObject({ text: "Moved 30 mails from Receipts (old) into Money & receipts", undo: true });

    const undone = await inApp(`/v0/done/${entry?.id ?? "none"}/undo`);
    expect(undone.statusCode).toBe(200);
    expect(oldReceipts.map(({ message_id: id }) => mail.folderOf("icloud", id))).toEqual(
      oldReceipts.map(() => "Receipts (old)"),
    );
  });

  it("searches and reads mail, only for the session's token", async () => {
    const found = await command(["search", "--from", "northwind.example"]);
    const read = await command(["read", "--message-id", offer.message_id]);

    expect(found.status).toBe(200);
    expect(found.text).toContain(`Clara Voss · AI Engineer at Northwind (icloud ${offer.message_id})`);
    expect(found.text).not.toContain("Pizza Place");
    expect(read.text).toContain("Subject: AI Engineer at Northwind");
    expect(read.text).toContain("would you be open to a chat");
    const refused = await command(["search", "--from", "northwind.example"], "ito_wrong");
    expect(refused.status).toBe(401);
  });

  it("explains itself on help or a mistake", async () => {
    const help = await command([]);
    const unknown = await command(["forward"]);
    const missing = await command(["read"]);

    expect(help.status).toBe(200);
    expect(help.text).toContain("Mail: their mail");
    expect(help.text).toContain(`${launcher} mail unsubscribe:`);
    expect(unknown).toMatchObject({ status: 422 });
    expect(unknown.text).toContain("Mail has no forward.");
    expect(missing.status).toBe(422);
    expect(missing.text).toContain("It needs --message-id.");
  });

  it("drafts a reply onto the Desk, and replaces it when drafted again", async () => {
    const first = await command(["draft", "--reply-to", offer.message_id, "--body", "Happy to chat. Thursday?"]);
    const firstCard = drafts().find((card) => card.draft?.in_reply_to === offer.message_id);
    const second = await command(["draft", "--reply-to", offer.message_id, "--body", "Happy to chat. Friday?"]);
    const replies = drafts().filter((card) => card.draft?.in_reply_to === offer.message_id);

    expect(first.status).toBe(200);
    expect(second.text).toMatch(/^Saved the draft in Drafts and put it on the Desk as /u);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.draft).toMatchObject({
      to: ["clara.voss@northwind.example"],
      subject: "Re: AI Engineer at Northwind",
      body: "Happy to chat. Friday?",
      in_reply_to: offer.message_id,
    });
    expect(mail.removedDrafts()).toContain(firstCard?.draft?.message_id);
  });

  it("says what each mail step did in plain words, and opens onto the mails rather than their ids", async () => {
    const { store, turns, callTool } = running().server;
    const accepted = store.acceptMessage(toMessageId(randomUUID()), "Did Northwind write?");
    if (!accepted.ok) throw new Error(accepted.failure);
    const stepsOf = (): readonly Step[] =>
      store.snapshot("no_cursor").event.steps.filter(({ capability }) => capability === "mail");
    turns.route(toMessageId(accepted.value.message.id), "Did Northwind write?");

    await vi.waitFor(() => {
      expect(stepsOf().map(({ title }) => title)).toEqual(["Searching mail", "Reading a thread"]);
    });
    // The agent's command and tool call run while their steps do.
    await command(["search", "--from", "northwind.example"]);
    await callTool("mail_thread", { message_id: offer.message_id });
    await vi.waitFor(
      () => {
        expect(store.snapshot("no_cursor").event.turn).toBeNull();
      },
      { timeout: 5000 },
    );

    const [search, thread] = stepsOf();
    expect(search).toMatchObject({
      kind: "tool",
      operation: "search",
      title: "Searched mail for northwind.example",
      outcome: "completed",
      note: "1 mail",
      run_title: { present: "Searching mail", past: "Searched mail {count} times" },
      mails: [{ from: "Clara Voss", subject: "AI Engineer at Northwind" }],
    });
    expect(thread).toMatchObject({
      operation: "thread",
      title: "Read the thread “AI Engineer at Northwind” with Clara Voss",
      mails: [{ from: "Clara Voss", subject: "AI Engineer at Northwind", text: offer.text }],
    });
    expect(search).not.toHaveProperty("arguments");
    expect(thread).not.toHaveProperty("arguments");
  });
});
