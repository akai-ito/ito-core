import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { systemClock } from "#clock.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import type { Event, Message } from "#protocol/types.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { openEventStream, type EventStream } from "./support/event-stream.ts";

const token = "ito_crash_test_not_a_real_token_0000000000000000000";
const headers = { authorization: `Bearer ${token}` };
const binary = path.join(import.meta.dirname, "..", "bin", "ito.ts");
const home = mkdtempSync(path.join(os.tmpdir(), "ito-crash-"));
const eventWaitMs = 5000;

const seedToken = (): void => {
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  store.setSetting(tokenSetting, hashToken(token));
  store.close();
};

const findFreePort = async (): Promise<number> => {
  const probe = createNetServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  if (!address || typeof address === "string") throw new Error("No port was assigned.");
  return address.port;
};

const isAnswering = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
};

const startIto = async (port: number): Promise<ChildProcess> => {
  const child = spawn(process.execPath, [binary, "serve", "--engine", "demo", "--port", String(port)], {
    env: { ...process.env, ITO_HOME: home },
    stdio: "ignore",
  });
  const waitUntilReady = async (attempt: number): Promise<void> => {
    if (await isAnswering(`http://127.0.0.1:${port}/.well-known/ito`)) return;
    if (attempt === 100) throw new Error("ito serve didn't start.");
    await delay(100);
    await waitUntilReady(attempt + 1);
  };
  await waitUntilReady(1);
  return child;
};

const nextEvent = async (stream: EventStream): Promise<Event> => {
  const event = await stream.next(eventWaitMs);
  if (event === undefined) throw new Error("No event arrived in time.");
  return event as Event;
};

const readUntil = async (
  stream: EventStream,
  isLast: (event: Event, seen: readonly Event[]) => boolean,
  seen: readonly Event[] = [],
): Promise<readonly Event[]> => {
  const event = await nextEvent(stream);
  const all = [...seen, event];
  return isLast(event, all) ? all : readUntil(stream, isLast, all);
};

type MessageStarted = Extract<Event, { readonly type: "message.started" }>;

const replyId = (events: readonly Event[]): string | undefined =>
  events.find(
    (event): event is MessageStarted =>
      event.type === "message.started" && event.message.role === "agent" && event.message.kind === "reply",
  )?.message.id;

const replyText = (events: readonly Event[], message: string): string =>
  events.map((event) => (event.type === "message.delta" && event.message === message ? event.text : "")).join("");

const isReply = (message: Message, id: string): boolean => message.id === id;

describe("a crash mid-reply", () => {
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the confirmed message and ends the reply as interrupted, with its text", async () => {
    seedToken();
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const first = await startIto(port);

    const live = await openEventStream(`${origin}/v0/events`, headers);
    const opening = await nextEvent(live);
    expect(opening.type).toBe("snapshot");
    const userMessage = { id: randomUUID(), text: "Write me something long, please." };
    const sent = await fetch(`${origin}/v0/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(userMessage),
    });
    expect(sent.status).toBe(201);

    const beforeCrash = await readUntil(live, (_event, seen) => {
      const reply = replyId(seen);
      return (
        reply !== undefined &&
        seen.filter((event) => event.type === "message.delta" && event.message === reply).length >= 3
      );
    });
    first.kill("SIGKILL");
    await once(first, "exit");
    live.close();

    const reply = replyId(beforeCrash) ?? "";
    const shownBeforeCrash = replyText(beforeCrash, reply);
    const lastSeen = beforeCrash.at(-1)?.id ?? "";

    const second = await startIto(port);
    try {
      const resumed = await openEventStream(`${origin}/v0/events`, { ...headers, "last-event-id": lastSeen });
      const afterRestart = await readUntil(resumed, (event) => event.type === "turn.ended");
      resumed.close();

      const ended = afterRestart.find((event) => event.type === "message.ended" && event.message === reply);
      expect(ended).toMatchObject({ outcome: "interrupted" });
      expect(afterRestart.at(-1)).toMatchObject({ type: "turn.ended", outcome: "interrupted" });
      const idsBefore = new Set(beforeCrash.map((event) => event.id));
      expect(afterRestart.filter((event) => idsBefore.has(event.id))).toEqual([]);

      const fresh = await openEventStream(`${origin}/v0/events`, headers);
      const snapshot = await nextEvent(fresh);
      fresh.close();
      if (snapshot.type !== "snapshot") throw new Error(`Expected a snapshot, got ${snapshot.type}.`);
      expect(snapshot.messages).toContainEqual(expect.objectContaining(userMessage));
      const kept = snapshot.messages.find((message) => isReply(message, reply));
      expect(kept).toMatchObject({ outcome: "interrupted" });
      expect(kept?.text.startsWith(shownBeforeCrash)).toBe(true);
      expect(snapshot.turn).toBeNull();
    } finally {
      second.kill("SIGTERM");
      await once(second, "exit");
    }
  });
});
