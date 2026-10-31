import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { JobList } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-jobs-"));
const token = "ito_jobs_test_not_a_real_token_000000000000000000000000";

type Ran = { readonly prompt: string };

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const setUp = () => {
  const dataDirectory = mkdtempSync(path.join(home, "server-"));
  const clock = createVirtualClock(Date.parse("2026-10-31T09:00:00.000Z"));
  const ran = createCell<readonly Ran[]>([]);
  const open = async (): Promise<Server> => {
    const server = createServer({
      embedder: wordEmbedder,
      dataDirectory,
      name: "jobs",
      clock,
      timeZone: "UTC",
      createEngine: () =>
        createScriptEngine(
          clock,
          () => {
            throw new Error("This test starts no turns.");
          },
          undefined,
          undefined,
          undefined,
          (prompt) => {
            ran.update((current) => [...current, { prompt }]);
            return Promise.resolve(ok("Done."));
          },
        ),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    return server;
  };
  const runUntil = (time: string): void => {
    if (clock.runNext(Date.parse(time))) runUntil(time);
    else clock.moveTo(Date.parse(time));
  };
  return { open, ran, runUntil };
};

const listJobs = async (server: Server): Promise<{ status: number } & Partial<JobList>> => {
  const response = await server.app.inject({
    method: "GET",
    url: "/v0/jobs",
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.statusCode, ...response.json<Partial<JobList>>() };
};

describe("Kumo's standing jobs", () => {
  it("runs a follow-up once and a standing job every week, across a restart", async () => {
    const { open, ran, runUntil } = setUp();
    const first = await open();

    const followUp = await first.callTool("schedule", {
      why: "Ask how the QRT interview went",
      at: "2026-11-01T18:00:00Z",
    });
    const standing = await first.callTool("schedule", {
      why: "Look for startups you'd join",
      standing: { ask: "startups I'd join" },
    });
    const whenever = await first.callTool("schedule", { why: "Someday" });
    const local = await first.callTool("schedule", { why: "Someday", at: "2026-11-01T18:00" });
    const listed = await listJobs(first);

    expect(followUp.text).toMatch(/^Scheduled j_\w+, at 2026-11-01T18:00:00\.000Z\.$/u);
    expect(standing.text).toMatch(/^Scheduled j_\w+, every 7 days, next at 2026-11-07T09:00:00\.000Z\.$/u);
    expect(whenever).toEqual({ text: "Say when: at a time, after_event, or as a standing job.", isError: true });
    expect(local).toEqual({
      text: "2026-11-01T18:00 isn't an ISO time with its offset, such as 2026-11-03T18:00:00Z.",
      isError: true,
    });
    expect(listed).toMatchObject({
      status: 200,
      jobs: [
        { why: "Ask how the QRT interview went", at: "2026-11-01T18:00:00.000Z" },
        { standing: { ask: "startups I'd join" }, at: "2026-11-07T09:00:00.000Z" },
      ],
    });

    runUntil("2026-11-02T00:00:00.000Z");
    await vi.waitFor(async () => {
      await expect(listJobs(first)).resolves.toMatchObject({ jobs: [{ at: "2026-11-07T09:00:00.000Z" }] });
    });

    expect(ran.get()).toHaveLength(1);
    expect(ran.get()[0]?.prompt).toContain(
      "It's time for a look you scheduled for yourself: “Ask how the QRT interview went”.",
    );
    expect(ran.get()[0]?.prompt).toContain("call schedule again for a better time");

    runUntil("2026-11-07T09:00:00.000Z");
    await vi.waitFor(async () => {
      await expect(listJobs(first)).resolves.toMatchObject({ jobs: [{ at: "2026-11-14T09:00:00.000Z" }] });
    });
    await first.close();

    expect(ran.get()[1]?.prompt).toContain(
      "It's a standing job: you keep looking for startups I'd join, every 7 days.",
    );

    const second = await open();
    try {
      const reloaded = await listJobs(second);
      runUntil("2026-11-14T09:00:00.000Z");
      await vi.waitFor(() => {
        expect(ran.get()).toHaveLength(3);
      });
      const id = reloaded.jobs?.[0]?.id ?? "";
      const cancelled = await second.callTool("cancel", { id });

      expect(reloaded.jobs).toMatchObject([{ why: "Look for startups you'd join", at: "2026-11-14T09:00:00.000Z" }]);
      expect(cancelled).toEqual({ text: `Cancelled ${id}: Look for startups you'd join.` });
      expect(await listJobs(second)).toEqual({ status: 200, jobs: [] });
    } finally {
      await second.close();
    }
  });

  it("checks in once the event it waited for ends", async () => {
    const { open, ran } = setUp();
    const server = await open();
    try {
      const scheduled = await server.callTool("schedule", {
        why: "Ask how the dentist went",
        after_event: { uid: "dentist-1", title: "Dentist" },
      });
      server.jobs.onEventEnded("someone-elses-event");
      server.jobs.onEventEnded("dentist-1");
      await vi.waitFor(async () => {
        await expect(listJobs(server)).resolves.toEqual({ status: 200, jobs: [] });
      });

      expect(scheduled.text).toMatch(/^Scheduled j_\w+, after Dentist\.$/u);
      expect(ran.get()).toHaveLength(1);
      expect(ran.get()[0]?.prompt).toContain("It was for after Dentist, which has ended.");
    } finally {
      await server.close();
    }
  });
});
