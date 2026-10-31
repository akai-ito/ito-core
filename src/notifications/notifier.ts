import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { toAskId, toTurnId, type AskId } from "#conversation/ids.ts";
import type { Apns } from "#notifications/apns.ts";
import { sealNotification, type Sealed } from "#notifications/crypto.ts";
import type { Presence } from "#notifications/presence.ts";
import { toFailedText, toFirstLine, toReminderText } from "#notifications/text.ts";
import type { Ask, Desk, Notification } from "#protocol/types.ts";
import { localHourOf, toLevel } from "#notifications/manners.ts";
import type { LogEntry, Store, StoredDevice } from "#store/store.ts";
import type { Log } from "#turns/turns.ts";
import { withoutBlocks } from "#replies/blocks.ts";

export type PushLevel = "passive" | "active" | "time-sensitive";

export type Envelope = {
  readonly aps: {
    readonly alert: { readonly title: string; readonly body: string };
    readonly "mutable-content": 1;
    readonly "interruption-level": PushLevel;
    readonly category?: "ask";
  };
  readonly ito: Sealed;
};

export type NotifierOptions = {
  readonly store: Store;
  readonly apns: Apns;
  readonly clock: Clock;
  readonly presence: Presence;
  readonly agentName: () => string;
  readonly log: Log;
  readonly reminderMs: number;
  readonly timeZone?: string;
  readonly isBusy?: () => boolean;
};

export type Notifier = { readonly close: () => void };

export const defaultReminderMs = 3 * 60 * 60 * 1000;

const expiryMs = 24 * 60 * 60 * 1000;

const fallbackText = (kind: Notification["kind"], agentName: string): string => {
  switch (kind) {
    case "reply": {
      return `${agentName} replied`;
    }
    case "failed": {
      return `${agentName} couldn't finish`;
    }
    case "ask": {
      return `${agentName} asked you something`;
    }
    case "reminder": {
      return `${agentName} is still waiting on you`;
    }
    case "post": {
      return `${agentName} has news`;
    }
    case "card": {
      return `Something is waiting on you`;
    }
    case "briefing": {
      return `Your morning briefing`;
    }
  }
};

const toAskPart = (ask: Ask): NonNullable<Notification["ask"]> => ({
  id: ask.id,
  options: ask.options.map((option) => option.label),
  allows_text: ask.allows_text,
});

export const toEnvelope = (
  notification: Notification,
  level: PushLevel,
  device: StoredDevice,
  agentName: string,
): Envelope => ({
  aps: {
    alert: { title: agentName, body: fallbackText(notification.kind, agentName) },
    "mutable-content": 1,
    "interruption-level": level,
    ...(notification.ask && { category: "ask" }),
  },
  ito: sealNotification(notification, device),
});

