import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isFullAccess } from "#access/access.ts";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { ok } from "#result.ts";
import { createServer, type EngineContext } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-access-"));
const token = "ito_access_test_not_a_real_token_000000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const open = async () => {
  const clock = createVirtualClock(Date.parse("2026-11-27T14:02:00.000Z"));
  const context = createCell<EngineContext | undefined>(undefined);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "access",
    clock,
    timeZone: "Europe/London",
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
        () => Promise.resolve(ok("Done.")),
      );
    },
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  await server.app.ready();
  const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) => {
    const response = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload && { payload }),
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  };
  const inMind = (): string => context.get()?.inMind() ?? "";
  const isFull = (): boolean => isFullAccess((key) => server.store.setting(key));
  return { server, clock, call, inMind, isFull };
};

describe("full access", () => {
  it("is off until it's turned on, and only with a body that says so", async () => {
    const { server, call, isFull } = await open();

    const read = await call("GET", "/v0/access");
    const bare = await call("POST", "/v0/access/full");
    const empty = await call("POST", "/v0/access/full", {});
    const unmeant = await call("POST", "/v0/access/full", { confirm: false });

    expect(read).toEqual({ status: 200, body: { mode: "sandboxed" } });
    expect([bare.status, empty.status, unmeant.status]).toEqual([400, 400, 400]);
    expect(isFull()).toBe(false);
    expect(server.store.access()).toEqual({ mode: "sandboxed" });
    await server.close();
  });

  it("goes on from the next turn, tells Kumo what it means, and notes it in Kumo's work once", async () => {
    const { server, call, inMind, isFull } = await open();

    const given = await call("POST", "/v0/access/full", { confirm: true });
    const again = await call("POST", "/v0/access/full", { confirm: true });

    expect(given).toEqual({ status: 200, body: { mode: "full", since: "2026-11-27T14:02:00.000Z" } });
    expect(again).toEqual(given);
    expect(isFull()).toBe(true);
    expect(inMind()).toContain("<access>\nFull access is on since Friday 27 November at 14:02");
    expect(inMind()).toContain("Ito's own checkout at ");
    expect(server.store.snapshot("no_cursor").event).toMatchObject({
      access: { mode: "full", since: "2026-11-27T14:02:00.000Z" },
    });
    const work = await call("GET", "/v0/work");
    expect(work.body.handled).toEqual([
      expect.objectContaining({
        text: "Full access on: Kumo runs without its sandbox from its next turn",
        reason: "You turned it on in Settings",
        undo: false,
        quiet: false,
      }),
    ]);
    await server.close();
  });

  it("goes off again from the next turn, safely repeated, leaving nothing in mind or in the snapshot", async () => {
    const { server, call, inMind, isFull } = await open();
    await call("POST", "/v0/access/full", { confirm: true });

    const ended = await call("DELETE", "/v0/access/full");
    const again = await call("DELETE", "/v0/access/full");

    expect(ended).toEqual({ status: 200, body: { mode: "sandboxed" } });
    expect(again).toEqual(ended);
    expect(isFull()).toBe(false);
    expect(inMind()).not.toContain("<access>");
    expect(server.store.snapshot("no_cursor").event).not.toHaveProperty("access");
    const work = await call("GET", "/v0/work");
    expect((work.body.handled as readonly { readonly text: string }[]).map(({ text }) => text)).toEqual([
      "Full access off: Kumo's back in its sandbox from its next turn",
      "Full access on: Kumo runs without its sandbox from its next turn",
    ]);
    await server.close();
  });
});
