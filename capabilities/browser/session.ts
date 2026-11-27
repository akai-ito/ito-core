import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices, type BrowserContext, type CDPSession, type Download, type Page } from "playwright";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import { startDisplay, type Display, type DisplayMode } from "./display.ts";
import { inTime, quietly } from "./quietly.ts";

// One Chromium on the server, with one persistent profile that keeps his logins between restarts. It always browses
// at his phone's size, with touch and a phone's user agent, so the page Kumo reads is the page he takes over,
// unchanged: an iPhone's until his phone says the room it has for the page, then that. On a Linux server it's headful
// on a virtual display, as sites trust a headful browser more (see display.ts); the live view comes from Chrome's own
// screencast either way, never from the display.

export const phone = { ...devices["iPhone 15 Pro"], deviceScaleFactor: 2 };

// The iPhone's whole screen, which the page's own screen size follows.
const phoneScreen = { width: 393, height: 852 };

export type Size = { readonly width: number; readonly height: number };

// The room a page can have, in CSS pixels, whatever a phone says.
export const roomLimits = { width: { min: 280, max: 600 }, height: { min: 200, max: 1400 } } as const;

const within = (value: number, { min, max }: { readonly min: number; readonly max: number }): number =>
  Math.round(Math.min(Math.max(value, min), max));

export const toRoom = ({ width, height }: Size): Size => ({
  width: within(width, roomLimits.width),
  height: within(height, roomLimits.height),
});

export type Mode = { readonly mode: DisplayMode; readonly detail: string };

export type Navigation = { readonly main: number; readonly frames: number };

export type SessionOptions = {
  readonly profile: string;
  readonly downloads: () => string;
  readonly executablePath?: string;
  // Where to keep the room his phone last said it has, so a restart browses at his size.
  readonly roomFile?: string;
  readonly display?: () => Promise<Display>;
  readonly onTabs: () => void;
  readonly info: (line: string) => void;
};

