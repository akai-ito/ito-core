import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo, setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { openNotification } from "#notifications/crypto.ts";
import type { Envelope } from "#notifications/notifier.ts";
import { createServer, databaseFile, type Server } from "#server.ts";
import { openEventStream, type EventStream } from "./event-stream.ts";
import { startFakeApns, type Pushed } from "./fake-apns.ts";
import { createIdMatcher } from "./matching.ts";
import { createScriptQueue, deriveScripts } from "./scripts.ts";
import {
  readTranscript,
  type AppRequest,
  type ServerResponse,
  type Step,
  type TranscriptPush,
} from "./transcript-file.ts";
import { createVirtualClock } from "./virtual-clock.ts";

export const transcriptToken = "ito_example_not_a_real_token_00000000000000000000";

const waitMs = 4000;
const quietMs = 300;
const afterwardsMs = 70_000;

type Live = { readonly server: Server; readonly origin: string };

type Received = { readonly status: number; readonly headers: Headers; readonly body: unknown };

type WorldStep = Extract<Step, { readonly world: string }>;

type DeviceKey = { readonly id: string; readonly notificationKey: string };

const apnsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const fail = (message: string): never => {
  throw new Error(message);
};

const isWorldStep = (step: Step): step is WorldStep => "world" in step;

const idsIn = (value: unknown): readonly string[] => {
  if (typeof value === "string") return /^[emsta]_\d{4}_\d{5}$/u.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => idsIn(item));
  return value && typeof value === "object" ? Object.values(value).flatMap((item) => idsIn(item)) : [];
};

