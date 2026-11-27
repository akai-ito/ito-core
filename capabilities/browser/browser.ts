import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page, Request } from "playwright";
import { z } from "zod";
import { createCell } from "#cell.ts";
import {
  defineCapability,
  defineControl,
  defineOperation,
  fail,
  ok,
  type CallContext,
  type Capability,
  type Context,
  type Result,
} from "#sdk/capability.ts";
import { createFinals, type Final, type Finals } from "./finals.ts";
import { isSubmitKey, judgeClick, moneyRefusal, type ClickKind } from "./gate.ts";
import { createLive, inputSchema, toUrl, type Live, type MarkTarget } from "./live.ts";
import { isSecretField, readPage, stateOf, targetText, withOutline, type Line, type Reading } from "./page.ts";
import type { Display } from "./display.ts";
import { createSession, keepDownload, missingChromium, type Navigation, type Session } from "./session.ts";
import { quietly } from "./quietly.ts";
import { skill } from "./skill.ts";

export type BrowserOptions = {
  readonly executablePath?: string;
  // Where Chromium draws; by default, headful on a virtual display where there's one (see display.ts).
  readonly display?: () => Promise<Display>;
  // How long he holds the page without touching it before it goes back to Kumo by itself.
  readonly leaseMs?: number;
  // How long a browsing task goes without an action before it ends, when nothing waits on him.
  readonly taskIdleMs?: number;
  // How long Chromium stays open with nothing to do.
  readonly idleMs?: number;
  // How long a final step waits for the site's answer before it's uncertain.
  readonly finalWaitMs?: number;
  readonly now?: () => number;
};

export type NeedKind = "login" | "code" | "captcha" | "payment" | "other";

type Need = { readonly kind: NeedKind; readonly why: string; readonly turn?: string; readonly at: number };

type Card = {
  readonly id: string;
  readonly page: Page;
  readonly ref: string;
  readonly line: Line;
  readonly digest: string;
  readonly navigation: Navigation;
  readonly button: string;
};

type Task = {
  readonly thread?: string;
  readonly turn?: string;
  readonly steps: number;
  readonly doing?: string;
  readonly need?: Need;
  readonly card?: Card;
  readonly last: number;
  readonly site?: string;
  readonly url?: string;
  readonly title?: string;
};

type Read = { readonly page: Page; readonly navigation: Navigation; readonly revision: number };

// The press the gate refused because money moves there: the button he's asked to press himself, for the takeover to
// ring.
type PayButton = { readonly page: Page; readonly ref: string; readonly navigation: Navigation; readonly label: string };

type Place = { readonly thread?: string; readonly turn?: string };

// The browser's state as Ito shows it: what Kumo is doing on which site, what it needs from him, and who has the page.
export type BrowserState = {
  readonly state: "idle" | "browsing" | "needs_you" | "yours" | "waiting";
  readonly thread?: string;
  readonly site?: string;
  readonly url?: string;
  readonly title?: string;
  readonly doing?: string;
  readonly step?: number;
  readonly need?: { readonly kind: NeedKind; readonly why: string; readonly turn?: string };
  readonly lease?: { readonly until: number };
  readonly card?: string;
};

export type HandedBack = {
  readonly lapsed: boolean;
  // He stopped the task: nothing wakes Kumo.
  readonly stopped?: true;
  readonly thread?: string;
  readonly need?: { readonly kind: NeedKind; readonly why: string };
  readonly site?: string;
  readonly url?: string;
  readonly hadTask: boolean;
};

export type CommitOutcome = {
  readonly outcome: "done" | "changed" | "uncertain" | "refused";
  readonly detail: string;
  readonly site?: string;
  readonly url?: string;
  readonly title?: string;
  readonly final?: string;
};

const stepWords = z
  .string()
  .min(1)
  .max(80)
  .describe("What you're doing, in a few plain words he sees live in the thread, such as “choosing Sat 19:30”.");

const describe = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n", 1)[0] ?? error.message) : String(error);

const hisPage =
  "He has the page now, in a takeover: nothing you do reaches it until he hands it back. Stop here and end your " +
  "turn; you'll be woken to read the page again when he's done.";

const toLines = (lines: readonly (string | false | undefined)[]): string =>
  lines.filter((line): line is string => typeof line === "string").join("\n");

const signalLines = ({ signals }: Reading): readonly string[] => [
  ...(signals.payment.length > 0
    ? [`Money: this page takes payment (${signals.payment.join(", ")}). Its final press is his: ask him to take over.`]
    : []),
  ...(signals.login
    ? ["Login: this page asks for a password. Logins are his: ask him to take over, need `login`."]
    : []),
  ...(signals.code ? ["Code: this page asks for a one-time code. Ask him to take over, need `code`."] : []),
  ...(signals.captcha ? ["CAPTCHA: this page wants a human check. Ask him to take over, need `captcha`."] : []),
];

const uncertainText = (final: Final): string =>
  `Uncertain: “${final.button}” on ${final.site} (${final.id}) may or may not have gone through ` +
  `(${final.reason ?? "its answer was lost"}). Nothing on ${final.site} can be committed until you've looked on ` +
  "the site, such as its bookings or orders, and settled it with browser_settle.";

const needs = (name: string, action: string): Result<never, string> => fail(`To ${action}, give ${name}.`);

const scrollBy = (by: number): void => {
  globalThis.scrollBy({ top: by, behavior: "instant" });
};

const detail = z.object({ label: z.string().min(1).max(30), value: z.string().min(1).max(120) });

const sameNavigation = (left: Navigation, right: Navigation, reference: string): boolean =>
  left.main === right.main && (!reference.startsWith("f") || left.frames === right.frames);