export type Session = {
  readonly ensure: () => Promise<Result<Page, string>>;
  readonly active: () => Page | undefined;
  readonly tabs: () => readonly Page[];
  readonly select: (index: number) => Result<Page, string>;
  readonly closeTab: (index: number) => Promise<Result<undefined, string>>;
  readonly newTab: () => Promise<Result<Page, string>>;
  readonly navigation: (page: Page) => Navigation;
  readonly notes: () => readonly string[];
  readonly expectDownload: <Value>(work: () => Promise<Value>) => Promise<Value>;
  readonly cdp: (page: Page) => Promise<CDPSession>;
  readonly isOpen: () => boolean;
  // Headful or headless, and where it draws or why not, once Chromium has started.
  readonly mode: () => Mode | undefined;
  // The room his phone has for the page now, which every tab browses at.
  readonly room: () => Size;
  // Makes every tab's viewport `size`; with `keep`, it's his phone's room from now on, kept across restarts, and not
  // just for now, as while the keyboard is up.
  readonly fit: (size: Size, keep: boolean) => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

export const chromiumPath = (given?: string): string => given ?? chromium.executablePath();

export const missingChromium = (given?: string): string | undefined => {
  const file = chromiumPath(given);
  return existsSync(file)
    ? undefined
    : "Chromium isn't installed on the server. In the ito-core folder, run: npx playwright install --with-deps chromium";
};

const safeName = (name: string): string => name.replaceAll(/[^\w.-]+/gu, "-").slice(-120) || "download";

export const keepDownload = async (download: Download, folder: string): Promise<string> => {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${String(Date.now())}-${safeName(download.suggestedFilename())}`);
  await download.saveAs(file);
  return file;
};

const loadRoom = (file: string | undefined): Size | undefined => {
  if (file === undefined || !existsSync(file)) return undefined;
  try {
    const { width, height } = JSON.parse(readFileSync(file, "utf8")) as Partial<Size>;
    return typeof width === "number" && typeof height === "number" ? toRoom({ width, height }) : undefined;
  } catch {
    return undefined;
  }
};

const keepRoom = (file: string, size: Size): void => {
  try {
    writeFileSync(file, JSON.stringify(size), { mode: 0o600 });
  } catch {
    // Kept for now only: a restart browses at the iPhone's size until his phone says its room again.
  }
};

const fitMs = 3000;

export const createSession = ({
  profile,
  downloads,
  executablePath,
  roomFile,
  display: openDisplay = startDisplay,
  onTabs,
  info,
}: SessionOptions): Session => {
  const context = createCell<BrowserContext | undefined>(undefined);
  const launching = createCell<Promise<Result<BrowserContext, string>> | undefined>(undefined);
  const pages = createCell<readonly Page[]>([]);
  const current = createCell<Page | undefined>(undefined);
  const navigations = createCell<ReadonlyMap<Page, Navigation>>(new Map());
  const pending = createCell<readonly string[]>([]);
  const cdps = createCell<ReadonlyMap<Page, Promise<CDPSession>>>(new Map());
  const isExpecting = createCell(false);
  const room = createCell<Size>(loadRoom(roomFile) ?? phone.viewport);
  const shown = createCell<Size>(room.get());
  const display = createCell<Display | undefined>(undefined);
  const mode = createCell<Mode | undefined>(undefined);

  const note = (line: string): void => {
    pending.update((notes) => [...notes, line].slice(-20));
  };

  const keep = (download: Download): Promise<string> => keepDownload(download, downloads());

  const sized = async (page: Page): Promise<void> => {
    const size = shown.get();
    const current = page.viewportSize();
    if (current?.width === size.width && current.height === size.height) return;
    await inTime(page.setViewportSize(size), fitMs);
  };

  const watch = (page: Page): void => {
    pages.update((open) => (open.includes(page) ? open : [...open, page]));
    void sized(page);
    navigations.update((known) => new Map([...known, [page, { main: 0, frames: 0 }]]));
    page.on("framenavigated", (frame) => {
      const isMain = frame === page.mainFrame();
      navigations.update((known) => {
        const { main, frames } = known.get(page) ?? { main: 0, frames: 0 };
        return new Map([...known, [page, isMain ? { main: main + 1, frames } : { main, frames: frames + 1 }]]);
      });
    });
    page.on("dialog", (dialog) => {
      const message = dialog.message().slice(0, 200);
      const isAlert = dialog.type() === "alert";
      note(`The page showed a ${dialog.type()} dialog, “${message}”, and Ito ${isAlert ? "closed" : "dismissed"} it.`);
      void quietly(isAlert ? dialog.accept() : dialog.dismiss());
    });
    page.on("download", (download) => {
      if (isExpecting.get()) return;
      void (async () => {
        const file = await quietly(keep(download));
        if (file !== undefined) note(`A download arrived and is at ${file}.`);
      })();
    });
    page.on("close", () => {
      pages.update((open) => open.filter((candidate) => candidate !== page));
      cdps.update((known) => new Map([...known].filter(([candidate]) => candidate !== page)));
      if (current.get() === page) {
        current.set(pages.get().at(-1));
        if (current.get()) note(`A tab closed itself; you're on ${current.get()?.url() ?? "the last tab"} now.`);
      }
      onTabs();
    });
  };

  // Headful where there's a display, headless where there isn't or Chromium can't open a window on it.
  const start = async (): Promise<BrowserContext> => {
    const options = {
      ...phone,
      viewport: shown.get(),
      screen: { width: shown.get().width, height: Math.max(phoneScreen.height, shown.get().height) },
      ...(executablePath === undefined ? { channel: "chromium" } : { executablePath }),
      acceptDownloads: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        // The window's own scale matches the phone's emulated one. When they differ, as on a server's display or
        // headless, where it's 1, Chrome puts a touch in a frame from another site, such as a CAPTCHA's, somewhere
        // else in that frame.
        `--force-device-scale-factor=${String(phone.deviceScaleFactor)}`,
      ],
    };
    const where = await openDisplay();
    display.set(where);
    if (where.mode === "headful") {
      try {
        const launched = await chromium.launchPersistentContext(profile, {
          ...options,
          headless: false,
          env: { ...process.env, ...where.environment },
        });
        mode.set({ mode: "headful", detail: `headful on ${where.detail}` });
        return launched;
      } catch (error) {
        where.stop();
        display.set(undefined);
        const why = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
        mode.set({
          mode: "headless",
          detail: `headless, as Chromium couldn't open a window on ${where.detail} (${why})`,
        });
        return chromium.launchPersistentContext(profile, { ...options, headless: true });
      }
    }
    mode.set({ mode: "headless", detail: where.detail });
    return chromium.launchPersistentContext(profile, { ...options, headless: true });
  };

  const launch = async (): Promise<Result<BrowserContext, string>> => {
    const missing = missingChromium(executablePath);
    if (missing !== undefined) return fail(missing);
    try {
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const launched = await start();
      info(`Chromium started ${mode.get()?.detail ?? ""}.`);
      launched.setDefaultTimeout(15_000);
      launched.setDefaultNavigationTimeout(30_000);
      for (const page of launched.pages()) watch(page);
      launched.on("page", (page) => {
        watch(page);
        if (context.get() !== launched) return;
        current.set(page);
        note(`A new tab opened, and you're on it: ${page.url() || "about:blank"}.`);
        onTabs();
      });
      launched.on("close", () => {
        if (context.get() !== launched) return;
        context.set(undefined);
        pages.set([]);
        current.set(undefined);
        display.get()?.stop();
        display.set(undefined);
        info("Chromium closed.");
        onTabs();
      });
      context.set(launched);
      current.set(launched.pages().at(-1));
      return ok(launched);
    } catch (error) {
      display.get()?.stop();
      display.set(undefined);
      return fail(
        `Chromium couldn't start: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`,
      );
    }
  };

  const opened = async (): Promise<Result<BrowserContext, string>> => {
    const open = context.get();
    if (open) return ok(open);
    const already = launching.get();
    if (already) return already;
    const started = launch();
    launching.set(started);
    try {
      return await started;
    } finally {
      launching.set(undefined);
    }
  };

  const newTab = async (): Promise<Result<Page, string>> => {
    const open = await opened();
    if (!open.ok) return open;
    const page = await open.value.newPage();
    current.set(page);
    onTabs();
    return ok(page);
  };

  return {
    ensure: async () => {
      const open = await opened();
      if (!open.ok) return open;
      const page = current.get();
      return page && !page.isClosed() ? ok(page) : newTab();
    },
    active: () => current.get(),
    tabs: () => pages.get(),
    select: (index) => {
      const page = pages.get()[index - 1];
      if (!page) return fail(`There's no tab ${String(index)}: there are ${String(pages.get().length)}.`);
      current.set(page);
      onTabs();
      return ok(page);
    },
    closeTab: async (index) => {
      const page = pages.get()[index - 1];
      if (!page) return fail(`There's no tab ${String(index)}.`);
      await page.close();
      return ok(undefined);
    },
    newTab,
    navigation: (page) => navigations.get().get(page) ?? { main: 0, frames: 0 },
    notes: () => {
      const taken = pending.get();
      pending.set([]);
      return taken;
    },
    expectDownload: async (work) => {
      isExpecting.set(true);
      try {
        return await work();
      } finally {
        isExpecting.set(false);
      }
    },
    cdp: (page) => {
      const known = cdps.get().get(page);
      if (known) return known;
      const open = context.get();
      if (!open) return Promise.reject(new Error("Chromium isn't open."));
      const session = open.newCDPSession(page);
      cdps.update((sessions) => new Map([...sessions, [page, session]]));
      return session;
    },
    isOpen: () => context.get() !== undefined,
    mode: () => mode.get(),
    room: () => room.get(),
    fit: async (size, keep) => {
      const fitted = toRoom(size);
      if (keep) {
        const before = room.get();
        room.set(fitted);
        if (roomFile !== undefined && (before.width !== fitted.width || before.height !== fitted.height)) {
          keepRoom(roomFile, fitted);
        }
      }
      shown.set(fitted);
      await Promise.all(pages.get().map((page) => sized(page)));
    },
    shutdown: async () => {
      const open = context.get();
      context.set(undefined);
      pages.set([]);
      current.set(undefined);
      cdps.set(new Map());
      if (open) await quietly(open.close());
      display.get()?.stop();
      display.set(undefined);
    },
  };
};
