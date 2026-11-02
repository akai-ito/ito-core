import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import { toTurnId } from "#conversation/ids.ts";
import { isRefusal, type Apns } from "#notifications/apns.ts";
import { sealNotification, type Sealed } from "#notifications/crypto.ts";
import { toFailedText, toFirstLine } from "#notifications/text.ts";
import type { Ask, Notification } from "#protocol/types.ts";
import type { Health } from "#problems/problems.ts";
import type { LogEntry, Store, StoredDevice } from "#store/store.ts";
import type { Log } from "#turns/turns.ts";
import { withoutBlocks } from "#replies/blocks.ts";

// Every message notifies, at once and whatever the hour: their phone's Focus decides what makes a sound. Only an
// urgent message from Kumo is time-sensitive, to break through it.
export type PushLevel = "active" | "time-sensitive";

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
  readonly agentName: () => string;
  readonly log: Log;
  // How the last notification went: turned away or not reached, or through.
  readonly onHealth?: (health: Health) => void;
};

export type Notifier = {
  readonly close: () => void;
};

const expiryMs = 24 * 60 * 60 * 1000;

const ignore = (): void => undefined;

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
    case "post": {
      return `${agentName} has news`;
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
  agentName,
  log,
  onHealth = ignore,
}: NotifierOptions): Notifier => {
  const askingTurns = createCell<ReadonlySet<string>>(new Set());
  const deliveries = createCell<Promise<void>>(Promise.resolve());

  const deliver = async (notification: Notification, level: PushLevel): Promise<void> => {
    const failures = createCell<readonly string[]>([]);
    for (const device of store.devices()) {
      const sent = await apns.send(
        device,
        toEnvelope(notification, level, device, agentName()),
        clock.now() + expiryMs,
      );
      if (!sent.ok) {
        log("A notification didn't go out", sent.failure);
        failures.update((current) => [...current, sent.failure]);
      } else if (sent.value === "gone") store.removeDevice(device.id);
    }
    const [failure] = failures.get();
    onHealth(failure === undefined ? { ok: true } : { ok: false, reason: failure, isAuth: isRefusal(failure) });
  };

  const deliverAfter = async (previous: Promise<void>, notification: Notification, level: PushLevel): Promise<void> => {
    await previous;
    try {
      await deliver(notification, level);
    } catch (error) {
      log("A notification didn't go out", error);
    }
  };

  const notify = (notification: Notification, level: PushLevel = "active"): void => {
    if (store.devices().length === 0) return;
    deliveries.set(deliverAfter(deliveries.get(), notification, level));
  };

  const onTurnEnded = (event: Extract<LogEntry["event"], { readonly type: "turn.ended" }>): void => {
    const hasAsked = askingTurns.get().has(event.turn);
    askingTurns.update((current) => new Set([...current].filter((turn) => turn !== event.turn)));
    if (event.outcome === "failed" && event.error) {
      notify({ kind: "failed", text: toFailedText(event.error.message), turn: event.turn });
      return;
    }
    const reply = !hasAsked && event.outcome === "completed" ? store.lastReply(toTurnId(event.turn)) : undefined;
    if (reply)
      notify({ kind: "reply", text: toFirstLine(withoutBlocks(reply.text)), turn: event.turn, message: reply.id });
  };

  const onEvent = ({ event }: LogEntry): void => {
    if (event.type === "message.posted") {
      notify(
        { kind: "post", text: toFirstLine(withoutBlocks(event.message.text)), message: event.message.id },
        event.message.urgent === true ? "time-sensitive" : "active",
      );
      return;
    }
    if (event.type === "ask.started") {
      askingTurns.update((current) => new Set([...current, event.ask.turn]));
      notify({ kind: "ask", text: event.ask.question, ask: toAskPart(event.ask) });
      return;
    }
    if (event.type === "turn.ended") onTurnEnded(event);
  };

  const unsubscribe = store.subscribe(onEvent);

  return { close: unsubscribe };
};