const watchRequests = (page: Page) => {
  const open = createCell<ReadonlySet<Request>>(new Set());
  const failed = createCell<readonly string[]>([]);
  const isTracked = (request: Request): boolean => request.method() !== "GET" || request.resourceType() === "document";
  const without = (request: Request): void => {
    open.update((current) => new Set([...current].filter((candidate) => candidate !== request)));
  };
  const onRequest = (request: Request): void => {
    if (isTracked(request)) open.update((current) => new Set([...current, request]));
  };
  const onFinished = (request: Request): void => {
    without(request);
  };
  const onFailed = (request: Request): void => {
    if (!open.get().has(request)) return;
    without(request);
    const error = request.failure()?.errorText ?? "failed";
    // A page leaving for another before a document loaded isn't a lost answer.
    if (request.method() === "GET" && error.includes("ERR_ABORTED")) return;
    failed.update((current) => [...current, `${request.method()} ${new URL(request.url()).pathname}: ${error}`]);
  };
  const onCrash = (): void => {
    failed.update((current) => [...current, "the page crashed"]);
  };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("crash", onCrash);
  const stop = (): void => {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
    page.off("crash", onCrash);
  };
  const settle = async (waitMs: number): Promise<{ readonly failed: readonly string[]; readonly waiting: number }> => {
    const deadline = Date.now() + waitMs;
    await quietly(page.waitForTimeout(300));
    const poll = async (): Promise<void> => {
      if (open.get().size === 0 || Date.now() >= deadline || page.isClosed()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await poll();
    };
    await poll();
    stop();
    return { failed: failed.get(), waiting: open.get().size };
  };
  return { settle, stop };
};

export const createBrowser = ({
  executablePath,
  display,
  leaseMs = 10 * 60_000,
  taskIdleMs = 3 * 60_000,
  idleMs = 15 * 60_000,
  finalWaitMs = 20_000,
  now = Date.now,
}: BrowserOptions = {}): Capability => {
  const context = createCell<Context | undefined>(undefined);
  const task = createCell<Task | undefined>(undefined);
  const lease = createCell<{ readonly until: number } | undefined>(undefined);
  const revision = createCell(0);
  const lastRead = createCell<Read | undefined>(undefined);
  // When the call that last read a page began: settling an uncertain step needs a look in a later call than the press.
  const lastReadAt = createCell(0);
  const callStarted = createCell(0);
  const lastActive = createCell(now());
  const queue = createCell<Promise<unknown>>(Promise.resolve());
  const leaseTimer = createCell<NodeJS.Timeout | undefined>(undefined);
  const ticker = createCell<NodeJS.Timeout | undefined>(undefined);
  const payButton = createCell<PayButton | undefined>(undefined);
  // The turns whose task he stopped: they can't use the browser again, so a new ask starts afresh.
  const stoppedTurns = createCell<ReadonlySet<string>>(new Set());
  const parts = createCell<
    { readonly session: Session; readonly live: Live; readonly finals: Finals; readonly folder: string } | undefined
  >(undefined);

  const required = () => {
    const found = parts.get();
    if (!found) throw new Error("The browser hasn't started.");
    return found;
  };

  const workspaceDirectory = (part: string): string =>
    path.join(context.get()?.server.workspace ?? required().folder, "browser", part);

  const publish = (topic: string, data: unknown): void => {
    context.get()?.publish(topic, data);
  };

  const serially = <Value>(job: () => Promise<Value>): Promise<Value> => {
    const previous = queue.get();
    const run = (async (): Promise<Value> => {
      await quietly(previous);
      return job();
    })();
    queue.set(quietly(run));
    return run;
  };

  const taskFile = (): string => path.join(required().folder, "task.json");

  // A need outlives a restart, so the notification he hasn't answered yet still opens the right page.
  const saveTask = (): void => {
    const current = task.get();
    if (current?.need === undefined) {
      rmSync(taskFile(), { force: true });
      return;
    }
    const { thread, need, site, url, title, steps } = current;
    writeFileSync(taskFile(), JSON.stringify({ thread, need, site, url, title, steps }), { mode: 0o600 });
  };

  const loadTask = (): Task | undefined => {
    try {
      const file = taskFile();
      return existsSync(file)
        ? { ...(JSON.parse(readFileSync(file, "utf8")) as Omit<Task, "last">), last: now() }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const toState = (): BrowserState => {
    const current = task.get();
    const held = lease.get();
    const state: BrowserState["state"] = held
      ? "yours"
      : current?.need
        ? "needs_you"
        : current?.card
          ? "waiting"
          : current?.doing === undefined
            ? "idle"
            : "browsing";
    if (state === "idle" && !held) return { state };
    return {
      state,
      ...(current?.thread !== undefined && { thread: current.thread }),
      ...(current?.site !== undefined && { site: current.site }),
      ...(current?.url !== undefined && { url: current.url }),
      ...(current?.title !== undefined && { title: current.title }),
      ...(current?.doing !== undefined && state === "browsing" && { doing: current.doing, step: current.steps }),
      ...(current?.need && {
        need: {
          kind: current.need.kind,
          why: current.need.why,
          ...(current.need.turn !== undefined && { turn: current.need.turn }),
        },
      }),
      ...(held && { lease: { until: held.until } }),
      ...(current?.card && { card: current.card.id }),
    };
  };

  const publishState = (): void => {
    publish("state", toState());
  };

  const changeTask = (change: (current: Task | undefined) => Task | undefined): void => {
    task.update(change);
    saveTask();
    publishState();
  };

  const isHeld = (current: Task): boolean =>
    current.need !== undefined || current.card !== undefined || now() - current.last < taskIdleMs;

  const busy = (current: Task): string =>
    `The browser is busy with another thread's task${current.site === undefined ? "" : ` on ${current.site}`}` +
    `${current.need ? `, waiting on him (“${current.need.why}”)` : ""}. Tell him; one task uses it at a time.`;

  // A call from Kumo claims the browser for its thread. Calls from the main chat or from background work carry on
  // the task there is, so the work Ito wakes after a takeover continues it in its thread.
  const claim = ({ thread, turn }: Place): Result<Task, string> => {
    if (turn !== undefined && stoppedTurns.get().has(turn)) {
      return fail(
        "He stopped this task, and the page stays as it is. Don't use the browser again in this turn: tell him in a " +
          "line where you'd got to.",
      );
    }
    if (lease.get()) return fail(hisPage);
    const current = task.get();
    const isOther = current !== undefined && thread !== undefined && current.thread !== thread;
    if (current && isOther && isHeld(current)) return fail(busy(current));
    const claimed: Task =
      current && !isOther
        ? { ...current, ...(thread !== undefined && { thread }), ...(turn !== undefined && { turn }), last: now() }
        : { ...(thread !== undefined && { thread }), ...(turn !== undefined && { turn }), steps: 0, last: now() };
    task.set(claimed);
    lastActive.set(now());
    return ok(claimed);
  };

  const step = (doing: string): void => {
    changeTask((current) => current && { ...current, doing, steps: current.steps + 1, last: now() });
  };

  const placeOf = ({ thread, turn }: CallContext): Place => ({
    ...(thread !== undefined && { thread }),
    ...(turn !== undefined && { turn }),
  });

  const activePage = async (): Promise<Result<Page, string>> => required().session.ensure();

  const read = async (page: Page): Promise<Reading> => {
    await quietly(page.waitForLoadState("domcontentloaded", { timeout: 5000 }));
    const reading = await readPage(page);
    lastRead.set({ page, navigation: required().session.navigation(page), revision: revision.get() });
    lastReadAt.set(callStarted.get());
    task.update((current) => current && { ...current, site: reading.site, url: reading.url, title: reading.title });
    return reading;
  };

  const uncertainLine = (reading: Reading): string | undefined => {
    const origin = URL.canParse(reading.url) ? new URL(reading.url).origin : "";
    const final = required().finals.uncertainOn(origin);
    return final && uncertainText(final);
  };

  const describePage = (page: Page, reading: Reading, picture?: string): string => {
    const { session } = required();
    const tabs = session.tabs();
    const index = tabs.indexOf(page) + 1;
    const notes = session.notes();
    return toLines([
      `On ${reading.site}: ${reading.title || "(no title)"}`,
      reading.url,
      tabs.length > 1 && `Tab ${String(index)} of ${String(tabs.length)}.`,
      ...notes.map((note) => `Meanwhile: ${note}`),
      ...signalLines(reading),
      uncertainLine(reading),
      picture !== undefined &&
        `A picture of the page is at ${picture}: look at it with your image viewer. Act by refs from the text, never by the picture.`,
      "",
      reading.text,
      reading.isCut && "(The page goes on: scroll, or act on what's here.)",
    ]);
  };

  const settleAfter = async (page: Page): Promise<void> => {
    await quietly(page.waitForLoadState("domcontentloaded", { timeout: 5000 }));
    await quietly(page.waitForTimeout(250));
  };

  const afterAction = async (lead: string): Promise<Result<{ readonly text: string }, string>> => {
    const page = required().session.active();
    if (!page) return ok({ text: `${lead}\nNo tab is open now.` });
    await settleAfter(page);
    try {
      const reading = await read(page);
      return ok({ text: `${lead}\n\n${describePage(page, reading)}` });
    } catch (error) {
      return ok({
        text: `${lead}\n\nThe page can't be read yet (${describe(error)}): it may still be waiting for the site. Read it again in a moment.`,
      });
    }
  };

  type Resolved = { readonly locator: Locator; readonly line: Line; readonly reading: Reading };

  // A ref is good while Kumo has read this tab since it last moved on, no takeover came between, and the element is
  // still on the page with the same role and name. Otherwise Kumo gets the page as it is now.
  const resolve = async (page: Page, reference: string): Promise<Result<Resolved, string>> => {
    const known = lastRead.get();
    const navigation = required().session.navigation(page);
    const isFresh =
      known?.page === page &&
      known.revision === revision.get() &&
      sameNavigation(known.navigation, navigation, reference);
    const reading = await read(page);
    const line = reading.refs.get(reference);
    if (isFresh && line) return ok({ locator: page.getByRef(reference), line, reading });
    const why = known?.revision === revision.get() ? "the page changed since you read it" : "read the page first";
    return fail(`${reference} isn't a ref you can use: ${why}. Here's the page now:\n\n${describePage(page, reading)}`);
  };

  const pressFinal = async (
    page: Page,
    locator: Locator,
    button: string,
    site: string,
  ): Promise<{ readonly final: Final; readonly isDone: boolean; readonly reason?: string }> => {
    const { finals } = required();
    const final = finals.begin({ site, origin: new URL(page.url()).origin, url: page.url(), button });
    const watching = watchRequests(page);
    try {
      await locator.click({ timeout: 10_000 });
    } catch (error) {
      watching.stop();
      const reason = `the press didn't finish: ${describe(error)}`;
      finals.finish(final.id, "uncertain", reason);
      return { final, isDone: false, reason };
    }
    const settled = await watching.settle(finalWaitMs);
    const problems = [
      ...settled.failed,
      ...(settled.waiting > 0 ? [`no answer after ${String(Math.round(finalWaitMs / 1000))} seconds`] : []),
    ];
    if (problems.length > 0) {
      const reason = problems.join("; ");
      finals.finish(final.id, "uncertain", reason);
      return { final, isDone: false, reason };
    }
    finals.finish(final.id, "done");
    return { final, isDone: true };
  };

  const inWorkspace = (file: string): string | undefined => {
    const workspace = context.get()?.server.workspace ?? "";
    const full = path.resolve(workspace, file);
    return workspace !== "" && full.startsWith(`${path.resolve(workspace)}${path.sep}`) && existsSync(full)
      ? full
      : undefined;
  };

  const actInput = z.object({
    action: z
      .enum(["click", "type", "select", "press", "scroll", "upload", "download"])
      .describe("What to do: click, type, select, press (a key), scroll, upload or download."),
    ref: z
      .string()
      .optional()
      .describe("The element's ref from your last read, such as e12. Scroll and press can do without."),
    kind: z
      .enum(["browse", "final", "payment"])
      .optional()
      .describe(
        "For a click: browse (the default), final for the press that commits something free, payment for money.",
      ),
    text: z.string().max(5000).optional().describe("For type: the text, which replaces what's in the field."),
    submit: z.boolean().optional().describe("For type: press Enter after, such as in a search box."),
    values: z.array(z.string()).optional().describe("For select: the option or options to choose, by label or value."),
    key: z.string().optional().describe("For press: a key such as Enter, Escape, Tab or ArrowDown."),
    direction: z.enum(["down", "up"]).optional().describe("For scroll without a ref: which way, a screen at a time."),
    files: z.array(z.string()).optional().describe("For upload: files in your workspace, by path."),
    step: stepWords,
  });

  type ActInput = z.infer<typeof actInput>;

  const act = async (page: Page, input: ActInput): Promise<Result<{ readonly text: string }, string>> => {
    const { session, finals } = required();
    if (input.action === "scroll" && input.ref === undefined) {
      const height = page.viewportSize()?.height ?? 600;
      await page.evaluate(scrollBy, (input.direction === "up" ? -height : height) * 0.8);
      return afterAction(`Scrolled ${input.direction ?? "down"}.`);
    }
    if (input.action === "press" && input.ref === undefined) {
      if (input.key === undefined) return needs("key", "press a key");
      const reading = await readPage(page);
      if (isSubmitKey(input.key) && reading.signals.payment.length > 0)
        return fail(moneyRefusal(`Enter would send a form on a page that takes payment`));
      await page.keyboard.press(input.key);
      return afterAction(`Pressed ${input.key}.`);
    }
    if (input.ref === undefined) return needs("ref", input.action);
    const resolved = await resolve(page, input.ref);
    if (!resolved.ok) return resolved;
    const { locator, line, reading } = resolved.value;
    switch (input.action) {
      case "click": {
        const text = await targetText(locator);
        const verdict = judgeClick({ ...line, text }, input.kind ?? ("browse" satisfies ClickKind), reading.signals);
        if (verdict.kind === "money") {
          rememberPay(page, input.ref, line.name || text);
          return fail(moneyRefusal(verdict.why));
        }
        if (verdict.kind === "browse") {
          await locator.click();
          return afterAction(`Clicked ${line.name || input.ref}.`);
        }
        const uncertain = finals.uncertainOn(new URL(page.url()).origin);
        if (uncertain) return fail(uncertainText(uncertain));
        const pressed = await pressFinal(page, locator, line.name || text || input.ref, reading.site);
        return afterAction(
          pressed.isDone
            ? `Pressed “${pressed.final.button}”, a final step (${pressed.final.id}); the site answered. Read what it says to be sure.`
            : `${uncertainText({ ...pressed.final, ...(pressed.reason !== undefined && { reason: pressed.reason }) })} Don't press it again.`,
        );
      }
      case "type": {
        if (input.text === undefined) return needs("text", "type");
        if (await isSecretField(locator)) {
          return fail(
            "Refused: that's a secret field (a password, a card or a code), and those are his. Ask him to take over: " +
              "need `login`, `code` or `payment`.",
          );
        }
        if (input.submit === true && reading.signals.payment.length > 0) {
          return fail(moneyRefusal("Enter would send a form on a page that takes payment"));
        }
        await locator.fill(input.text);
        if (input.submit === true) await locator.press("Enter");
        return afterAction(`Typed into ${line.name || input.ref}${input.submit === true ? " and pressed Enter" : ""}.`);
      }
      case "select": {
        if (!input.values || input.values.length === 0) return needs("values", "select");
        try {
          await locator.selectOption([...input.values]);
        } catch (error) {
          return fail(
            `${line.name || input.ref} isn't a list Ito can choose in directly (${describe(error)}). Click it, then click the option.`,
          );
        }
        return afterAction(`Chose ${input.values.join(", ")} in ${line.name || input.ref}.`);
      }
      case "press": {
        if (input.key === undefined) return needs("key", "press a key");
        if (isSubmitKey(input.key) && reading.signals.payment.length > 0)
          return fail(moneyRefusal("Enter would send a form on a page that takes payment"));
        await locator.press(input.key);
        return afterAction(`Pressed ${input.key} in ${line.name || input.ref}.`);
      }
      case "scroll": {
        await locator.scrollIntoViewIfNeeded();
        return afterAction(`Scrolled to ${line.name || input.ref}.`);
      }
      case "upload": {
        const files = (input.files ?? []).map((file) => [file, inWorkspace(file)] as const);
        if (files.length === 0) return needs("files", "upload");
        const missing = files.filter(([, full]) => full === undefined).map(([file]) => file);
        if (missing.length > 0)
          return fail(`Only files in your workspace can go up, and ${missing.join(", ")} isn't one.`);
        const chosen = files.flatMap(([, full]) => full ?? []);
        try {
          await locator.setInputFiles(chosen);
        } catch {
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), locator.click()]);
          await chooser.setFiles(chosen);
        }
        return afterAction(`Chose ${String(chosen.length)} file${chosen.length === 1 ? "" : "s"} to upload.`);
      }
      case "download": {
        const download = await session.expectDownload(async () => {
          const [arrived] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), locator.click()]);
          return arrived;
        });
        const file = await keepDownload(download, workspaceDirectory("downloads"));
        return afterAction(`Downloaded it to ${file}.`);
      }
    }
  };

  const rememberPay = (page: Page, reference: string, label: string): void => {
    payButton.set({ page, ref: reference, navigation: required().session.navigation(page), label: label.slice(0, 80) });
  };

  // The button a payment waits on, while it's still on the page Kumo stopped at.
  const payMark = (): MarkTarget | undefined => {
    const button = payButton.get();
    const { session } = required();
    const isOn =
      button !== undefined &&
      task.get()?.need?.kind === "payment" &&
      !button.page.isClosed() &&
      sameNavigation(session.navigation(button.page), button.navigation, button.ref);
    return isOn ? { page: button.page, locator: button.page.getByRef(button.ref), label: button.label } : undefined;
  };

  const withBrowser = async (
    given: CallContext,
    work: (page: Page) => Promise<Result<{ readonly text: string }, string>>,
  ): Promise<Result<{ readonly text: string }, string>> =>
    serially(async () => {
      callStarted.set(now());
      const claimed = claim(placeOf(given));
      if (!claimed.ok) return claimed;
      const page = await activePage();
      if (!page.ok) return page;
      try {
        return await work(page.value);
      } catch (error) {
        return fail(`The browser couldn't do that: ${describe(error)}`);
      } finally {
        publishState();
      }
    });

  const forget = (): void => {
    changeTask((current) => current && { ...current, card: undefined });
  };

  const endTask = (): void => {
    const current = task.get();
    if (!current || current.need || current.card) {
      if (current?.doing !== undefined) changeTask((held) => held && { ...held, doing: undefined });
      return;
    }
    task.set(undefined);
    saveTask();
    publishState();
  };

  const lapse = (): void => {
    void serially(() => Promise.resolve(handBack(true)));
  };

  const scheduleLease = (): void => {
    clearTimeout(leaseTimer.get());
    const held = lease.get();
    if (!held) return;
    const wait = Math.max(held.until - now(), 0);
    leaseTimer.set(setTimeout(lapse, wait));
  };

  const handBack = (lapsed: boolean, stopped = false): BrowserState => {
    if (!lease.get()) return toState();
    clearTimeout(leaseTimer.get());
    lease.set(undefined);
    revision.update((count) => count + 1);
    lastRead.set(undefined);
    const { live } = required();
    live.track(undefined);
    void live.hold(false);
    const current = task.get();
    const handed: HandedBack = {
      lapsed,
      ...(stopped && { stopped: true as const }),
      hadTask: current !== undefined,
      ...(current?.thread !== undefined && { thread: current.thread }),
      ...(current?.need && { need: { kind: current.need.kind, why: current.need.why } }),
      ...(current?.site !== undefined && { site: current.site }),
      ...(current?.url !== undefined && { url: current.url }),
    };
    task.update((held) => held && { ...held, need: undefined, doing: undefined, last: now() });
    saveTask();
    publish("handed_back", handed);
    publishState();
    return toState();
  };

  const tick = (): void => {
    const current = task.get();
    if (
      current &&
      !lease.get() &&
      current.need === undefined &&
      current.card === undefined &&
      now() - current.last >= taskIdleMs
    ) {
      task.set(undefined);
      publishState();
    }
    const { session, live } = required();
    const isQuiet = !lease.get() && task.get() === undefined && !live.isWatching();
    if (isQuiet && session.isOpen() && now() - lastActive.get() >= idleMs) void serially(() => session.shutdown());
  };

  const open = defineOperation({
    name: "open",
    title: "Open a page",
    running: "Opening a page",
    done: "Opened a page",
    description:
      "Open a page in the browser on the server, which you use for him: a URL in this tab or a new one, back, or " +
      "another tab. It browses at his phone's size, signed in wherever he's signed in. Returns the page as browser_read " +
      "does. Say what you're doing in `step`, in a few plain words he sees live in the thread.",
    input: z.object({
      url: z.string().optional().describe("The address to open."),
      new_tab: z.boolean().optional().describe("Open it in a new tab."),
      back: z.boolean().optional().describe("Go back a page instead."),
      tab: z.number().int().min(1).optional().describe("Switch to this tab, counting from 1."),
      close_tab: z.number().int().min(1).optional().describe("Close this tab."),
      step: stepWords,
    }),
    tool: "browser_open",
    run: (input, given) =>
      withBrowser(given, async (page) => {
        const { session } = required();
        step(input.step);
        if (input.close_tab !== undefined) {
          const closed = await session.closeTab(input.close_tab);
          return closed.ok ? afterAction(`Closed tab ${String(input.close_tab)}.`) : closed;
        }
        if (input.tab !== undefined) {
          const selected = session.select(input.tab);
          return selected.ok ? afterAction(`On tab ${String(input.tab)}.`) : selected;
        }
        if (input.back === true) {
          await page.goBack();
          return afterAction("Went back.");
        }
        if (input.url === undefined) return fail("Give a url, back, tab or close_tab.");
        const address = toUrl(input.url);
        if (!address) return fail(`${input.url} isn't a web address Ito opens: it takes http and https.`);
        const target = input.new_tab === true ? await session.newTab() : ok(page);
        if (!target.ok) return target;
        await target.value.goto(address);
        return afterAction(`Opened ${address}.`);
      }),
  });

  const readOperation = defineOperation({
    name: "read",
    title: "Read the page",
    running: "Reading the page",
    done: "Read the page",
    description:
      "Read the page: its accessibility snapshot, with a ref such as e12 on every element you can act on, and what " +
      "the page asks of him: a login, a code, a CAPTCHA or a payment. A ref stays good while that element is on the " +
      "page with the same name; once the page moves on or he takes it over, read again. With `screenshot`, also a " +
      "picture of the page, as a fallback for what the text can't show; act by refs, never by the picture.",
    input: z.object({ screenshot: z.boolean().optional().describe("Also save a picture of the page to look at.") }),
    tool: "browser_read",
    run: (input, given) =>
      withBrowser(given, async (page) => {
        const reading = await read(page);
        if (input.screenshot !== true) return ok({ text: describePage(page, reading) });
        const folder = workspaceDirectory("screens");
        mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `${String(now())}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 70 });
        return ok({ text: describePage(page, reading, file) });
      }),
  });

  const actOperation = defineOperation({
    name: "act",
    title: "Act on the page",
    running: "Acting on the page",
    done: "Acted on the page",
    description: [
      "Do one thing on the page by ref: click, type, select, press a key, scroll, upload or download. It returns the",
      "page afterwards. For a click, say its `kind`: browse to move around or choose (the default), final for the",
      "press that commits something free, such as booking a table or sending a form, and payment for anything that",
      "moves money. Money is his hand, and the browser enforces it: it refuses any press that pays, whatever kind you",
      "declare, such as Pay, Place order, Buy now or a button naming a price, and any press that commits or continues",
      "on a page with card fields, a payment frame or a wallet button. Stop there and use browser_takeover with need",
      "payment. It refuses typing into passwords, card fields and codes too: those are his. A final press whose answer",
      "is lost comes back uncertain: look on the site before anything else and settle it with browser_settle. For a",
      "free booking or form that matters to him, use browser_commit rather than pressing final yourself.",
    ].join(" "),
    input: actInput,
    tool: "browser_act",
    run: (input, given) =>
      withBrowser(given, async (page) => {
        step(input.step);
        return act(page, input);
      }),
  });

  const takeover = defineOperation({
    name: "takeover",
    title: "Ask him to take over",
    running: "Asking him to take over",
    done: "Asked him to take over",
    description: [
      "Ask him to take over the page when it needs his hand: login to sign in (you never see passwords), code for a",
      "two-factor code, captcha, payment to press the pay button himself on the final page, or other. His phone gets",
      "a notification that opens straight into this page, and nothing changes on it while you wait. End your turn",
      "after, with one short line saying what you need. When he hands it back, you're woken to read the page again",
      "and carry on.",
    ].join(" "),
    input: z.object({
      need: z.enum(["login", "code", "captcha", "payment", "other"]).describe("What his hand is for."),
      why: z
        .string()
        .min(1)
        .max(160)
        .describe("What to do, as his notification says it, such as “Sign in to OpenTable so I can book Saturday”."),
    }),
    tool: "browser_takeover",
    run: ({ need, why }, given) =>
      withBrowser(given, async (page) => {
        const reading = await read(page);
        changeTask(
          (current) =>
            current && {
              ...current,
              doing: undefined,
              need: { kind: need, why, at: now(), ...(given.turn !== undefined && { turn: given.turn }) },
            },
        );
        return ok({
          text:
            `Asked him to take over on ${reading.site}: his phone shows “${why}”, and a tap opens this page. Stop ` +
            "browsing and end your turn with one short line on what you need. When he hands the page back, you're " +
            "woken to read it again and carry on.",
        });
      }),
  });

  const commit = defineOperation({
    name: "commit",
    title: "Put a booking to him",
    running: "Putting it to him",
    done: "Put it to him",
    description: [
      "Put a free booking or form to him as a one-tap card, on his Desk and in this thread: a picture of the page",
      "with the button outlined, your summary, and the details that matter. When he taps the go-ahead, Ito presses",
      "exactly that button for him if the page is still as it is now; if it changed, you're told to look again and",
      "ask again. It can't be used where money moves. Use it when the stakes call for his yes; when they're low and",
      "your track says he trusts you there, press final yourself. End your turn after: you'll hear how it went.",
    ].join(" "),
    input: z.object({
      ref: z.string().describe("The button that commits it, from your last read."),
      title: z.string().min(1).max(60).describe("The card's title, such as “Book Dishoom, Sat 19:30”."),
      summary: z.string().min(1).max(400).describe("What pressing it does, in a sentence or two."),
      details: z
        .array(detail)
        .max(8)
        .optional()
        .describe("What matters, such as when, for how many, and the name it's under."),
      verb: z.string().min(1).max(24).optional().describe("The go-ahead button's word, such as “Book it”."),
      until: z
        .string()
        .optional()
        .describe("When it stops mattering, as an ISO time, such as when a held slot lapses."),
    }),
    tool: "browser_commit",
    run: (input, given) =>
      withBrowser(given, async (page) => {
        const { finals, folder } = required();
        const resolved = await resolve(page, input.ref);
        if (!resolved.ok) return resolved;
        const { locator, line, reading } = resolved.value;
        const text = await targetText(locator);
        const verdict = judgeClick({ ...line, text }, "final", reading.signals);
        if (verdict.kind === "money") {
          rememberPay(page, input.ref, line.name || text);
          return fail(moneyRefusal(verdict.why));
        }
        const uncertain = finals.uncertainOn(new URL(page.url()).origin);
        if (uncertain) return fail(uncertainText(uncertain));
        const digest = await stateOf(page, line);
        const picture = await withOutline(locator, () => page.screenshot({ type: "jpeg", quality: 70 }));
        const pictures = path.join(folder, "cards");
        mkdirSync(pictures, { recursive: true, mode: 0o700 });
        const file = path.join(pictures, `${String(now())}.jpg`);
        writeFileSync(file, picture, { mode: 0o600 });
        const button = line.name || text || input.ref;
        const current = task.get();
        const asked = await given.request("card", {
          title: input.title,
          summary: input.summary,
          details: input.details ?? [],
          verb: input.verb ?? "Go ahead",
          site: reading.site,
          url: reading.url,
          button,
          screenshot: file,
          ...(current?.thread !== undefined && { thread: current.thread }),
          ...(input.until !== undefined && { until: input.until }),
        });
        rmSync(file, { force: true });
        if (!asked.ok) return fail(`The card couldn't go on his Desk: ${asked.failure}`);
        const answeredCard = (asked.value as { readonly card?: unknown }).card;
        const id = typeof answeredCard === "string" ? answeredCard : "";
        const earlier = current?.card;
        if (earlier && earlier.id !== id) await given.request("drop_card", { card: earlier.id });
        const card: Card = {
          id,
          page,
          ref: input.ref,
          line,
          digest,
          navigation: required().session.navigation(page),
          button,
        };
        changeTask((held) => held && { ...held, card, doing: undefined });
        return ok({
          text:
            `It's on his Desk as card ${id}, with a picture of the page and “${button}” outlined. End your turn ` +
            "now and say it's waiting for his tap. When he answers, Ito presses it if the page hasn't changed, and " +
            "you're told how it went.",
        });
      }),
  });

  const settle = defineOperation({
    name: "settle",
    title: "Settle a final step",
    running: "Settling a final step",
    done: "Settled a final step",
    description:
      "Say how a final step went, once you've looked on the site, such as at its bookings, its orders or the " +
      "confirmation page: went_through or not_through, with how you know, and the site's reference when it shows " +
      "one, such as a booking number. Do it for a step that came back uncertain, as until then nothing on that site " +
      "can be committed again, so nothing is booked twice; and for one the site answered, once you've read its " +
      "confirmation, so his trail shows it confirmed with its reference. Never mark anything confirmed, such as a " +
      "calendar event, before this.",
    input: z.object({
      final: z.string().describe("The final step's id, such as final-1764000000000-3."),
      outcome: z.enum(["went_through", "not_through"]),
      how: z.string().min(1).max(200).describe("How you know, such as “It's listed under Upcoming bookings”."),
      reference: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("The site's reference for it, as the confirmation shows it, such as “TW-48KQ”."),
    }),
    tool: "browser_settle",
    run: ({ final, outcome, how, reference }) =>
      serially((): Promise<Result<{ readonly text: string }, string>> => {
        const settled = required().finals.settle(final, outcome, how, lastReadAt.get(), reference);
        if (!settled.ok) return Promise.resolve(settled);
        publish("settled", { final, outcome, ...(settled.value.reference !== undefined && { reference }) });
        return Promise.resolve(
          ok({
            text:
              outcome === "went_through"
                ? `Settled: “${settled.value.button}” went through${reference === undefined ? "" : ` (${reference})`}. Don't press it again.`
                : `Settled: “${settled.value.button}” didn't go through, so it can be tried again.`,
          }),
        );
      }),
  });

  const take = defineControl({
    name: "take",
    input: z.object({}),
    run: () =>
      serially(async () => {
        const page = await activePage();
        if (!page.ok) return page;
        const current = task.get();
        if (current?.need && page.value.url() === "about:blank" && current.url !== undefined) {
          await quietly(page.value.goto(current.url));
        }
        if (!lease.get()) {
          revision.update((count) => count + 1);
          lastRead.set(undefined);
        }
        lease.set({ until: now() + leaseMs });
        lastActive.set(now());
        scheduleLease();
        const { live } = required();
        await live.hold(true);
        live.track(payMark());
        publishState();
        return ok(toState());
      }),
  });

  const handBackControl = defineControl({
    name: "hand_back",
    input: z.object({}),
    run: () => serially(() => Promise.resolve(ok(handBack(false)))),
  });

  // His input goes straight to the live view's own lane, never behind Kumo's work or anything else here.
  const input = defineControl({
    name: "input",
    input: z.object({ input: inputSchema }),
    run: async ({ input: given }) => {
      if (!lease.get()) return fail("Take over first: until then the live view is only to watch.");
      lease.set({ until: now() + leaseMs });
      scheduleLease();
      lastActive.set(now());
      const { session, live } = required();
      const page = session.active();
      if (!page || page.isClosed()) return fail("The page has closed: hand it back to Kumo.");
      const done = await live.input(page, given);
      return done.ok ? ok({}) : done;
    },
  });

  const watch = defineControl({
    name: "watch",
    input: z.object({ on: z.boolean() }),
    // Watching never waits for Kumo's step: the view is of the page as it is now, whatever Kumo is doing on it.
    run: async ({ on }) => {
      const { live, session } = required();
      if (on) {
        const page = await activePage();
        if (!page.ok) return page;
        publishView(page.value);
      }
      lastActive.set(now());
      await live.watch(on);
      if (on) publish("link", { state: live.link() });
      return ok({ watching: live.isWatching(), open: session.isOpen() });
    },
  });

  const commitControl = defineControl({
    name: "commit",
    input: z.object({ card: z.string() }),
    run: ({ card }) =>
      serially(async (): Promise<Result<CommitOutcome, string>> => {
        const held = task.get()?.card;
        if (held?.id !== card) return ok({ outcome: "changed", detail: "Kumo has moved on from that page since." });
        if (lease.get()) {
          return ok({
            outcome: "refused",
            detail: "You have the page in a takeover: press its button yourself, or hand it back first.",
          });
        }
        const { page } = held;
        const navigation = required().session.navigation(page);
        if (page.isClosed() || !sameNavigation(navigation, held.navigation, held.ref)) {
          forget();
          return ok({ outcome: "changed", detail: "The page moved on before the tap." });
        }
        const reading = await read(page);
        const line = reading.refs.get(held.ref);
        const digest = line && (await stateOf(page, line));
        if (!line || digest !== held.digest) {
          forget();
          return ok({
            outcome: "changed",
            detail: "The page changed before the tap.",
            site: reading.site,
            url: reading.url,
          });
        }
        const locator = page.getByRef(held.ref);
        const verdict = judgeClick({ ...line, text: await targetText(locator) }, "final", reading.signals);
        if (verdict.kind === "money") {
          forget();
          return ok({
            outcome: "refused",
            detail: `Money moves there (${verdict.why}), so it's his hand, in a takeover.`,
          });
        }
        const uncertain = required().finals.uncertainOn(new URL(page.url()).origin);
        if (uncertain) {
          forget();
          return ok({ outcome: "refused", detail: uncertainText(uncertain) });
        }
        const pressed = await pressFinal(page, locator, held.button, reading.site);
        forget();
        await settleAfter(page);
        const after = (await quietly(read(page))) ?? reading;
        return ok({
          outcome: pressed.isDone ? "done" : "uncertain",
          detail: pressed.isDone
            ? `Pressed “${held.button}”, and the site answered.`
            : (pressed.reason ?? "Its answer was lost."),
          site: after.site,
          url: after.url,
          title: after.title,
          final: pressed.final.id,
        });
      }),
  });

  const drop = defineControl({
    name: "drop",
    input: z.object({ card: z.string() }),
    run: ({ card }) =>
      serially(() => {
        if (task.get()?.card?.id === card) forget();
        return Promise.resolve(ok({}));
      }),
  });

  // He stopped the task. It's settled at once, ahead of anything queued: a step Kumo is in the middle of finishes,
  // then nothing more of the task is done. A takeover he holds ends without waking Kumo, a need and a card waiting
  // for him are dropped, and the page stays exactly as it is, unpressed.
  const stopControl = defineControl({
    name: "stop",
    input: z.object({}),
    run: async (_input, given) => {
      const current = task.get();
      const turns = [current?.turn, current?.need?.turn].filter((turn): turn is string => turn !== undefined);
      stoppedTurns.update((known) => new Set([...known, ...turns].slice(-50)));
      if (lease.get()) handBack(false, true);
      const card = current?.card?.id;
      if (card !== undefined) await given.request("drop_card", { card });
      payButton.set(undefined);
      task.set(undefined);
      saveTask();
      publishState();
      return ok(toState());
    },
  });

  const turnEnded = defineControl({
    name: "turn_ended",
    input: z.object({ turn: z.string() }),
    run: ({ turn }) =>
      serially(() => {
        if (task.get()?.turn === turn) endTask();
        return Promise.resolve(ok({}));
      }),
  });

  const stateControl = defineControl({
    name: "state",
    input: z.object({}),
    run: () => Promise.resolve(ok(toState())),
  });

  const publishView = (page: Page): void => {
    const { session } = required();
    const viewport = page.viewportSize() ?? session.room();
    const mode = session.mode()?.mode;
    publish("view", {
      url: page.url(),
      width: viewport.width,
      height: viewport.height,
      tab: Math.max(session.tabs().indexOf(page) + 1, 1),
      tabs: Math.max(session.tabs().length, 1),
      ...(mode !== undefined && { display: mode }),
    });
  };

  return defineCapability({
    id: "browser",
    version: "0.1",
    kind: "hand",
    title: "Browser",
    symbol: "safari",
    summary:
      "A browser on your server that Kumo uses for you: bookings, forms and admin, shopping and research. Logins, " +
      "codes and payments stay yours, through takeover.",
    skill,
    uses: { hosts: ["*"], folders: ["browser"] },
    setup: [],
    operations: [open, readOperation, actOperation, takeover, commit, settle],
    controls: [take, handBackControl, input, watch, commitControl, drop, stopControl, turnEnded, stateControl],
    check: () => Promise.resolve(missingChromium(executablePath)),
    stop: async () => {
      clearInterval(ticker.get());
      clearTimeout(leaseTimer.get());
      await parts.get()?.session.shutdown();
    },
    start: (given) => {
      const missing = missingChromium(executablePath);
      if (missing !== undefined) return Promise.resolve(fail(missing));
      context.set(given);
      const session = createSession({
        profile: path.join(given.folder, "profile"),
        downloads: () => workspaceDirectory("downloads"),
        roomFile: path.join(given.folder, "room.json"),
        ...(executablePath !== undefined && { executablePath }),
        ...(display !== undefined && { display }),
        onTabs: () => {
          const page = parts.get()?.session.active();
          if (page) publishView(page);
          void parts.get()?.live.retarget();
        },
        info: (line) => {
          process.stderr.write(`${line}\n`);
        },
      });
      const live = createLive({
        session,
        onFrame: (frame) => {
          publish("frame", frame);
        },
        onFocus: (field) => {
          publish("focus", field ?? {});
        },
        onLink: (state) => {
          publish("link", { state });
        },
        onMark: (mark) => {
          publish("mark", mark ?? {});
        },
        onResize: () => {
          const page = parts.get()?.session.active();
          if (page) publishView(page);
        },
      });
      parts.set({ session, live, finals: createFinals(given.folder, now), folder: given.folder });
      task.set(loadTask());
      publishState();
      clearInterval(ticker.get());
      const every = Math.max(Math.min(taskIdleMs / 2, 15_000), 50);
      const interval = setInterval(tick, every);
      interval.unref();
      ticker.set(interval);
      return Promise.resolve(ok(undefined));
    },
  });
};
