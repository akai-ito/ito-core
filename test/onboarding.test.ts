import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts, demoWork } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { askedSetting, createGettingStarted } from "#onboarding/onboarding.ts";
import type { Onboarding } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { createServer } from "#server.ts";
import type { Tool } from "#tools/mcp.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-onboarding-"));
const token = "ito_onboarding_test_not_a_real_token_0000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("getting started", () => {
  it("starts on a fresh box, shows what the demo found, takes a belief and finishes", async () => {
    const server = createServer({
      dataDirectory: home,
      name: "onboarding",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(systemClock, demoScripts, callTool, undefined, demoAnswers, demoWork(callTool)),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const call = (method: "GET" | "POST", url: string, payload?: Readonly<Record<string, unknown>>) =>
      server.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
    const onboarding = async (): Promise<Onboarding> => {
      const response = await call("GET", "/v0/onboarding");
      return response.json<Onboarding>();
    };
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const fresh = await onboarding();
      const freshSnapshot = server.store.snapshot("no_cursor").event.onboarding;
      const accepted = server.store.acceptMessage(toMessageId(randomUUID()), "Let's start");
      if (!accepted.ok) throw new Error(accepted.failure);
      server.turns.route(toMessageId(accepted.value.message.id), "Let's start");
      await vi.waitFor(
        async () => {
          const current = await onboarding();
          expect(current.state).toBe("ready");
        },
        { timeout: 15_000, interval: 100 },
      );
      const ready = await onboarding();
      const belief = ready.proposal?.beliefs[0]?.id ?? "none";
      const unknown = await call("POST", "/v0/onboarding/beliefs/n_nothing", { answer: "true" });
      const confirmed = await call("POST", `/v0/onboarding/beliefs/${belief}`, { answer: "true" });
      const finished = await call("POST", "/v0/onboarding/done");

      expect(fresh).toEqual({ state: "reading" });
      expect(freshSnapshot).toEqual({ state: "reading" });
      expect(ready.proposal).toMatchObject({
        beliefs: [{ text: "You're training for a sub-20 5K, with parkrun on Saturdays.", page: "memory:now" }],
        added: [{ title: "Flights to Valencia", calendar: { kumo: false } }],
        motions: [],
      });
      expect(unknown.statusCode).toBe(404);
      expect(confirmed.statusCode).toBe(202);
      expect(finished.json()).toEqual({ state: "done" });
      expect(server.store.snapshot("no_cursor").event.onboarding).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

const ignore = (): void => undefined;

const openAgain = () => {
  const settings = createCell<ReadonlyMap<string, string>>(new Map([[askedSetting, "true"]]));
  const state = createCell<Onboarding>({ state: "done" });
  const accounts = createCell<readonly string[]>(["icloud"]);
  const listeners = createCell<readonly (() => void)[]>([]);
  const caughtUp = createCell<readonly (readonly string[])[]>([]);
  const prompts = createCell<readonly string[]>([]);
  const tools = createCell<readonly Tool[]>([]);
  const gettingStarted = createGettingStarted({
    store: {
      onboarding: () => state.get(),
      setOnboarding: (next) => {
        state.set(next);
      },
      setting: (key) => settings.get().get(key),
      setSetting: (key, value) => {
        settings.update((current) => new Map([...current, [key, value]]));
      },
    },
    identifiers: { belief: () => `n_${String(prompts.get().length)}` },
    work: async (prompt) => {
      prompts.update((current) => [...current, prompt]);
      if (prompt.includes("believe")) {
        await tools.get()[0]?.call({ text: "You're training for a sub-20 5K.", page: "memory:now" });
      }
      return ok("Done.");
    },
    catchUp: (onProgress, only) => {
      caughtUp.update((current) => [...current, only]);
      onProgress(0, 12);
      return Promise.resolve(ok(undefined));
    },
    mailAccounts: () => accounts.get(),
    onSources: (listener) => {
      listeners.update((current) => [...current, listener]);
      return ignore;
    },
    onAdded: ignore,
    motionIds: () => ["job-search", "boiler"],
    info: ignore,
  });
  tools.set(gettingStarted.tools);
  const connect = (account: string): void => {
    accounts.update((current) => [...current, account]);
    for (const listener of listeners.get()) listener();
  };
  return { gettingStarted, state, caughtUp, prompts, connect };
};

describe("getting started again", () => {
  it("reads no mail again, names beliefs from memory and shows what's in motion now", async () => {
    const { gettingStarted, state, caughtUp, prompts } = openAgain();

    const again = gettingStarted.replay();

    expect(again).toEqual({ state: "reading" });
    await vi.waitFor(() => {
      expect(state.get().state).toBe("ready");
    });
    expect(caughtUp.get()).toEqual([]);
    expect(prompts.get()).toHaveLength(2);
    expect(state.get().proposal).toEqual({
      beliefs: [{ id: "n_2", text: "You're training for a sub-20 5K.", page: "memory:now" }],
      added: [],
      motions: ["job-search", "boiler"],
    });
    expect(gettingStarted.inMindText()).toContain("getting started again");
    expect(gettingStarted.replay()).toEqual(state.get());
  });

  it("catches up only on an account connected while it runs again", async () => {
    const { gettingStarted, state, caughtUp, connect } = openAgain();
    gettingStarted.replay();
    await vi.waitFor(() => {
      expect(state.get().state).toBe("ready");
    });

    connect("gmail");

    await vi.waitFor(() => {
      expect(caughtUp.get()).toEqual([["gmail"]]);
      expect(state.get().state).toBe("ready");
    });
    expect(state.get().proposal?.beliefs).toHaveLength(1);
    expect(gettingStarted.finish()).toEqual({ state: "done" });
    expect(gettingStarted.inMindText()).toBe("");
  });
});
