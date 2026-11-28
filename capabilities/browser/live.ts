import type { CDPSession, Locator, Page, Frame as PageFrame } from "playwright";
import { z } from "zod";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import { createLane } from "./lane.ts";
import { focusOf, revealFocus, toPagePoint, toScreenBox, unzoomed, type Box, type Field, type Visual } from "./page.ts";
import { inTime, quietly } from "./quietly.ts";
import { createReporter } from "./reporter.ts";
import type { Session, Size } from "./session.ts";

// The live view: Chrome's own screencast of the tab, frame by frame as it paints, and his touches, keys and text
// sent back into it during a takeover. Nothing here goes through a desktop or a virtual display.
//
// His input never waits on anything else: each goes to the page at once, in order, through a lane of its own (see
// lane.ts), and what the page says back, such as the field with the focus, is read beside it, newest first, never in
// its way (see reporter.ts). The page's viewport is the room his phone has for it, so nothing sits under the phone's
// bars, and a touch lands on the CSS pixel he sees under his finger, zoomed or not. When the page should have painted
// and no frame came, the screencast starts again, or stills take its place, and the phone hears it's reconnecting
// rather than looking at a frozen picture.

export const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal("touch"),
    phase: z.enum(["start", "move", "end", "cancel"]),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ type: z.literal("scroll"), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("fill"), text: z.string().max(10_000) }),
  z.object({
    type: z.literal("key"),
    key: z.enum(["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
  }),
  z.object({
    type: z.literal("navigate"),
    url: z.string().min(1).max(4000).optional(),
    action: z.enum(["back", "forward", "reload"]).optional(),
  }),
  // The room the page has on his screen, between the takeover's header and its bar, and how much of it the keyboard
  // covers from the bottom while it's up.
  z.object({
    type: z.literal("viewport"),
    width: z.number().positive().max(4000),
    height: z.number().positive().max(4000),
    keyboard: z.number().min(0).max(4000).optional(),
  }),
]);

export type Input = z.infer<typeof inputSchema>;

// A frame of the tab: a JPEG, base64, of the whole viewport, `width` by `height` CSS pixels, at `scale` image pixels
// to each. Chrome's screencast sends one at 1x as soon as anything paints; once the page has been still for a moment,
// a sharp one at the phone's own 2x follows, so text reads cleanly while he looks and moving stays quick.
export type Frame = {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly at: number;
};

// Whether frames are flowing: `reconnecting` once the page should have painted and neither the screencast nor a
// still could show it.
export type Link = "live" | "reconnecting";

// The site's own button a payment waits on, for the phone to ring: its box on screen, in CSS pixels from the top left.
export type Mark = { readonly box: Box; readonly label: string };

export type MarkTarget = { readonly page: Page; readonly locator: Locator; readonly label: string };

export type LiveOptions = {
  readonly session: Session;
  readonly onFrame: (frame: Frame) => void;
  readonly onFocus: (field: Field | undefined) => void;
  readonly onLink?: (link: Link) => void;
  readonly onMark?: (mark: Mark | undefined) => void;
  // The viewport changed size, such as for the keyboard.
  readonly onResize?: () => void;
  // How long the page has to paint after an input before the screencast is thought stalled.
  readonly stallMs?: number;
};

export type Live = {
  readonly watch: (on: boolean) => Promise<void>;
  readonly retarget: () => Promise<void>;
  readonly isWatching: () => boolean;
  // He holds the page, or no longer does.
  readonly hold: (on: boolean) => Promise<void>;
  readonly input: (page: Page, input: Input) => Promise<Result<undefined, string>>;
  // The button to ring, or none.
  readonly track: (target: MarkTarget | undefined) => void;
  readonly link: () => Link;
};

type Cast = {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly listener: (frame: ScreencastFrame) => void;
  readonly onNavigated: (frame: PageFrame) => void;
  readonly onLoad: () => void;
};

type Queued = { readonly page: Page; readonly input: Input };

type ScreencastFrame = {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: {
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly pageScaleFactor?: number;
    readonly timestamp?: number;
  };
};

type LayoutMetrics = {
  readonly cssVisualViewport: {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly pageX: number;
    readonly pageY: number;
    readonly clientWidth: number;
    readonly clientHeight: number;
    readonly scale: number;
  };
};

const quality = 60;

const sharpQuality = 75;

// How long the page stays still before the sharp frame.
const stillMs = 250;

// How long one input may take before the next goes on.
const inputMs = 1500;

