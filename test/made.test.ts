import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { fixtureDirectory } from "#protocol/tools/transcript-files.ts";
import type { Event, MadeDetail, MadeList } from "#protocol/types.ts";
import { createServer, type EngineContext, type Server } from "#server.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-made-"));
const token = "ito_made_test_not_a_real_token_0000000000000000000000000000";
const photo = readFileSync(path.join(fixtureDirectory, "riverside.jpg"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

type Answer = { readonly status: number; readonly body: unknown };

type Opened = {
  readonly server: Server;
  readonly clock: VirtualClock;
  readonly context: () => EngineContext;
  readonly events: () => readonly Event[];
  readonly request: (method: "GET" | "PATCH", url: string, body?: unknown) => Promise<Answer>;
  readonly read: (url: string) => Promise<unknown>;
};

const open = (): Opened => {
  const clock = createVirtualClock(Date.parse("2026-11-21T10:00:00.000Z"));
  const context = createCell<EngineContext | undefined>(undefined);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "made",
    clock,
    timeZone: "Europe/London",
    fetch: () => Promise.resolve(new Response(new Uint8Array(photo), { headers: { "Content-Type": "image/jpeg" } })),
    createEngine: (given) => {
      context.set(given);
      return createScriptEngine(clock, () => {
        throw new Error("This test starts no turns.");
      });
    },
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  const events = createCell<readonly Event[]>([]);
  server.store.subscribe(({ event }) => {
    events.update((current) => [...current, event]);
  });
  const request = async (method: "GET" | "PATCH", url: string, body?: unknown): Promise<Answer> => {
    const response = await server.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { "content-type": "application/merge-patch+json" }),
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: response.json<unknown>() };
  };
  const found = context.get();
  if (!found) throw new Error("The engine never started.");
  const read = async (url: string): Promise<unknown> => {
    const answer = await request("GET", url);
    return answer.body;
  };
  return { server, clock, context: () => found, events: () => events.get(), request, read };
};

const keep = async (server: Server): Promise<string> => {
  const kept = await server.callTool("keep_image", { url: "https://photos.example.org/v-and-a-dome.jpg" });
  return String(kept.structured?.attachment);
};

const picture = (attachment: string) => ({
  attachment,
  alt: "The V&A's dome from Cromwell Road",
  source_url: "https://commons.example.org/wiki/File:V_and_A_dome.jpg",
  credit: "Photo by A. Example, CC BY-SA 4.0",
});

const guide = (cover: string) => ({
  intro: [
    "Two hours, four rooms, in walking order from the Cromwell Road door.",
    "",
    "```ari:place",
    JSON.stringify({ name: "The V&A", address: "Cromwell Road, London", note: "open till 17:45" }),
    "```",
  ].join("\n"),
  check: "Spotted",
  sections: [
    {
      id: "cast-courts",
      title: "Cast Courts",
      detail: "Room 46a–b · 25 min",
      image: picture(cover),
      items: [
        { id: "trajans-column", title: "Trajan's Column", detail: "Cut in two to fit under the roof." },
        { id: "fig-leaf", title: "David's fig leaf", detail: "It hangs in a case behind him." },
      ],
    },
    {
      id: "raphael-cartoons",
      title: "Raphael Cartoons",
      detail: "Room 48a · 15 min",
      items: [{ id: "miraculous-draught", title: "The Miraculous Draught of Fishes" }],
    },
    { id: "halfway", title: "Halfway", numbered: false, text: "Coffee in the Morris Room." },
  ],
});

const makeGuide = async (server: Server, cover: string) =>
  server.callTool("make_made_page", {
    id: "va-guide",
    title: "Your guide to the V&A",
    summary: "3 rooms · 3 things to spot",
    for_day: "2026-11-22",
    cover: picture(cover),
    content: guide(cover),
  });

