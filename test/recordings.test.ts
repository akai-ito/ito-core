import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import type { Act } from "#engine/scripted/script-engine.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Recording, Transcript } from "#protocol/types.ts";
import { fail } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { createSidecarVoice, voicePython } from "#voice/sidecar.ts";
import { clockTime, corrected, toSeconds, withCorrection } from "#recordings/transcripts.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-recordings-"));
const token = "ito_recordings_test_token_000000000000000000000000000";
const authorization = `Bearer ${token}`;
const sidecar = path.join(import.meta.dirname, "support", "voice", "sidecar.ts");
const servers = createCell<readonly Server[]>([]);

type Started = {
  readonly server: Server;
  readonly voice: string;
  readonly data: string;
  readonly prompts: () => readonly string[];
  readonly states: () => readonly Recording[];
};

type Options = {
  readonly behaviour?: string;
  readonly hasVoice?: boolean;
  readonly acts?: readonly Act[];
  readonly turnMs?: number;
};

const installVoice = (behaviour: string): string => {
  const directory = mkdtempSync(path.join(home, "voice-"));
  const python = voicePython(directory);
  mkdirSync(path.dirname(python), { recursive: true });
  writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "${sidecar}" "$@"\n`);
  chmodSync(python, 0o755);
  writeFileSync(path.join(directory, "behaviour"), behaviour);
  return directory;
};

const start = async ({
  behaviour = "ready",
  hasVoice = true,
  acts = [],
  turnMs = 200,
}: Options = {}): Promise<Started> => {
  const voice = installVoice(behaviour);
  const data = mkdtempSync(path.join(home, "data-"));
  mkdirSync(path.join(data, "voice"), { recursive: true });
  writeFileSync(path.join(data, "voice", "voiceprint.json"), JSON.stringify({ vector: [0.6, 0.8], threshold: 0.5 }));
  const prompts = createCell<readonly string[]>([]);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: data,
    name: "recordings",
    createEngine: ({ callTool }) =>
      createScriptEngine(
        systemClock,
        (_turn, _inputs, now) => ({
          events: [{ at: now + turnMs, event: { type: "ended" } }],
          acts: acts.map((act) => ({ ...act, at: now + act.at })),
          steer: () => ({ outcome: "refused" }),
          stoppedAt: (at) => at,
        }),
        callTool,
        undefined,
        undefined,
        (prompt) => {
          prompts.update((current) => [...current, prompt]);
          return Promise.resolve(fail({ code: "engine_failed", detail: "The test has Kumo do nothing here." }));
        },
      ),
    ...(hasVoice && {
      createVoice: (context) => createSidecarVoice({ ...context, directory: voice, models: path.join(data, "models") }),
    }),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  servers.update((current) => [...current, server]);
  const states = createCell<readonly Recording[]>([]);
  server.store.subscribe(({ event }) => {
    if (event.type === "recording.changed") states.update((current) => [...current, event.recording]);
  });
  return { server, voice, data, prompts: () => prompts.get(), states: () => states.get() };
};

const call = async (server: Server, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  server.app.inject({ method, url, headers: { authorization }, ...(payload && { payload }) });

// Sends a made-up recording in a message, as the app does once it's uploaded.
const sendRecording = async (server: Server): Promise<string> => {
  const id = randomUUID();
  const uploaded = await server.app.inject({
    method: "PUT",
    url: `/v0/attachments/${id}?name=Interview.m4a`,
    headers: { authorization, "content-type": "audio/mp4" },
    payload: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypM4A recorded words")]),
  });
  expect(uploaded.statusCode).toBe(201);
  const sent = await call(server, "POST", "/v0/messages", {
    id: randomUUID(),
    text: "How did my interview go?",
    attachments: [id],
  });
  expect(sent.statusCode).toBe(201);
  return id;
};

const recordingOf = async (server: Server, id: string): Promise<Recording> => {
  const answer = await call(server, "GET", `/v0/recordings/${id}`);
  return answer.json<{ recording: Recording }>().recording;
};

const waitForState = async (server: Server, id: string, state: Recording["state"]): Promise<Recording> =>
  vi.waitFor(
    async () => {
      const recording = await recordingOf(server, id);
      expect(recording.state).toBe(state);
      return recording;
    },
    { timeout: 10_000 },
  );

const readLines = (file: string): readonly Readonly<Record<string, unknown>>[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);

afterEach(async () => {
  await Promise.all(servers.get().map((server) => server.close()));
  servers.set([]);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("recordings", () => {
  it("are transcribed on the server with their progress, and Kumo comes back to one the chat didn't read", async () => {
    const { server, voice, data, prompts, states } = await start();

    const id = await sendRecording(server);
    const ready = await waitForState(server, id, "ready");

    expect(ready).toMatchObject({ name: "Interview.m4a", duration_seconds: 61.5, speakers: 2 });
    expect(states().map(({ state }) => state)).toContain("transcribing");
    expect(states().find(({ progress }) => progress?.done_seconds === 30)?.progress).toEqual({
      done_seconds: 30,
      total_seconds: 61.5,
    });
    const [asked] = readLines(path.join(voice, "transcribe.log"));
    expect(asked).toEqual({
      job: id,
      path: path.join(data, "attachments", id),
      voiceprint: { vector: [0.6, 0.8], threshold: 0.5 },
    });
    await vi.waitFor(() => {
      expect(prompts()).toHaveLength(1);
    });
    const [prompt = ""] = prompts();
    expect(prompt).toContain(`A recording they sent is transcribed: Interview.m4a (${id}), 62 seconds long`);
    expect(prompt).toContain('sent with the words: "How did my interview go?"');
    expect(prompt).toContain("post in a new one (new_thread)");
    expect(prompt).toContain("Propose, don't do");
    expect(prompt).toContain("as one ari:proposals block");
    expect(prompt).toContain(`[18:42](recording:${id}?t=18:42)`);
    const listed = await call(server, "GET", "/v0/recordings");
    expect(listed.json<{ recordings: Recording[] }>().recordings.map(({ attachment }) => attachment)).toEqual([id]);
  });

  it("give their transcript with times and voices, as JSON or text, and take corrections over what was heard", async () => {
    const { server } = await start();
    const id = await sendRecording(server);
    await waitForState(server, id, "ready");

    const read = await call(server, "GET", `/v0/recordings/${id}/transcript`);
    const { transcript } = read.json<{ transcript: Transcript }>();
    expect(transcript.speakers).toEqual([
      { id: "S1", name: "Speaker 1", seconds: 3.8, you: false },
      { id: "you", name: "You", seconds: 4.8, you: true },
    ]);
    expect(transcript).toMatchObject({ language: "en", model: "nvidia/parakeet-tdt-0.6b-v2", corrections: [] });

    const corrected = await call(server, "POST", `/v0/recordings/${id}/corrections`, {
      replace: [{ heard: "myra", meant: "Mira" }],
      speakers: [{ id: "S1", name: "Interviewer" }],
    });
    expect(corrected.statusCode).toBe(200);
    const text = await call(server, "GET", `/v0/recordings/${id}/transcript?format=text`);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toBe(
      [
        "[0:00] Interviewer: Thanks for coming in. Could you tell me about Mira's team?",
        "[0:05] You: Of course. I lead the tools group at Northwind.",
        "[0:10] Great.",
        "",
      ].join("\n"),
    );
    const stranger = await call(server, "POST", `/v0/recordings/${id}/corrections`, {
      speakers: [{ id: "S9", name: "Someone" }],
    });
    expect(stranger.statusCode).toBe(400);
    const undone = await call(server, "POST", `/v0/recordings/${id}/corrections`, {
      replace: [{ heard: "Myra", meant: "Myra" }],
    });
    expect(undone.json<{ transcript: Transcript }>().transcript.segments[0]?.text).toContain("Myra's team");
  });

  it("are read and corrected by Kumo through its tools, a page at a time or for a topic", async () => {
    const sent = createCell("");
    const { server, prompts } = await start({
      acts: [
        {
          at: 1000,
          act: async (callTool) => {
            await callTool("read_recording", { attachment: sent.get() });
          },
        },
      ],
      turnMs: 1500,
    });
    await vi.waitFor(
      () => {
        expect(server.voice.readiness().state).toBe("ready");
      },
      { timeout: 10_000 },
    );
    const id = await sendRecording(server);
    sent.set(id);
    await waitForState(server, id, "ready");

    const listed = await server.callTool("read_recording", {});
    expect(listed.text).toContain(`- Interview.m4a (${id}) is transcribed: 62 seconds, 2 voices.`);
    const read = await server.callTool("read_recording", { attachment: id });
    expect(read.text).toContain("Voices, told apart by how they sound, a best guess: Speaker 1 (S1, 4 seconds)");
    expect(read.text).toContain("[0:05] You: Of course. I lead the tools group at Northwind.");
    expect(read.text).toContain("(That's the end.)");
    const found = await server.callTool("read_recording", { attachment: id, find: "northwind" });
    expect(found.text).toContain('1 turns mention "northwind":\n[0:05] You:');
    const later = await server.callTool("read_recording", { attachment: id, from: "0:06" });
    expect(later.text).not.toContain("[0:00]");
    const fixed = await server.callTool("correct_transcript", { attachment: id, heard: "Myra", meant: "Mira" });
    expect(fixed.text).toBe('Corrected: "Myra" now reads "Mira".');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(prompts()).toEqual([]);
  });

  it("delete their audio, transcript and the copy in Kumo's workspace, even mid-transcription", async () => {
    const { server, data, states } = await start({ behaviour: "slow-transcribe" });
    const id = await sendRecording(server);
    await waitForState(server, id, "transcribing");
    const copy = path.join(data, "workspace", "uploads", "Interview.m4a");
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, readFileSync(path.join(data, "attachments", id)));
    writeFileSync(path.join(data, "workspace", "uploads", "Other.m4a"), "something else entirely");

    const deleted = await call(server, "DELETE", `/v0/recordings/${id}`);

    expect(deleted.json()).toMatchObject({ recording: { attachment: id, state: "deleted" } });
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(path.join(data, "workspace", "uploads", "Other.m4a"))).toBe(true);
    const audio = await call(server, "GET", `/v0/attachments/${id}`);
    expect(audio.statusCode).toBe(404);
    const transcript = await call(server, "GET", `/v0/recordings/${id}/transcript`);
    expect(transcript.statusCode).toBe(409);
    expect(transcript.json()).toMatchObject({ error: { code: "not_transcribed" }, recording: { state: "deleted" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(states().at(-1)?.state).toBe("deleted");
    const again = await call(server, "DELETE", `/v0/recordings/${id}`);
    expect(again.statusCode).toBe(200);
    const listed = await call(server, "GET", "/v0/recordings");
    expect(listed.json()).toEqual({ recordings: [] });
  });

  it("say plainly when a recording can't be read, and try again when asked", async () => {
    const { server, voice } = await start({ behaviour: "unreadable" });
    const id = await sendRecording(server);

    const failed = await waitForState(server, id, "failed");

    expect(failed.error).toEqual({
      code: "recording_unreadable",
      message: "The server couldn't read this recording.",
      detail: "ffmpeg couldn't read the recording: Invalid data found",
    });
    const retried = await call(server, "POST", `/v0/recordings/${id}/retry`);
    expect(retried.statusCode).toBe(202);
    await waitForState(server, id, "failed");
    expect(readLines(path.join(voice, "transcribe.log"))).toHaveLength(2);
    const notFailed = await call(server, "POST", `/v0/recordings/${randomUUID()}/retry`);
    expect(notFailed.statusCode).toBe(404);
  });

  it("wait, saying why, on a server with no voice, which says so before anything is uploaded", async () => {
    const { server } = await start({ hasVoice: false });
    const limits = await call(server, "GET", "/v0/uploads");
    expect(limits.json()).toMatchObject({
      transcription: { state: "unavailable", reason: "This server runs without a voice.", languages: ["en"] },
    });

    const id = await sendRecording(server);

    await vi.waitFor(async () => {
      expect(await recordingOf(server, id)).toMatchObject({
        state: "queued",
        reason: "The server's voice isn't running: This server runs without a voice.",
      });
    });
    const early = await server.callTool("read_recording", { attachment: id });
    expect(early.text).toBe(
      "Interview.m4a is waiting to be transcribed. The server's voice isn't running: This server runs without a voice.",
    );
  });
});

describe("transcript corrections", () => {
  it("replace whole words in any case, keep what follows literally, and undo when corrected to themselves", () => {
    const corrections = withCorrection([], { heard: "myra", meant: "Mira" });

    expect(corrected("Myra said Myrage costs $5, ask MYRA.", corrections)).toBe("Mira said Myrage costs $5, ask Mira.");
    expect(corrected("The fee was cheap.", withCorrection([], { heard: "cheap", meant: "$& more" }))).toBe(
      "The fee was $& more.",
    );
    expect(withCorrection(corrections, { heard: "Myra", meant: "Myra" })).toEqual([]);
    expect(withCorrection(corrections, { heard: "MYRA", meant: "Maira" })).toEqual([{ heard: "MYRA", meant: "Maira" }]);
  });

  it("read and write times in a recording", () => {
    expect([clockTime(4.6), clockTime(750), clockTime(3729)]).toEqual(["0:04", "12:30", "1:02:09"]);
    expect([toSeconds("12:30"), toSeconds("1:02:09"), toSeconds("90"), toSeconds("soon")]).toEqual([
      750,
      3729,
      90,
      undefined,
    ]);
  });
});
