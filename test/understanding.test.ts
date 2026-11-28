import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Question, Understanding, VoiceState, Work } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer, type EngineContext } from "#server.ts";
import { noVoice, type HeardRecording, type TranscriptionFailure, type VoiceContext } from "#voice/loop.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-understanding-"));
const token = "ito_understanding_test_not_a_real_token_000000000000000";
const authorization = `Bearer ${token}`;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

type Heard = Result<HeardRecording, TranscriptionFailure>;

const heardSaying = (text: string): Heard =>
  ok({ seconds: 3, segments: [{ start: 0, end: 3, text }], speakers: [], model: "test" });

const open = async () => {
  const clock = createVirtualClock(Date.parse("2026-11-27T09:00:00.000Z"));
  const context = createCell<EngineContext | undefined>(undefined);
  const prompts = createCell<readonly string[]>([]);
  const voiceState = createCell<VoiceState>("loading");
  const voiceContext = createCell<VoiceContext | undefined>(undefined);
  const heard = createCell<readonly Heard[]>([]);
  const transcribed = createCell<readonly string[]>([]);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "understanding",
    clock,
    timeZone: "UTC",
    createEngine: (given) => {
      context.set(given);
      return createScriptEngine(
        clock,
        () => {
          throw new Error("This test starts no turns.");
        },
        undefined,
        undefined,
        undefined,
        (prompt) => {
          prompts.update((current) => [...current, prompt]);
          return Promise.resolve(ok("Wrote it on How to help you.\nWeekends start slow."));
        },
      );
    },
    createVoice: (given) => {
      voiceContext.set(given);
      return {
        ...noVoice("A test voice."),
        readiness: () => ({ state: voiceState.get() }),
        transcribe: (job) => {
          transcribed.update((current) => [...current, job]);
          const [next, ...rest] = heard.get();
          heard.set(rest);
          return Promise.resolve(next ?? fail({ code: "failed", detail: "The test heard nothing." }));
        },
      };
    },
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const changes = createCell<readonly Question[]>([]);
  server.store.subscribe(({ event }) => {
    if (event.type === "question.changed") changes.update((current) => [...current, event.question]);
  });
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    server.app.inject({ method, url, headers: { authorization }, ...(payload && { payload }) });
  const understanding = async (): Promise<Understanding> => {
    const read = await call("GET", "/v0/understanding");
    return read.json<Understanding>();
  };
  const recent = async (): Promise<readonly Question[]> => {
    const page = await understanding();
    return page.recent;
  };
  const answer = (question: string, reply: object) =>
    call("POST", `/v0/understanding/questions/${question}/answer`, reply);
  const voiceIs = (state: VoiceState): void => {
    voiceState.set(state);
    voiceContext.get()?.onReadiness({ state });
  };
  const upload = async (name: string, mediaType: string): Promise<string> => {
    const id = randomUUID();
    const uploaded = await server.app.inject({
      method: "PUT",
      url: `/v0/attachments/${id}?name=${name}`,
      headers: { authorization, "content-type": mediaType },
      payload: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypM4A spoken words")]),
    });
    expect(uploaded.statusCode).toBe(201);
    return id;
  };
  const track = async (name = "Planning with you"): Promise<string> => {
    const opened = await server.callTool("open_track", { name });
    return /l_\w+/u.exec(opened.text)?.[0] ?? "";
  };
  const ask = async (
    trackId: string,
    missing: string,
    options: readonly string[] = [],
  ): Promise<{ readonly id: string; readonly text: string; readonly isError?: boolean }> => {
    const asked = await server.callTool("add_question", {
      track: trackId,
      understood: "You keep Sunday mornings free.",
      missing,
      why: "So the weekends I plan leave you rested.",
      ...(options.length > 0 && { options }),
    });
    return { ...asked, id: /q_\w+/u.exec(asked.text)?.[0] ?? "" };
  };
  return {
    server,
    clock,
    prompts,
    changes,
    heard,
    transcribed,
    call,
    understanding,
    recent,
    answer,
    voiceIs,
    upload,
    track,
    ask,
    inMind: () => context.get()?.inMind() ?? "",
  };
};

