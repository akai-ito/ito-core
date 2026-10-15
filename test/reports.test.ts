import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toTurnId } from "#conversation/ids.ts";
import type { ToolServer } from "#engine/engine.ts";
import { demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { toFingerprint, type Gap } from "#reports/gap.ts";
import { createGitHub } from "#reports/github.ts";
import { createReporter, reportsTokenSetting, type Reporter } from "#reports/reporter.ts";
import { createServer, type Server } from "#server.ts";
import type { Settings } from "#store/store.ts";
import { startFakeGitHub, type FakeGitHub } from "./support/fake-github.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-reports-"));
const github = createCell<FakeGitHub | undefined>(undefined);

const parkrun: Gap = {
  capability: "web search",
  operation: "open a page",
  tried: "Opened the parkrun event page to read the start time",
  failed: "The page answered 403 to every fetch",
  wouldHelp: "A browser that can load pages behind bot protection",
};

const statusOf = async (response: Promise<Response>): Promise<number> => {
  const { status } = await response;
  return status;
};

const currentGitHub = (): FakeGitHub => {
  const current = github.get();
  if (!current) throw new Error("No fake GitHub is running.");
  return current;
};

const createMemorySettings = (values: ReadonlyMap<string, string> = new Map()): Settings => {
  const current = createCell(values);
  return {
    setting: (key) => current.get().get(key),
    setSetting: (key, value) => {
      current.set(new Map([...current.get(), [key, value]]));
    },
  };
};

const createTestReporter = (
  settings: Settings,
  dailyLimit = 20,
): { readonly reporter: Reporter; readonly logged: () => readonly string[] } => {
  const logged = createCell<readonly string[]>([]);
  const fake = currentGitHub();
  const reporter = createReporter({
    settings,
    clock: createVirtualClock(Date.parse("2026-10-15T12:00:00.000Z")),
    info: (message) => {
      logged.set([...logged.get(), message]);
    },
    versions: { ito: "0.2.0", codex: "0.162.1" },
    connect: (token) =>
      createGitHub({ apiUrl: fake.apiUrl, repository: fake.repository, token, userAgent: "ito/test" }),
    dailyLimit,
  });
  return { reporter, logged: () => logged.get() };
};

