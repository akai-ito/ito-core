import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo, setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";
import { createCannedVoice, type CannedVoice, type YouSay } from "./canned-voice.ts";
import { openCallSocket, type Arrived, type CallSocket } from "./call-socket.ts";
import { createScriptEngine, type Complete } from "#engine/scripted/script-engine.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { fail as failed, ok } from "#result.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { fixtureDirectory } from "#protocol/tools/transcript-files.ts";
import type { Attachment } from "#protocol/types.ts";
import type { Readiness, VoiceContext } from "#voice/loop.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { openNotification } from "#notifications/crypto.ts";
import type { Envelope } from "#notifications/notifier.ts";
import type { SeededPage } from "#memory/memory.ts";
import { createServer, databaseFile, type Server } from "#server.ts";
import { openEventStream, type EventStream } from "./event-stream.ts";
import { startFakeApns, type Pushed } from "./fake-apns.ts";
import { createIdMatcher } from "./matching.ts";
import { createScriptQueue, deriveScripts } from "./scripts.ts";
import { testCapability } from "./test-capabilities.ts";
import {
  readTranscript,
  type Transcript,
  type AppRequest,
  type ServerResponse,
  type Step,
  type TranscriptPush,
  type SocketLine,
} from "./transcript-file.ts";
import { createVirtualClock } from "./virtual-clock.ts";
import { wordEmbedder } from "#memory/embedder.ts";

export const transcriptToken = "ito_example_not_a_real_token_00000000000000000000";

const capabilities = [testCapability("reports")];
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
  if (typeof value === "string") return /^[emstac]_\d{4}_\d{5}$/u.test(value) ? [value] : [];
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

const fixture = (name: string): Buffer => readFileSync(path.join(fixtureDirectory, name));

const bodyOf = (request: AppRequest): Uint8Array<ArrayBuffer> | string | undefined => {
  if (request.body_file) return new Uint8Array(fixture(request.body_file));
  if (request.body_size !== undefined) return new Uint8Array(request.body_size);
  return request.body === undefined ? undefined : JSON.stringify(request.body);
};

const send = async (origin: string, request: AppRequest): Promise<Received> => {
  const body = bodyOf(request);
  const isJson = request.body !== undefined;
  const response = await fetch(origin + request.path, {
    method: request.method,
    headers: { ...(isJson && { "content-type": "application/json" }), ...toHeaders(request.headers) },
    ...(body !== undefined && { body }),
  });
  const isJsonAnswer = response.headers.get("content-type")?.startsWith("application/json") ?? false;
  const text = isJsonAnswer ? await response.text() : undefined;
  if (!isJsonAnswer) await response.arrayBuffer();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : undefined };
};

