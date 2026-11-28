import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { toMessageId, toThreadId, type MessageId } from "#conversation/ids.ts";
import type { Complete } from "#engine/engine.ts";
import { createQuickChoice, type QuickChoice } from "#engine/quick-model.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Attachment } from "#protocol/types.ts";
import { fail, ok } from "#result.ts";
import { createServer } from "#server.ts";
import { previewLink, readPage } from "#shares/link.ts";
import { toSaid } from "#shares/said.ts";
import { createShares, sortSchema, type Shares } from "#shares/shares.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Store } from "#store/store.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-shares-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const info = (): void => undefined;

const openStore = (name: string): Store =>
  createStore(openDatabase(path.join(home, `${name}.db`)), systemClock, randomIdentifiers);

const page = (head: string): string => `<!doctype html><html><head>${head}</head><body><p>Hi</p></body></html>`;

const htmlFetch =
  (html: string, contentType = "text/html; charset=utf-8"): Fetch =>
  () =>
    Promise.resolve(new Response(html, { headers: { "content-type": contentType } }));

const photo = (id: string): Attachment => ({
  id,
  kind: "image",
  name: "screenshot.png",
  media_type: "image/png",
  size: 4,
});

const saveAttachment = (store: Store, attachment: Attachment): void => {
  const saved = store.saveAttachment(attachment, `sha-${attachment.id}`);
  if (!saved.ok) throw new Error(saved.failure);
};

type Asked = { readonly prompt: string; readonly images: readonly string[]; readonly needsImages: boolean };

// A sorter over a real store, with Kumo's answer given, and what it was asked and routed kept.
const sorter = (store: Store, answer: Awaited<ReturnType<Complete>>, fetcher: Fetch = htmlFetch(page(""))) => {
  const asked = createCell<readonly Asked[]>([]);
  const routed = createCell<readonly { readonly message: MessageId; readonly text: string }[]>([]);
  const needs = createCell(false);
  const quickChoice: QuickChoice = (wanted) => {
    needs.set(wanted?.images ?? false);
    return Promise.resolve({ model: "luna", effort: "low" });
  };
  const complete: Complete = (prompt, schema, _choice, images = []) => {
    expect(schema).toBe(sortSchema);
    asked.update((current) => [...current, { prompt, images, needsImages: needs.get() }]);
    return Promise.resolve(answer);
  };
  const shares: Shares = createShares({
    store,
    fetch: fetcher,
    complete,
    quickChoice,
    attachmentPath: (id) => `/attachments/${id}`,
    spoken: (at) => at,
    route: (message, text) => {
      routed.update((current) => [...current, { message, text }]);
    },
    info,
  });
  return { shares, asked, routed };
};

describe("a shared link's page", () => {
  it("is read from its Open Graph tags first, then the usual ones, in plain words", () => {
    expect(
      readPage(
        page(
          "<title>Ignored | Site</title>" +
            '<meta property="og:title" content="  Platform   Engineer &amp; SRE ">' +
            '<meta name="description" content="Build what every team ships on.">' +
            '<meta property="og:site_name" content="Halcyon Careers">',
        ),
      ),
    ).toEqual({
      title: "Platform Engineer & SRE",
      description: "Build what every team ships on.",
      site: "Halcyon Careers",
    });
    expect(readPage(page("<title>\n  Kiln, Soho\n</title>"))).toEqual({ title: "Kiln, Soho" });
    const long = page(`<meta property="og:description" content="${"word ".repeat(200)}">`);
    expect(readPage(long).description).toHaveLength(400);
  });

  it("keeps the link with its host when the page isn't HTML, can't be fetched, or isn't on the web", async () => {
    const url = "https://www.kiln.example/menu.pdf";
    expect(await previewLink(url, htmlFetch("%PDF", "application/pdf"))).toEqual({ url, site: "kiln.example" });
    expect(await previewLink(url, () => Promise.reject(new Error("offline")))).toEqual({ url, site: "kiln.example" });
    const gone = page("<title>Gone</title>");
    expect(await previewLink(url, () => Promise.resolve(new Response(gone, { status: 404 })))).toEqual({
      url,
      site: "kiln.example",
    });
    const kiln = htmlFetch(page("<title>Kiln</title>"));
    expect(await previewLink("https://kiln.example/", kiln)).toEqual({
      url: "https://kiln.example/",
      title: "Kiln",
      site: "kiln.example",
    });
  });
});

