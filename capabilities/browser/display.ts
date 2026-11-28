import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createCell } from "#cell.ts";

// Where Chromium draws. On a Linux server it runs headful, as a person's browser does, on a virtual display: one
// that's already there ($DISPLAY, such as under xvfb-run), or Xvfb started here for as long as Chromium runs. Sites
// trust a headful browser more than a headless one, so logins and CAPTCHAs behave as they do on a laptop. Headless is
// the fallback only when no display can start, and it says why. A Mac has no virtual display, so there it runs
// headless unless ITO_BROWSER=headful asks for a window on the desktop; ITO_BROWSER=headless forces headless anywhere.

export type DisplayMode = "headful" | "headless";

export type Display = {
  readonly mode: DisplayMode;
  // In a few plain words: where it draws, or why it's headless.
  readonly detail: string;
  // What Chromium's environment needs, such as DISPLAY.
  readonly environment: Readonly<Record<string, string>>;
  readonly stop: () => void;
};

export type DisplayOptions = {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly xvfb?: string;
  readonly startMs?: number;
};

export const xvfbFix =
  "To fix it, install Xvfb on the server (sudo apt install xvfb), then switch the browser off and on.";

const nothing = (): void => {
  // Nothing was started, so nothing stops.
};

const headless = (detail: string): Display => ({ mode: "headless", detail, environment: {}, stop: nothing });

const firstLine = (text: string): string => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

// Starts Xvfb on the first free display, which it names on a pipe once it's ready to draw on. The screen is large
// enough for the phone's page at 2x, whatever size the takeover gives it.
const startXvfb = (xvfb: string, startMs: number): Promise<Display> =>
  new Promise((resolve) => {
    const child = spawn(xvfb, ["-displayfd", "3", "-screen", "0", "2560x2560x24", "-nolisten", "tcp", "-noreset"], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const named = createCell("");
    const errors = createCell("");
    const isDone = createCell(false);
    const timer = createCell<NodeJS.Timeout | undefined>(undefined);
    const finish = (display: Display): void => {
      if (isDone.get()) return;
      isDone.set(true);
      clearTimeout(timer.get());
      resolve(display);
    };
    timer.set(
      setTimeout(() => {
        child.kill("SIGKILL");
        finish(headless(`Xvfb didn't start in time. ${xvfbFix}`));
      }, startMs),
    );
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      errors.update((current) => `${current}${chunk}`.slice(-2000));
    });
    (child.stdio[3] as Readable | null)?.setEncoding("utf8").on("data", (chunk: string) => {
      const text = named.update((current) => `${current}${chunk}`);
      const number = /^(?<display>\d+)\n/u.exec(text)?.groups?.display;
      if (number === undefined) return;
      finish({
        mode: "headful",
        detail: `a virtual display (Xvfb :${number})`,
        environment: { DISPLAY: `:${number}` },
        stop: () => {
          child.kill("SIGTERM");
        },
      });
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        headless(
          error.code === "ENOENT"
            ? `Xvfb isn't installed, so it runs headless. ${xvfbFix}`
            : `Xvfb couldn't start (${error.message}). ${xvfbFix}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      const why = firstLine(errors.get()) || (signal ? `killed by ${signal}` : `exited with code ${String(code)}`);
      finish(headless(`Xvfb stopped as it started (${why}). ${xvfbFix}`));
    });
  });

export const startDisplay = async ({
  platform = process.platform,
  environment = process.env,
  xvfb = "Xvfb",
  startMs = 5000,
}: DisplayOptions = {}): Promise<Display> => {
  const asked = environment.ITO_BROWSER;
  if (asked === "headless") return headless("headless, as ITO_BROWSER asks");
  if (platform !== "linux") {
    return asked === "headful"
      ? { mode: "headful", detail: "a window on the desktop", environment: {}, stop: nothing }
      : headless("headless, as on any Mac or PC without ITO_BROWSER=headful");
  }
  const display = environment.DISPLAY;
  return display === undefined || display === ""
    ? startXvfb(xvfb, startMs)
    : { mode: "headful", detail: `the display ${display}`, environment: { DISPLAY: display }, stop: nothing };
};
