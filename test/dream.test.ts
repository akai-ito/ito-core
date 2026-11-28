import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { readTakenDay } from "#attachments/media.ts";
import { createCell } from "#cell.ts";
import { toMessageId } from "#conversation/ids.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Block } from "#day/blocks.ts";
import type { CalendarItem, DoneEntry, DreamState, DreamResult, Thread } from "#protocol/types.ts";
import { createDreams } from "#dream/dream.ts";
import { handledMail } from "#mail/mail.ts";
import type { Mail } from "#mail/message.ts";
import { createDayNotes } from "#dream/notes.ts";
import { openDatabase } from "#store/database.ts";
import { createDreamStore } from "#store/dreams.ts";
import { inToolContext } from "#tools/context.ts";
import type { Tool } from "#tools/mcp.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-dream-"));
const token = "ito_dream_test_not_a_real_token_000000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// What Kumo does in a piece of background work: given its prompt and run, it may call tools, then answers.
type Act = (prompt: string, run: string, server: Server) => Promise<Result<string, string>>;

const settle = async (rounds = 12): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

const setUp = (start: string) => {
  const dataDirectory = mkdtempSync(path.join(home, "server-"));
  const clock = createVirtualClock(Date.parse(start));
  const prompts = createCell<readonly { readonly prompt: string; readonly run: string }[]>([]);
  const acts = createCell<readonly Act[]>([]);
  const live = createCell<Server | undefined>(undefined);
  const open = async (): Promise<Server> => {
    const server = createServer({
      embedder: wordEmbedder,
      dataDirectory,
      name: "dreams",
      clock,
      timeZone: "Europe/London",
      dreams: true,
      createEngine: () =>
        createScriptEngine(
          clock,
          () => {
            throw new Error("This test starts no turns.");
          },
          undefined,
          undefined,
          undefined,
          async (prompt, run) => {
            prompts.update((current) => [...current, { prompt, run }]);
            const [act] = acts.get();
            acts.update((current) => current.slice(1));
            const running = live.get();
            const done = act && running ? await act(prompt, run, running) : fail("The test has Kumo do nothing here.");
            return done.ok ? ok(done.value) : fail({ code: "model_unavailable", detail: done.failure });
          },
        ),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    live.set(server);
    return server;
  };
  const runUntil = async (time: string): Promise<void> => {
    if (clock.runNext(Date.parse(time))) {
      await settle();
      await runUntil(time);
      return;
    }
    clock.moveTo(Date.parse(time));
    await settle();
  };
  const plan = (...given: readonly Act[]): void => {
    acts.update((current) => [...current, ...given]);
  };
  return { open, runUntil, plan, prompts, clock };
};

const request = async (server: Server, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const response = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.body === "" ? undefined : response.json<unknown>() };
};

const dreamOf = async (server: Server): Promise<DreamState> => {
  const { body } = await request(server, "GET", "/v0/dream");
  return body as DreamState;
};

const latestOf = async (server: Server): Promise<DreamState["latest"]> => {
  const { latest } = await dreamOf(server);
  return latest;
};

const call = async (server: Server, run: string, name: string, input: unknown): Promise<string> => {
  const called = await server.callTool(name, input, run);
  if (called.isError === true) throw new Error(`${name}: ${called.text}`);
  return called.text;
};

const say = (server: Server, text: string): void => {
  const accepted = server.store.acceptMessage(toMessageId(randomUUID()), text);
  if (!accepted.ok) throw new Error("not accepted");
};

describe("dreams", () => {
  it("come once a night at the dream time, read the day, write the journal and leave a record with undo", async () => {
    const { open, runUntil, plan, prompts } = setUp("2026-11-26T20:00:00.000Z");
    const server = await open();
    const finished = createCell<readonly string[]>([]);
    server.store.subscribe(({ event }) => {
      if (event.type === "dream.finished") finished.update((ids) => [...ids, event.dream.id]);
    });
    try {
      say(server, "Long run with Leo this morning, 14 km! Then pastries at the market.");
      server.store.postMessage("Lovely. Your longest since the summer.");
      await server.callTool("note_day", { text: "Ran 14 km by the river with Leo; pastries at the market after." });
      await server.callTool("note_day", { text: "Best run in months.", yours: true });
      await server.callTool("note_day", { text: "Saw Mira for lunch.", day: "2026-11-24" });
      const later = await server.callTool("note_day", { text: "Not yet.", day: "2026-11-30" });
      expect(later.isError).toBe(true);
      const before = await dreamOf(server);
      expect(before).toEqual({ time: "04:00", next_at: "2026-11-27T04:00:00.000Z" });

      plan(async (_prompt, run, running) => {
        await call(running, run, "journal", {
          day: "2026-11-26",
          text: "A long run along the river with Leo, 14 km, my longest since the summer. Pastries at the market after.",
          gist: "14 km with Leo; my longest since the summer",
          note: "The day",
        });
        await call(running, run, "set_wake_up", {
          what: "Ask how the legs feel after the long run",
          why: "Fourteen kilometres is a jump; check recovery before Saturday's session.",
          at: "2026-11-27T09:00:00Z",
          asked: false,
          source: { kind: "chat", title: "The long run with Leo" },
        });
        const wakeUp = running.wakeUps.list()[0]?.id ?? "";
        await call(running, run, "record_dream", {
          headline: "A good Thursday: the long run, written up",
          lines: [
            { group: "saved", text: "Wrote Thursday's journal", page: "memory:journal/2026-11-26" },
            { group: "planned", text: "A check on your legs at 09:00", wake_up: wakeUp },
            { group: "noticed", text: "Your long runs are back on" },
          ],
        });
        return ok("Dreamt.");
      });
      await runUntil("2026-11-27T03:59:00.000Z");
      expect(prompts.get()).toHaveLength(0);
      await runUntil("2026-11-27T04:00:00.000Z");
      await server.dreams.settled();

      const [dreamt] = prompts.get();
      expect(dreamt?.run).toMatch(/^dream-/u);
      expect(dreamt?.prompt).toContain("# Your dream");
      expect(dreamt?.prompt).toContain("The day you're mostly looking back on is 2026-11-26.");
      expect(dreamt?.prompt).toContain("about 26 November 2026: Ran 14 km by the river with Leo");
      expect(dreamt?.prompt).toContain("about 26 November 2026: their words: “Best run in months.”");
      expect(dreamt?.prompt).toContain("about 24 November 2026: Saw Mira for lunch.");
      expect(dreamt?.prompt).toContain("they: Long run with Leo this morning, 14 km!");
      expect(dreamt?.prompt).toContain("you: Lovely. Your longest since the summer.");

      const state = await dreamOf(server);
      expect(state.next_at).toBe("2026-11-28T04:00:00.000Z");
      expect(state.dreaming).toBeUndefined();
      expect(state.latest).toMatchObject({
        day: "2026-11-26",
        trigger: "scheduled",
        started_at: "2026-11-27T04:00:00.000Z",
        headline: "A good Thursday: the long run, written up",
        lines: [
          { group: "saved", text: "Wrote Thursday's journal", page: "memory:journal/2026-11-26", undo: true },
          { group: "planned", text: "A check on your legs at 09:00", undo: true },
          { group: "noticed", text: "Your long runs are back on" },
        ],
      });
      expect(state.latest?.lines[2]).not.toHaveProperty("done");
      expect(state.latest?.seen_at).toBeUndefined();
      expect(finished.get()).toEqual([state.latest?.id]);
      expect(server.store.desk().handled).toBe(0);
      const entries = server.store.listDone(undefined, 10).entries;
      expect(entries.map(({ text }) => text).toSorted((left, right) => left.localeCompare(right))).toEqual([
        "A check on your legs at 09:00",
        "Wrote Thursday's journal",
      ]);
      expect(entries.map(({ dream }) => dream)).toEqual([state.latest?.id, state.latest?.id]);

      // Undo puts the journal day back as it was before the dream: there was none.
      const journalLine = state.latest?.lines[0];
      const undone = await request(server, "POST", `/v0/done/${journalLine?.done ?? ""}/undo`);
      expect(undone.status).toBe(200);
      expect(server.memory.page("memory:journal/2026-11-26").ok).toBe(false);
      const wakeUpLine = state.latest?.lines[1];
      await request(server, "POST", `/v0/done/${wakeUpLine?.done ?? ""}/undo`);
      expect(server.wakeUps.list()).toEqual([]);
      const after = await dreamOf(server);
      expect(after.latest?.lines.slice(0, 2)).toMatchObject([
        { undo: false, undone: true },
        { undo: false, undone: true },
      ]);

      const seen = await request(server, "POST", `/v0/dreams/${state.latest?.id ?? ""}/seen`);
      expect((seen.body as DreamResult).dream.seen_at).toBe("2026-11-27T04:00:00.000Z");
      const missing = await request(server, "POST", "/v0/dreams/z_nothing/seen");
      expect(missing.status).toBe(404);

      // The notes it took in don't come again.
      plan(() => Promise.resolve(ok("Dreamt.")));
      await runUntil("2026-11-28T04:00:00.000Z");
      await server.dreams.settled();
      expect(prompts.get()[1]?.prompt).toContain("You kept no notes for tonight.");
    } finally {
      await server.close();
    }
  });

  it("let a manual dream before bed stand in for the night's, one at a time", async () => {
    const { open, runUntil, plan, prompts } = setUp("2026-11-26T22:00:00.000Z");
    const server = await open();
    try {
      const release = createCell<(() => void) | undefined>(undefined);
      plan(
        (_prompt, run, running) =>
          new Promise((resolve) => {
            release.set(() => {
              void call(running, run, "record_dream", { lines: [{ group: "noticed", text: "A quiet day" }] }).then(
                () => {
                  resolve(ok("Dreamt."));
                },
              );
            });
          }),
      );
      await runUntil("2026-11-26T23:30:00.000Z");
      const started = await request(server, "POST", "/v0/dream");
      expect(started.status).toBe(202);
      expect(started.body).toMatchObject({ dreaming: { since: "2026-11-26T23:30:00.000Z", trigger: "manual" } });
      await settle();
      const again = await request(server, "POST", "/v0/dream");
      expect(again.body).toMatchObject({ dreaming: { since: "2026-11-26T23:30:00.000Z" } });
      release.get()?.();
      await server.dreams.settled();
      expect(await latestOf(server)).toMatchObject({
        day: "2026-11-26",
        trigger: "manual",
        lines: [{ group: "noticed", text: "A quiet day" }],
      });

      await runUntil("2026-11-27T04:30:00.000Z");
      await server.dreams.settled();
      expect(prompts.get()).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("dream once the server's back if it was off at the dream time, and try again when the model can't", async () => {
    const { open, runUntil, plan, prompts, clock } = setUp("2026-11-26T22:00:00.000Z");
    const first = await open();
    await first.close();
    clock.moveTo(Date.parse("2026-11-27T09:00:00.000Z"));
    plan(
      () => Promise.resolve(fail("The model isn't answering.")),
      () => Promise.resolve(ok("Dreamt.")),
    );
    const server = await open();
    try {
      await runUntil("2026-11-27T09:00:01.000Z");
      await server.dreams.settled();
      expect(prompts.get()).toHaveLength(1);
      expect(await latestOf(server)).toBeUndefined();
      await runUntil("2026-11-27T09:30:01.000Z");
      await server.dreams.settled();
      expect(prompts.get()).toHaveLength(2);
      expect(await latestOf(server)).toMatchObject({ trigger: "scheduled", day: "2026-11-26", lines: [] });
    } finally {
      await server.close();
    }
  });

  it("keep the dream time in settings, on their local clock", async () => {
    const { open } = setUp("2026-11-26T22:00:00.000Z");
    const server = await open();
    try {
      const set = await request(server, "PUT", "/v0/dream/time", { time: "03:30" });
      expect(set).toEqual({ status: 200, body: { time: "03:30", next_at: "2026-11-27T03:30:00.000Z" } });
      const wrong = await request(server, "PUT", "/v0/dream/time", { time: "4am" });
      expect(wrong.status).toBe(400);
      expect(await dreamOf(server)).toEqual({ time: "03:30", next_at: "2026-11-27T03:30:00.000Z" });
    } finally {
      await server.close();
    }
  });

  it("offer the journal and the record only in a dream", async () => {
    const { open } = setUp("2026-11-26T22:00:00.000Z");
    const server = await open();
    try {
      const record = await server.callTool("record_dream", { lines: [] }, "some-run");
      expect(record).toEqual({ text: "Only a dream leaves a record.", isError: true });
    } finally {
      await server.close();
    }
  });

  it("give the dream the photos they shared, by the day each was taken", async () => {
    const { open, runUntil, plan, prompts } = setUp("2026-11-26T20:00:00.000Z");
    const server = await open();
    try {
      const photo = takenOn("2026:11:22 10:15:00");
      server.attachments.save("f_photo", "river.jpg", "image/jpeg", photo);
      const accepted = server.store.acceptMessage(toMessageId(randomUUID()), "From Saturday's walk", ["f_photo"]);
      expect(accepted.ok).toBe(true);
      plan(() => Promise.resolve(ok("Dreamt.")));
      await runUntil("2026-11-27T04:00:00.000Z");
      await server.dreams.settled();
      expect(prompts.get()[0]?.prompt).toContain(
        "- uploads/f_photo.jpg: shared Thu 26 Nov 20:00 in the main chat; taken 22 November 2026; they wrote: “From Saturday's walk”",
      );
      expect(readTakenDay(photo)).toBe("2026-11-22");
      expect(readTakenDay(Buffer.from([255, 216, 255, 217]))).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

// One entry in an EXIF directory, little-endian.
const entry = (tag: number, type: number, count: number, value: number): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt16LE(tag, 0);
  bytes.writeUInt16LE(type, 2);
  bytes.writeUInt32LE(count, 4);
  bytes.writeUInt32LE(value, 8);
  return bytes;
};

// A tiny JPEG with an EXIF block saying when it was taken, as a phone writes it.
const takenOn = (taken: string): Buffer => {
  const text = Buffer.from(`${taken}\0`, "ascii");
  const header = Buffer.concat([Buffer.from("II", "ascii"), Buffer.from([42, 0, 8, 0, 0, 0])]);
  const first = Buffer.concat([Buffer.from([1, 0]), entry(0x87_69, 4, 1, 26), Buffer.alloc(4)]);
  const exifDirectory = Buffer.concat([Buffer.from([1, 0]), entry(0x90_03, 2, text.length, 44), Buffer.alloc(4)]);
  const tiff = Buffer.concat([header, first, exifDirectory, text]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(app1.length + 2, 0);
  return Buffer.concat([Buffer.from([255, 216, 255, 225]), length, app1, Buffer.from([255, 217])]);
};

const ignore = (): void => undefined;

const noThreads = new Map<string, Thread>();
const noTitles = new Map<string, string>();
const noBlocks = new Map<string, Block>();

// A stand-in for one of Kumo's calendar tools, doing to the calendar what the real one would.
const tool = (name: string, act: (input: unknown) => void): Tool => ({
  name,
  title: name,
  description: name,
  inputSchema: { type: "object" },
  call: (input) => {
    act(input);
    return Promise.resolve({ text: "Done." });
  },
});

const uidOf = (input: unknown): string => String((input as Readonly<Record<string, unknown>>).uid);

describe("a dream's changes to Kumo's calendar", () => {
  it("are each one entry in Done that puts the block back as it was", async () => {
    const directory = mkdtempSync(path.join(home, "calendar-"));
    const database = openDatabase(path.join(directory, "ito.db"));
    const clock = createVirtualClock(Date.parse("2026-11-27T04:00:00.000Z"));
    const kumo = { name: "Kumo", kumo: true };
    const item = (uid: string, title: string, start: string, end: string): CalendarItem => ({
      id: `v_${uid}`,
      uid,
      title,
      start,
      end,
      all_day: false,
      calendar: kumo,
      status: "confirmed",
    });
    const items = createCell<readonly CalendarItem[]>([
      item("block-run", "Easy run", "2026-11-27T07:00:00.000Z", "2026-11-27T07:45:00.000Z"),
      item("block-admin", "Admin", "2026-11-27T17:00:00.000Z", "2026-11-27T17:30:00.000Z"),
    ]);
    const added = createCell<readonly { readonly entry: DoneEntry; readonly undo: unknown }[]>([]);
    const settings = createCell<ReadonlyMap<string, string>>(new Map());
    const run = createCell("");
    const dreams = createDreams({
      store: createDreamStore(database),
      settings: {
        setting: (key) => settings.get().get(key),
        setSetting: (key, value) => {
          settings.update((current) => new Map([...current, [key, value]]));
        },
      },
      clock,
      timeZone: () => "UTC",
      newId: () => "z_1",
      work: async (_prompt, given) => {
        run.set(given);
        const call = (calling: Tool, input: unknown) =>
          inToolContext({ run: given }, () => dreams.watch(calling).call(input));
        await call(
          tool("plan_block", () => {
            items.update((current) => [
              ...current,
              item("block-prep", "Interview prep", "2026-11-27T10:00:00.000Z", "2026-11-27T11:00:00.000Z"),
            ]);
          }),
          {},
        );
        await call(
          tool("change_event", (input) => {
            items.update((current) =>
              current.map((shown) =>
                shown.uid === uidOf(input)
                  ? { ...shown, start: "2026-11-27T07:30:00.000Z", end: "2026-11-27T08:15:00.000Z" }
                  : shown,
              ),
            );
          }),
          { uid: "block-run" },
        );
        await call(
          tool("delete_event", (input) => {
            items.update((current) => current.filter((shown) => shown.uid !== uidOf(input)));
          }),
          { uid: "block-admin" },
        );
        const recorded = await inToolContext({ run: given }, () =>
          dreams.tools[0]?.call({
            lines: [{ group: "planned", text: "Prep for Friday's interview at 10", event: "block-prep" }],
          }),
        );
        expect(recorded?.isError).toBeUndefined();
        return ok("Dreamt.");
      },
      notes: createDayNotes({ database, clock, timeZone: () => "UTC" }),
      sources: {
        messagesSince: () => [],
        thread: (id) => noThreads.get(id),
        doneSince: () => [],
        mailSince: () => Promise.resolve([]),
        calendar: () => items.get(),
        tracks: () => [],
        attachmentPath: (id) => id,
      },
      changes: {
        versionOf: () => Promise.resolve(undefined),
        titleOf: (address) => noTitles.get(address),
        revert: () => Promise.resolve(ok(undefined)),
        wakeUps: () => [],
        putWakeUp: (wakeUp) => ok(wakeUp),
        cancelWakeUp: () => true,
        block: (uid) => noBlocks.get(uid),
      },
      desk: {
        addDone: (given) => {
          const { undo, ...rest } = given;
          const entry: DoneEntry = {
            id: `d_${String(added.get().length)}`,
            at: "2026-11-27T04:00:00.000Z",
            ...rest,
            undo: undo !== undefined,
          };
          added.update((current) => [...current, { entry, undo }]);
          return entry;
        },
        onUndo: ignore,
      },
      findDone: (id) => added.get().find(({ entry }) => entry.id === id),
      publish: ignore,
      instructions: "# Your dream",
      workspace: mkdtempSync(path.join(home, "workspace-")),
      info: ignore,
      isScheduled: false,
    });
    dreams.dreamNow();
    await dreams.settled();

    expect(run.get()).toMatch(/^dream-/u);
    expect(dreams.state().latest?.lines).toEqual([
      { group: "planned", text: "Prep for Friday's interview at 10", event: "v_block-prep", done: "d_0", undo: true },
      {
        group: "planned",
        text: "Moved “Easy run” to Fri 27 Nov 07:30–08:15",
        event: "v_block-run",
        done: "d_1",
        undo: true,
      },
      {
        group: "planned",
        text: "Removed “Admin”, Fri 27 Nov 17:00–17:30",
        event: "v_block-admin",
        done: "d_2",
        undo: true,
      },
    ]);
    expect(added.get().map(({ undo }) => undo)).toEqual([
      { kind: "kumo_block_added", uid: "block-prep" },
      {
        kind: "kumo_block_moved",
        uid: "block-run",
        start: "2026-11-27T07:00:00.000Z",
        end: "2026-11-27T07:45:00.000Z",
      },
      {
        kind: "kumo_block_removed",
        event: {
          uid: "block-admin",
          title: "Admin",
          start: "2026-11-27T17:00:00.000Z",
          end: "2026-11-27T17:30:00.000Z",
        },
      },
    ]);
    expect(added.get().every(({ entry }) => entry.dream === "z_1")).toBe(true);
    dreams.close();
  });
});

// A mail as the mailbox reads it, with how it's marked.
const mail = (messageId: string, date: string, flags: readonly string[], subject: string): Mail => ({
  account: "icloud",
  folder: "INBOX",
  uid: 1,
  messageId,
  references: [],
  from: { name: "Clara Voss", address: "clara@northwind.example" },
  to: [{ name: "Sam", address: "sam@halcyon.example" }],
  cc: [],
  subject,
  date,
  text: "",
  flags,
});

describe("the mail a dream reads", () => {
  it("is what they read, answered or flagged since the last dream, and what they sent", () => {
    const since = Date.parse("2026-11-26T04:00:00.000Z");

    const lines = handledMail(
      "icloud",
      since,
      [
        mail("<offer@northwind>", "2026-11-26T14:02:00.000Z", ["\\Seen", "\\Flagged"], "Your offer"),
        mail("<unread@northwind>", "2026-11-26T15:00:00.000Z", [], "Newsletter"),
        mail("<old@northwind>", "2026-11-25T09:00:00.000Z", ["\\Seen"], "Last week"),
      ],
      [mail("<reply@me>", "2026-11-26T16:30:00.000Z", ["\\Seen"], "Re: Your offer")],
    );

    expect(lines.map(({ line }) => line)).toEqual([
      "- 2026-11-26T14:02 · Clara Voss · Your offer (icloud <offer@northwind>) · read, flagged",
      "- 2026-11-26T16:30 · they sent to Sam · Re: Your offer (icloud <reply@me>)",
    ]);
  });
});
