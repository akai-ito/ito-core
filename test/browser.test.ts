import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrowser, type BrowserOptions, type BrowserState, type CommitOutcome } from "#browser/browser.ts";
import { missingChromium } from "#browser/session.ts";
import { createCell } from "#cell.ts";
import { fail, ok, type CallResult, type Result } from "#sdk/capability.ts";
import { startSite, type Site } from "./support/browser-site.ts";
import { createTestCore, testServer, type Place, type Published, type TestCore } from "./support/capability-core.ts";

// The browser capability on real Chromium against a made-up site served by the test: tools and refs, money, final
// steps, commit cards, takeover, the live view, and logins that last. Without Chromium installed it's skipped, unless
// ITO_REQUIRE_BROWSER says this machine must have one, as CI does.

const hasChromium = missingChromium() === undefined;
if (!hasChromium && process.env.ITO_REQUIRE_BROWSER === "1") throw new Error(missingChromium());

const temporary = realpathSync(os.tmpdir());
const home = mkdtempSync(path.join(temporary, "ito-browser-"));
const site = createCell<Site | undefined>(undefined);
const cores = createCell<readonly TestCore[]>([]);

type Card = { readonly name: string; readonly data: Readonly<Record<string, unknown>>; readonly picture: number };

type Opened = {
  readonly core: TestCore;
  readonly folder: string;
  readonly workspace: string;
  readonly cards: () => readonly Card[];
  readonly call: (operation: string, input: unknown, place?: Place) => Promise<Result<CallResult, string>>;
  readonly text: (operation: string, input: unknown, place?: Place) => Promise<string>;
  readonly states: () => readonly BrowserState[];
};

const origin = (): string => {
  const running = site.get();
  if (!running) throw new Error("The fixture site isn't running.");
  return running.origin;
};

const openBrowser = async (options: BrowserOptions = {}, folder = mkdtempSync(path.join(home, "core-"))) => {
  const workspace = path.join(folder, "workspace");
  mkdirSync(workspace, { recursive: true });
  const cards = createCell<readonly Card[]>([]);
  const core = createTestCore(createBrowser({ finalWaitMs: 1500, ...options }), {
    folder,
    server: { ...testServer, workspace },
    answer: (name, data) => {
      const given = data as Readonly<Record<string, unknown>>;
      const picture = typeof given.screenshot === "string" ? readFileSync(given.screenshot).length : 0;
      const count = cards.update((current) => [...current, { name, data: given, picture }]).length;
      return name === "card" ? ok({ card: `card-${String(count)}` }) : ok({});
    },
  });
  cores.update((current) => [...current, core]);
  const started = await core.start({});
  if (!started.ok) throw new Error(started.failure);
  const call = (operation: string, input: unknown, place?: Place) => core.call(operation, input, place ?? firstTurn);
  const text = async (operation: string, input: unknown, place?: Place): Promise<string> => {
    const called = await call(operation, input, place);
    if (!called.ok) throw new Error(called.failure);
    return called.value.text;
  };
  const states = (): readonly BrowserState[] =>
    core
      .published()
      .filter(({ topic }) => topic === "state")
      .map(({ data }) => data as BrowserState);
  return { core, folder, workspace, cards: () => cards.get(), call, text, states } satisfies Opened;
};

const referenceOf = (text: string, role: string, name: string): string => {
  const found = text
    .split("\n")
    .find((line) => line.includes(`- ${role} "${name}"`))
    ?.match(/\[ref=(?<ref>[a-z0-9]+)\]/u)?.groups?.ref;
  if (found === undefined) throw new Error(`No ${role} “${name}” in:\n${text}`);
  return found;
};

const failureOf = (result: Result<CallResult, string>): string => (result.ok ? "" : result.failure);

const step = "testing";

const firstTurn: Place = { turn: "turn-1" };