const givenAttachments = (transcript: Transcript): readonly Attachment[] =>
  transcript.given.flatMap((event) =>
    event.type === "message.accepted"
      ? [...(event.message.attachments ?? []), ...(event.message.spoken?.audio ? [event.message.spoken.audio] : [])]
      : [],
  );

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

  const withLiveVersion = (input: unknown): unknown => {
    const fields = input as Readonly<Record<string, unknown>>;
    const { address, version } = fields;
    if (typeof address !== "string" || typeof version !== "string") return input;
    const file = `${address.replace(/^memory:/u, "")}.md`;
    const latest = execFileSync("git", ["-C", path.join(directory, "thread"), "log", "-1", "--format=%H", "--", file], {
      encoding: "utf8",
    });
    return { ...fields, version: latest.trim() };
  };
  const ids = createIdMatcher(transcript.given.flatMap((event) => idsIn(event)));
  const live = createCell<Live | undefined>(undefined);
  const stream = createCell<EventStream | undefined>(undefined);
  const response = createCell<Promise<Received> | undefined>(undefined);
  const apns = await startFakeApns();
  const deviceKey = createCell<DeviceKey | undefined>(undefined);
  const tokens = createCell<ReadonlyMap<string, string>>(new Map());
  const voiceReadiness = createCell<Readiness>({ state: "ready" });
  const voiceContext = createCell<VoiceContext | undefined>(undefined);
  const cannedVoice = createCell<CannedVoice | undefined>(undefined);
  const youSay = createCell<readonly YouSay[]>([]);
  const callSocket = createCell<CallSocket | undefined>(undefined);
  const spokenPcm = new Uint8Array(fixture("spoken-sentence.wav")).slice(44);
  const web = createCell<ReadonlyMap<string, string>>(new Map());
  const asides = createCell<readonly unknown[]>([]);

  const complete: Complete = () => {
    const [next, ...rest] = asides.get();
    asides.set(rest);
    return Promise.resolve(next === undefined ? failed("The transcript has Ari answer nothing aside here.") : ok(next));
  };

  const fetchImage = (url: string): Promise<Response> => {
    const file = web.get().get(url);
    if (file === undefined) return Promise.resolve(new Response("Not found", { status: 404 }));
    const bytes = new Uint8Array(fixture(file));
    return Promise.resolve(new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }));
  };

  const createReplayServer = (): Server =>
    createServer({
      fetchImage,
      embedder: wordEmbedder,
      dataDirectory: directory,
      createEngine: () => createScriptEngine(clock, scripts, undefined, demoModels, complete),
      name: "studio",
      agentName: "Ari",
      clock,
      push: { hosts: { production: apns.origin, sandbox: apns.origin } },
      capabilities,
      timeZone: "UTC",
      createVoice: (context) => {
        voiceContext.set(context);
        const voice = createCannedVoice(
          spokenPcm,
          () => voiceReadiness.get(),
          () => {
            const [next, ...rest] = youSay.get();
            youSay.set(rest);
            return next;
          },
        );
        cannedVoice.set(voice);
        return voice;
      },
    });

  const listen = async (server: Server): Promise<void> => {
    await server.host.ready;
    live.set({ server, origin: await server.app.listen({ port: 0, host: "127.0.0.1" }) });
  };

  const origin = (): string => live.get()?.origin ?? fail(`${name}: no server is running`);

  const closeStream = (): void => {
    stream.get()?.close();
    stream.set(undefined);
  };

  const closeCallSocket = async (): Promise<void> => {
    const current = callSocket.get();
    callSocket.set(undefined);
    await current?.close();
    await settle();
  };

  const stopServer = async (): Promise<void> => {
    closeStream();
    await closeCallSocket();
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
    const expectedToken = (expected.body as { readonly token?: unknown } | undefined)?.token;
    const receivedToken = (received.body as { readonly token?: unknown } | undefined)?.token;
    if (typeof expectedToken === "string" && typeof receivedToken === "string") {
      tokens.update((current) => new Map([...current, [expectedToken, receivedToken]]));
      check(receivedToken.startsWith("ito_") ? undefined : `token ${receivedToken} doesn't look like one`, index);
      return;
    }
    if (expected.body !== undefined) check(ids.match(expected.body, received.body), index);
  };

  const withTokens = (step: AppRequest): AppRequest => {
    const authorization = step.headers?.Authorization;
    const token = authorization?.replace(/^Bearer /u, "");
    const actual = token === undefined ? undefined : tokens.get().get(token);
    return actual ? { ...step, headers: { ...step.headers, Authorization: `Bearer ${actual}` } } : step;
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
    const translated = withTokens(ids.translate(step));
    const registered = /^\/v0\/devices\/(?<device>[^/]+)$/u.exec(translated.path)?.groups?.device;
    const key = (translated.body as { readonly notification_key?: string } | undefined)?.notification_key;
    if (registered && key && translated.method === "PUT") deviceKey.set({ id: registered, notificationKey: key });
    if (translated.method === "GET" && /^\/v0\/calls\/[^/]+\/stream$/u.test(translated.path)) {
      await closeCallSocket();
      const opened = await openCallSocket(
        origin().replace(/^http/u, "ws") + translated.path,
        toHeaders(translated.headers),
      );
      callSocket.set(opened);
      response.set(Promise.resolve({ status: opened.status, headers: opened.headers, body: opened.body }));
      return;
    }
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
        await closeCallSocket();
        return;
      }
      case "voiceprint_learnt": {
        await advance(time);
        mkdirSync(path.join(directory, "voice"), { recursive: true });
        writeFileSync(
          path.join(directory, "voice", "voiceprint.json"),
          JSON.stringify({ vector: [1, 0], threshold: 0.6 }),
        );
        return;
      }
      case "you_say": {
        await advance(time);
        const {
          text,
          heard = [],
          held,
        } = step as unknown as Omit<YouSay, "heard"> & {
          readonly heard?: readonly string[];
        };
        youSay.update((current) => [...current, { text, heard, ...(held === true && { held }) }]);
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
      case "memory_holds": {
        await advance(time);
        const { pages } = step as unknown as { readonly pages: readonly SeededPage[] };
        for (const page of pages) {
          const seeded = await (live.get()?.server.memory.seed(page) ?? Promise.resolve(undefined));
          check(seeded?.ok === false ? `memory refused ${page.address}: ${seeded.failure}` : undefined, index);
        }
        return;
      }
      case "voice_loading":
      case "voice_ready":
      case "voice_failed": {
        await advance(time);
        const { reason } = step as unknown as { readonly reason?: string };
        const readiness: Readiness = {
          state: step.world === "voice_ready" ? "ready" : step.world === "voice_loading" ? "loading" : "failed",
          ...(reason !== undefined && { reason }),
        };
        voiceReadiness.set(readiness);
        voiceContext.get()?.onReadiness(readiness);
        if (readiness.state === "failed") cannedVoice.get()?.fail(readiness.reason ?? "The voice failed.");
        return;
      }
      case "capability_on": {
        await advance(time);
        const { capability, values } = step as unknown as {
          readonly capability: string;
          readonly values: Readonly<Record<string, string>>;
        };
        const host = live.get()?.server.host;
        const saved = await host?.setUp(capability, values);
        const switched = await host?.switchTo(capability, true);
        check(
          saved?.ok === false || switched?.ok === false ? `${capability} couldn't be switched on` : undefined,
          index,
        );
        return;
      }
      case "agent_calls": {
        await advance(time);
        const { tool, input, returns } = step as unknown as {
          readonly tool: string;
          readonly input: unknown;
          readonly returns?: unknown;
        };
        const called = await (live.get()?.server.callTool(tool, ids.translate(withLiveVersion(input))) ??
          Promise.resolve(undefined));
        check(called?.isError === true ? `${tool} failed: ${called.text}` : undefined, index);
        if (returns !== undefined) check(ids.match(returns, called?.structured), index);
        return;
      }
      case "ari_keeps_up": {
        const { changes, summary, note } = step as unknown as {
          readonly changes: unknown;
          readonly summary: string;
          readonly note: string;
        };
        asides.update((current) => [...current, { changes_json: JSON.stringify(changes), summary, note }]);
        await advance(time);
        return;
      }
      case "web_has": {
        await advance(time);
        const { url, file } = step as unknown as { readonly url: string; readonly file: string };
        web.update((current) => new Map([...current, [url, file]]));
        return;
      }
      case "pairing_code_shown": {
        await advance(time);
        const code = String((step as { readonly code?: unknown }).code).replaceAll("-", "");
        live.get()?.server.store.createPairingCode(hashToken(code), new Date(time + 5 * 60 * 1000).toISOString());
        return;
      }
      default: {
        await advance(time);
      }
    }
  };

  const compareArrival = (received: Arrived | undefined, expected: SocketLine): string | undefined => {
    if (received === undefined) return `nothing arrived on the call socket, expected ${JSON.stringify(expected)}`;
    if (expected.frame !== undefined) {
      return "frame" in received ? ids.match(expected.frame, received.frame) : `got ${JSON.stringify(received)}`;
    }
    const wanted = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "from"));
    return JSON.stringify(received) === JSON.stringify(wanted)
      ? undefined
      : `got ${JSON.stringify(received)}, expected ${JSON.stringify(wanted)}`;
  };

  const playSocket = async (line: SocketLine, index: number, time: number): Promise<void> => {
    const socket = callSocket.get() ?? fail(`${name}, step ${index + 1}: a socket line with no call socket open`);
    if (line.from === "app") {
      await advance(time);
      if (line.frame !== undefined) socket.sendFrame(ids.translate(line.frame));
      if (line.audio !== undefined) socket.sendAudio(fixture(line.audio));
      await settle();
      return;
    }
    await advance(time);
    check(compareArrival(await socket.next(waitMs), line), index);
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
    if ("socket" in step) {
      await playSocket(step.socket, index, time);
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
  for (const attachment of givenAttachments(transcript)) {
    seeded.attachments.save(attachment.id, attachment.name, attachment.media_type, fixture(attachment.name));
  }
  seeded.store.importEvents(transcript.given);
  seeded.store.setSetting(tokenSetting, hashToken(transcriptToken));
  const hasDevices = transcript.steps.some((step) => "app" in step && step.app.path.startsWith("/v0/devices/"));
  if (hasDevices) {
    seeded.store.setSetting(apnsSettings.privateKey, apnsKey);
    seeded.store.setSetting(apnsSettings.keyId, "KEY1234567");
    seeded.store.setSetting(apnsSettings.teamId, "TEAM123456");
    seeded.store.setSetting(apnsSettings.bundleId, "com.example.ari");
  }
  const restoreTargets = new Set(transcript.steps.filter((step) => isWorldStep(step)).map((step) => step.to));
  if (restoreTargets.has(transcript.given.at(-1)?.id)) seeded.store.backupTo(backupFile);

  try {
    await listen(seeded);
    const steps = transcript.steps.entries();
    for (const [index, step] of steps) await perform(step, index);
    await advance(start + (transcript.steps.at(-1)?.at ?? 0) + afterwardsMs);
    const extra = await stream.get()?.next(quietMs);
    if (extra !== undefined) fail(`${name}: an unexpected event after the last step: ${JSON.stringify(extra)}`);
    const extraFrame = await callSocket.get()?.next(quietMs);
    if (extraFrame !== undefined) {
      fail(`${name}: an unexpected frame on the call socket after the last step: ${JSON.stringify(extraFrame)}`);
    }
    const extraPush = await apns.next(quietMs);
    if (extraPush) fail(`${name}: an unexpected push after the last step: ${JSON.stringify(extraPush.payload)}`);
  } finally {
    await stopServer();
    await seeded.close();
    await apns.close();
    rmSync(directory, { recursive: true, force: true });
  }
};
