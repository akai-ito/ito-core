import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toMessageId, toThreadId, toTurnId, type MessageId, type ThreadId } from "#conversation/ids.ts";
import type { Complete } from "#engine/engine.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Store } from "#store/store.ts";
import { createNaming, toTitle } from "#threads/naming.ts";
import { createThreads } from "#threads/threads.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-threads-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const info = (): void => undefined;

const openStore = (name: string): Store =>
  createStore(openDatabase(path.join(home, `${name}.db`)), systemClock, randomIdentifiers);

// One exchange where it's sent: your message, a turn there, and Kumo's reply.
const talk = (
  store: Store,
  id: string,
  said: string,
  answered: string,
  where: Parameters<Store["acceptMessage"]>[5] = {},
): { readonly user: MessageId; readonly reply: MessageId; readonly thread: ThreadId | undefined } => {
  const user = toMessageId(`m_${id}`);
  const accepted = store.acceptMessage(user, said, [], undefined, undefined, where);
  if (!accepted.ok) throw new Error(accepted.failure);
  const thread = accepted.value.message.thread === undefined ? undefined : toThreadId(accepted.value.message.thread);
  const turn = toTurnId(`t_${id}`);
  store.startTurn(turn, [user], undefined, thread);
  const reply = store.startMessage(turn, "reply");
  store.appendText(reply, answered);
  store.endMessage(reply, "completed", answered.length);
  store.endTurn(turn, "completed");
  return { user, reply, thread };
};

const threadOf = (store: Store, message: MessageId): ThreadId => {
  const thread = store.findMessage(message)?.thread;
  if (thread === undefined) throw new Error(`${message} isn't in a thread`);
  return toThreadId(thread);
};

describe("side threads in the store", () => {
  it("starts a thread under a message you reply to in the main chat, and keeps it out of the main chat's snapshot", () => {
    const store = openStore("reply");
    const morning = talk(store, "1", "Lunch with Lena at 12:30.", "Then the morning's yours. An easy 5k first?");
    const pace = talk(store, "2", "What pace?", "Slower than 6:30 a km.", { replyTo: morning.reply });
    const thread = threadOf(store, pace.user);
    const again = talk(store, "3", "And distance?", "Five, even if you feel good.", { replyTo: morning.reply });

    expect(threadOf(store, again.user)).toBe(thread);
    expect(store.findThread(thread)).toMatchObject({
      by: "you",
      state: "open",
      anchor: morning.reply,
      replies: 4,
      position: store.findMessage(morning.reply)?.position,
      news: { message: again.reply, text: "Five, even if you feel good." },
    });
    const { event } = store.snapshot("no_cursor");
    expect(event.messages.map(({ id }) => id)).toEqual([morning.user, morning.reply]);
    expect(event.threads.map(({ id }) => id)).toEqual([thread]);
  });

  it("quotes a message you reply to inside a thread, and opens a done thread again", () => {
    const store = openStore("quote");
    const first = talk(store, "1", "Find me a barber for Saturday", "I've asked Theo for 11:30.", {
      isNewThread: true,
    });
    const thread = first.thread ?? toThreadId("");
    store.changeThread(thread, { by: "kumo", state: "done", result: "Theo, Saturday 11:30" });
    expect(store.findThread(thread)).toMatchObject({ state: "done", done: { by: "kumo" } });

    const later = talk(store, "2", "Can it be 12 instead?", "I'll ask.", { replyTo: first.reply });

    expect(store.findMessage(later.user)?.quotes).toEqual({ message: first.reply, text: "I've asked Theo for 11:30." });
    const reopened = store.findThread(thread);
    expect(reopened?.state).toBe("open");
    expect(reopened?.done).toBeUndefined();
    expect(reopened?.result).toBe("Theo, Saturday 11:30");
  });

  it("moves a thread's line to the end with the news when Kumo posts there, until you've seen it", () => {
    const store = openStore("post");
    const first = talk(store, "1", "Haircut on Saturday?", "Asking Theo.", { isNewThread: true });
    const thread = first.thread ?? toThreadId("");
    store.seeThread(thread);
    talk(store, "2", "Unrelated: rain later?", "Dry until six.");

    const post = store.postMessage("Theo confirmed 11:30.", { thread });

    expect(store.findThread(thread)).toMatchObject({
      position: post.position,
      news: { message: post.id, text: "Theo confirmed 11:30." },
      replies: 3,
    });
    expect(store.postsSinceTurn(thread).map(({ id }) => id)).toEqual([post.id]);
    expect(store.seeThread(thread)?.news).toBeUndefined();
  });

  it("moves a message between the main chat and threads, but not one a thread hangs from", () => {
    const store = openStore("move");
    const morning = talk(store, "1", "Morning", "Morning. Seven hours ten.");
    const reply = talk(store, "2", "Good?", "Your best this week.", { replyTo: morning.reply });
    const thread = threadOf(store, reply.user);

    const moved = store.moveMessage(reply.user, undefined);
    const refused = store.moveMessage(morning.reply, thread);

    expect(moved.ok ? moved.value.thread : "refused").toBeUndefined();
    expect(store.findThread(thread)?.replies).toBe(1);
    expect(refused).toEqual({ ok: false, failure: "anchor" });
    expect(store.moveMessage(toMessageId("m_nowhere"), undefined)).toEqual({ ok: false, failure: "not_found" });
  });

  it("branches Kumo's thread where the message that started it was, and lists threads open first, by a word", () => {
    const store = openStore("branch");
    const user = toMessageId("m_menu");
    store.acceptMessage(user, "What should we get? Two of us, not too heavy");
    const branched = store.branchThread("Kiln menu", [user]);
    if (!branched.ok) throw new Error(branched.failure);
    const done = talk(store, "2", "Insurance renewal?", "Renewed, same cover.", { isNewThread: true });
    store.changeThread(done.thread ?? toThreadId(""), { by: "kumo", state: "done", result: "Renewed, £14 a month" });

    expect(branched.value).toMatchObject({
      by: "kumo",
      title: "Kiln menu",
      position: store.findMessage(user)?.position,
    });
    expect(store.findMessage(user)?.thread).toBe(branched.value.id);
    const listed = store.listThreads("", undefined, 50);
    expect(listed.open.map(({ id }) => id)).toEqual([branched.value.id]);
    expect(listed.done.map(({ id }) => id)).toEqual([done.thread]);
    expect(store.listThreads("heavy", undefined, 50).open.map(({ id }) => id)).toEqual([branched.value.id]);
    expect(store.listThreads("£14", undefined, 50).done.map(({ id }) => id)).toEqual([done.thread]);
    expect(store.listThreads("noodles", undefined, 50)).toEqual({ open: [], done: [], hasMore: false });
  });
});

