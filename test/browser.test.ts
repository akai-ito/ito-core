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

// The colour at a point in a frame of the live view, whose viewport is `width` CSS pixels wide.
const colourAt = async (base64: string, x: number, y: number, width: number): Promise<string> => {
  const { data: pixels, info } = await sharp(Buffer.from(base64, "base64")).raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / width;
  const at = (Math.floor(y * scale) * info.width + Math.floor(x * scale)) * info.channels;
  const [red = 0, green = 0, blue = 0] = [pixels[at], pixels[at + 1], pixels[at + 2]];
  const named = [
    { name: "red", isIt: red > 150 && green < 90 && blue < 90 },
    { name: "green", isIt: green > 120 && red < 90 && blue < 90 },
    { name: "blue", isIt: blue > 150 && red < 90 && green < 90 },
  ].find(({ isIt }) => isIt)?.name;
  return named ?? `rgb(${String(red)},${String(green)},${String(blue)})`;
};

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
    const focusIs = (expected: Readonly<Record<string, unknown>>) =>
      vi.waitFor(() => {
        expect(focus()).toMatchObject(expected);
      });
    expect(await browser.core.control("input", { input: { type: "key", key: "Tab" } })).toEqual({
      ok: true,
      value: {},
    });
    await focusIs({ kind: "email", label: "Email", length: 0 });
    expect((focus() as { readonly box: { readonly width: number } }).box.width).toBeGreaterThan(0);
    await browser.core.control("input", { input: { type: "fill", text: "sam@example.com" } });
    await focusIs({ kind: "email", length: 15 });
    await browser.core.control("input", { input: { type: "key", key: "Tab" } });
    await focusIs({ kind: "password" });
    const password = focus() as { readonly kind: string; readonly box: { readonly y: number } };
    expect(password.box.y).toBeGreaterThan(0);
    await browser.core.control("input", { input: { type: "fill", text: "wrong" } });
    await browser.core.control("input", { input: { type: "fill", text: "correct horse" } });
    await focusIs({ kind: "password", length: 13 });
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
    await vi.waitFor(
      async () => {
        expect(await first.text("read", {})).toContain("Signed in as sam@example.com");
      },
      { timeout: 5000 },
    );
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

  describe("taking over pages that were finicky from a phone", () => {
    type Watched = {
      readonly frames: () => readonly string[];
      readonly links: () => readonly string[];
      readonly input: (input: Readonly<Record<string, unknown>>) => Promise<number>;
      readonly colourAt: (x: number, y: number) => Promise<string>;
      readonly focus: () => unknown;
    };

    // Watches the page and takes it over, keeping every frame and link state, and timing each input.
    const takeOver = async (browser: Opened): Promise<Watched> => {
      const frames = createCell<readonly string[]>([]);
      const links = createCell<readonly string[]>([]);
      browser.core.onPublish(({ topic, data }) => {
        if (topic === "frame") frames.update((current) => [...current, (data as { readonly data: string }).data]);
        else if (topic === "link") links.update((current) => [...current, (data as { readonly state: string }).state]);
      });
      await browser.core.control("watch", { on: true });
      await vi.waitFor(() => {
        expect(frames.get().length).toBeGreaterThan(0);
      });
      expect(await browser.core.control("take", {})).toMatchObject({ ok: true });
      const width = () =>
        (browser.core.published().findLast(({ topic }) => topic === "view")?.data as { readonly width?: number })
          .width ?? 393;
      return {
        frames: () => frames.get(),
        links: () => links.get(),
        input: async (input) => {
          const started = Date.now();
          expect(await browser.core.control("input", { input })).toEqual({ ok: true, value: {} });
          return Date.now() - started;
        },
        colourAt: async (x, y) => colourAt(frames.get().at(-1) ?? "", x, y, width()),
        focus: () => browser.core.published().findLast(({ topic }) => topic === "focus")?.data,
      };
    };

    const here: Place = { thread: "thread-9", turn: "turn-9" };

    it("types the password on the step that arrives after a navigation, among frames that never finish", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/signin`, step: "signing in" }, here);
      await browser.text("takeover", { need: "login", why: "Sign in to Fixture Market" }, here);
      const page = await takeOver(browser);

      const tapped = await page.input({ type: "tap", x: 100, y: 120 });
      await vi.waitFor(() => {
        expect(page.focus()).toMatchObject({ kind: "email", label: "Email" });
      });
      const typed = [
        tapped,
        await page.input({ type: "fill", text: "sam@example.com" }),
        await page.input({ type: "tap", x: 170, y: 182 }),
      ];
      // No input of his: the password field took the focus by itself, and the phone hears it.
      await vi.waitFor(
        () => {
          expect(page.focus()).toMatchObject({ kind: "password", label: "Password", length: 0 });
        },
        { timeout: 5000 },
      );
      const box = (page.focus() as { readonly box: { readonly x: number; readonly y: number } }).box;
      expect(box).toMatchObject({ x: 20, y: 100 });
      const took = [
        ...typed,
        await page.input({ type: "fill", text: "correct horse" }),
        await page.input({ type: "key", key: "Enter" }),
      ];

      expect(Math.max(...took)).toBeLessThan(1600);
      await browser.core.control("hand_back", {});
      await vi.waitFor(
        async () => {
          expect(await browser.text("read", {}, here)).toContain("Signed in to Fixture Market as sam@example.com");
        },
        { timeout: 5000 },
      );
    });

    it("lands taps and typing in a check inside a frame from another site, with the phone's keyboard for its field", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/check`, step: "getting the timetable" }, here);
      await browser.text("takeover", { need: "captcha", why: "Get past the check" }, here);
      const page = await takeOver(browser);

      await page.input({ type: "tap", x: 52, y: 332 });
      await vi.waitFor(async () => {
        expect(await page.colourAt(52, 332)).toBe("green");
      });
      await page.input({ type: "tap", x: 100, y: 400 });
      await vi.waitFor(() => {
        expect(page.focus()).toMatchObject({ kind: "text", label: "Answer", length: 0 });
      });
      const { box } = page.focus() as { readonly box: Readonly<Record<string, number>> };
      expect(box.x).toBeCloseTo(32, 0);
      expect(box.y).toBeCloseTo(382, 0);
      expect(box.width).toBeCloseTo(200, 0);
      expect(box.height).toBeCloseTo(36, 0);
      await page.input({ type: "fill", text: "blue" });
      await vi.waitFor(() => {
        expect(page.focus()).toMatchObject({ label: "Answer", length: 4 });
      });

      await browser.core.control("hand_back", {});
      const read = await browser.text("read", {}, here);
      expect(read).toMatch(/checkbox "I'm a person" \[checked\]/u);
      expect(read).toMatch(/textbox "Answer"[^\n]*: blue/u);
    });

    it("never lets a frame that hangs hold up his taps", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/check`, step }, here);
      const page = await takeOver(browser);

      // The check's frame takes the focus into its field, then hangs for a long while.
      await page.input({ type: "tap", x: 282, y: 332 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const first = await page.input({ type: "tap", x: 196, y: 40 });
      await vi.waitFor(async () => {
        expect(await page.colourAt(196, 40)).toBe("red");
      });
      const second = await page.input({ type: "tap", x: 196, y: 40 });
      await vi.waitFor(async () => {
        expect(await page.colourAt(196, 40)).toBe("blue");
      });

      expect(Math.max(first, second)).toBeLessThan(1600);
      expect(await browser.core.control("hand_back", {})).toMatchObject({ ok: true, value: { state: "idle" } });
    });

    it("fits the page to the room his phone has, so a banner's button at the bottom is there to tap", async () => {
      const folder = mkdtempSync(path.join(home, "room-"));
      const browser = await openBrowser({}, folder);
      await browser.text("open", { url: `${origin()}/consent`, step }, here);
      const page = await takeOver(browser);
      const view = () => browser.core.published().findLast(({ topic }) => topic === "view")?.data;

      await page.input({ type: "viewport", width: 390, height: 560 });
      expect(view()).toMatchObject({ width: 390, height: 560 });
      await page.input({ type: "tap", x: 195, y: 560 - 44 });
      await vi.waitFor(async () => {
        expect(await page.colourAt(195, 300)).toBe("green");
      });
      await page.input({ type: "viewport", width: 390, height: 560, keyboard: 300 });
      expect(view()).toMatchObject({ width: 390, height: 260 });
      await page.input({ type: "viewport", width: 390, height: 560, keyboard: 300 });
      await browser.core.control("hand_back", {});
      await vi.waitFor(() => {
        expect(view()).toMatchObject({ width: 390, height: 560 });
      });
      browser.core.close();
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const again = await openBrowser({}, folder);
      expect(await again.text("open", { url: `${origin()}/book`, step })).toContain("Screen 390 wide");
    });

    it("scrolls far down with fast swipes, every one counted, and taps what's there", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/tall`, step }, here);
      const page = await takeOver(browser);

      const swipes = Array.from({ length: 40 }, () =>
        browser.core.control("input", { input: { type: "scroll", x: 196, y: 300, dx: 0, dy: 50 } }),
      );
      expect(await Promise.all(swipes)).toEqual(swipes.map(() => ({ ok: true, value: {} })));
      await vi.waitFor(async () => {
        await page.input({ type: "tap", x: 170, y: 130 });
        expect(await page.colourAt(196, 400)).toBe("green");
      });
    });

    it("applies a burst of taps in order, none dropped and none waiting on another", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/taps`, step }, here);
      await takeOver(browser);
      const order = [1, 2, 3, 4, 5, 3, 1, 5, 2, 4, 1, 2, 3, 4, 5];

      const started = Date.now();
      const tapped = await Promise.all(
        order.map((number) => browser.core.control("input", { input: { type: "tap", x: number * 64 - 20, y: 130 } })),
      );
      const took = Date.now() - started;
      expect(tapped.every((done) => done.ok)).toBe(true);
      expect(took).toBeLessThan(order.length * 400);

      await browser.core.control("hand_back", {});
      await vi.waitFor(async () => {
        expect(await browser.text("read", {}, here)).toContain(`Pressed: ${order.join(" ")}`);
      });
    });

    it("says it's reconnecting while the page is frozen, rather than showing a still picture as live, then recovers", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/freeze`, step }, here);
      const page = await takeOver(browser);

      await page.input({ type: "tap", x: 170, y: 130 });
      await vi.waitFor(
        () => {
          expect(page.links()).toContain("reconnecting");
        },
        { timeout: 6000 },
      );
      await vi.waitFor(
        async () => {
          expect(await page.colourAt(196, 400)).toBe("green");
          expect(page.links().at(-1)).toBe("live");
        },
        { timeout: 15_000 },
      );
    });

    it("stops the task: the takeover ends without waking Kumo, and that turn can't browse again", async () => {
      const browser = await openBrowser();
      await browser.text("open", { url: `${origin()}/login`, step }, here);
      await browser.text("takeover", { need: "login", why: "Sign in to Fixture Bank" }, here);
      await browser.core.control("take", {});

      expect(await browser.core.control("stop", {})).toEqual({ ok: true, value: { state: "idle" } });
      expect(browser.core.published().find(({ topic }) => topic === "handed_back")?.data).toMatchObject({
        stopped: true,
        need: { kind: "login" },
      });
      expect(failureOf(await browser.call("read", {}, here))).toContain("He stopped this task");
      const afresh = await browser.call("read", {}, { thread: "thread-9", turn: "turn-10" });
      expect(afresh.ok).toBe(true);
    });

    it("rings the site's own pay button Kumo stopped at, until the page goes back", async () => {
      const browser = await openBrowser();
      const shop = await browser.text("open", { url: `${origin()}/checkout`, step }, here);
      const paying = await browser.call(
        "act",
        { action: "click", ref: referenceOf(shop, "button", "Pay £42.00"), kind: "payment", step },
        here,
      );
      expect(failureOf(paying)).toMatch(/^Refused: money moves here/u);
      await browser.text("takeover", { need: "payment", why: "Pay £42 for the notebook" }, here);
      await takeOver(browser);
      const mark = () => browser.core.published().findLast(({ topic }) => topic === "mark")?.data;

      await vi.waitFor(() => {
        expect(mark()).toMatchObject({ label: "Pay £42.00" });
      });
      const { box } = mark() as { readonly box: Readonly<Record<string, number>> };
      expect(box.width).toBeGreaterThan(40);
      expect(box.y).toBeGreaterThan(100);
      await browser.core.control("hand_back", {});
      expect(mark()).toEqual({});
    });
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
