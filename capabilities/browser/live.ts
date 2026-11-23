import type { CDPSession, Page } from "playwright";
import { z } from "zod";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import { focusOf, selectFocused, type Field } from "./page.ts";
import { quietly } from "./quietly.ts";
import type { Session } from "./session.ts";

// The live view: Chrome's own screencast of the tab, frame by frame as it paints, and his touches, keys and text
// sent back into it during a takeover. Nothing here goes through a desktop or a virtual display.

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

export type LiveOptions = {
  readonly session: Session;
  readonly onFrame: (frame: Frame) => void;
  readonly onFocus: (field: Field | undefined) => void;
};

export type Live = {
  readonly watch: (on: boolean) => Promise<void>;
  readonly retarget: () => Promise<void>;
  readonly isWatching: () => boolean;
  readonly input: (page: Page, input: Input) => Promise<Result<undefined, string>>;
};

type Cast = {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly listener: (frame: ScreencastFrame) => void;
};

const quality = 60;

const sharpQuality = 75;

// How long the page stays still before the sharp frame.
const stillMs = 250;

type ScreencastFrame = {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number; readonly timestamp?: number };
};

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

export const createLive = ({ session, onFrame, onFocus }: LiveOptions): Live => {
  const isWatching = createCell(false);
  const cast = createCell<Cast | undefined>(undefined);
  const painted = createCell(0);
  const still = createCell<NodeJS.Timeout | undefined>(undefined);

  // Once nothing has painted for a moment, a sharp frame at the phone's scale, unless something paints meanwhile.
  const sharpen = async (page: Page, width: number, height: number): Promise<void> => {
    const count = painted.get();
    const picture = await quietly(
      page.screenshot({ type: "jpeg", quality: sharpQuality, scale: "device", timeout: 3000 }),
    );
    if (!picture || painted.get() !== count || cast.get()?.page !== page) return;
    onFrame({ data: picture.toString("base64"), width, height, scale: 2, at: Date.now() });
  };

  const stop = async (): Promise<void> => {
    const running = cast.get();
    cast.set(undefined);
    clearTimeout(still.get());
    if (!running) return;
    running.cdp.off("Page.screencastFrame", running.listener);
    await quietly(running.cdp.send("Page.stopScreencast"));
  };

  const start = async (): Promise<void> => {
    const page = session.active();
    if (!page || page.isClosed()) return;
    const cdp = await session.cdp(page);
    const viewport = page.viewportSize() ?? { width: 393, height: 659 };
    const listener = (frame: ScreencastFrame): void => {
      void quietly(cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }));
      if (cast.get()?.cdp !== cdp) return;
      const { deviceWidth: width, deviceHeight: height } = frame.metadata;
      painted.update((count) => count + 1);
      onFrame({ data: frame.data, width, height, scale: 1, at: Date.now() });
      clearTimeout(still.get());
      still.set(
        setTimeout(() => {
          void sharpen(page, width, height);
        }, stillMs),
      );
    };
    cdp.on("Page.screencastFrame", listener);
    cast.set({ page, cdp, listener });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      maxWidth: viewport.width * 2,
      maxHeight: viewport.height * 2,
      everyNthFrame: 1,
    });
  };

  const reportFocus = async (page: Page): Promise<void> => {
    onFocus(await quietly(focusOf(page)));
  };

  const touch = async (page: Page, phase: "start" | "move" | "end" | "cancel", x: number, y: number): Promise<void> => {
    const cdp = await session.cdp(page);
    const types = { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" } as const;
    const type = types[phase];
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: phase === "end" || phase === "cancel" ? [] : [{ x, y }],
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

  return {
    watch: async (on) => {
      isWatching.set(on);
      await stop();
      if (on) await start();
    },
    retarget: async () => {
      if (!isWatching.get() || cast.get()?.page === session.active()) return;
      await stop();
      await start();
    },
    isWatching: () => isWatching.get(),
    input: async (page, input) => {
      try {
        switch (input.type) {
          case "tap": {
            await page.touchscreen.tap(input.x, input.y);
            await reportFocus(page);
            return ok(undefined);
          }
          case "touch": {
            await touch(page, input.phase, input.x, input.y);
            if (input.phase === "end") await reportFocus(page);
            return ok(undefined);
          }
          case "scroll": {
            const cdp = await session.cdp(page);
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: input.x,
              y: input.y,
              deltaX: input.dx,
              deltaY: input.dy,
            });
            await reportFocus(page);
            return ok(undefined);
          }
          case "text": {
            await page.keyboard.insertText(input.text);
            await reportFocus(page);
            return ok(undefined);
          }
          case "fill": {
            const isSelected = await selectFocused(page);
            if (!isSelected) return fail("Nothing editable has the focus: tap a field first.");
            await (input.text === "" ? page.keyboard.press("Backspace") : page.keyboard.insertText(input.text));
            await reportFocus(page);
            return ok(undefined);
          }
          case "key": {
            await page.keyboard.press(input.key);
            await reportFocus(page);
            return ok(undefined);
          }
          case "navigate": {
            return await navigate(page, input);
          }
        }
      } catch (error) {
        return fail(error instanceof Error ? (error.message.split("\n", 1)[0] ?? error.message) : String(error));
      }
    },
  };
};