describe("what each conversation knows of the others", () => {
  it("gives a side thread a digest of the main chat and the other open threads, and the main chat the open threads", () => {
    const store = openStore("digest");
    talk(store, "1", "Lunch with Lena at 12:30.", "Then the morning's yours.");
    const menu = talk(store, "2", "Menu photo", "Noodles and laab.", { isNewThread: true });
    const guide = talk(store, "3", "V&A in two hours?", "Four rooms, nine things.", { isNewThread: true });
    store.changeThread(guide.thread ?? toThreadId(""), { by: "kumo", title: "V&A guide", result: "3 of 9 spotted" });
    const threads = createThreads({ store, spoken: () => "Saturday", branched: () => false });

    const inMenu = threads.inMindText(menu.thread);
    const inMain = threads.inMindText(undefined);

    expect(inMenu).toContain("<thread>");
    expect(inMenu).toContain("- Saturday, they: Lunch with Lena at 12:30.");
    expect(inMenu).toContain(`- ${String(guide.thread)}, “V&A guide”, last Saturday: 3 of 9 spotted`);
    expect(inMenu).not.toContain(`- ${String(menu.thread)},`);
    expect(inMain).toContain(`- ${String(menu.thread)}, a thread not yet named, last Saturday`);
    expect(inMain).toContain(`- ${String(guide.thread)}, “V&A guide”`);
  });

  it("asks Kumo to keep an open thread's line where it stands, and shows it the line it has", () => {
    const store = openStore("lines");
    const menu = talk(store, "1", "Menu photo", "Noodles and laab.", { isNewThread: true });
    const guide = talk(store, "2", "V&A in two hours?", "Four rooms, nine things.", { isNewThread: true });
    store.changeThread(guide.thread ?? toThreadId(""), { by: "kumo", result: "3 of 9 spotted" });
    const threads = createThreads({ store, spoken: () => "Saturday", branched: () => false });

    const inMenu = threads.inMindText(menu.thread);

    expect(inMenu).toContain("Its line shows under its name in their list of threads");
    expect(inMenu).toContain("It has no line yet: give it one once you've answered.");
    expect(threads.inMindText(guide.thread)).toContain("Its line now: “3 of 9 spotted”.");
  });
});

describe("naming a thread you started", () => {
  it("names it after its first answer, on the quick model, and leaves one with a name alone", async () => {
    const store = openStore("naming");
    const asked = createCell<readonly string[]>([]);
    const complete: Complete = (prompt) => {
      asked.update((current) => [...current, prompt]);
      return Promise.resolve(ok({ title: "“Haircut.”" }));
    };
    const naming = createNaming({
      store,
      complete,
      models: () => Promise.resolve(ok(demoModels)),
      info,
    });

    const first = talk(store, "1", "Haircut on Saturday?", "Asking Theo.", { isNewThread: true });
    await naming.idle();
    talk(store, "2", "Any news?", "Not yet.", { thread: first.thread ?? toThreadId("") });
    await naming.idle();
    naming.close();

    expect(store.findThread(first.thread ?? toThreadId(""))?.title).toBe("Haircut");
    expect(asked.get()).toHaveLength(1);
    expect(asked.get()[0]).toContain("They said: Haircut on Saturday?");
    expect(toTitle("planning a very long trip to Florence in May")).toBeUndefined();
  });
});
