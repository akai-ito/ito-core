import { readFileSync } from "node:fs";
import type { BrowserState, CommitOutcome, HandedBack } from "#browser/browser.ts";
import { createCell } from "#cell.ts";
import type { Host } from "#capabilities/host.ts";
import { toTimestamp } from "#clock.ts";
import { toThreadId } from "#conversation/ids.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { Attachments } from "#attachments/attachments.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Browser, Card } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// The part of Ito that follows Kumo's browser beyond its tools: its state as a line in the thread its task lives in,
// the live view streamed to the app and his touches sent back, the takeover lease, commit cards on the Desk, and
// waking Kumo when he hands the page back or answers a card. The browser itself runs in its own capability process.

export const browserId = "browser";

// One open live view: a WebSocket to an app.
export type BrowserSocket = {
  readonly sendText: (frame: unknown) => void;
  readonly sendFrame: (jpeg: Buffer) => void;
  readonly buffered: () => number;
  readonly close: (code: number, reason: string) => void;
};

export type BrowserHand = {
  readonly isOn: () => boolean;
  readonly unavailable: () => string;
  readonly state: () => Promise<Result<Browser, string>>;
  readonly take: () => Promise<Result<Browser, string>>;
  readonly handBack: () => Promise<Result<Browser, string>>;
  readonly attach: (socket: BrowserSocket) => Promise<void>;
  readonly detach: (socket: BrowserSocket) => void;
  readonly receive: (socket: BrowserSocket, text: string) => void;
  readonly close: () => void;
};

export type BrowserHandOptions = {
  readonly host: Host;
  readonly store: Store;
  readonly desk: DeskKeeper;
  readonly attachments: Attachments;
  readonly identifiers: Identifiers;
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly info: Info;
};

type View = {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly tab: number;
  readonly tabs: number;
};

type CardRequest = {
  readonly title: string;
  readonly summary: string;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  readonly verb: string;
  readonly site: string;
  readonly url: string;
  readonly button: string;
  readonly screenshot: string;
  readonly thread?: string;
  readonly until?: string;
};

// A slow connection gets the latest frame once it catches up, never a backlog.
const maxBufferedBytes = 512 * 1024;
const flushMs = 100;