describe("what Kumo reads of a share", () => {
  it("says it came from the share sheet, with the link, its page, the text and the note", () => {
    expect(
      toSaid("Worth a look?", {
        link: { url: "https://kiln.example/", title: "Kiln", site: "kiln.example", description: "Thai grill." },
        text: "Clay pot noodles\nLaab",
      }),
    ).toBe(
      [
        "(Shared from their phone's share sheet.)",
        "Link: https://kiln.example/",
        "Its page: “Kiln” (kiln.example): Thai grill.",
        "Text they shared:",
        "> Clay pot noodles",
        "> Laab",
        "Their note: Worth a look?",
      ].join("\n"),
    );
    expect(toSaid("", {})).toBe("(Shared from their phone's share sheet.)");
    expect(toSaid("Just a message", undefined)).toBe("Just a message");
  });
});

describe("the model that sorts a share", () => {
  it("is the quick one thinking least, or the default one when only that can see a screenshot", async () => {
    const blind = demoModels.map((model) => (model.id.includes("luna") ? { ...model, images: false } : model));
    const quick = createQuickChoice(() => Promise.resolve(ok(blind)));

    expect(await quick()).toEqual({ model: "gpt-6-luna", effort: "low" });
    expect(await quick({ images: true })).toEqual({ model: "gpt-6.1-sol", effort: "low" });
  });
});

describe("shares in the store", () => {
  it("are accepted once per id: the same share again changes nothing, and anything different is a conflict", () => {
    const store = openStore("accept");
    const id = toMessageId("2f1c0b8e-3a5d-4e6f-9a7b-1c2d3e4f5a6b");
    const first = store.acceptShare(id, { url: "https://kiln.example/", note: "Friday?", attachments: [] });
    const again = store.acceptShare(id, { note: "Friday?", url: "https://kiln.example/", attachments: [] });
    const different = store.acceptShare(id, { url: "https://kiln.example/", note: "Saturday?", attachments: [] });

    expect(first).toMatchObject({ ok: true, value: { isNew: true, share: { id } } });
    expect(again).toMatchObject({ ok: true, value: { isNew: false } });
    expect(different).toEqual({ ok: false, failure: "id_conflict" });
    expect(store.unplacedShares().map((share) => share.id)).toEqual([id]);
  });

  it("refuses an id a message has, and attachments that aren't there or belong to something else", () => {
    const store = openStore("refuse");
    const sent = store.acceptMessage(toMessageId("m_1"), "Morning", []);
    expect(sent.ok).toBe(true);
    saveAttachment(store, photo("f_1"));
    const taken = store.acceptMessage(toMessageId("m_2"), "", ["f_1"]);
    expect(taken.ok).toBe(true);
    saveAttachment(store, photo("f_2"));

    expect(store.acceptShare(toMessageId("m_1"), { note: "Hi", attachments: [] })).toEqual({
      ok: false,
      failure: "id_conflict",
    });
    expect(store.acceptShare(toMessageId("s_1"), { attachments: ["f_9"] })).toEqual({
      ok: false,
      failure: "unknown_attachment",
    });
    expect(store.acceptShare(toMessageId("s_2"), { attachments: ["f_1"] })).toEqual({
      ok: false,
      failure: "attachment_taken",
    });
    expect(store.acceptShare(toMessageId("s_3"), { attachments: ["f_2"] }).ok).toBe(true);
    // The share holds its photo until it's placed: no message takes it, and it isn't swept.
    expect(store.acceptMessage(toMessageId("m_3"), "", ["f_2"])).toEqual({ ok: false, failure: "attachment_taken" });
    expect(store.acceptShare(toMessageId("s_4"), { attachments: ["f_2"] })).toEqual({
      ok: false,
      failure: "attachment_taken",
    });
    expect(store.unattachedBefore("9999-01-01T00:00:00.000Z")).not.toContain("f_2");
  });

  it("become your message under the share's id, once, in a thread there is or a new one", () => {
    const store = openStore("place");
    const open = store.startThread("kumo", "Halcyon role");
    const done = store.startThread("kumo", "Old trip");
    store.changeThread(toThreadId(done.id), { by: "kumo", state: "done" });
    for (const id of ["s_1", "s_2", "s_3"]) {
      store.acceptShare(toMessageId(id), { note: `Note ${id}`, attachments: [] });
    }
    const link = { link: { url: "https://halcyon.example/jobs/1", title: "Platform Engineer" } };

    const joined = store.placeShare(toMessageId("s_1"), link, { thread: toThreadId(open.id) });
    const again = store.placeShare(toMessageId("s_1"), link, { title: "Something else" });
    const started = store.placeShare(toMessageId("s_2"), {}, { title: "Dentist check-up" });
    const fromDone = store.placeShare(toMessageId("s_3"), {}, { thread: toThreadId(done.id) });

    expect(joined).toMatchObject({
      ok: true,
      value: { isNew: true, message: { id: "s_1", role: "user", text: "Note s_1", thread: open.id, share: link } },
    });
    expect(again).toMatchObject({ ok: true, value: { isNew: false, message: { thread: open.id } } });
    const startedThread = started.ok ? store.findThread(toThreadId(started.value.message.thread ?? "")) : undefined;
    expect(startedThread).toMatchObject({ title: "Dentist check-up", by: "kumo", state: "open", replies: 1 });
    const fromDoneThread = fromDone.ok ? fromDone.value.message.thread : undefined;
    expect(fromDoneThread).not.toBe(done.id);
    expect(store.findThread(toThreadId(fromDoneThread ?? ""))?.title).toBeUndefined();
    expect(store.unplacedShares()).toEqual([]);
    expect(store.findShare(toMessageId("s_1"))?.placed).toEqual({ thread: open.id });
    expect(store.messageText(toMessageId("s_1"))).toBe(
      [
        "(Shared from their phone's share sheet.)",
        "Link: https://halcyon.example/jobs/1",
        "Its page: “Platform Engineer”",
        "Their note: Note s_1",
      ].join("\n"),
    );
  });
});