const toHeaders = (headers: AppRequest["headers"]): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${transcriptToken}`,
  ...Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
});

const settle = async (): Promise<void> => {
  await yieldToIo();
  await yieldToIo();
};

const send = async (origin: string, request: AppRequest): Promise<Received> => {
  const hasBody = request.body !== undefined;
  const response = await fetch(origin + request.path, {
    method: request.method,
    headers: { ...toHeaders(request.headers), ...(hasBody && { "content-type": "application/json" }) },
    ...(hasBody && { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : undefined };
};

const withTimeout = async <Value>(promise: Promise<Value>, what: string): Promise<Value> => {
  const timedOut = Symbol("timed out");
  const result = await Promise.race([promise, delay(waitMs, timedOut)]);
  return result === timedOut ? fail(`Timed out waiting for ${what}`) : result;
};

export const replay = async (name: string): Promise<void> => {
  const transcript = readTranscript(name);
  const start = Date.parse(transcript.header.start);
  const clock = createVirtualClock(start);
  const scripts = createScriptQueue(deriveScripts(transcript));
  const directory = mkdtempSync(path.join(os.tmpdir(), `ito-${name}-`));
  const backupFile = path.join(directory, "backup.db");
  const ids = createIdMatcher(transcript.given.flatMap((event) => idsIn(event)));
  const live = createCell<Live | undefined>(undefined);
  const stream = createCell<EventStream | undefined>(undefined);
  const response = createCell<Promise<Received> | undefined>(undefined);
  const apns = await startFakeApns();
  const deviceKey = createCell<DeviceKey | undefined>(undefined);

  const createReplayServer = (): Server =>
    createServer({
      dataDirectory: directory,
      createEngine: () => createScriptEngine(clock, scripts),
      name: "studio",
      agentName: "Ari",
      clock,
      push: { hosts: { production: apns.origin, sandbox: apns.origin } },
    });

  const listen = async (server: Server): Promise<void> => {
    live.set({ server, origin: await server.app.listen({ port: 0, host: "127.0.0.1" }) });
  };

  const origin = (): string => live.get()?.origin ?? fail(`${name}: no server is running`);

  const closeStream = (): void => {
    stream.get()?.close();
    stream.set(undefined);
  };

  const stopServer = async (): Promise<void> => {
    closeStream();
    const running = live.get();
    live.set(undefined);
    await running?.server.close();
  };

  const restoreBackup = (): void => {
    const database = databaseFile(directory);
    copyFileSync(backupFile, database);
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });
  };

  const advance = async (target: number): Promise<void> => {
    const runDue = async (): Promise<void> => {
      if (!clock.runNext(target)) return;
      await settle();
      await runDue();
    };
    await runDue();
    clock.moveTo(target);
    await settle();
  };

  const check = (problem: string | undefined, index: number): void => {
    if (problem) fail(`${name}, step ${index + 1}: ${problem}`);
  };

  const compareResponse = (received: Received, expected: ServerResponse, index: number): void => {
    check(
      received.status === expected.status ? undefined : `status ${received.status}, expected ${expected.status}`,
      index,
    );
    const expectedHeaders = Object.entries(expected.headers ?? {});
    for (const [header, value] of expectedHeaders) {
      const actual = received.headers.get(header);
      check(actual === value ? undefined : `header ${header}: ${String(actual)}, expected ${value}`, index);
    }
    if (expected.body !== undefined) check(ids.match(expected.body, received.body), index);
  };

  const recoveryTime = (index: number, stoppedAt: number): number => {
    const recovered = transcript.steps
      .slice(index + 1)
      .find((step) => "event" in step && Date.parse(step.event.at) > stoppedAt);
    return recovered && "event" in recovered ? Date.parse(recovered.event.at) : stoppedAt;
  };

  const comparePush = (received: Pushed, expected: TranscriptPush): string | undefined => {
    const device = deviceKey.get();
    if (!device) return "a push before any device registered";
    const envelope = received.payload as Envelope;
    const level = envelope.aps["interruption-level"];
    return level === expected.level
      ? ids.match(expected.notification, openNotification(envelope.ito, device))
      : `push level ${level}, expected ${expected.level}`;
  };

  const request = async (step: AppRequest): Promise<void> => {
    const translated = ids.translate(step);
    const registered = /^\/v0\/devices\/(?<device>[^/]+)$/u.exec(translated.path)?.groups?.device;
    const key = (translated.body as { readonly notification_key?: string } | undefined)?.notification_key;
    if (registered && key && translated.method === "PUT") deviceKey.set({ id: registered, notificationKey: key });
    if (translated.method !== "GET" || translated.path !== "/v0/events") {
      response.set(send(origin(), translated));
      return;
    }
    closeStream();
    const opened = await openEventStream(origin() + translated.path, toHeaders(translated.headers));
    stream.set(opened);
    response.set(Promise.resolve({ status: opened.status, headers: opened.headers, body: undefined }));
  };

  const changeWorld = async (step: WorldStep, index: number, time: number): Promise<void> => {
    switch (step.world) {
      case "offline":
      case "app_closed": {
        closeStream();
        await advance(time);
        return;
      }
      case "server_restarted": {
        await advance(time);
        await stopServer();
        await advance(recoveryTime(index, time));
        await listen(createReplayServer());
        return;
      }
      case "server_restored": {
        await advance(time);
        await stopServer();
        restoreBackup();
        await listen(createReplayServer());
        return;
      }
      default: {
        await advance(time);
      }
    }
  };

  const perform = async (step: Step, index: number): Promise<void> => {
    const time = start + step.at;
    if ("app" in step) {
      await advance(time);
      await request(step.app);
      return;
    }
    if ("server" in step) {
      const pending = response.get() ?? fail(`${name}, step ${index + 1}: a response without a request`);
      response.set(undefined);
      compareResponse(await withTimeout(pending, "a response"), step.server, index);
      return;
    }
    if ("push" in step) {
      await advance(time);
      const received = await apns.next(waitMs);
      check(
        received ? comparePush(received, step.push) : `no push arrived, expected ${JSON.stringify(step.push)}`,
        index,
      );
      return;
    }
    if ("event" in step) {
      await advance(Math.max(time, Date.parse(step.event.at)));
      const current = stream.get() ?? fail(`${name}, step ${index + 1}: an event with no stream open`);
      const received = await current.next(waitMs);
      check(
        received === undefined ? `no event arrived, expected ${step.event.type}` : ids.match(step.event, received),
        index,
      );
      return;
    }
    await changeWorld(step, index, time);
  };

  const seeded = createReplayServer();
  seeded.store.importEvents(transcript.given);
  seeded.store.setSetting(tokenSetting, hashToken(transcriptToken));
  seeded.store.setSetting(apnsSettings.privateKey, apnsKey);
  seeded.store.setSetting(apnsSettings.keyId, "KEY1234567");
  seeded.store.setSetting(apnsSettings.teamId, "TEAM123456");
  seeded.store.setSetting(apnsSettings.bundleId, "com.example.ari");
  const restoreTargets = new Set(transcript.steps.filter((step) => isWorldStep(step)).map((step) => step.to));
  if (restoreTargets.has(transcript.given.at(-1)?.id)) seeded.store.backupTo(backupFile);

  try {
    await listen(seeded);
    const steps = transcript.steps.entries();
    for (const [index, step] of steps) await perform(step, index);
    await advance(start + (transcript.steps.at(-1)?.at ?? 0) + afterwardsMs);
    const extra = await stream.get()?.next(quietMs);
    if (extra !== undefined) fail(`${name}: an unexpected event after the last step: ${JSON.stringify(extra)}`);
    const extraPush = await apns.next(quietMs);
    if (extraPush) fail(`${name}: an unexpected push after the last step: ${JSON.stringify(extraPush.payload)}`);
  } finally {
    await stopServer();
    await seeded.close();
    await apns.close();
    rmSync(directory, { recursive: true, force: true });
  }
};
