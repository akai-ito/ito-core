import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { commandsPath } from "#http/tools.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Step } from "#protocol/types.ts";
import { fail } from "#result.ts";
import { createServer, databaseFile, type Server } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { createFakeMail } from "./support/fake-mail.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-mail-commands-"));
const launcher = path.join(home, "bin", "ito");

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
    at: now + 900,
    event: {
      type: "step.ended",
      key: "shell",
      outcome: "completed",
      facts: { exit_code: 0, output: "- 2026-11-01 · Clara Voss · AI Engineer at Northwind" },
    },
  },
  { at: now + 900, event: { type: "step.ended", key: "mcp", outcome: "completed", facts: {} } },
  { at: now + 950, event: { type: "text.started", kind: "reply" } },
  { at: now + 960, event: { type: "text", text: "Northwind wrote about an AI Engineer role." } },
  { at: now + 970, event: { type: "text.ended" } },
  { at: now + 980, event: { type: "ended" } },
];

describe("mail in the conversation, through ito mail commands", () => {
  const mail = createFakeMail(() => new Date().toISOString());
  const server = createCell<Server | undefined>(undefined);
  const context = createCell<EngineContext | undefined>(undefined);

  const running = (): { readonly server: Server; readonly context: EngineContext } => {
    const current = server.get();
    const given = context.get();
    if (!current || !given) throw new Error("The server isn't running.");
    return { server: current, context: given };
  };

  const command = async (
    words: readonly string[],
    token = running().context.tools()?.token ?? "",
  ): Promise<{ readonly status: number; readonly text: string }> => {
    const origin = running().context.tools()?.origin ?? "";
    const response = await fetch(`${origin}${commandsPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ capability: "mail", arguments: words }),
    });
    const body = response.status === 401 ? { text: "" } : ((await response.json()) as { readonly text: string });
    return { status: response.status, text: body.text };
  };

  beforeAll(async () => {
    const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
    store.setSetting(onSetting("icloud"), "true");
    store.setSetting(valuesSetting("icloud"), JSON.stringify({ apple_id: "sam@icloud.com", app_password: "test" }));
    store.close();
    // In the inbox before the server watches it, so neither mail arrives as new.
    mail.arrive(offer);
    mail.arrive(promo);
    const started = createServer({
      embedder: wordEmbedder,
      dataDirectory: home,
      name: "mail-commands",
      timeZone: "UTC",
      createMailSource: mail.create,
      createCalendarSource: noCalendar,
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
    rmSync(home, { recursive: true, force: true });
  });

  it("lists mail in the instructions' skills, with a skill file that has its commands", () => {
    const skillFile = path.join(home, "skills", "mail", "SKILL.md");
    const instructions = running().context.instructions();

    expect(instructions).toContain(`- mail: their mail: find it, read whole threads`);
    expect(instructions).toContain(`(file: ${skillFile})`);
    expect(existsSync(skillFile)).toBe(true);
    const skill = readFileSync(skillFile, "utf8");
    expect(skill).toContain("name: mail");
    expect(skill).toContain(`${launcher} mail search: Search their mail`);
    expect(skill).toContain(`${launcher} mail draft: Write a draft`);
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
    const firstCard = running()
      .server.store.desk()
      .waiting.find((card) => card.kind === "draft");
    const second = await command(["draft", "--reply-to", offer.message_id, "--body", "Happy to chat. Friday?"]);
    const drafts = running()
      .server.store.desk()
      .waiting.filter((card) => card.kind === "draft");

    expect(first.status).toBe(200);
    expect(second.text).toMatch(/^Saved the draft in Drafts and put it on the Desk as /u);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.draft).toMatchObject({
      to: ["clara.voss@northwind.example"],
      subject: "Re: AI Engineer at Northwind",
      body: "Happy to chat. Friday?",
      in_reply_to: offer.message_id,
    });
    expect(mail.removedDrafts()).toEqual([firstCard?.draft?.message_id]);
  });

  it("titles a mail command, and the reader's own mail tool, as mail work", async () => {
    const { store, turns } = running().server;
    const accepted = store.acceptMessage(toMessageId(randomUUID()), "Did Northwind write?");
    if (!accepted.ok) throw new Error(accepted.failure);
    const stepsOf = (): readonly Step[] =>
      store.snapshot("no_cursor").event.steps.filter(({ capability }) => capability === "mail");
    turns.route(toMessageId(accepted.value.message.id), "Did Northwind write?");

    await vi.waitFor(() => {
      expect(stepsOf().map(({ title }) => title)).toEqual(["Searching mail", "Reading a thread"]);
    });
    await vi.waitFor(() => {
      expect(store.snapshot("no_cursor").event.turn).toBeNull();
    });
    expect(stepsOf().map(({ kind, operation, title, outcome }) => ({ kind, operation, title, outcome }))).toEqual([
      { kind: "tool", operation: "search", title: "Searched mail", outcome: "completed" },
      { kind: "tool", operation: "thread", title: "Read a thread", outcome: "completed" },
    ]);
  });
});