describe("sorting a share", () => {
  it("joins the open thread Kumo says it belongs to, and that thread's conversation answers it", async () => {
    const store = openStore("join");
    const role = store.startThread("kumo", "Halcyon role");
    store.postMessage("Sam wrote back about the platform team.", { thread: toThreadId(role.id) });
    const html = page(
      '<meta property="og:title" content="Platform Engineer"><meta property="og:site_name" content="Halcyon">',
    );
    const { shares, asked, routed } = sorter(store, ok({ thread: role.id, title: "" }), htmlFetch(html));
    const id = toMessageId("s_join");

    const accepted = shares.accept(id, { url: "https://halcyon.example/jobs/1", note: "This one", attachments: [] });
    expect(accepted).toMatchObject({ ok: true, value: { isNew: true, share: { id, state: "sorting" } } });
    await shares.idle();

    const message = store.findMessage(id);
    expect(message).toMatchObject({
      thread: role.id,
      text: "This one",
      share: { link: { url: "https://halcyon.example/jobs/1", title: "Platform Engineer", site: "Halcyon" } },
    });
    const [question] = asked.get();
    expect(question?.prompt).toContain(`- ${role.id}, “Halcyon role”`);
    expect(question?.prompt).toContain("Kumo: Sam wrote back about the platform team.");
    expect(question?.prompt).toContain("Its page: “Platform Engineer” (Halcyon)");
    expect(question?.images).toEqual([]);
    expect(routed.get()).toEqual([{ message: id, text: store.messageText(id) }]);
    expect(shares.accept(id, { url: "https://halcyon.example/jobs/1", note: "This one", attachments: [] })).toEqual({
      ok: true,
      value: {
        isNew: false,
        share: { id, state: "placed", at: accepted.ok ? accepted.value.share.at : "", thread: role.id },
      },
    });
  });

  it("shows Kumo a screenshot, and starts the thread Kumo names when it belongs to none", async () => {
    const store = openStore("start");
    saveAttachment(store, photo("f_shot"));
    const { shares, asked, routed } = sorter(store, ok({ thread: "", title: "“Dentist check-up.”" }));

    shares.accept(toMessageId("s_shot"), { attachments: ["f_shot"] });
    await shares.idle();

    const message = store.findMessage(toMessageId("s_shot"));
    expect(message?.attachments?.map(({ id }) => id)).toEqual(["f_shot"]);
    expect(message?.share).toEqual({});
    expect(store.findThread(toThreadId(message?.thread ?? ""))).toMatchObject({
      title: "Dentist check-up",
      by: "kumo",
    });
    expect(asked.get()).toMatchObject([{ images: ["/attachments/f_shot"], needsImages: true }]);
    expect(asked.get()[0]?.prompt).toContain("They have no open threads.");
    expect(routed.get().map(({ message: routedId }) => routedId)).toEqual(["s_shot"]);
  });

  it("starts a thread of its own, named later, when Kumo can't decide or names a thread that isn't open", async () => {
    const store = openStore("fallback");
    const failing = sorter(store, fail("The model service isn't responding right now."));
    failing.shares.accept(toMessageId("s_a"), { note: "A quick thought", attachments: [] });
    await failing.shares.idle();
    const wrong = sorter(store, ok({ thread: "h_nowhere", title: "" }));
    wrong.shares.accept(toMessageId("s_b"), { text: "Some text", attachments: [] });
    await wrong.shares.idle();

    for (const id of ["s_a", "s_b"]) {
      const thread = store.findMessage(toMessageId(id))?.thread;
      expect(thread).toBeDefined();
      expect(store.findThread(toThreadId(thread ?? ""))?.title).toBeUndefined();
    }
    expect([...failing.routed.get(), ...wrong.routed.get()].map(({ message }) => message)).toEqual(["s_a", "s_b"]);
  });

  it("sorts what a restart cut off, in the order it came, and never answers a share twice", async () => {
    const store = openStore("recover");
    store.acceptShare(toMessageId("s_1"), { note: "First", attachments: [] });
    store.acceptShare(toMessageId("s_2"), { note: "Second", attachments: [] });
    store.acceptShare(toMessageId("s_3"), { note: "Third", attachments: [] });
    store.placeShare(toMessageId("s_3"), {}, { title: "Already placed" });
    const { shares, routed } = sorter(store, ok({ thread: "", title: "Thoughts" }));

    shares.recover();
    await shares.idle();

    expect(routed.get().map(({ message }) => message)).toEqual(["s_1", "s_2"]);
  });
});