// How often the screencast's health is looked at, how long a restarted one has to show a frame, and how often stills
// come while it's down.
const watchdogMs = 250;
const restartedMs = 1000;
const stillsEveryMs = 700;
const castRetryMs = 5000;

const cdpMs = 3000;

// How long the page's own process has to answer before it's thought frozen, and how often a quiet page is asked.
const answerMs = 1000;
const probeMs = 1000;

// How long after a sharp frame is taken the frame its taking paints is dropped.
const echoMs = 150;

const types = { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" } as const;

export const toUrl = (given: string): string | undefined => {
  const text = given.trim();
  const withScheme = /^[a-z][\w+.-]*:/iu.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

// Two inputs as one, where waiting ones can be: a finger's moves keep only the latest place, scrolls add up, and
// sizes keep the latest.
export const mergeInputs = (waiting: Input, next: Input): Input | undefined => {
  if (waiting.type === "touch" && next.type === "touch" && waiting.phase === "move" && next.phase === "move") {
    return next;
  }
  if (waiting.type === "scroll" && next.type === "scroll") {
    return { ...next, dx: waiting.dx + next.dx, dy: waiting.dy + next.dy };
  }
  if (waiting.type === "viewport" && next.type === "viewport") return next;
  return undefined;
};

const sameBox = (left: Box | undefined, right: Box | undefined): boolean =>
  JSON.stringify(left && roundBox(left)) === JSON.stringify(right && roundBox(right));

const roundBox = ({ x, y, width, height }: Box): Box => ({
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(width),
  height: Math.round(height),
});

const describe = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n", 1)[0] ?? error.message) : String(error);

const ignore = (): void => {
  // Nobody follows this.
};

// Whether the page's own process answers at once, even if only to say no, as it does unless it's frozen or busy.
const answers = async (cdp: CDPSession): Promise<boolean> => {
  const settled = async (): Promise<boolean> => {
    await quietly(cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }));
    return true;
  };
  return (await inTime(settled(), answerMs)) === true;
};

// A still of the viewport, as the screen shows it, for when the screencast has nothing to give.
const takeStill = async (cdp: CDPSession, width: number, height: number): Promise<Frame | undefined> => {
  const shot = await inTime<{ readonly data: string }>(
    cdp.send("Page.captureScreenshot", { format: "jpeg", quality }),
    1500,
  );
  return shot && { data: shot.data, width, height, scale: 1, at: Date.now() };
};