export const createNotifier = ({
  store,
  apns,
  clock,
  presence,
  agentName,
  log,
  reminderMs,
  timeZone = "UTC",
  isBusy = () => false,
}: NotifierOptions): Notifier => {
  const askingTurns = createCell<ReadonlySet<string>>(new Set());
  const lastSounded = createCell<number | undefined>(undefined);
  const shownCards = createCell<ReadonlySet<string>>(new Set(store.desk().waiting.map(({ id }) => id)));
  const shownBriefing = createCell<string | undefined>(store.desk().briefing?.id);
  const reminders = createCell<ReadonlyMap<string, Cancel>>(new Map());
  const deliveries = createCell<Promise<void>>(Promise.resolve());

  const deliver = async (notification: Notification, level: PushLevel): Promise<void> => {
    for (const device of store.devices()) {
      const sent = await apns.send(
        device,
        toEnvelope(notification, level, device, agentName()),
        clock.now() + expiryMs,
      );
      if (!sent.ok) log("A notification didn't go out", sent.failure);
      else if (sent.value === "gone") store.removeDevice(device.id);
    }
  };

  const deliverAfter = async (previous: Promise<void>, notification: Notification, level: PushLevel): Promise<void> => {
    await previous;
    try {
      await deliver(notification, level);
    } catch (error) {
      log("A notification didn't go out", error);
    }
  };

  const notify = (notification: Notification, wanted: PushLevel): void => {
    if (presence.isWatched() || store.devices().length === 0) return;
    const now = clock.now();
    const level = toLevel({
      wanted,
      now,
      lastSounded: lastSounded.get(),
      localHour: localHourOf(now, timeZone),
      isBusy: isBusy(),
    });
    if (level !== "passive") lastSounded.set(now);
    deliveries.set(deliverAfter(deliveries.get(), notification, level));
  };

  const onDesk = (desk: Desk): void => {
    const fresh = desk.waiting.filter(({ id }) => !shownCards.get().has(id));
    shownCards.set(new Set(desk.waiting.map(({ id }) => id)));
    for (const card of fresh) notify({ kind: "card", text: card.title, card: card.id }, "active");
    const { briefing } = desk;
    if (briefing && briefing.id !== shownBriefing.get()) {
      notify({ kind: "briefing", text: briefing.lines[0]?.text ?? "Your morning briefing" }, "passive");
    }
    shownBriefing.set(briefing?.id);
  };

  const dropReminder = (ask: string): void => {
    reminders.get().get(ask)?.();
    reminders.update((current) => new Map([...current].filter(([id]) => id !== ask)));
  };

  const remind = (ask: AskId): void => {
    dropReminder(ask);
    const current = store.findAsk(ask);
    if (!current || current.outcome || store.isReminded(ask)) return;
    store.markReminded(ask);
    notify({ kind: "reminder", text: toReminderText(current.question), ask: toAskPart(current) }, "active");
  };

  const scheduleReminder = (ask: Ask): void => {
    const delayMs = Math.max(0, Date.parse(ask.at) + reminderMs - clock.now());
    const cancel = clock.after(delayMs, () => {
      remind(toAskId(ask.id));
    });
    reminders.update((current) => new Map([...current, [ask.id, cancel]]));
  };

  const onTurnEnded = (event: Extract<LogEntry["event"], { readonly type: "turn.ended" }>): void => {
    const hasAsked = askingTurns.get().has(event.turn);
    askingTurns.update((current) => new Set([...current].filter((turn) => turn !== event.turn)));
    if (event.outcome === "failed" && event.error) {
      notify({ kind: "failed", text: toFailedText(event.error.message), turn: event.turn }, "active");
      return;
    }
    const reply = !hasAsked && event.outcome === "completed" ? store.lastReply(toTurnId(event.turn)) : undefined;
    if (reply)
      notify(
        { kind: "reply", text: toFirstLine(withoutBlocks(reply.text)), turn: event.turn, message: reply.id },
        "active",
      );
  };

  const onEvent = ({ event }: LogEntry): void => {
    if (event.type === "desk.changed") {
      onDesk(event.desk);
      return;
    }
    if (event.type === "message.posted") {
      notify(
        { kind: "post", text: toFirstLine(withoutBlocks(event.message.text)), message: event.message.id },
        "active",
      );
      return;
    }
    if (event.type === "ask.started") {
      askingTurns.update((current) => new Set([...current, event.ask.turn]));
      notify({ kind: "ask", text: event.ask.question, ask: toAskPart(event.ask) }, "time-sensitive");
      scheduleReminder(event.ask);
      return;
    }
    if (event.type === "ask.ended") {
      dropReminder(event.ask.id);
      return;
    }
    if (event.type === "turn.ended") onTurnEnded(event);
  };

  const unsubscribe = store.subscribe(onEvent);
  const waiting = store.waitingAsk();
  if (waiting && !store.isReminded(toAskId(waiting.id))) scheduleReminder(waiting);

  return {
    close: () => {
      unsubscribe();
      for (const cancel of reminders.get().values()) cancel();
      reminders.set(new Map());
    },
  };
};
