import { describe, expect, it } from "vitest";
import { startDisplay } from "#browser/display.ts";
import { createLane } from "#browser/lane.ts";
import { mergeInputs, type Input } from "#browser/live.ts";
import { toPagePoint, toScreenBox } from "#browser/page.ts";
import { createReporter } from "#browser/reporter.ts";
import { createCell } from "#cell.ts";
import { explainStop } from "#capabilities/process.ts";
import { fail, ok } from "#result.ts";

// The parts of the takeover that keep his input from ever waiting: the lane his input goes through, the reader that
// says where the focus is beside it, how moves and scrolls join while they wait, where a touch lands on a zoomed page,
// where Chromium draws, and what the capability screen says when the browser can't start.

const later = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Nothing here joins: each item is its own.
const apart = <Item>(waiting: Item, next: Item): Item | undefined => (waiting === next ? next : undefined);

const never = new Promise<never>(() => {
  // Hangs, as a busy page does.
});

describe("his input's lane", () => {
  it("applies everything in the order it came, each once", async () => {
    const applied = createCell<readonly number[]>([]);
    const lane = createLane<number>({
      apply: async (item) => {
        await later(item % 2 === 0 ? 15 : 1);
        applied.update((current) => [...current, item]);
        return ok(undefined);
      },
      merge: apart,
      limitMs: () => 1000,
    });

    const done = await Promise.all([1, 2, 3, 4, 5, 6].map((item) => lane.push(item)));

    expect(applied.get()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(done.every((result) => result.ok)).toBe(true);
  });

  it("goes on past one that hangs, once its moment is up", async () => {
    const applied = createCell<readonly string[]>([]);
    const lane = createLane<string>({
      apply: async (item) => {
        if (item === "stuck") await never;
        applied.update((current) => [...current, item]);
        return ok(undefined);
      },
      merge: apart,
      limitMs: () => 50,
    });

    const started = Date.now();
    await Promise.all(["first", "stuck", "after"].map((item) => lane.push(item)));

    expect(applied.get()).toEqual(["first", "after"]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("joins what can wait together, and says why when something fails", async () => {
    const applied = createCell<readonly Input[]>([]);
    const gate = Promise.withResolvers<undefined>();
    const lane = createLane<Input>({
      apply: async (input) => {
        if (input.type === "tap") await gate.promise;
        applied.update((current) => [...current, input]);
        return input.type === "key" ? fail("The page has closed.") : ok(undefined);
      },
      merge: mergeInputs,
      limitMs: () => 1000,
    });

    const tapped = lane.push({ type: "tap", x: 1, y: 1 });
    const scrolls = [10, 20, 30].map((dy) => lane.push({ type: "scroll", x: 5, y: 5, dx: 0, dy }));
    const moves = [1, 2, 3].map((x) => lane.push({ type: "touch", phase: "move", x, y: 0 }));
    const key = lane.push({ type: "key", key: "Enter" });
    gate.resolve(undefined);
    await Promise.all([tapped, ...scrolls, ...moves]);

    expect(await key).toEqual(fail("The page has closed."));
    expect(applied.get()).toEqual([
      { type: "tap", x: 1, y: 1 },
      { type: "scroll", x: 5, y: 5, dx: 0, dy: 60 },
      { type: "touch", phase: "move", x: 3, y: 0 },
      { type: "key", key: "Enter" },
    ]);
  });

  it("drops what still waits when the takeover ends", async () => {
    const lane = createLane<string>({
      apply: async () => {
        await later(30);
        return ok(undefined);
      },
      merge: apart,
      limitMs: () => 1000,
    });

    const first = lane.push("now");
    const second = lane.push("later");
    lane.clear("The page went back to Kumo.");

    expect(await first).toEqual(ok(undefined));
    expect(await second).toEqual(fail("The page went back to Kumo."));
  });
});

describe("the focus, read beside his input", () => {
  it("tells the newest reading, and lets a hung one go so the next can start", async () => {
    const told = createCell<readonly string[]>([]);
    const readings = createCell<readonly (() => Promise<string>)[]>([
      () => never,
      async () => {
        await later(5);
        return "password";
      },
    ]);
    const reporter = createReporter({
      read: () => {
        const [next = () => Promise.resolve("none"), ...rest] = readings.get();
        readings.set(rest);
        return next();
      },
      report: (value) => {
        told.update((current) => [...current, value]);
      },
      delayMs: 1,
      limitMs: 40,
      retryMs: 10,
    });

    reporter.request();
    await later(200);

    expect(told.get()).toEqual(["password"]);
    reporter.stop();
  });

  it("tells nothing once stopped, even what it was reading", async () => {
    const told = createCell<readonly string[]>([]);
    const reporter = createReporter({
      read: async () => {
        await later(20);
        return "email";
      },
      report: (value) => {
        told.update((current) => [...current, value]);
      },
      delayMs: 1,
    });

    reporter.request();
    await later(5);
    reporter.stop();
    await later(60);

    expect(told.get()).toEqual([]);
  });
});

describe("where a touch lands", () => {
  it("is the CSS pixel under his finger, on a page zoomed in and panned or not", () => {
    expect(toPagePoint({ scale: 1, x: 0, y: 0 }, { x: 120, y: 300 })).toEqual({ x: 120, y: 300 });
    expect(toPagePoint({ scale: 2, x: 40, y: 500 }, { x: 120, y: 300 })).toEqual({ x: 100, y: 650 });
    expect(toScreenBox({ scale: 2, x: 40, y: 500 }, { x: 100, y: 650, width: 50, height: 20 })).toEqual({
      x: 120,
      y: 300,
      width: 100,
      height: 40,
    });
  });
});

describe("where Chromium draws", () => {
  it("is headful on a Linux server's display, and on Xvfb started for it when there's none", async () => {
    const onDisplay = await startDisplay({ platform: "linux", environment: { DISPLAY: ":7" } });
    expect(onDisplay).toMatchObject({ mode: "headful", environment: { DISPLAY: ":7" } });

    const missing = await startDisplay({ platform: "linux", environment: {}, xvfb: "/nonexistent/Xvfb" });
    expect(missing.mode).toBe("headless");
    expect(missing.detail).toContain("Xvfb isn't installed");
    expect(missing.detail).toContain("sudo apt install xvfb");
  });

  it("is headless on a Mac unless asked, and wherever ITO_BROWSER says headless", async () => {
    const mac = await startDisplay({ platform: "darwin", environment: {} });
    const asked = await startDisplay({ platform: "darwin", environment: { ITO_BROWSER: "headful" } });
    const forced = await startDisplay({ platform: "linux", environment: { ITO_BROWSER: "headless", DISPLAY: ":1" } });

    expect([mac.mode, asked.mode, forced.mode]).toEqual(["headless", "headful", "headless"]);
  });

  it.skipIf(process.platform !== "linux")("starts Xvfb itself when it's installed, and stops it after", async () => {
    const display = await startDisplay({ platform: "linux", environment: {} });
    if (display.detail.includes("isn't installed")) return;

    expect(display.mode).toBe("headful");
    expect(display.environment.DISPLAY).toMatch(/^:\d+$/u);
    display.stop();
  });
});

describe("why a capability stopped", () => {
  it("names the missing package and the fix when the server skipped npm ci", () => {
    const written = [
      "node:internal/modules/package_json_reader:268",
      "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
      "        ^",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from /srv/ito-core/capabilities/browser/session.ts",
      "    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:268:9)",
      "Node.js v24.19.0",
    ];

    expect(explainStop("browser", written)).toBe(
      "browser couldn't start: the playwright package isn't installed on the server. To fix it, run npm ci " +
        "--omit=dev in the ito-core folder, then switch browser off and on.",
    );
  });

  it("gives the error it threw otherwise, and nothing when it wrote nothing that says", () => {
    expect(explainStop("echo", ["TypeError: values.token is undefined", "    at start"], false)).toBe(
      "echo stopped: TypeError: values.token is undefined",
    );
    expect(explainStop("echo", ["Listening", "Node.js v24.19.0"])).toBeUndefined();
  });
});