const restful = "What makes a weekend feel restful rather than busy?";
const choices = ["Unplanned time", "Seeing friends", "Being outdoors"];

describe("Understanding you", () => {
  it("asks on a track, a few at a time, never what it's already asking", async () => {
    const { server, changes, track, ask, understanding, inMind } = await open();
    try {
      const nowhere = await ask("l_none", restful);
      const planning = await track();
      const first = await ask(planning, restful, choices);
      const again = await ask(planning, "What makes a weekend restful for you, rather than busy?");
      const tooLong = await server.callTool("add_question", {
        track: planning,
        understood: "x",
        missing: "Which café?",
        why: "y",
        options: ["z".repeat(81)],
      });
      const more = await Promise.all(
        [
          "When a week is packed, what should I protect first?",
          "Which mornings do you like to keep for deep work?",
          "How far ahead do you like plans with friends made?",
          "Should errands go on weekday evenings or Saturday?",
        ].map((missing) => ask(planning, missing)),
      );
      const sixth = await ask(planning, "Do holidays need a plan, or room to wander?");

      expect(nowhere).toMatchObject({ isError: true, text: "There's no such track: open one with open_track first." });
      expect(first.text).toBe(
        `Added ${first.id} to Planning with you. It waits quietly for them in Understanding you.`,
      );
      expect(again.isError).toBeUndefined();
      expect(again.text).toMatch(
        new RegExp(String.raw`^You've already asked that: ${first.id} \(Planning with you\)`, "u"),
      );
      expect(tooLong).toMatchObject({ isError: true, text: "Keep each option to 80 characters or fewer." });
      expect(more.every(({ isError }) => isError === undefined)).toBe(true);
      expect(sixth).toMatchObject({ isError: true });
      expect(sixth.text).toContain("Planning with you already has 5 open questions.");
      expect(changes.get()).toHaveLength(5);
      expect(changes.get()[0]).toEqual({
        id: first.id,
        track: planning,
        state: "open",
        understood: "You keep Sunday mornings free.",
        missing: restful,
        why: "So the weekends I plan leave you rested.",
        options: choices,
        asked_at: "2026-11-27T09:00:00.000Z",
        changed_at: "2026-11-27T09:00:00.000Z",
      });
      const page = await understanding();
      expect(page.questions.map(({ id }) => id)).toEqual([first.id, ...more.map(({ id }) => id)]);
      expect(page.tracks).toMatchObject([{ id: planning, name: "Planning with you" }]);
      expect(inMind()).toContain(`<questions>`);
      expect(inMind()).toContain(`- ${first.id} (Planning with you): ${restful}`);
      expect(server.store.desk().waiting).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("takes taps and words, none fit or not sure, as an answer that's enough", async () => {
    const { server, prompts, changes, call, answer, track, ask, understanding, inMind } = await open();
    try {
      const planning = await track();
      const first = await ask(planning, restful, choices);
      const second = await ask(planning, "When a week is packed, what should I protect first?");
      const stranger = await answer(first.id, { picked: ["Nope"] });
      const both = await answer(first.id, { picked: ["Unplanned time"], none_fit: true });
      const nothing = await answer(first.id, { none_fit: false });
      const empty = await answer(first.id, {});
      const unknown = await answer("q_none", { not_sure: true });
      const taken = await answer(first.id, { none_fit: true, text: " Mostly a long walk. " });

      expect(stranger.statusCode).toBe(400);
      expect(stranger.json()).toMatchObject({ error: { message: "“Nope” isn't one of this question's options." } });
      expect(both.json()).toMatchObject({ error: { message: "None fit doesn't go with options you picked." } });
      expect(nothing.json()).toMatchObject({
        error: { message: "Pick an option, say it in your words, or say none fit or not sure." },
      });
      expect(empty.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(404);
      expect(taken.statusCode).toBe(202);
      expect(taken.json()).toMatchObject({
        question: {
          id: first.id,
          state: "answered",
          answer: { at: "2026-11-27T09:00:00.000Z", text: "Mostly a long walk.", none_fit: true },
        },
      });
      await vi.waitFor(() => {
        expect(changes.get().at(-1)).toMatchObject({ id: first.id, filed: "Weekends start slow." });
      });
      const [prompt] = prompts.get();
      expect(prompt).toContain("on your Planning with you track.");
      expect(prompt).toContain(`What you asked: ${restful}`);
      expect(prompt).toContain("They said none of your options fit.");
      expect(prompt).toContain('In their words: "Mostly a long walk."');
      expect(prompt).toContain("Let the answer be enough");
      expect(prompt).toContain("settle that one with settle_question");

      const retried = await answer(first.id, { text: "Mostly a long walk.", none_fit: true });
      const changed = await answer(first.id, { text: "Something else" });
      const later = await call("POST", `/v0/understanding/questions/${first.id}/not-now`);
      const unsure = await answer(second.id, { not_sure: true });
      const settleAnswered = await server.callTool("settle_question", { question: second.id, note: "In the chat." });
      expect(retried.statusCode).toBe(202);
      expect(changed.json()).toMatchObject({ error: { message: "That question is already answered." } });
      expect(later.statusCode).toBe(400);
      expect(unsure.json()).toMatchObject({ question: { state: "answered", answer: { not_sure: true } } });
      expect(settleAnswered).toEqual({ text: `${second.id} is already answered.`, isError: true });
      await vi.waitFor(() => {
        expect(prompts.get()).toHaveLength(2);
      });

      const read = await call("GET", "/v0/work");
      const work = read.json<Work>();
      expect(work.tracks[0]?.evidence).toEqual([
        {
          at: "2026-11-27T09:00:00.000Z",
          kind: "answered",
          text: "You answered “When a week is packed, what should I protect first?”: not sure",
          question: second.id,
        },
        {
          at: "2026-11-27T09:00:00.000Z",
          kind: "answered",
          text: `You answered “${restful}”: none of the options fit; “Mostly a long walk.”`,
          question: first.id,
        },
      ]);
      const page = await understanding();
      expect(page.questions).toEqual([]);
      expect(page.recent.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(inMind()).not.toContain("<questions>");
      expect(server.store.desk()).toMatchObject({ waiting: [], handled: 0 });
    } finally {
      await server.close();
    }
  });

  it("sets a question aside with Not now, and lets Kumo settle or drop one", async () => {
    const { server, clock, call, track, ask, understanding, recent } = await open();
    try {
      const planning = await track();
      const first = await ask(planning, restful, choices);
      const second = await ask(planning, "When a week is packed, what should I protect first?");
      const third = await ask(planning, "Which mornings do you like to keep for deep work?");
      clock.moveTo(Date.parse("2026-11-27T10:00:00.000Z"));
      const later = await call("POST", `/v0/understanding/questions/${first.id}/not-now`);
      const settled = await server.callTool("settle_question", {
        question: second.id,
        note: "You said in the chat that sleep comes first.",
      });
      const dropped = await server.callTool("drop_question", { question: third.id, why: "The plan passed." });
      const droppedAgain = await server.callTool("drop_question", { question: third.id, why: "Again." });
      const listed = await server.callTool("list_questions", {});
      const answerDropped = await call("POST", `/v0/understanding/questions/${third.id}/answer`, { not_sure: true });

      expect(later.json()).toMatchObject({
        question: { id: first.id, state: "open", later_at: "2026-11-27T10:00:00.000Z" },
      });
      expect(settled.text).toBe(`Settled ${second.id}.`);
      expect(dropped.text).toBe(`Dropped ${third.id}.`);
      expect(droppedAgain.isError).toBe(true);
      expect(answerDropped.statusCode).toBe(404);
      expect(listed.text).toContain(`Waiting:\n- ${first.id} (Planning with you), asked 2026-11-27: ${restful}`);
      expect(listed.text).toContain("They said not now on 2026-11-27.");
      expect(listed.text).toContain(
        `Answered or settled lately:\n- ${second.id} (Planning with you), settled 2026-11-27: When a week is packed, ` +
          "what should I protect first? → You said in the chat that sleep comes first.",
      );
      const page = await understanding();
      expect(page.questions.map(({ id }) => id)).toEqual([first.id]);
      expect(page.recent).toMatchObject([
        { id: second.id, state: "settled", note: "You said in the chat that sleep comes first." },
      ]);
      expect(page.recent[0]).not.toHaveProperty("later_at");
      clock.moveTo(Date.parse("2026-12-12T10:00:00.000Z"));
      expect(await recent()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("hears a spoken answer on the server once its voice is ready, and opens it again if it can't", async () => {
    const { server, prompts, heard, transcribed, answer, voiceIs, upload, track, ask, understanding, recent } =
      await open();
    try {
      const planning = await track();
      const first = await ask(planning, restful, choices);
      const second = await ask(planning, "When a week is packed, what should I protect first?");
      const third = await ask(planning, "Which mornings do you like to keep for deep work?");
      const spoken = await upload("answer.m4a", "audio/mp4");
      const photo = await upload("photo.jpg", "image/jpeg");
      const both = await answer(first.id, { audio: spoken, text: "And words." });
      const missing = await answer(first.id, { audio: randomUUID() });
      const notAudio = await answer(first.id, { audio: photo });
      voiceIs("failed");
      const voiceless = await answer(first.id, { audio: spoken });
      voiceIs("loading");
      const taken = await answer(first.id, { audio: spoken, picked: ["Being outdoors"] });

      expect(both.json()).toMatchObject({
        error: { message: "Send your words as text or as a recording, not both." },
      });
      expect(missing.json()).toMatchObject({
        error: { message: "That recording isn't on the server: upload it first." },
      });
      expect(notAudio.statusCode).toBe(400);
      expect(voiceless.json()).toMatchObject({
        error: {
          message: "The server's voice isn't running, so it can't hear a spoken answer now. Write it instead.",
        },
      });
      expect(taken.statusCode).toBe(202);
      expect(taken.json()).toMatchObject({ question: { state: "answered", answer: { audio: spoken } } });
      expect(taken.json<{ question: Question }>().question.answer?.text).toBeUndefined();
      expect(transcribed.get()).toEqual([]);

      heard.set([heardSaying("A long walk,"), heardSaying("Not audio at all")]);
      voiceIs("ready");
      await vi.waitFor(async () => {
        const [heardFirst] = await recent();
        expect(heardFirst?.answer).toMatchObject({
          audio: spoken,
          picked: ["Being outdoors"],
          text: "A long walk,",
        });
      });
      await vi.waitFor(() => {
        expect(prompts.get().at(-1)).toContain(
          `They said it aloud; what the server heard, which may have small slips: "A long walk,"`,
        );
      });
      expect(transcribed.get()).toEqual([spoken]);

      const unreadable = await upload("second.m4a", "audio/mp4");
      heard.set([fail({ code: "unreadable", detail: "It isn't audio." })]);
      await answer(second.id, { audio: unreadable });
      await vi.waitFor(async () => {
        const page = await understanding();
        expect(page.questions[0]).toMatchObject({
          id: second.id,
          state: "open",
          unheard: "Your recording couldn't be heard: It isn't audio.",
        });
      });

      voiceIs("loading");
      const waiting = await upload("third.m4a", "audio/mp4");
      await answer(third.id, { audio: waiting });
      heard.set([fail({ code: "unavailable", detail: "The voice went away." }), heardSaying("Tuesday mornings.")]);
      voiceIs("ready");
      await vi.waitFor(() => {
        expect(transcribed.get()).toEqual([spoken, unreadable, waiting]);
      });
      voiceIs("ready");
      await vi.waitFor(async () => {
        const [heardLast] = await recent();
        expect(heardLast).toMatchObject({
          id: third.id,
          answer: { text: "Tuesday mornings." },
        });
      });
    } finally {
      await server.close();
    }
  });
});