describe.skipIf(!hasChromium)("the browser", () => {
  beforeAll(async () => {
    site.set(await startSite());
  });

  afterEach(async () => {
    for (const core of cores.get()) core.close();
    cores.set([]);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    await site.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("reads a page as refs at iPhone size, acts on them, and shows what it's doing", async () => {
    const browser = await openBrowser();
    const opened = await browser.text(
      "open",
      { url: `${origin()}/book`, step: "finding Saturday tables" },
      { thread: "thread-1", turn: "turn-1" },
    );

    expect(opened).toContain("On Fixture Kitchen: Book a table");
    expect(opened).toContain("Screen 393 wide, touch, iPhone");
    const typed = await browser.text("act", {
      action: "type",
      ref: referenceOf(opened, "textbox", "Name"),
      text: "Sam Lee",
      step: "filling in the name",
    });
    const pressed = await browser.text("act", {
      action: "click",
      ref: referenceOf(typed, "button", "Sat 28"),
      step: "choosing Sat 28",
    });
    const chosen = await browser.text("act", {
      action: "select",
      ref: referenceOf(pressed, "combobox", "Time"),
      values: ["19:30"],
      step: "choosing 19:30",
    });

    expect(chosen).toContain('textbox "Name"');
    expect(chosen).toContain("Sam Lee");
    expect(chosen).toMatch(/button "Sat 28" (?:\[active\] )?\[pressed\]/u);
    expect(chosen).toMatch(/option "19:30" \[selected\]/u);
    expect(browser.states().at(-1)).toEqual({
      state: "browsing",
      thread: "thread-1",
      site: "Fixture Kitchen",
      url: `${origin()}/book`,
      title: "Book a table",
      doing: "choosing 19:30",
      step: 4,
    });
  });

  it("refuses a ref once its element changes or the page moves on, with the page as it is now", async () => {
    const browser = await openBrowser();
    const opened = await browser.text("open", { url: `${origin()}/renaming`, step });
    const book = referenceOf(opened, "button", "Book");
    const changed = await browser.text("act", {
      action: "click",
      ref: referenceOf(opened, "button", "Change it"),
      step,
    });
    const stale = await browser.call("act", { action: "click", ref: book, step });

    expect(failureOf(stale)).toContain(`${book} isn't a ref you can use`);
    expect(failureOf(stale)).toContain('button "Book now"');
    const fresh = referenceOf(changed, "button", "Book now");
    await browser.text("open", { url: `${origin()}/book`, step });
    expect(failureOf(await browser.call("act", { action: "click", ref: fresh, step }))).toContain("isn't a ref");
  });

  it("never presses a button that pays, nor types where a card or password goes", async () => {
    const browser = await openBrowser();
    const opened = await browser.text("open", { url: `${origin()}/checkout`, step });

    expect(opened).toContain("Money: this page takes payment (card fields, a total to pay)");
    const pay = await browser.call("act", { action: "click", ref: referenceOf(opened, "button", "Pay £42.00"), step });
    const order = await browser.call("act", {
      action: "click",
      ref: /generic \[ref=(?<ref>e\d+)\] \[cursor=pointer\]: Place order/u.exec(opened)?.groups?.ref ?? "",
      kind: "browse",
      step,
    });
    const onward = await browser.call("act", { action: "click", ref: referenceOf(opened, "button", "Continue"), step });
    const card = await browser.call("act", {
      action: "type",
      ref: referenceOf(opened, "textbox", "Card number"),
      text: "4242 4242 4242 4242",
      step,
    });
    const note = referenceOf(opened, "textbox", "Gift note");
    const sent = await browser.call("act", { action: "type", ref: note, text: "Happy birthday", submit: true, step });
    const typed = await browser.call("act", { action: "type", ref: note, text: "Happy birthday", step });

    for (const refused of [pay, order, onward, sent]) expect(failureOf(refused)).toMatch(/^Refused: money moves here/u);
    expect(failureOf(card)).toContain("Refused: that's a secret field");
    expect(typed.ok).toBe(true);
    expect(site.get()?.payments()).toBe(0);
  });

  it("keeps a final step whose answer was lost uncertain until Kumo has looked on the site", async () => {
    const browser = await openBrowser();
    const opened = await browser.text("open", { url: `${origin()}/book-slow`, step });
    const filled = await browser.text("act", {
      action: "type",
      ref: referenceOf(opened, "textbox", "Name"),
      text: "Robin",
      step,
    });
    const pressed = await browser.text("act", {
      action: "click",
      ref: referenceOf(filled, "button", "Book now"),
      kind: "final",
      step,
    });
    const final = /\((?<id>final-[\d-]+)\)/u.exec(pressed)?.groups?.id ?? "";

    expect(pressed).toContain("Uncertain: “Book now” on Fixture Kitchen");
    expect(pressed).toContain("Don't press it again");
    const again = await browser.text("open", { url: `${origin()}/book`, step });
    const retried = await browser.call("act", {
      action: "click",
      ref: referenceOf(again, "button", "Book now"),
      kind: "final",
      step,
    });
    expect(failureOf(retried)).toContain("Uncertain");
    const looked = await browser.text("open", { url: `${origin()}/bookings`, step: "checking the booking" });
    expect(looked).toContain("Robin, 2 guests");
    const settled = await browser.text("settle", { final, outcome: "went_through", how: "It's under Your bookings" });

    expect(settled).toBe("Settled: “Book now” went through. Don't press it again.");
    expect(
      site
        .get()
        ?.bookings()
        .filter(({ name }) => name === "Robin"),
    ).toHaveLength(1);
  });

  it("asks for a look on the site before an uncertain step can be settled", async () => {
    const browser = await openBrowser();
    const opened = await browser.text("open", { url: `${origin()}/book-slow`, step });
    const pressed = await browser.text("act", {
      action: "click",
      ref: referenceOf(opened, "button", "Book now"),
      kind: "final",
      step,
    });
    const final = /\((?<id>final-[\d-]+)\)/u.exec(pressed)?.groups?.id ?? "";
    const early = await browser.call("settle", { final, outcome: "not_through", how: "Guessing" });

    expect(failureOf(early)).toContain("Look on Fixture Kitchen first");
  });

  it("puts a free booking to him as a card bound to the page, and asks again once the page changed", async () => {
    const browser = await openBrowser();
    const here = { thread: "thread-2", turn: "turn-2" };
    const fill = async (name: string): Promise<string> => {
      const opened = await browser.text("open", { url: `${origin()}/book`, step }, here);
      return browser.text(
        "act",
        { action: "type", ref: referenceOf(opened, "textbox", "Name"), text: name, step },
        here,
      );
    };
    const first = await fill("Avery");
    const proposed = await browser.text(
      "commit",
      {
        ref: referenceOf(first, "button", "Book now"),
        title: "Book Fixture Kitchen, Sat 19:00",
        summary: "A table for two under Avery.",
        details: [{ label: "When", value: "Sat 28, 19:00" }],
        verb: "Book it",
      },
      here,
    );

    expect(proposed).toContain("It's on his Desk as card card-1");
    expect(browser.cards()[0]).toMatchObject({
      name: "card",
      data: {
        title: "Book Fixture Kitchen, Sat 19:00",
        verb: "Book it",
        site: "Fixture Kitchen",
        button: "Book now",
        thread: "thread-2",
        details: [{ label: "When", value: "Sat 28, 19:00" }],
      },
    });
    expect(browser.cards()[0]?.picture).toBeGreaterThan(1000);
    expect(browser.states().at(-1)).toMatchObject({ state: "waiting", card: "card-1", thread: "thread-2" });
    const done = (await browser.core.control("commit", { card: "card-1" })) as Result<CommitOutcome, string>;
    expect(done).toMatchObject({ ok: true, value: { outcome: "done", title: "Booked" } });
    expect(
      site
        .get()
        ?.bookings()
        .filter(({ name }) => name === "Avery"),
    ).toHaveLength(1);

    const second = await fill("Blake");
    await browser.text(
      "commit",
      { ref: referenceOf(second, "button", "Book now"), title: "Book again", summary: "Another table." },
      here,
    );
    await browser.text(
      "act",
      { action: "select", ref: referenceOf(second, "combobox", "Time"), values: ["20:00"], step },
      here,
    );
    const changed = (await browser.core.control("commit", { card: "card-2" })) as Result<CommitOutcome, string>;

    expect(changed).toMatchObject({ ok: true, value: { outcome: "changed" } });
    expect(
      site
        .get()
        ?.bookings()
        .filter(({ name }) => name === "Blake"),
    ).toHaveLength(0);
    const shop = await browser.text("open", { url: `${origin()}/checkout`, step }, here);
    const paying = await browser.call(
      "commit",
      { ref: referenceOf(shop, "button", "Pay £42.00"), title: "Pay", summary: "Pay for it." },
      here,
    );
    expect(failureOf(paying)).toMatch(/^Refused: money moves here/u);
  });

  it("locks Kumo out while he holds the page, and has Kumo read it again after he hands it back", async () => {
    const browser = await openBrowser();
    const opened = await browser.text(
      "open",
      { url: `${origin()}/login`, step: "signing in" },
      { thread: "thread-3", turn: "turn-3" },
    );
    expect(opened).toContain("Login: this page asks for a password");
    const asked = await browser.text(
      "takeover",
      { need: "login", why: "Sign in to Fixture Bank so I can check the balance" },
      { thread: "thread-3", turn: "turn-3" },
    );
    expect(asked).toContain("his phone shows “Sign in to Fixture Bank so I can check the balance”");
    expect(browser.states().at(-1)).toMatchObject({
      state: "needs_you",
      thread: "thread-3",
      need: { kind: "login", why: "Sign in to Fixture Bank so I can check the balance", turn: "turn-3" },
    });

    const taken = await browser.core.control("take", {});
    expect(taken).toMatchObject({ ok: true, value: { state: "yours", lease: {} } });
    const locked = await browser.call("act", { action: "click", ref: referenceOf(opened, "button", "Sign in"), step });
    expect(failureOf(locked)).toContain("He has the page now");
    const focus = () => browser.core.published().findLast(({ topic }) => topic === "focus")?.data;
    expect(await browser.core.control("input", { input: { type: "key", key: "Tab" } })).toEqual({
      ok: true,
      value: {},
    });
    expect(focus()).toMatchObject({ kind: "email", label: "Email", length: 0 });
    expect((focus() as { readonly box: { readonly width: number } }).box.width).toBeGreaterThan(0);
    await browser.core.control("input", { input: { type: "fill", text: "sam@example.com" } });
    expect(focus()).toMatchObject({ kind: "email", length: 15 });
    await browser.core.control("input", { input: { type: "key", key: "Tab" } });
    const password = focus() as { readonly kind: string; readonly box: { readonly y: number } };
    expect(password.kind).toBe("password");
    expect(password.box.y).toBeGreaterThan(0);
    await browser.core.control("input", { input: { type: "fill", text: "wrong" } });
    await browser.core.control("input", { input: { type: "fill", text: "correct horse" } });
    expect(focus()).toMatchObject({ kind: "password", length: 13 });
    expect(await browser.core.control("input", { input: { type: "key", key: "Enter" } })).toEqual({
      ok: true,
      value: {},
    });
    const handed = await browser.core.control("hand_back", {});

    expect(handed).toMatchObject({ ok: true, value: { state: "idle" } });
    expect(browser.core.published().find(({ topic }) => topic === "handed_back")?.data).toEqual({
      lapsed: false,
      hadTask: true,
      thread: "thread-3",
      need: { kind: "login", why: "Sign in to Fixture Bank so I can check the balance" },
      site: "Fixture Bank",
      url: `${origin()}/login`,
    });
    const stale = await browser.call("act", { action: "click", ref: referenceOf(opened, "button", "Sign in"), step });
    expect(failureOf(stale)).toContain("read the page first");
    await vi.waitFor(async () => {
      expect(await browser.text("read", {})).toContain("Signed in as sam@example.com");
    });
    expect(await browser.core.control("input", { input: { type: "key", key: "Tab" } })).toEqual({
      ok: false,
      failure: "Take over first: until then the live view is only to watch.",
    });
  });

  it("gives the page back to Kumo by itself when he leaves it held", async () => {
    const browser = await openBrowser({ leaseMs: 300 });
    await browser.text("open", { url: `${origin()}/book`, step });
    await browser.core.control("take", {});

    await vi.waitFor(() => {
      expect(browser.core.published().find(({ topic }) => topic === "handed_back")?.data).toMatchObject({
        lapsed: true,
      });
    });
    expect(browser.states().at(-1)?.state).not.toBe("yours");
  });

  it("streams the tab as he sees it and takes his touches back, quickly", async () => {
    const browser = await openBrowser();
    await browser.text("open", { url: `${origin()}/touch`, step });
    const frames = createCell<readonly (Published & { readonly at: number })[]>([]);
    browser.core.onPublish((published) => {
      if (published.topic === "frame") frames.update((current) => [...current, { ...published, at: Date.now() }]);
    });
    await browser.core.control("watch", { on: true });
    await vi.waitFor(() => {
      expect(frames.get().length).toBeGreaterThan(0);
    });
    expect(browser.core.published().find(({ topic }) => topic === "view")?.data).toMatchObject({
      width: 393,
      height: 659,
      tab: 1,
      tabs: 1,
    });
    const colourOf = async (data: unknown): Promise<string> => {
      const { data: base64 } = data as { readonly data: string };
      const { data: pixels, info } = await sharp(Buffer.from(base64, "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      const middle = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      return (pixels[middle] ?? 0) > 120 && (pixels[middle + 2] ?? 0) < 90 ? "red" : "blue";
    };

    await browser.core.control("take", {});
    const tappedAt = Date.now();
    await browser.core.control("input", { input: { type: "tap", x: 196, y: 150 } });
    await vi.waitFor(
      async () => {
        const red = await Promise.all(frames.get().map(async (frame) => colourOf(frame.data)));
        expect(red).toContain("red");
      },
      { timeout: 5000, interval: 20 },
    );
    const firstRed = await (async () => {
      const coloured = await Promise.all(
        frames.get().map(async (frame) => ({ at: frame.at, colour: await colourOf(frame.data) })),
      );
      return coloured.find(({ at, colour }) => at >= tappedAt && colour === "red")?.at ?? Date.now();
    })();
    const latency = firstRed - tappedAt;

    await browser.core.control("input", { input: { type: "key", key: "Escape" } });
    const counted = frames.get().length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fps = (frames.get().length - counted) / 2;
    console.log(`Live view: tap to frame ${String(latency)} ms, ${fps.toFixed(1)} frames a second while it moves`);
    expect(latency).toBeLessThan(1500);
    expect(fps).toBeGreaterThan(3);
    await browser.core.control("watch", { on: false });
  });

  it("keeps his logins across a restart, in its own profile", async () => {
    const folder = mkdtempSync(path.join(home, "profile-"));
    const first = await openBrowser({}, folder);
    await first.text("open", { url: `${origin()}/login`, step });
    await first.core.control("take", {});
    for (const input of [
      { type: "key", key: "Tab" },
      { type: "text", text: "sam@example.com" },
      { type: "key", key: "Tab" },
      { type: "text", text: "correct horse" },
      { type: "key", key: "Enter" },
    ]) {
      await first.core.control("input", { input });
    }
    await first.core.control("hand_back", {});
    await vi.waitFor(async () => {
      expect(await first.text("read", {})).toContain("Signed in as sam@example.com");
    });
    first.core.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const second = await openBrowser({}, folder);
    expect(await second.text("open", { url: `${origin()}/account`, step })).toContain("Signed in as sam@example.com");
    expect(existsSync(path.join(folder, "profile"))).toBe(true);
  });

  it("uploads only from the workspace, and keeps downloads there", async () => {
    const browser = await openBrowser();
    writeFileSync(path.join(browser.workspace, "photo.jpg"), "a passport photo");
    const opened = await browser.text("open", { url: `${origin()}/files`, step });
    const photo = referenceOf(opened, "button", "Photo");
    const chosen = await browser.text("act", { action: "upload", ref: photo, files: ["photo.jpg"], step });
    const outside = await browser.call("act", { action: "upload", ref: photo, files: ["/etc/hosts"], step });
    const downloaded = await browser.text("act", {
      action: "download",
      ref: referenceOf(chosen, "link", "Menu"),
      step,
    });

    expect(chosen).toContain("Chosen: photo.jpg");
    expect(failureOf(outside)).toContain("Only files in your workspace can go up");
    const file = /Downloaded it to (?<file>\S+)\./u.exec(downloaded)?.groups?.file ?? "";
    expect(file.startsWith(path.join(browser.workspace, "browser", "downloads"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("Soup of the day\n");
  });

  it("serves one thread's task at a time, until that task's turn ends", async () => {
    const browser = await openBrowser();
    await browser.text("open", { url: `${origin()}/book`, step }, { thread: "thread-a", turn: "turn-a" });
    const other = await browser.call("read", {}, { thread: "thread-b", turn: "turn-b" });
    const background = await browser.call("read", {}, { run: "run-1" });

    expect(failureOf(other)).toContain("The browser is busy with another thread's task on Fixture Kitchen");
    expect(background.ok).toBe(true);
    await browser.core.control("turn_ended", { turn: "turn-a" });
    expect(browser.states().at(-1)).toEqual({ state: "idle" });
    const freed = await browser.call("read", {}, { thread: "thread-b", turn: "turn-b" });
    expect(freed.ok).toBe(true);
  });

  it("says when Chromium is missing, rather than browsing without it", async () => {
    const core = createTestCore(createBrowser({ executablePath: path.join(home, "no-chromium") }), {
      folder: mkdtempSync(path.join(home, "missing-")),
    });
    cores.update((current) => [...current, core]);

    expect(await core.check({})).toContain("Chromium isn't installed on the server");
    const missing = missingChromium(path.join(home, "no-chromium"));
    expect(await core.start({})).toEqual(fail(missing));
  });
});