describe("POST /v0/shares", () => {
  const token = "ito_shares_test_not_a_real_token_0000000000000000000000";
  const directory = mkdtempSync(path.join(os.tmpdir(), "ito-shares-server-"));
  const clock = createVirtualClock(Date.parse("2026-11-27T09:00:00.000Z"));
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: directory,
    fetch: () => Promise.resolve(new Response("Not found", { status: 404 })),
    createEngine: () =>
      createScriptEngine(clock, () => ({ events: [], steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at })),
    name: "studio",
    clock,
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  const post = async (body: Readonly<Record<string, unknown>>) =>
    server.app.inject({
      method: "POST",
      url: "/v0/shares",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("answers once the share is on disk, the same again on a retry, and refuses a different share under its id", async () => {
    // Kumo sorts shares once the server listens, as it waits to call the model.
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const id = "6c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
    const first = await post({ id, url: "https://kiln.example/", note: "Friday?" });
    const again = await post({ id, url: "https://kiln.example/", note: "Friday?" });
    const different = await post({ id, url: "https://kiln.example/", note: "Saturday?" });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ share: { id, state: "sorting" } });
    expect(again.statusCode).toBe(200);
    expect(different.statusCode).toBe(409);
    expect(different.json()).toMatchObject({ error: { code: "id_conflict" } });
    await server.shares.idle();
    expect(server.store.findMessage(toMessageId(id))).toMatchObject({
      text: "Friday?",
      share: { link: { url: "https://kiln.example/", site: "kiln.example" } },
    });
  });

  it("refuses a share with nothing in it, a link that isn't on the web, and a photo that isn't there", async () => {
    const empty = await post({ id: "7d1e2f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a" });
    const local = await post({ id: "8e2f3a4b-5c6d-4e7f-8a8b-9c0d1e2f3a4b", url: "file:///etc/hosts" });
    const missing = await post({
      id: "9f3a4b5c-6d7e-4f8a-9b9c-0d1e2f3a4b5c",
      attachments: ["0a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d"],
    });

    expect(empty.statusCode).toBe(400);
    expect(local.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "attachment_missing" } });
  });
});