// An address without what comes after it, which can carry a session or a token.
export const withoutQuery = (url: string): string => {
  if (!URL.canParse(url)) return url;
  const { origin, pathname } = new URL(url);
  return origin === "null" ? (url.split(/[?#]/u, 1)[0] ?? url) : `${origin}${pathname}`;
};

const lineOf = ({ state, site, doing = "browsing", step }: BrowserState): string | undefined => {
  const on = site === undefined ? "" : ` on ${site}`;
  switch (state) {
    case "idle": {
      return undefined;
    }
    case "browsing": {
      const what = doing;
      const count = step === undefined ? "" : ` · step ${String(step)}`;
      return site === undefined
        ? `${what.charAt(0).toUpperCase()}${what.slice(1)}${count}`
        : `On ${site}: ${what}${count}`;
    }
    case "needs_you": {
      return `Needs your hand${on}`;
    }
    case "yours": {
      return `You have the page${on}`;
    }
    case "waiting": {
      return `Waiting for your OK${on}`;
    }
  }
};

export const toBrowser = (given: BrowserState): Browser => {
  if (given.state === "idle") return { state: "idle" };
  const line = lineOf(given);
  return {
    state: given.state,
    ...(line !== undefined && { line }),
    ...(given.thread !== undefined && { thread: given.thread }),
    ...(given.site !== undefined && given.site !== "" && { site: given.site }),
    ...(given.url !== undefined && given.url !== "" && { url: withoutQuery(given.url) }),
    ...(given.title !== undefined && { title: given.title }),
    ...(given.doing !== undefined && { doing: given.doing }),
    ...(given.step !== undefined && given.step > 0 && { step: given.step }),
    ...(given.need && {
      need: {
        kind: given.need.kind,
        why: given.need.why,
        ...(given.need.turn !== undefined && { turn: given.need.turn }),
      },
    }),
    ...(given.lease && { lease: { until: toTimestamp(given.lease.until) } }),
    ...(given.card !== undefined && given.card !== "" && { card: given.card }),
  };
};

const isState = (value: unknown): value is BrowserState =>
  typeof value === "object" && value !== null && typeof (value as { readonly state?: unknown }).state === "string";

const textField = (value: unknown, field: string): string | undefined => {
  const found = value && typeof value === "object" ? (value as Readonly<Record<string, unknown>>)[field] : undefined;
  return typeof found === "string" && found !== "" ? found : undefined;
};

const toCardRequest = (data: unknown): CardRequest | undefined => {
  const title = textField(data, "title");
  const summary = textField(data, "summary");
  const site = textField(data, "site");
  const url = textField(data, "url");
  const button = textField(data, "button");
  const screenshot = textField(data, "screenshot");
  if (!title || !summary || !site || !url || !button || !screenshot) return undefined;
  const details = (data as { readonly details?: unknown }).details;
  const thread = textField(data, "thread");
  const until = textField(data, "until");
  return {
    title,
    summary,
    site,
    url,
    button,
    screenshot,
    verb: textField(data, "verb") ?? "Go ahead",
    details: Array.isArray(details)
      ? details
          .map((detail: unknown) => ({ label: textField(detail, "label"), value: textField(detail, "value") }))
          .filter((detail): detail is { readonly label: string; readonly value: string } =>
            Boolean(detail.label && detail.value),
          )
      : [],
    ...(thread !== undefined && { thread }),
    ...(until !== undefined && { until }),
  };
};

const placeLine = (store: Store, thread: string | undefined): string => {
  const found = thread === undefined ? undefined : store.findThread(toThreadId(thread));
  return found
    ? `The task lives in their thread ${found.title === undefined ? "" : `“${found.title}” `}(${found.id}): anything ` +
        "you tell them about it goes there, with post."
    : "Anything you tell them about it goes in the main chat, with post.";
};

const handedBackPrompt = (store: Store, handed: HandedBack): string =>
  [
    `He handed the browser back to you${handed.lapsed ? ", by leaving it alone until it came back by itself" : ""}.`,
    handed.need
      ? `You'd asked him to take over: “${handed.need.why}”.`
      : "He took the page over while you were working on it.",
    `It's on ${handed.site ?? "the page you left"}${handed.url === undefined ? "" : ` (${withoutQuery(handed.url)})`}, ` +
      "and it may have moved on: your old refs are gone. Read the page with browser_read before you act, then carry " +
      "on with the task until it's done or truly needs him again.",
    ...(handed.need?.kind === "payment"
      ? ["He pressed the pay button himself, or chose not to: read the page to see which, and tell him how it stands."]
      : []),
    placeLine(store, handed.thread),
    "End with one line saying what you did.",
  ].join("\n");

const commitPrompt = (store: Store, card: Card, said: string, outcome?: CommitOutcome): string => {
  const commit = card.commit;
  const asked = `You put “${card.title}” to him as a card: pressing “${commit?.button ?? "it"}” on ${commit?.site ?? "the site"}.`;
  const result = ((): readonly string[] => {
    if (!outcome) {
      return [
        `He answered “${said}”, so nothing was pressed.`,
        "If he said what to change, change it on the page and put it to him again with browser_commit; otherwise " +
          "leave it, and say so in a line.",
      ];
    }
    switch (outcome.outcome) {
      case "done": {
        return [
          `He tapped “${said}”, and Ito pressed it: the site answered, and it's now on “${outcome.title ?? ""}”.`,
          "Read the page to be sure it went through, then tell him in a line what's booked or sent, and anything he " +
            "needs to know, such as a confirmation number.",
        ];
      }
      case "uncertain": {
        return [
          `He tapped “${said}”, and Ito pressed it, but the site's answer was lost (${outcome.detail}).`,
          "Don't press it again. Look on the site, such as its bookings, orders or a confirmation mail, settle it with " +
            "browser_settle, and tell him how it stands.",
        ];
      }
      case "changed": {
        return [
          `He tapped “${said}”, but the page had changed (${outcome.detail}), so nothing was pressed.`,
          "Read the page again. If it's still what he wants, put it to him again with browser_commit.",
        ];
      }
      case "refused": {
        return [`He tapped “${said}”, but nothing was pressed: ${outcome.detail}`];
      }
    }
  })();
  return [asked, ...result, placeLine(store, commit?.thread), "End with one line saying what you did."].join("\n");
};

const doneText = (card: Card, outcome: CommitOutcome): string => {
  switch (outcome.outcome) {
    case "done": {
      return `Went ahead: ${card.title}`;
    }
    case "uncertain": {
      return `Pressed “${card.commit?.button ?? card.title}”, but the site didn't answer; Kumo is checking`;
    }
    case "changed": {
      return `“${card.title}” changed before your tap, so nothing was pressed`;
    }
    case "refused": {
      return `Nothing was pressed for “${card.title}”`;
    }
  }
};

export const createBrowserHand = ({
  host,
  store,
  desk,
  attachments,
  identifiers,
  work,
  info,
}: BrowserHandOptions): BrowserHand => {
  const sockets = createCell<ReadonlySet<BrowserSocket>>(new Set());
  const pending = createCell<ReadonlyMap<BrowserSocket, Buffer>>(new Map());
  const view = createCell<View | undefined>(undefined);
  const flusher = createCell<NodeJS.Timeout | undefined>(undefined);

  const isOn = (): boolean => host.find(browserId)?.state === "on";

  const unavailable = (): string => {
    const found = host.find(browserId);
    if (!found) return "Kumo's browser isn't installed on this server.";
    if (found.state === "off") return "Kumo's browser is off. Switch it on in Settings › Capabilities.";
    return found.detail ?? "Kumo's browser isn't running right now.";
  };

  const broadcast = (frame: unknown): void => {
    for (const socket of sockets.get()) socket.sendText(frame);
  };

  const flush = (): void => {
    const waiting = pending.get();
    if (waiting.size === 0) return;
    const sent = [...waiting].filter(([socket]) => socket.buffered() <= maxBufferedBytes);
    for (const [socket, jpeg] of sent) socket.sendFrame(jpeg);
    pending.update((current) => new Map([...current].filter(([socket]) => sent.every(([done]) => done !== socket))));
  };

  const sendFrame = (jpeg: Buffer): void => {
    for (const socket of sockets.get()) {
      if (socket.buffered() > maxBufferedBytes) pending.update((current) => new Map([...current, [socket, jpeg]]));
      else {
        pending.update((current) => new Map([...current].filter(([waiting]) => waiting !== socket)));
        socket.sendFrame(jpeg);
      }
    }
  };

  const setState = (given: BrowserState): void => {
    const before = JSON.stringify(store.browser());
    store.setBrowser(toBrowser(given));
    const after = store.browser();
    if (JSON.stringify(after) !== before) broadcast({ type: "state", browser: after });
  };

  const wake = (prompt: string, why: string): void => {
    void (async () => {
      const done = await work(prompt);
      if (!done.ok) info("Kumo couldn't carry on with the browser", { why, reason: done.failure });
    })();
  };

  // Wakes Kumo when he hands the page back after it asked, or mid-task, unless a turn there is still running: that
  // turn reads the page again on its next step.
  const onHandedBack = (handed: HandedBack): void => {
    if (!handed.need && !handed.hadTask) return;
    const thread = handed.thread === undefined ? undefined : toThreadId(handed.thread);
    if (store.runningTurn(thread)) return;
    wake(handedBackPrompt(store, handed), "handed back");
  };

  const addCard = (data: unknown): Result<unknown, string> => {
    const given = toCardRequest(data);
    if (!given) return fail("A commit card needs a title, a summary, the site, its address, the button and a picture.");
    const bytes = readFileSync(given.screenshot);
    const id = identifiers.attachment();
    const saved = attachments.save(id, "page.jpg", "image/jpeg", bytes);
    if (!saved.ok) return fail("The page's picture couldn't be kept.");
    store.keepAttachment(id);
    const until = given.until === undefined ? NaN : Date.parse(given.until);
    const card = desk.addCard({
      kind: "commit",
      title: given.title.slice(0, 80),
      options: [{ label: given.verb.slice(0, 24), acts: true }, { label: "Not now" }],
      allows_text: true,
      ...(Number.isFinite(until) && { until: toTimestamp(until) }),
      commit: {
        site: given.site,
        url: withoutQuery(given.url),
        button: given.button,
        summary: given.summary,
        ...(given.details.length > 0 && { details: given.details.slice(0, 8) }),
        screenshot: id,
        ...(given.thread !== undefined && { thread: given.thread }),
      },
    });
    return ok({ card: card.id });
  };

  host.attach(browserId, {
    onPublish: (topic, data) => {
      switch (topic) {
        case "state": {
          if (isState(data)) setState(data);
          return;
        }
        case "frame": {
          const base64 = textField(data, "data");
          if (base64 !== undefined) sendFrame(Buffer.from(base64, "base64"));
          return;
        }
        case "view": {
          view.set(data as View);
          broadcast({ type: "view", ...(data as View) });
          return;
        }
        case "focus": {
          const field = data && typeof data === "object" && "kind" in data ? data : undefined;
          broadcast({ type: "focus", ...(field && { field }) });
          return;
        }
        case "handed_back": {
          onHandedBack(data as HandedBack);
          return;
        }
        default: {
          info("The browser published something Ito doesn't follow", { topic });
        }
      }
    },
    onRequest: (name, data) => {
      switch (name) {
        case "card": {
          return Promise.resolve(addCard(data));
        }
        case "drop_card": {
          const card = textField(data, "card");
          if (card !== undefined && desk.cards().some(({ id }) => id === card)) desk.removeCard(card);
          return Promise.resolve(ok({}));
        }
        default: {
          return Promise.resolve(fail(`Ito doesn't answer ${name} from the browser.`));
        }
      }
    },
    onStopped: () => {
      setState({ state: "idle" });
      view.set(undefined);
      for (const socket of sockets.get()) {
        socket.sendText({ type: "ended", reason: "Kumo's browser stopped." });
        socket.close(1001, "The browser stopped.");
      }
      sockets.set(new Set());
      pending.set(new Map());
    },
  });

  desk.handle("commit", async (card, answer) => {
    const chosen = card.options.find(({ label }) => label === answer.option);
    const said = answer.option ?? answer.text ?? "";
    if (chosen?.acts !== true) {
      await host.control(browserId, "drop", { card: card.id });
      desk.addDone({
        text: `Didn't go ahead with “${card.title}”`,
        ...(answer.text !== undefined && { reason: answer.text }),
        quiet: false,
      });
      wake(commitPrompt(store, card, said), "commit declined");
      return;
    }
    const pressed = await host.control(browserId, "commit", { card: card.id });
    const outcome: CommitOutcome = pressed.ok
      ? (pressed.value as CommitOutcome)
      : { outcome: "refused", detail: pressed.failure };
    desk.addDone({ text: doneText(card, outcome), reason: outcome.detail, quiet: false });
    wake(commitPrompt(store, card, said, outcome), `commit ${outcome.outcome}`);
    return;
  });

  const control = async (name: string): Promise<Result<Browser, string>> => {
    if (!isOn()) return fail(unavailable());
    const done = await host.control(browserId, name, {});
    if (!done.ok) return done;
    if (isState(done.value)) setState(done.value);
    return ok(store.browser());
  };

  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type !== "turn.ended" || store.browser().state === "idle" || !isOn()) return;
    void host.control(browserId, "turn_ended", { turn: event.turn });
  });

  return {
    isOn,
    unavailable,
    state: async () => {
      if (!isOn()) return fail(unavailable());
      const done = await host.control(browserId, "state", {});
      if (done.ok && isState(done.value)) setState(done.value);
      return ok(store.browser());
    },
    take: () => control("take"),
    handBack: () => control("hand_back"),
    attach: async (socket) => {
      const isFirst = sockets.get().size === 0;
      sockets.update((current) => new Set([...current, socket]));
      socket.sendText({ type: "state", browser: store.browser() });
      const shown = view.get();
      if (shown) socket.sendText({ type: "view", ...shown });
      if (!flusher.get()) {
        const timer = setInterval(flush, flushMs);
        timer.unref();
        flusher.set(timer);
      }
      if (!isFirst) return;
      const watched = await host.control(browserId, "watch", { on: true });
      if (!watched.ok) socket.sendText({ type: "refused", message: watched.failure });
    },
    detach: (socket) => {
      sockets.update((current) => new Set([...current].filter((candidate) => candidate !== socket)));
      pending.update((current) => new Map([...current].filter(([waiting]) => waiting !== socket)));
      if (sockets.get().size > 0) return;
      clearInterval(flusher.get());
      flusher.set(undefined);
      if (isOn()) void host.control(browserId, "watch", { on: false });
    },
    receive: (socket, text) => {
      const input = ((): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      })();
      if (textField(input, "type") === undefined) {
        socket.sendText({ type: "refused", message: "That isn't a frame the browser takes." });
        return;
      }
      void (async () => {
        const done = await host.control(browserId, "input", { input });
        if (!done.ok) socket.sendText({ type: "refused", message: done.failure });
      })();
    },
    close: () => {
      unsubscribe();
      clearInterval(flusher.get());
    },
  };
};
