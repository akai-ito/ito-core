import { generateKeyPairSync } from "node:crypto";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { missingChromium } from "#browser/session.ts";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toDeviceId, toThreadId, toTurnId } from "#conversation/ids.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { apnsSettings, type ApnsCredentials } from "#notifications/apns.ts";
import { openNotification } from "#notifications/crypto.ts";
import type { Envelope } from "#notifications/notifier.ts";
import type { Browser, Card } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { toKeyId } from "#store/store.ts";
import { startSite, type Site } from "./support/browser-site.ts";
import { startFakeApns, type FakeApns } from "./support/fake-apns.ts";

// Kumo's browser through the server's own boundaries: the capability as its own process on real Chromium, the
// line on the event stream, the live view over a WebSocket, the takeover lease over HTTP, a need's notification
// through APNs, commit cards on the Desk, and Kumo woken when he hands the page back or answers a card.

const hasChromium = missingChromium() === undefined;
if (!hasChromium && process.env.ITO_REQUIRE_BROWSER === "1") throw new Error(missingChromium());

const temporary = realpathSync(os.tmpdir());
const home = mkdtempSync(path.join(temporary, "ito-browser-server-"));
const token = "ito_browser_test_not_a_real_token_000000000000000000000";
const entry = fileURLToPath(new URL("../capabilities/browser/main.ts", import.meta.url));
const protocol = fileURLToPath(new URL("../protocol/", import.meta.url));
const site = createCell<Site | undefined>(undefined);
const apns = createCell<FakeApns | undefined>(undefined);
const servers = createCell<readonly Server[]>([]);

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credentials: ApnsCredentials = {
  keyId: "KEY1234567",
  teamId: "TEAM123456",
  bundleId: "com.example.ari",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const notificationKey = Buffer.from("01234567890123456789012345678901").toString("base64");
const device = {
  id: toDeviceId("8a1c7a3e-2b4f-4c6d-8e9f-0a1b2c3d4e5f"),
  apnsToken: "fedcba9876543210".repeat(4),
  environment: "production" as const,
  notificationKey,
  keyId: toKeyId(notificationKey),
  registeredAt: "2026-11-23T12:00:00.000Z",
};

const ajv = new Ajv2020({ strict: false });
const schemaOf = (name: string): object => JSON.parse(readFileSync(path.join(protocol, name), "utf8")) as object;
ajv.addSchema(schemaOf("events.schema.json"));
ajv.addSchema(schemaOf("browser.schema.json"));
const fromServer = ajv.getSchema(
  "https://akai-ito.github.io/ito-core/protocol/v0/browser.schema.json#/$defs/FromServer",
);
const fromApp = ajv.getSchema("https://akai-ito.github.io/ito-core/protocol/v0/browser.schema.json#/$defs/FromApp");

const origin = (): string => site.get()?.origin ?? "";

type Opened = {
  readonly server: Server;
  readonly base: string;
  readonly prompts: () => readonly string[];
  readonly call: (name: string, input: unknown, thread?: string) => Promise<string>;
  readonly fails: (name: string, input: unknown, thread?: string) => Promise<string>;
  readonly request: (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => Promise<Response>;
};

const openServer = async (): Promise<Opened> => {
  const prompts = createCell<readonly string[]>([]);
  const fake = apns.get();
  const server = createServer({
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "hands",
    embedder: wordEmbedder,
    timeZone: "UTC",
    capabilities: [{ id: "browser", entry }],
    ...(fake && { push: { hosts: { production: fake.origin, sandbox: fake.origin } } }),
    createEngine: ({ callTool }) =>
      createScriptEngine(
        systemClock,
        () => {
          throw new Error("This test starts no turns.");
        },
        callTool,
        undefined,
        undefined,
        (prompt) => {
          prompts.update((current) => [...current, prompt]);
          return Promise.resolve(ok("Carried on."));
        },
      ),
  });
  servers.update((current) => [...current, server]);
  server.store.setSetting(tokenSetting, hashToken(token));
  server.store.setSetting(apnsSettings.privateKey, credentials.privateKey);
  server.store.setSetting(apnsSettings.keyId, credentials.keyId);
  server.store.setSetting(apnsSettings.teamId, credentials.teamId);
  server.store.setSetting(apnsSettings.bundleId, credentials.bundleId);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  const base = typeof address === "object" && address ? `127.0.0.1:${String(address.port)}` : "";
  await server.host.ready;
  await server.host.switchTo("browser", true);
  await vi.waitFor(() => {
    expect(server.host.find("browser")?.state).toBe("on");
  });
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<Response> =>
    fetch(`http://${base}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined && { "content-type": "application/json" }),
      },
      ...(payload !== undefined && { body: JSON.stringify(payload) }),
    });
  const call = async (name: string, input: unknown, thread?: string): Promise<string> => {
    const called = await server.callTool(name, input, undefined, thread);
    if (called.isError === true) throw new Error(called.text);
    return called.text;
  };
  const fails = async (name: string, input: unknown, thread?: string): Promise<string> => {
    const called = await server.callTool(name, input, undefined, thread);
    return called.isError === true ? called.text : "";
  };
  return { server, base, prompts: () => prompts.get(), call, fails, request };
};

type Live = {
  readonly texts: () => readonly Readonly<Record<string, unknown>>[];
  readonly frames: () => readonly { readonly at: number; readonly jpeg: Buffer }[];
  readonly send: (frame: unknown) => void;
  readonly close: () => void;
};

const openLive = async (base: string): Promise<Live> => {
  const texts = createCell<readonly Readonly<Record<string, unknown>>[]>([]);
  const frames = createCell<readonly { readonly at: number; readonly jpeg: Buffer }[]>([]);
  const socket = new WebSocket(`ws://${base}/v0/capabilities/browser/stream`, {
    headers: { authorization: `Bearer ${token}` },
  });
  socket.on("message", (data, isBinary) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (isBinary) frames.update((current) => [...current, { at: Date.now(), jpeg: bytes }]);
    else
      texts.update((current) => [...current, JSON.parse(bytes.toString("utf8")) as Readonly<Record<string, unknown>>]);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    texts: () => texts.get(),
    frames: () => frames.get(),
    send: (frame) => {
      expect(fromApp?.(frame)).toBe(true);
      socket.send(JSON.stringify(frame));
    },
    close: () => {
      socket.close();
    },
  };
};

const referenceOf = (text: string, role: string, name: string): string => {
  const found = text
    .split("\n")
    .find((line) => line.includes(`- ${role} "${name}"`))
    ?.match(/\[ref=(?<ref>[a-z0-9]+)\]/u)?.groups?.ref;
  if (found === undefined) throw new Error(`No ${role} “${name}” in:\n${text}`);
  return found;
};

const colourOf = async (jpeg: Buffer): Promise<"red" | "blue"> => {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const middle = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return (data[middle] ?? 0) > 120 && (data[middle + 2] ?? 0) < 90 ? "red" : "blue";
};

const browserOf = (server: Server): Browser => server.store.browser();

const commitCard = (server: Server): Card => {
  const found = server.store.desk().waiting.find(({ kind }) => kind === "commit");
  if (!found) throw new Error("No commit card is waiting.");
  return found;
};

describe.skipIf(!hasChromium)("Kumo's browser on the server", () => {
  beforeAll(async () => {
    site.set(await startSite());
    apns.set(await startFakeApns());
  });

  afterEach(async () => {
    await Promise.all(servers.get().map((server) => server.close()));
    servers.set([]);
  });

  afterAll(async () => {
    await site.get()?.close();
    await apns.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("shows Kumo's task as a line in its thread, streams it live, and hands him the page on request", async () => {
    const { server, base, call, fails, request } = await openServer();
    const thread = server.store.startThread("kumo", "Dinner on Saturday");
    await call("browser_open", { url: `${origin()}/book?from=mail#top`, step: "finding a table" }, thread.id);

    expect(browserOf(server)).toEqual({
      state: "browsing",
      line: "On Fixture Kitchen: finding a table · step 1",
      thread: thread.id,
      site: "Fixture Kitchen",
      url: `${origin()}/book`,
      title: "Book a table",
      doing: "finding a table",
      step: 1,
    });
    expect(server.store.snapshot("no_cursor").event.browser).toEqual(browserOf(server));
    const stated = await request("GET", "/v0/capabilities/browser/state");
    expect(await stated.json()).toEqual({ browser: browserOf(server) });

    const live = await openLive(base);
    await vi.waitFor(() => {
      expect(live.frames().length).toBeGreaterThan(0);
    });
    expect(live.texts()[0]).toEqual({ type: "state", browser: browserOf(server) });
    const view = live.texts().find(({ type }) => type === "view");
    expect(view).toMatchObject({ url: `${origin()}/book?from=mail#top`, width: 393, height: 659, tab: 1, tabs: 1 });
    expect(["headful", "headless"]).toContain(view?.display);
    expect(live.texts()).toContainEqual({ type: "link", state: "live" });
    live.send({ type: "tap", x: 10, y: 10 });
    await vi.waitFor(() => {
      expect(live.texts()).toContainEqual({
        type: "refused",
        message: "Take over first: until then the live view is only to watch.",
      });
    });

    const taken = await request("POST", "/v0/capabilities/browser/takeover");
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({
      browser: { state: "yours", line: "You have the page on Fixture Kitchen", lease: {} },
    });
    expect(await fails("browser_read", {}, thread.id)).toContain("He has the page now");

    live.send({ type: "navigate", url: `${origin()}/touch` });
    await vi.waitFor(async () => {
      const last = live.frames().at(-1);
      expect(last && (await colourOf(last.jpeg))).toBe("blue");
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tappedAt = Date.now();
    live.send({ type: "tap", x: 196, y: 150 });
    const redAt = await vi.waitFor(
      async () => {
        const coloured = await Promise.all(
          live
            .frames()
            .filter(({ at }) => at >= tappedAt)
            .map(async (frame) => ({ at: frame.at, colour: await colourOf(frame.jpeg) })),
        );
        const red = coloured.find(({ colour }) => colour === "red");
        expect(red).toBeDefined();
        return red?.at ?? 0;
      },
      { timeout: 5000, interval: 10 },
    );
    live.send({ type: "key", key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const counted = live.frames().length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fps = (live.frames().length - counted) / 2;
    console.log(
      `Live view over the WebSocket: tap to frame ${String(redAt - tappedAt)} ms, ${fps.toFixed(1)} frames a second while it moves`,
    );
    expect(redAt - tappedAt).toBeLessThan(1500);
    expect(fps).toBeGreaterThan(3);

    const handed = await request("DELETE", "/v0/capabilities/browser/takeover");
    expect(await handed.json()).toMatchObject({ browser: { state: "idle" } });
    expect(await fails("browser_act", { action: "press", key: "Tab", ref: "e1", step: "carrying on" })).toContain(
      "read the page first",
    );
    for (const frame of live.texts()) expect(fromServer?.(frame), JSON.stringify(frame)).toBe(true);
    live.close();
  });

  it("notifies once when Kumo needs his hand, opens into the takeover, and wakes Kumo in the thread after", async () => {
    const { server, call, request, prompts } = await openServer();
    const fake = apns.get();
    if (!fake) throw new Error("No fake APNs is running.");
    const registered = await request("PUT", `/v0/devices/${device.id}`, {
      apns_token: device.apnsToken,
      environment: "production",
      notification_key: notificationKey,
    });
    expect(registered.status).toBe(201);
    const thread = server.store.startThread("kumo", "Bank balance");
    const before = fake.pushed().length;
    await call("browser_open", { url: `${origin()}/login`, step: "opening the bank" }, thread.id);
    await call(
      "browser_takeover",
      { need: "login", why: "Sign in to Fixture Bank so I can check the balance" },
      thread.id,
    );
    await call("browser_read", {}, thread.id);

    await expect.poll(() => fake.pushed().length - before).toBe(1);
    const pushed = fake.pushed().at(-1)?.payload as Envelope;
    expect(pushed.aps.alert.body).toBe("Kumo needs your hand");
    expect(openNotification(pushed.ito, device)).toEqual({
      kind: "takeover",
      text: "Sign in to Fixture Bank so I can check the balance",
      takeover: { need: "login", site: "Fixture Bank" },
      thread: thread.id,
      thread_title: "Bank balance",
    });
    expect(browserOf(server)).toMatchObject({
      state: "needs_you",
      line: "Needs your hand on Fixture Bank",
      need: { kind: "login", why: "Sign in to Fixture Bank so I can check the balance" },
    });

    await request("POST", "/v0/capabilities/browser/takeover");
    await request("DELETE", "/v0/capabilities/browser/takeover");

    await expect.poll(() => prompts().length).toBe(1);
    expect(prompts()[0]).toContain(
      "You'd asked him to take over: “Sign in to Fixture Bank so I can check the balance”.",
    );
    expect(prompts()[0]).toContain(`(${thread.id})`);
    expect(fake.pushed().length - before).toBe(1);
  });

  it("puts a free booking on the Desk, and presses it only when he says go and the page hasn't moved", async () => {
    const { server, call, request, prompts } = await openServer();
    const thread = server.store.startThread("kumo", "Dinner for two");
    const fill = async (name: string): Promise<string> => {
      const opened = await call("browser_open", { url: `${origin()}/book`, step: "opening the booking" }, thread.id);
      return call(
        "browser_act",
        { action: "type", ref: referenceOf(opened, "textbox", "Name"), text: name, step: "giving the name" },
        thread.id,
      );
    };
    const filled = await fill("Morgan");
    await call(
      "browser_commit",
      {
        ref: referenceOf(filled, "button", "Book now"),
        title: "Book Fixture Kitchen, Sat 19:00",
        summary: "A table for two under Morgan.",
        details: [{ label: "When", value: "Sat 28, 19:00" }],
        verb: "Book it",
      },
      thread.id,
    );
    const card = commitCard(server);

    expect(card).toMatchObject({
      kind: "commit",
      title: "Book Fixture Kitchen, Sat 19:00",
      options: [{ label: "Book it", acts: true }, { label: "Not now" }],
      allows_text: true,
      commit: {
        site: "Fixture Kitchen",
        url: `${origin()}/book`,
        button: "Book now",
        summary: "A table for two under Morgan.",
        details: [{ label: "When", value: "Sat 28, 19:00" }],
        thread: thread.id,
      },
    });
    const picture = await request("GET", `/v0/attachments/${card.commit?.screenshot ?? ""}`);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    const bytes = await picture.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(browserOf(server)).toMatchObject({
      state: "waiting",
      card: card.id,
      line: "Waiting for your OK on Fixture Kitchen",
    });

    const answered = await request("POST", `/v0/desk/cards/${card.id}/answer?thread=${thread.id}`, {
      option: "Book it",
    });
    expect(answered.status).toBe(202);
    await vi.waitFor(() => {
      expect(server.store.desk().waiting.some(({ id }) => id === card.id)).toBe(false);
    });
    expect(
      site
        .get()
        ?.bookings()
        .filter(({ name }) => name === "Morgan"),
    ).toHaveLength(1);
    await expect.poll(() => prompts().length).toBe(1);
    expect(prompts()[0]).toMatch(/He tapped “Book it”, and Ito pressed it \(final-[\d-]+\): the site answered/u);

    const again = await fill("Quinn");
    await call(
      "browser_commit",
      { ref: referenceOf(again, "button", "Book now"), title: "Book again", summary: "Another table." },
      thread.id,
    );
    const second = commitCard(server);
    await request("POST", `/v0/desk/cards/${second.id}/answer`, { option: "Not now" });
    await expect.poll(() => prompts().length).toBe(2);
    expect(prompts()[1]).toContain("He answered “Not now”, so nothing was pressed.");
    expect(
      site
        .get()
        ?.bookings()
        .filter(({ name }) => name === "Quinn"),
    ).toHaveLength(0);
    expect(server.store.desk().waiting.filter(({ kind }) => kind === "commit")).toEqual([]);
  });

  it("keeps hand-offs and how a card went in the task's trail, and stops a task without waking Kumo", async () => {
    const { server, base, call, request, prompts } = await openServer();
    const thread = server.store.startThread("kumo", "Train to the coast");
    const place = toThreadId(thread.id);
    server.store.postMessage("I'll look at the trains.", { thread: place });
    const turn = toTurnId("turn-coast");
    server.store.startTurn(turn, [], undefined, place);
    server.store.endTurn(turn, "completed");
    const trail = () => server.store.threadPage(place)?.steps ?? [];

    await call("browser_open", { url: `${origin()}/login`, step: "opening the bank" }, thread.id);
    await call("browser_takeover", { need: "login", why: "Sign in to Fixture Bank" }, thread.id);
    expect(trail().filter(({ kind }) => kind === "handoff")).toMatchObject([
      {
        turn,
        title: "Needed you to log in",
        outcome: "completed",
        handoff: { need: "login", why: "Sign in to Fixture Bank", site: "Fixture Bank" },
      },
    ]);
    const live = await openLive(base);
    await request("POST", "/v0/capabilities/browser/takeover");
    live.send({ type: "viewport", width: 402, height: 640, keyboard: 0 });
    await vi.waitFor(() => {
      expect(live.texts()).toContainEqual(expect.objectContaining({ type: "view", width: 402, height: 640 }));
    });
    expect(live.texts()).toContainEqual({ type: "link", state: "live" });
    await request("DELETE", "/v0/capabilities/browser/takeover");
    await vi.waitFor(() => {
      expect(trail().find(({ kind }) => kind === "handoff")?.handoff).toMatchObject({ answer: "handed_back" });
    });
    await expect.poll(() => prompts().length).toBe(1);

    await call("browser_takeover", { need: "captcha", why: "Get past the check" }, thread.id);
    await request("POST", "/v0/capabilities/browser/takeover");
    const stopped = await request("DELETE", "/v0/capabilities/browser/task");
    expect(await stopped.json()).toEqual({ browser: { state: "idle" } });
    await vi.waitFor(() => {
      expect(trail().findLast(({ kind }) => kind === "handoff")).toMatchObject({
        title: "Needed you past a check",
        handoff: { need: "captcha", answer: "stopped" },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(prompts()).toHaveLength(1);

    const opened = await call("browser_open", { url: `${origin()}/book`, step: "opening the booking" }, thread.id);
    const filled = await call(
      "browser_act",
      { action: "type", ref: referenceOf(opened, "textbox", "Name"), text: "Rowan", step: "giving the name" },
      thread.id,
    );
    await call(
      "browser_commit",
      { ref: referenceOf(filled, "button", "Book now"), title: "Book a table", summary: "For two.", verb: "Book" },
      thread.id,
    );
    const card = commitCard(server);
    await request("POST", `/v0/desk/cards/${card.id}/answer?thread=${thread.id}`, { option: "Book" });
    await vi.waitFor(() => {
      expect(trail().find(({ kind }) => kind === "commit")).toMatchObject({
        title: "Pressed “Book now”",
        commit: { card: card.id, title: "Book a table", verb: "Book", outcome: "done", page: { button: "Book now" } },
      });
    });
    await expect.poll(() => prompts().length).toBe(2);
    const final = /\((?<final>final-[\d-]+)\)/u.exec(prompts()[1] ?? "")?.groups?.final ?? "";
    await call("browser_read", {}, thread.id);
    await call(
      "browser_settle",
      { final, outcome: "went_through", how: "The page says Booked", reference: "FK-2041" },
      thread.id,
    );
    await vi.waitFor(() => {
      expect(trail().find(({ kind }) => kind === "commit")?.commit).toMatchObject({
        outcome: "done",
        reference: "FK-2041",
      });
    });
    for (const frame of live.texts()) expect(fromServer?.(frame), JSON.stringify(frame)).toBe(true);
    live.close();
  });

  it("refuses the live view and the takeover while the browser is off", async () => {
    const { server, base, request } = await openServer();
    await server.host.switchTo("browser", false);

    const taken = await request("POST", "/v0/capabilities/browser/takeover");
    const socket = new WebSocket(`ws://${base}/v0/capabilities/browser/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const status = await new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      socket.once("open", () => {
        resolve(101);
      });
    });

    expect(taken.status).toBe(503);
    expect(await taken.json()).toMatchObject({
      error: { code: "unavailable", detail: "Kumo's browser is off. Switch it on in Settings › Capabilities." },
    });
    expect(status).toBe(503);
    expect(browserOf(server)).toEqual({ state: "idle" });
  });
});