describe("pages Kumo makes", () => {
  it("makes a page that the shelf lists, with its content, no ticks and its first change", async () => {
    const { server, read, events } = open();
    const cover = await keep(server);

    const made = await makeGuide(server, cover);
    const shelf = (await read("/v0/made")) as MadeList;
    const detail = (await read("/v0/made/va-guide")) as MadeDetail;
    await server.close();

    expect(made.isError).toBeUndefined();
    expect(made.text).toContain('```ari:made\n{"made":"va-guide"}\n```');
    expect(shelf.made).toEqual([
      expect.objectContaining({ id: "va-guide", title: "Your guide to the V&A", version: 1, for_day: "2026-11-22" }),
    ]);
    // Made in the main chat: "From your chat", with no thread.
    expect(shelf.made[0]?.thread).toBeUndefined();
    expect(detail.content).toEqual(guide(cover));
    expect(detail.state).toEqual({});
    expect(detail.changes).toEqual([expect.objectContaining({ version: 1, note: "Made it" })]);
    expect(events().map(({ type }) => type)).toContain("made.created");
  });

  it("remembers the side thread it was made in, through every change, so the page links back to it", async () => {
    const { server, read } = open();
    const cover = await keep(server);

    await server.callTool(
      "make_made_page",
      { id: "va-guide", title: "Your guide to the V&A", summary: "3 rooms", content: guide(cover) },
      undefined,
      "h_va_guide",
    );
    await server.callTool("change_made_page", { id: "va-guide", version: 1, summary: "4 rooms", note: "A room more" });
    const shelf = (await read("/v0/made")) as MadeList;
    await server.close();

    expect(shelf.made).toEqual([expect.objectContaining({ id: "va-guide", version: 2, thread: "h_va_guide" })]);
  });

  it("refuses a page whose pictures, ids or blocks the phone couldn't show", async () => {
    const { server } = open();
    const cover = await keep(server);
    const content = guide(cover);

    const unkept = await makeGuide(server, "f_not_kept");
    const twice = await server.callTool("make_made_page", {
      id: "twice",
      title: "Twice",
      summary: "",
      content: { sections: [{ id: "a", title: "A", items: [{ id: "a", title: "Also A" }] }] },
    });
    const badBlock = await server.callTool("make_made_page", {
      id: "bad-block",
      title: "Bad block",
      summary: "",
      content: { ...content, intro: '```ari:weather\n{"sky": "clear"}\n```' },
    });
    await makeGuide(server, cover);
    const again = await makeGuide(server, cover);
    await server.close();

    expect([unkept.isError, unkept.text.includes("keep it with keep_image")]).toEqual([true, true]);
    expect([twice.isError, twice.text.includes("The id a is used twice")]).toEqual([true, true]);
    expect([badBlock.isError, badBlock.text.includes("ari:weather")]).toEqual([true, true]);
    expect([again.isError, again.text.includes("change_made_page")]).toEqual([true, true]);
  });

  it("takes your ticks from any device, once, and only for its items", async () => {
    const { server, request, events } = open();
    await makeGuide(server, await keep(server));
    const at = "2026-11-22T14:32:00.000Z";

    const ticked = await request("PATCH", "/v0/made/va-guide/state", {
      ticks: { "trajans-column": at },
    });
    const repeated = await request("PATCH", "/v0/made/va-guide/state", {
      ticks: { "trajans-column": at },
    });
    const unknown = await request("PATCH", "/v0/made/va-guide/state", { ticks: { "the-moon": at } });
    const untimed = await request("PATCH", "/v0/made/va-guide/state", { ticks: { "fig-leaf": true } });
    const missing = await request("PATCH", "/v0/made/no-such-page/state", { ticks: {} });
    const untick = await request("PATCH", "/v0/made/va-guide/state", {
      ticks: { "trajans-column": null },
    });
    await server.close();

    expect(ticked).toEqual({ status: 200, body: { state: { ticks: { "trajans-column": at } } } });
    expect(repeated.body).toEqual(ticked.body);
    expect(unknown.status).toBe(400);
    expect(untimed.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(untick.body).toEqual({ state: {} });
    expect(events().filter(({ type }) => type === "made.state")).toHaveLength(2);
  });

  it("keeps a page current from the version Kumo read, saying what changed and letting go of gone ticks", async () => {
    const { server, request, read, events } = open();
    const cover = await keep(server);
    await makeGuide(server, cover);
    await request("PATCH", "/v0/made/va-guide/state", {
      ticks: { "trajans-column": "2026-11-22T14:32:00.000Z", "miraculous-draught": "2026-11-22T14:50:00.000Z" },
    });
    const content = guide(cover);
    const closed = { ...content, sections: content.sections.filter(({ id }) => id !== "raphael-cartoons") };
    const note = "The Raphael Cartoons are closed today, so they're out.";

    const stale = await server.callTool("change_made_page", { id: "va-guide", version: 2, content: closed, note });
    const changed = await server.callTool("change_made_page", {
      id: "va-guide",
      version: 1,
      summary: "2 rooms · 2 things to spot",
      content: closed,
      note,
    });
    const readBack = await server.callTool("read_made_page", { id: "va-guide" });
    const detail = (await read("/v0/made/va-guide")) as MadeDetail;
    await server.close();

    expect([stale.isError, stale.text.includes("at version 1 now")]).toEqual([true, true]);
    expect(changed.text).toBe("Saved Your guide to the V&A, now at version 2.");
    expect(detail.made).toMatchObject({
      version: 2,
      summary: "2 rooms · 2 things to spot",
      cover: picture(cover),
    });
    expect(detail.changes.map(({ note: said }) => said)).toEqual([note, "Made it"]);
    expect(detail.state).toEqual({ ticks: { "trajans-column": "2026-11-22T14:32:00.000Z" } });
    expect(readBack.text).toContain("Spotted: trajans-column at Sun 14:32.");
    expect(events().map(({ type }) => type)).toEqual(
      expect.arrayContaining(["made.created", "made.state", "made.changed"]),
    );
  });

  it("keeps the pages that are still live in Kumo's mind, with how far along they are", async () => {
    const { server, request, context, clock } = open();
    const cover = await keep(server);
    await makeGuide(server, cover);
    await request("PATCH", "/v0/made/va-guide/state", {
      ticks: { "fig-leaf": "2026-11-22T14:38:00.000Z" },
    });

    const before = context().inMind();
    clock.moveTo(Date.parse("2026-11-23T09:00:00.000Z"));
    const after = context().inMind();
    await server.close();

    expect(before).toContain(
      "- Your guide to the V&A (va-guide, for Sunday 22 Nov): 3 rooms · 3 things to spot; 1 of 3 spotted",
    );
    expect(after).not.toContain("<made_pages>");
  });

  it("forgets a page only when you allow it", async () => {
    const { server, read } = open();
    await makeGuide(server, await keep(server));

    const kept = await server.callTool("forget_made_page", { id: "va-guide", reason: "The visit's done" });
    const shelf = (await read("/v0/made")) as MadeList;
    await server.close();

    expect(kept.text).toBe("They kept Your guide to the V&A, so nothing was forgotten.");
    expect(shelf.made).toHaveLength(1);
  });
});
