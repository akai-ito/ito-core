import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { weatherEveryMs, weatherUrl } from "#places/places.ts";
import { ok } from "#result.ts";
import { createServer, type EngineContext } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-places-"));
const token = "ito_places_test_not_a_real_token_000000000000000000000000";
const device = "5d1c7a3e-2b4f-4c6d-8e9f-0a1b2c3d4e5f";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const settle = async (rounds = 10): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

const rome = { latitude: 41.9, longitude: 12.5 };

// Rome's weather as Open-Meteo gives it, an hour ahead of UTC, with today's sunset at 16:58.
const forecast = (temperature: number, code: number) => ({
  utc_offset_seconds: 3600,
  current: { temperature_2m: temperature, weather_code: code, is_day: 1 },
  daily: { sunset: ["2026-11-14T16:58"] },
});

const open = async () => {
  const clock = createVirtualClock(Date.parse("2026-11-14T08:00:00.000Z"));
  const context = createCell<EngineContext | undefined>(undefined);
  const prompts = createCell<readonly string[]>([]);
  const answers = createCell<ReadonlyMap<string, unknown>>(new Map());
  const asked = createCell<readonly string[]>([]);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "places",
    clock,
    timeZone: "Europe/London",
    fetch: (url) => {
      asked.update((current) => [...current, url]);
      const answer = answers.get().get(url);
      return Promise.resolve(answer === undefined ? new Response("Busy", { status: 503 }) : Response.json(answer));
    },
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
          return Promise.resolve(ok("Nothing else needed moving."));
        },
      );
    },
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const report = async (body: unknown): Promise<number> => {
    const response = await server.app.inject({
      method: "PUT",
      url: `/v0/devices/${device}/whereabouts`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
    await settle();
    return response.statusCode;
  };
  const info = async (): Promise<unknown> => {
    const response = await server.app.inject({
      method: "GET",
      url: "/v0/server",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.json<unknown>();
  };
  const runUntil = async (time: number): Promise<void> => {
    if (clock.runNext(time)) {
      await settle();
      await runUntil(time);
      return;
    }
    clock.moveTo(time);
    await settle();
  };
  const answer = (url: string, body: unknown): void => {
    answers.update(
      (current) =>
        new Map([
          ...[...current].filter(([key]) => key !== url),
          ...(body === undefined ? [] : [[url, body] as const]),
        ]),
    );
  };
  return { server, clock, context, prompts, asked, report, info, runUntil, answer };
};

describe("where they roughly are", () => {
  it("keeps only the latest, rounded, and lives by its time zone", async () => {
    const { server, report, info, context } = await open();
    try {
      expect(await info()).toMatchObject({ time_zone: "Europe/London" });
      expect(await info()).not.toHaveProperty("whereabouts");
      expect(await report({ time_zone: "Mars/Olympus" })).toBe(400);
      expect(await report({ time_zone: "UTC+3" })).toBe(400);
      expect(await report({ time_zone: "Europe/Rome", area: { latitude: 41.902783, longitude: 12.496366 } })).toBe(204);

      expect(await info()).toMatchObject({
        time_zone: "Europe/Rome",
        whereabouts: {
          time_zone: "Europe/Rome",
          area: { latitude: 41.9, longitude: 12.5 },
          as_of: expect.any(String) as unknown,
        },
      });
      expect(context.get()?.inMind()).toContain("It's Saturday 14 November at 09:00 where they are (Europe/Rome).");
    } finally {
      await server.close();
    }
  });

  it("move repeating wake-ups to their time where they are, and wake Kumo to look at the rest", async () => {
    const { server, report, prompts } = await open();
    try {
      expect(await report({ time_zone: "Europe/London" })).toBe(204);
      await server.callTool("set_wake_up", {
        what: "Look at the day with them",
        why: "They asked for it each weekday.",
        repeat: { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" },
        asked: true,
        source: { kind: "chat", title: "Each weekday morning" },
      });
      await server.callTool("set_wake_up", {
        what: "Ask about the Halcyon offer",
        why: "They said they'd hear by Monday.",
        at: "2026-11-16T18:00:00Z",
        asked: false,
        source: { kind: "chat", title: "Halcyon offer" },
      });
      expect(prompts.get()).toEqual([]);

      expect(await report({ time_zone: "America/New_York" })).toBe(204);
      await settle();

      expect(server.store.desk().plans.map(({ what, at }) => [what, at])).toEqual([
        ["Look at the day with them", "2026-11-16T14:00:00.000Z"],
        ["Ask about the Halcyon offer", "2026-11-16T18:00:00.000Z"],
      ]);
      expect(prompts.get()).toHaveLength(1);
      expect(prompts.get()[0]).toContain("Their phone moved from Europe/London to America/New_York");
      expect(prompts.get()[0]).toContain("“Ask about the Halcyon offer” at Mon 16 Nov, 13:00");
    } finally {
      await server.close();
    }
  });
});

describe("the weather around them", () => {
  it("is read for their rough place, refreshed, kept through a blip, and gone without a place", async () => {
    const { server, report, answer, runUntil, clock, context, asked } = await open();
    try {
      expect(await report({ time_zone: "Europe/Rome" })).toBe(204);
      expect(server.store.desk().ambient).toBeUndefined();
      expect(asked.get()).toEqual([]);

      answer(weatherUrl(rome), forecast(17.4, 0));
      expect(await report({ time_zone: "Europe/Rome", area: { ...rome, name: "Rome" } })).toBe(204);

      expect(server.store.desk().ambient).toEqual({
        temperature: 17,
        condition: "clear",
        is_day: true,
        sunset: "2026-11-14T15:58:00.000Z",
        place: "Rome",
      });
      expect(context.get()?.inMind()).toContain("It's 17°C and clear in Rome; sunset 16:58.");

      answer(weatherUrl(rome), forecast(14.6, 63));
      await runUntil(clock.now() + weatherEveryMs);
      expect(server.store.desk().ambient).toMatchObject({ temperature: 15, condition: "rain" });

      answer(weatherUrl(rome), undefined);
      await runUntil(clock.now() + weatherEveryMs);
      expect(server.store.desk().ambient).toMatchObject({ temperature: 15 });
      await runUntil(clock.now() + 4 * weatherEveryMs);
      expect(server.store.desk().ambient).toBeUndefined();

      answer(weatherUrl(rome), forecast(12, 3));
      await runUntil(clock.now() + weatherEveryMs);
      expect(server.store.desk().ambient).toMatchObject({ condition: "cloudy" });
      expect(await report({ time_zone: "Europe/Rome" })).toBe(204);
      expect(server.store.desk().ambient).toBeUndefined();
      expect(asked.get().every((url) => url.startsWith("https://api.open-meteo.com/v1/forecast?latitude=41.9&"))).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
});