export const createLive = ({
  session,
  onFrame,
  onFocus,
  onLink = ignore,
  onMark = ignore,
  onResize = ignore,
  stallMs = 1500,
}: LiveOptions): Live => {
  const isWatching = createCell(false);
  const isHolding = createCell(false);
  const cast = createCell<Cast | undefined>(undefined);
  const painted = createCell(0);
  const still = createCell<NodeJS.Timeout | undefined>(undefined);
  const visual = createCell<Visual>(unzoomed);
  const measuredAt = createCell(0);
  const link = createCell<Link>("live");
  // When the page should have painted by, if nothing has since it was asked to.
  const due = createCell<number | undefined>(undefined);
  const isRecovering = createCell(false);
  const isStills = createCell(false);
  const lastStill = createCell(0);
  const lastRestart = createCell(0);
  const watchdog = createCell<NodeJS.Timeout | undefined>(undefined);
  const shownFocus = createCell<string>("");
  const target = createCell<MarkTarget | undefined>(undefined);
  const shownMark = createCell<Mark | undefined>(undefined);
  const markAsked = createCell(0);
  // Until when a frame is the echo of a sharp frame being taken.
  const capturing = createCell(0);
  const lastFrame = createCell(0);
  const lastProbe = createCell(0);

  const setLink = (next: Link): void => {
    if (link.get() === next) return;
    link.set(next);
    onLink(next);
  };

  // Something reached the screen: the link is live.
  const arrived = (frame: Frame): void => {
    lastStill.set(Date.now());
    lastFrame.set(Date.now());
    onFrame(frame);
    setLink("live");
  };

  const expectPaint = (): void => {
    if (!isWatching.get() || due.get() !== undefined) return;
    due.set(Date.now() + stallMs);
  };

  // Where the page is zoomed and panned to, from Chrome itself, without running anything in the page.
  const measure = async (cdp: CDPSession): Promise<Visual | undefined> => {
    const metrics = (await inTime(cdp.send("Page.getLayoutMetrics"), 500)) as LayoutMetrics | undefined;
    const viewport = metrics?.cssVisualViewport;
    if (!viewport) return undefined;
    const measured: Visual = { scale: viewport.scale || 1, x: viewport.offsetX, y: viewport.offsetY };
    visual.set(measured);
    measuredAt.set(Date.now());
    return measured;
  };

  const currentVisual = async (page: Page): Promise<Visual> => {
    if (visual.get().scale === 1) return unzoomed;
    const cdp = await inTime(session.cdp(page), 500);
    return (cdp && (await measure(cdp))) ?? visual.get();
  };

  const focus = createReporter({
    read: async () => {
      const page = session.active();
      return !page || page.isClosed() || !isHolding.get() ? undefined : focusOf(page, await currentVisual(page));
    },
    report: (field) => {
      const shown = field ? JSON.stringify({ ...field, box: roundBox(field.box) }) : "";
      if (shown === shownFocus.get()) return;
      shownFocus.set(shown);
      onFocus(field);
    },
  });

  const markReader = createReporter({
    read: async (): Promise<Mark | undefined> => {
      const tracked = target.get();
      if (!tracked || tracked.page.isClosed() || tracked.page !== session.active()) return undefined;
      const box = await tracked.locator.boundingBox({ timeout: 500 });
      return box ? { box: toScreenBox(await currentVisual(tracked.page), box), label: tracked.label } : undefined;
    },
    report: (mark) => {
      const shown = shownMark.get();
      if (shown?.label === mark?.label && sameBox(shown?.box, mark?.box)) return;
      shownMark.set(mark);
      onMark(mark && { ...mark, box: roundBox(mark.box) });
    },
    limitMs: 1000,
    retries: 1,
  });

  const askMark = (): void => {
    if (!target.get() || Date.now() - markAsked.get() < 150) return;
    markAsked.set(Date.now());
    markReader.request();
  };

  // Once nothing has painted for a moment, a sharp frame at the phone's scale, of exactly what's on screen, zoomed or
  // not, unless something paints meanwhile. Taking it makes Chrome paint once more, the same picture: that frame is
  // dropped, or every sharp frame would ask for another.
  const sharpen = async (page: Page, cdp: CDPSession, width: number, height: number): Promise<void> => {
    const count = painted.get();
    capturing.set(Infinity);
    const shot = await inTime<{ readonly data: string }>(
      cdp.send("Page.captureScreenshot", { format: "jpeg", quality: sharpQuality }),
      cdpMs,
    );
    capturing.set(Date.now() + echoMs);
    if (!shot || painted.get() !== count || cast.get()?.page !== page) return;
    arrived({ data: shot.data, width, height, scale: 2, at: Date.now() });
  };

  const size = (page: Page): Size => page.viewportSize() ?? session.room();

  // A new document, such as the password step after the email one, may put the focus in a field by itself.
  const onNavigated = (frame: PageFrame): void => {
    if (frame.parentFrame() !== null) return;
    expectPaint();
    if (isHolding.get()) focus.request();
  };

  const onLoad = (): void => {
    if (isHolding.get()) focus.request();
    askMark();
  };

  const stop = async (): Promise<void> => {
    const running = cast.get();
    cast.set(undefined);
    clearTimeout(still.get());
    if (!running) return;
    running.cdp.off("Page.screencastFrame", running.listener);
    running.page.off("framenavigated", running.onNavigated);
    running.page.off("load", running.onLoad);
    await inTime(running.cdp.send("Page.stopScreencast"), cdpMs);
  };

  const start = async (): Promise<void> => {
    const page = session.active();
    if (!page || page.isClosed()) return;
    const cdp = await inTime(session.cdp(page), cdpMs);
    if (!cdp) return;
    const viewport = size(page);
    const listener = (frame: ScreencastFrame): void => {
      void quietly(cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }));
      if (cast.get()?.cdp !== cdp || Date.now() < capturing.get()) return;
      const { deviceWidth: width, deviceHeight: height, pageScaleFactor = 1 } = frame.metadata;
      painted.update((count) => count + 1);
      due.set(undefined);
      isStills.set(false);
      const zoom = visual.get();
      if (pageScaleFactor === 1 && zoom.scale !== 1) visual.set(unzoomed);
      if (pageScaleFactor !== 1 && (zoom.scale !== pageScaleFactor || Date.now() - measuredAt.get() > 200)) {
        visual.set({ ...zoom, scale: pageScaleFactor });
        void measure(cdp);
      }
      arrived({ data: frame.data, width, height, scale: 1, at: Date.now() });
      askMark();
      clearTimeout(still.get());
      still.set(
        setTimeout(() => {
          void sharpen(page, cdp, width, height);
        }, stillMs),
      );
    };
    cdp.on("Page.screencastFrame", listener);
    page.on("framenavigated", onNavigated);
    page.on("load", onLoad);
    cast.set({ page, cdp, listener, onNavigated, onLoad });
    lastRestart.set(Date.now());
    await inTime(
      cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality,
        // While it moves, frames at 1x, so they stay quick; the sharp one once it's still is at 2x.
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1,
      }),
      cdpMs,
    );
  };

  const restart = async (): Promise<void> => {
    await stop();
    if (isWatching.get()) await start();
  };

  // The page should have painted and no frame came. If the page's process doesn't answer, it's frozen or busy: say
  // it's reconnecting, rather than leave the old picture up as if it were live, and look again soon. If it answers,
  // the screencast is what's stuck: start it again, which always sends a frame, and if none comes even then, show
  // stills in its place while it's down.
  const recover = async (): Promise<void> => {
    if (isRecovering.get()) return;
    isRecovering.set(true);
    try {
      due.set(undefined);
      const page = cast.get()?.page ?? session.active();
      const cdp = page ? await inTime(session.cdp(page), 500) : undefined;
      if (!page || !cdp || !(await answers(cdp))) {
        setLink("reconnecting");
        due.set(Date.now() + restartedMs);
        return;
      }
      const before = painted.get();
      await restart();
      await new Promise((resolve) => setTimeout(resolve, restartedMs));
      if (painted.get() !== before || !isWatching.get()) return;
      const running = cast.get();
      const picture = running && (await takeStill(running.cdp, size(running.page).width, size(running.page).height));
      if (picture) {
        isStills.set(true);
        arrived(picture);
        return;
      }
      setLink("reconnecting");
      due.set(Date.now() + restartedMs);
    } finally {
      isRecovering.set(false);
    }
  };

  // While he holds a page that hasn't painted for a while, whether it's still there: a frozen one shows as
  // reconnecting even when nothing was asked of it, and once it answers again, a fresh frame brings it back.
  const probe = async (): Promise<void> => {
    lastProbe.set(Date.now());
    const running = cast.get();
    if (!running) return;
    if (!(await answers(running.cdp))) {
      setLink("reconnecting");
      return;
    }
    if (link.get() === "reconnecting") due.set(Date.now());
  };

  const look = (): void => {
    if (!isWatching.get() || isRecovering.get()) return;
    const deadline = due.get();
    if (deadline !== undefined && Date.now() >= deadline) {
      void recover();
      return;
    }
    const isQuiet = Date.now() - lastFrame.get() >= stallMs && Date.now() - lastProbe.get() >= probeMs;
    if (isQuiet && (isHolding.get() || link.get() === "reconnecting")) void probe();
    if (!isStills.get() || Date.now() - lastStill.get() < stillsEveryMs) return;
    // While the screencast is down, a still now and then, and now and then another try at the screencast.
    lastStill.set(Date.now());
    void (async () => {
      if (Date.now() - lastRestart.get() >= castRetryMs) await restart();
      const running = cast.get();
      if (!running || !isStills.get()) return;
      const viewport = size(running.page);
      const picture = (await answers(running.cdp))
        ? await takeStill(running.cdp, viewport.width, viewport.height)
        : undefined;
      if (picture && isStills.get()) arrived(picture);
      else if (!picture) setLink("reconnecting");
    })();
  };

  const startWatchdog = (): void => {
    clearInterval(watchdog.get());
    const timer = setInterval(look, watchdogMs);
    timer.unref();
    watchdog.set(timer);
  };

  const stopWatchdog = (): void => {
    clearInterval(watchdog.get());
    watchdog.set(undefined);
    due.set(undefined);
    isStills.set(false);
    setLink("live");
  };

  const point = async (page: Page, x: number, y: number) => toPagePoint(await currentVisual(page), { x, y });

  const touch = async (page: Page, phase: "start" | "move" | "end" | "cancel", x: number, y: number): Promise<void> => {
    const cdp = await session.cdp(page);
    const at = await point(page, x, y);
    await cdp.send("Input.dispatchTouchEvent", {
      type: types[phase],
      touchPoints: phase === "end" || phase === "cancel" ? [] : [at],
    });
  };

  const navigate = async (
    page: Page,
    { url, action }: { readonly url?: string; readonly action?: "back" | "forward" | "reload" },
  ): Promise<Result<undefined, string>> => {
    if (url !== undefined) {
      const address = toUrl(url);
      if (!address) return fail("That isn't a web address.");
      await page.goto(address, { waitUntil: "commit" });
      return ok(undefined);
    }
    switch (action) {
      case "back": {
        await page.goBack({ waitUntil: "commit" });
        break;
      }
      case "forward": {
        await page.goForward({ waitUntil: "commit" });
        break;
      }
      case "reload": {
        await page.reload({ waitUntil: "commit" });
        break;
      }
      case undefined: {
        return fail("Give a url or an action.");
      }
    }
    return ok(undefined);
  };

  // The room changed: the viewport follows, as a phone's browser does when its bars or keyboard come and go, the field
  // he's typing in comes back into view, and frames come at the new size.
  const resize = async (page: Page, width: number, height: number, keyboard: number): Promise<void> => {
    const before = size(page);
    await session.fit({ width, height: height - keyboard }, keyboard === 0);
    const after = size(page);
    if (before.width === after.width && before.height === after.height) return;
    onResize();
    if (keyboard > 0) await revealFocus(page);
    if (isWatching.get()) await restart();
  };

  const apply = async ({ page, input }: Queued): Promise<Result<undefined, string>> => {
    if (page.isClosed()) return fail("That page has closed.");
    switch (input.type) {
      case "tap": {
        await touch(page, "start", input.x, input.y);
        await touch(page, "end", input.x, input.y);
        break;
      }
      case "touch": {
        await touch(page, input.phase, input.x, input.y);
        break;
      }
      case "scroll": {
        const cdp = await session.cdp(page);
        const zoom = await currentVisual(page);
        const at = toPagePoint(zoom, input);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: input.dx / zoom.scale,
          deltaY: input.dy / zoom.scale,
        });
        break;
      }
      case "text": {
        await page.keyboard.insertText(input.text);
        break;
      }
      case "fill": {
        // Replaces what the field with the focus holds, wherever it is, frames included, without looking for it.
        await page.keyboard.press("ControlOrMeta+A");
        await (input.text === "" ? page.keyboard.press("Backspace") : page.keyboard.insertText(input.text));
        break;
      }
      case "key": {
        await page.keyboard.press(input.key);
        break;
      }
      case "navigate": {
        const went = await navigate(page, input);
        if (!went.ok) return went;
        break;
      }
      case "viewport": {
        await resize(page, input.width, input.height, Math.min(input.keyboard ?? 0, input.height - 1));
        break;
      }
    }
    return ok(undefined);
  };

  const lane = createLane<Queued>({
    apply: async (queued) => {
      // From now, the page has a moment to paint: an input on a frozen page shows as reconnecting soon after.
      if (queued.input.type !== "viewport") expectPaint();
      try {
        return await apply(queued);
      } catch (error) {
        return fail(describe(error));
      } finally {
        if (queued.input.type !== "viewport") expectPaint();
        if (!(queued.input.type === "touch" && queued.input.phase === "move")) focus.request();
        askMark();
      }
    },
    merge: (waiting, next) => {
      if (waiting.page !== next.page) return;
      const merged = mergeInputs(waiting.input, next.input);
      return merged && { page: next.page, input: merged };
    },
    limitMs: ({ input }) => (input.type === "viewport" ? cdpMs : input.type === "navigate" ? 2000 : inputMs),
  });

  return {
    watch: async (on) => {
      isWatching.set(on);
      await stop();
      if (on) {
        startWatchdog();
        await start();
      } else stopWatchdog();
    },
    retarget: async () => {
      if (!isWatching.get() || cast.get()?.page === session.active()) return;
      await restart();
      if (isHolding.get()) focus.request();
    },
    isWatching: () => isWatching.get(),
    hold: async (on) => {
      isHolding.set(on);
      if (on) {
        focus.request();
        return;
      }
      lane.clear("The page went back to Kumo.");
      focus.stop();
      if (shownFocus.get() !== "") {
        shownFocus.set("");
        onFocus(undefined);
      }
      const page = session.active();
      const before = page ? size(page) : undefined;
      // The keyboard is gone with the takeover: the page has his whole room again.
      await session.fit(session.room(), false);
      if (!(page && before && (before.height !== size(page).height || before.width !== size(page).width))) {
        return;
      }

      onResize();
      if (isWatching.get()) await restart();
    },
    input: (page, input) => lane.push({ page, input }),
    track: (given) => {
      target.set(given);
      if (given) {
        markAsked.set(0);
        askMark();
        return;
      }
      markReader.stop();
      if (shownMark.get() === undefined) return;
      shownMark.set(undefined);
      onMark(undefined);
    },
    link: () => link.get(),
  };
};