describe("gap reports", () => {
  beforeAll(async () => {
    github.set(await startFakeGitHub());
  });

  afterAll(async () => {
    await github.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("opens a labelled issue from the template, then adds to it when the gap comes back", async () => {
    const fake = currentGitHub();
    const { reporter } = createTestReporter(createMemorySettings(new Map([[reportsTokenSetting, fake.token]])));
    const opened = await reporter.report(toTurnId("t_one"), parkrun);
    expect(opened).toEqual({
      ok: true,
      value: { url: `https://github.com/${fake.repository}/issues/1`, action: "opened" },
    });
    const [issue] = fake.issues();
    expect(issue?.title).toBe("Gap: web search · open a page");
    expect(issue?.labels).toEqual(["gap"]);
    expect(issue?.body.split("\n")).toEqual([
      "Ari hit a gap and reported it.",
      "",
      "**Capability:** web search",
      "**Operation:** open a page",
      "**Tried:** Opened the parkrun event page to read the start time",
      "**Failed:** The page answered 403 to every fetch",
      "**Would have helped:** A browser that can load pages behind bot protection",
      "",
      "Ito 0.2.0 · Codex 0.162.1",
      "",
      `Fingerprint: ${toFingerprint(parkrun)}`,
    ]);

    const repeated = await reporter.report(toTurnId("t_one"), { ...parkrun, tried: "Opened it again" });
    expect(repeated).toEqual(opened);
    expect(fake.issues()[0]?.comments).toEqual([]);

    const later = await reporter.report(toTurnId("t_two"), {
      ...parkrun,
      wouldHelp: " a browser that can load  pages behind bot protection ",
    });
    expect(later).toMatchObject({ ok: true, value: { action: "commented" } });
    expect(later.ok && later.value.url).toMatch(/\/issues\/1#issuecomment-\d+$/u);
    expect(fake.issues()).toHaveLength(1);
    expect(fake.issues()[0]?.comments).toEqual([
      "Hit again.\n\n**Tried:** Opened the parkrun event page to read the start time\n**Failed:** The page answered 403 to every fetch\n\nIto 0.2.0 · Codex 0.162.1",
    ]);
  });

  it("says plainly when reporting isn't set up, or GitHub refuses", async () => {
    const unset = createTestReporter(createMemorySettings());
    expect(await unset.reporter.report(toTurnId("t_three"), parkrun)).toEqual({
      ok: false,
      failure: "Reporting isn't set up on this server yet: run ito reports token there.",
    });
    const refused = createTestReporter(createMemorySettings(new Map([[reportsTokenSetting, "github_pat_wrong"]])));
    expect(await refused.reporter.report(toTurnId("t_three"), parkrun)).toEqual({
      ok: false,
      failure: "GitHub answered 401: Bad credentials.",
    });
  });

  it("keeps reports past the daily limit in the log", async () => {
    const fake = currentGitHub();
    const { reporter, logged } = createTestReporter(
      createMemorySettings(new Map([[reportsTokenSetting, fake.token]])),
      2,
    );
    const turn = toTurnId("t_four");
    const gaps = ["maps", "trains", "weather"].map((need) => ({ ...parkrun, wouldHelp: `A ${need} source` }));
    const outcomes = await Promise.all(gaps.map((gap) => reporter.report(turn, gap)));
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false]);
    expect(outcomes[2]).toEqual({
      ok: false,
      failure: "Today's 2 reports are used up, so this one went to the server log.",
    });
    expect(logged()).toEqual(["A gap report went to the log instead, past today's limit"]);
  });
});

describe("Ito's tools over MCP", () => {
  const server = createCell<Server | undefined>(undefined);
  const tools = createCell<(() => ToolServer | undefined) | undefined>(undefined);

  const toolServer = (): ToolServer => {
    const current = tools.get()?.();
    if (!current) throw new Error("The tool server isn't listening.");
    return current;
  };

  const post = async (body: unknown, token = toolServer().token): Promise<Response> =>
    fetch(toolServer().url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const rpc = async (method: string, parameters?: unknown): Promise<unknown> => {
    const response = await post({ jsonrpc: "2.0", id: 1, method, params: parameters });
    return response.json();
  };

  beforeAll(async () => {
    const fake = await startFakeGitHub();
    github.set(fake);
    const started = createServer({
      dataDirectory: path.join(home, "server"),
      name: "test",
      createEngine: (context) => {
        tools.set(context.tools);
        return createScriptEngine(systemClock, demoScripts);
      },
      reports: { apiUrl: fake.apiUrl },
    });
    await started.app.listen({ host: "127.0.0.1", port: 0 });
    server.set(started);
  });

  afterAll(async () => {
    await server.get()?.close();
    await github.get()?.close();
  });

  it("answers only the session's token, and lists Ito's tools", async () => {
    expect(await statusOf(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ito_wrong"))).toBe(401);
    expect(await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ito" } },
    });
    expect(await statusOf(post({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBe(202);
    expect(await rpc("tools/list")).toMatchObject({ result: { tools: [{ name: "report_gap" }, { name: "ask" }] } });
    const { url } = toolServer();
    expect(await statusOf(fetch(url))).toBe(405);
    expect(await rpc("resources/list")).toMatchObject({ error: { code: -32_601 } });
  });

  it("files a report through the tool once a token is set", async () => {
    const fake = currentGitHub();
    const report = {
      name: "report_gap",
      arguments: {
        capability: parkrun.capability,
        operation: parkrun.operation,
        tried: parkrun.tried,
        failed: parkrun.failed,
        would_help: parkrun.wouldHelp,
      },
    };
    expect(await rpc("tools/call", report)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: "Reporting isn't set up on this server yet: run ito reports token there." }],
      },
    });
    expect(await rpc("tools/call", { name: "report_gap", arguments: { capability: "web search" } })).toMatchObject({
      result: { isError: true, content: [{ text: "A report needs operation, tried, failed, would_help." }] },
    });
    server.get()?.store.setSetting(reportsTokenSetting, fake.token);
    const url = `https://github.com/${fake.repository}/issues/1`;
    expect(await rpc("tools/call", report)).toMatchObject({
      result: {
        isError: false,
        content: [{ type: "text", text: `Reported as a new issue: ${url}` }],
        structuredContent: { url, action: "opened" },
      },
    });
  });
});
