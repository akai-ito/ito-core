import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts, demoWork } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createDesk, quoteOf } from "#desk/desk.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { createCell } from "#cell.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-desk-"));
const ignore = (): void => undefined;
const token = "ito_desk_test_not_a_real_token_00000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const openDesk = (canWork = true) => {
  const server = createServer({
    dataDirectory: canWork ? home : path.join(home, "idle"),
    name: "desk",
    embedder: wordEmbedder,
    timeZone: "UTC",
    createEngine: ({ callTool }) =>
      createScriptEngine(
        systemClock,
        demoScripts,
        callTool,
        undefined,
        demoAnswers,
        canWork ? demoWork(callTool) : undefined,
      ),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  const say = async (text: string): Promise<void> => {
    const accepted = server.store.acceptMessage(toMessageId(randomUUID()), text);
    if (!accepted.ok) throw new Error(accepted.failure);
    server.turns.route(toMessageId(accepted.value.message.id), text);
    await vi.waitFor(
      () => {
        const { event } = server.store.snapshot("no_cursor");
        expect(event.messages.at(-1)).toMatchObject({ role: "agent", outcome: "completed" });
        expect(event.turn).toBeNull();
      },
      { timeout: 15_000, interval: 100 },
    );
  };
  const post = (url: string, payload: Readonly<Record<string, unknown>>) =>
    server.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
  const answer = async (title: string, body: Readonly<Record<string, unknown>>) => {
    const card = server.store.desk().waiting.find((waiting) => waiting.title === title);
    return server.app.inject({
      method: "POST",
      url: `/v0/desk/cards/${card?.id ?? "none"}/answer`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  };
  return { server, say, answer, post };
};

describe("the Desk", () => {
  it("takes Kumo's cards, answers them through the box, and counts what Kumo handled", async () => {
    const { server, say, answer } = openDesk();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Fill the desk");
      const wrong = await answer("Binned a Revolut mail", { option: "Maybe" });
      const right = await answer("Binned a Revolut mail", { option: "Right" });
      const offered = await answer("Italian practice?", { option: "Yes" });

      expect(wrong.statusCode).toBe(400);
      expect(right.statusCode).toBe(202);
      expect(right.json()).toMatchObject({
        card: { title: "Binned a Revolut mail", state: "working", answer: { option: "Right" } },
      });
      expect(offered.statusCode).toBe(202);
      await vi.waitFor(
        () => {
          expect(server.store.desk().waiting).toEqual([]);
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.listDone(undefined, 10).entries.map(({ text, reason }) => [text, reason])).toEqual(
        expect.arrayContaining([
          ["You answered “Binned a Revolut mail”: Right", "Noted; nothing more was needed."],
          ["You answered “Italian practice?”: Yes", "Noted; nothing more was needed."],
        ]),
      );
      expect(server.store.desk().handled).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("takes in “That was wrong” once, and only adds the words said again", async () => {
    const { server, post } = openDesk();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("done", { text: "Moved climbing with Leo to 20:00", reason: "Leo asked by mail." });
      const [entry] = server.store.listDone(undefined, 1).entries;
      const wrong = await post(`/v0/done/${entry?.id ?? "none"}/wrong`, { text: "Leo meant next week" });
      const again = await post(`/v0/done/${entry?.id ?? "none"}/wrong`, { text: "and it's at the wall" });
      const bare = await post(`/v0/done/${entry?.id ?? "none"}/wrong`, {});
      const missing = await post("/v0/done/d_none/wrong", {});

      expect(wrong.json()).toMatchObject({ entry: { id: entry?.id, corrected_at: expect.any(String) as unknown } });
      expect(again.json()).toEqual(wrong.json());
      expect(bare.json()).toEqual(wrong.json());
      expect(missing.statusCode).toBe(404);
      await vi.waitFor(
        () => {
          expect(
            server.store
              .listDone(undefined, 10)
              .entries.filter(({ text }) => text.startsWith("You said"))
              .map(({ text, reason }) => [text, reason]),
          ).toEqual(
            expect.arrayContaining([
              [
                "You said “Moved climbing with Leo to 20:00” was wrong: Leo meant next week",
                "Noted on How to help you for next time.",
              ],
              [
                "You said “Moved climbing with Leo to 20:00” was wrong: and it's at the wall",
                "Noted on How to help you for next time.",
              ],
            ]),
          );
        },
        { timeout: 5000, interval: 50 },
      );
      expect(
        server.store.listDone(undefined, 10).entries.filter(({ text }) => text.startsWith("You said")),
      ).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("quotes what Kumo did in Done by its first sentence, cut at a word when it's long", () => {
    expect(quoteOf("Maya wants to hear how Monday went. Tell me, and I'll draft it.")).toBe(
      "Maya wants to hear how Monday went",
    );
    expect(quoteOf("How did the call go?")).toBe("How did the call go?");
    expect(quoteOf(`${"word ".repeat(20)}end.`)).toBe(`${"word ".repeat(11).trim()}…`);
  });

  it("puts a card back, with why in Done, when Kumo couldn't act on the answer", async () => {
    const { server, say, answer } = openDesk(false);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Fill the desk");
      const card = server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail");
      const answered = await answer("Binned a Revolut mail", { option: "Right" });

      expect(answered.statusCode).toBe(202);
      await vi.waitFor(
        () => {
          expect(server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail")).toMatchObject({
            id: card?.id,
            at: card?.at,
            changed_at: expect.any(String) as unknown,
            kind: "question",
            options: [{ label: "Right", acts: true }, { label: "Keep it" }],
          });
          expect(server.store.listDone(undefined, 10).entries[0]).toMatchObject({
            text: "Couldn't act on your answer to “Binned a Revolut mail”; it's back on your Desk",
            reason: "The scripted engine does no background work.",
          });
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail")?.state).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("acts on a card once, when the same answer comes twice", async () => {
    const store = createStore(openDatabase(path.join(home, "twice.db")), systemClock, randomIdentifiers);
    const acted = createCell(0);
    const releases = createCell<readonly (() => void)[]>([]);
    const desk = createDesk({
      store,
      identifiers: randomIdentifiers,
      clock: systemClock,
      timeZone: "UTC",
      work: async () => {
        acted.update((count) => count + 1);
        await new Promise<void>((resolve) => {
          releases.update((current) => [...current, resolve]);
        });
        return ok("Noted.");
      },
      info: ignore,
    });
    const card = desk.addCard({
      kind: "offer",
      title: "Italian practice?",
      options: [{ label: "Yes" }, { label: "Not now" }],
      allows_text: false,
      offer: { text: "Lessons?" },
    });
    const answers = [
      desk.answer(card.id, { option: "Yes" }),
      desk.answer(card.id, { option: "Yes" }),
      desk.answer(card.id, { option: "Not now" }),
    ];
    await vi.waitFor(() => {
      expect(releases.get().length).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of releases.get()) release();
    await desk.settled();

    expect(answers.map(({ ok: isOk }) => isOk)).toEqual([true, true, false]);
    expect(acted.get()).toBe(1);
    desk.close();
    store.close();
  });

  it("undoes an entry once, when Undo is tapped twice", async () => {
    const store = createStore(openDatabase(path.join(home, "undo-twice.db")), systemClock, randomIdentifiers);
    const desk = createDesk({
      store,
      identifiers: randomIdentifiers,
      clock: systemClock,
      timeZone: "UTC",
      work: () => Promise.resolve(ok("")),
      info: ignore,
    });
    const moved = createCell(0);
    desk.onUndo(async () => {
      moved.update((count) => count + 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ok(undefined);
    });
    const entry = desk.addDone({ text: "Binned a mail from Acme", quiet: false, undo: { kind: "mail_filed" } });

    const [first, second] = await Promise.all([desk.undo(entry.id), desk.undo(entry.id)]);

    expect(first).toMatchObject({ ok: true, value: { text: "Undone: Binned a mail from Acme", undo: false } });
    expect(second).toEqual(first);
    expect(moved.get()).toBe(1);
    expect(await desk.undo(entry.id)).toEqual({ ok: false, failure: "That can't be undone." });
    desk.close();
    store.close();
  });
});
