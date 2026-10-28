import type { Attachments } from "#attachments/attachments.ts";
import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { toMessageId, type MessageId } from "#conversation/ids.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Term } from "#memory/vocabulary.ts";
import type { Store } from "#store/store.ts";
import type { Info, Log, Turns } from "#turns/turns.ts";
import { correct } from "#voice/corrector.ts";
import { heardRate, toWav, type Heard, type Listening, type VoiceLoop, type Voiceprint } from "#voice/loop.ts";
import { askAloud, createSentenceFeed, type SentenceFeed } from "#voice/spoken.ts";

export type CallState = "listening" | "hearing" | "turn_ended" | "working" | "speaking";

export type ToApp =
  | { readonly type: "state"; readonly state: CallState }
  | { readonly type: "heard"; readonly text: string; readonly final: boolean; readonly message?: string }
  | { readonly type: "saying"; readonly id: string; readonly text: string }
  | { readonly type: "stop_playback" }
  | { readonly type: "problem"; readonly reason: string };

export type FromApp =
  | { readonly type: "mute" }
  | { readonly type: "unmute" }
  | { readonly type: "end" }
  | { readonly type: "played"; readonly id: string; readonly cut?: boolean };

export type CallSocket = {
  readonly send: (frame: ToApp) => void;
  readonly sendAudio: (pcm: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
};

export type Voiceprints = {
  readonly load: () => Voiceprint | undefined;
  readonly save: (voiceprint: Voiceprint) => void;
};

export type CallOptions = {
  readonly call: string;
  readonly store: Store;
  readonly turns: Turns;
  readonly attachments: Attachments;
  readonly voice: VoiceLoop;
  readonly vocabulary: () => Promise<readonly Term[]>;
  readonly voiceprints: Voiceprints;
  readonly chosenVoice: () => string;
  readonly identifiers: Identifiers;
  readonly clock: Clock;
  readonly info: Info;
  readonly log: Log;
  readonly onEnded: () => void;
};

export type CallStream = {
  readonly attach: (socket: CallSocket) => Promise<void>;
  readonly detach: (socket: CallSocket) => void;
  readonly receive: (frame: FromApp) => void;
  readonly hear: (pcm: Uint8Array) => void;
  readonly end: (reason?: string) => Promise<void>;
};

export const reconnectMs = 20_000;

export const narrationMs = 9000;

export const droppedReason = "The connection dropped.";

const replacedCode = 4000;

const failedCode = 1011;

type Sentence = { readonly id: string; readonly text: string };

export const createCallStream = (options: CallOptions): CallStream => {
  const { call, store, turns, attachments, voice, identifiers, clock, info, log } = options;
  const socket = createCell<CallSocket | undefined>(undefined);
  const listening = createCell<Listening | undefined>(undefined);
  const state = createCell<CallState>("listening");
  const lastHeard = createCell<string | undefined>(undefined);
  const isMuted = createCell(false);
  const isEnded = createCell(false);
  const reconnect = createCell<Cancel | undefined>(undefined);
  const narration = createCell<Cancel | undefined>(undefined);
  const feeds = createCell<ReadonlyMap<string, SentenceFeed>>(new Map());
  const queue = createCell<readonly Sentence[]>([]);
  const isSaying = createCell(false);
  const unplayed = createCell<ReadonlySet<string>>(new Set());
  const generation = createCell(0);
  const sentences = createCell(0);
  const isAgentWorking = createCell(false);
  const status = createCell<{ readonly kind: string; readonly label: string } | undefined>(undefined);
  const narrated = createCell<ReadonlySet<string>>(new Set());
  const unsubscribe = createCell<(() => void) | undefined>(undefined);

  const send = (frame: ToApp): void => {
    socket.get()?.send(frame);
  };

  const moveTo = (next: CallState): void => {
    if (state.get() === next) return;
    state.set(next);
    send({ type: "state", state: next });
  };

  const isQuiet = (): boolean => !isSaying.get() && queue.get().length === 0 && unplayed.get().size === 0;

  const settle = (): void => {
    if (!isQuiet() || state.get() === "hearing") return;
    listening.get()?.speaking(false);
    moveTo(isAgentWorking.get() ? "working" : "listening");
    if (isAgentWorking.get()) scheduleNarration();
  };

  const scheduleNarration = (): void => {
    narration.get()?.();
    narration.set(
      clock.after(narrationMs, () => {
        narration.set(undefined);
        const current = status.get();
        if (current?.kind !== "working" || state.get() !== "working" || !isQuiet() || narrated.get().has(current.label))
          return;
        narrated.set(new Set([...narrated.get(), current.label]));
        enqueue([current.label]);
      }),
    );
  };

  const sayNext = async (): Promise<void> => {
    const [next, ...rest] = queue.get();
    if (!next || isSaying.get() || isEnded.get()) return;
    queue.set(rest);
    isSaying.set(true);
    const started = generation.get();
    const spoken = await voice.speak(next.text, options.chosenVoice());
    isSaying.set(false);
    if (generation.get() !== started || isEnded.get()) return;
    if (spoken.ok) {
      unplayed.set(new Set([...unplayed.get(), next.id]));
      listening.get()?.speaking(true);
      moveTo("speaking");
      send({ type: "saying", id: next.id, text: next.text });
      socket.get()?.sendAudio(spoken.value);
    } else {
      log("Ari couldn't say a sentence on a call", spoken.failure);
    }
    await sayNext();
    settle();
  };

  const enqueue = (texts: readonly string[]): void => {
    if (texts.length === 0 || !socket.get()) return;
    const added = texts.map((text) => {
      sentences.set(sentences.get() + 1);
      return { id: `s${String(sentences.get())}`, text };
    });
    queue.set([...queue.get(), ...added]);
    void sayNext();
  };

  const stopSpeaking = (): void => {
    generation.set(generation.get() + 1);
    queue.set([]);
    unplayed.set(new Set());
    listening.get()?.speaking(false);
    send({ type: "stop_playback" });
  };

  const followAgent = (): (() => void) =>
    store.subscribe(({ event }) => {
      switch (event.type) {
        case "turn.started": {
          isAgentWorking.set(true);
          narrated.set(new Set());
          if (state.get() !== "hearing" && isQuiet()) moveTo("working");
          scheduleNarration();
          return;
        }
        case "turn.status": {
          status.set({ kind: event.kind, label: event.label });
          return;
        }
        case "turn.ended": {
          isAgentWorking.set(false);
          status.set(undefined);
          settle();
          return;
        }
        case "message.started": {
          if (event.message.role === "agent") {
            feeds.set(new Map([...feeds.get(), [event.message.id, createSentenceFeed()]]));
          }
          return;
        }
        case "message.delta":
        case "message.ended": {
          const feed = feeds.get().get(event.message);
          const text = store.messageText(toMessageId(event.message));
          if (!feed || text === undefined) return;
          enqueue(feed(text, event.type === "message.ended"));
          return;
        }
        case "ask.started": {
          enqueue(askAloud(event.ask));
          return;
        }
        case "message.accepted":
        case "message.queued":
        case "message.read":
        case "step.started":
        case "step.updated":
        case "step.ended":
        case "ask.ended":
        case "call.started":
        case "call.ended":
        case "call.audio_deleted":
        case "voice.status": {
          return;
        }
      }
    });

  const post = async (text: string, pcm: Uint8Array): Promise<MessageId | undefined> => {
    const corrected = correct(text, await options.vocabulary());
    const recording = identifiers.attachment();
    const saved = attachments.save(recording, "turn.wav", "audio/wav", Buffer.from(toWav(pcm, heardRate)));
    if (!saved.ok) return undefined;
    const message = identifiers.message();
    const accepted = store.acceptMessage(message, corrected.text, undefined, [], {
      call,
      audio: recording,
      corrections: corrected.corrections,
    });
    if (!accepted.ok) {
      log("A spoken turn couldn't become a message", accepted.failure);
      return undefined;
    }
    turns.route(message, corrected.text);
    send({ type: "heard", text: corrected.text, final: true, message });
    return message;
  };

  const fail = async (reason: string): Promise<void> => {
    send({ type: "problem", reason });
    socket.get()?.close(failedCode, reason);
    await end(reason);
  };

  const onHeard = (heard: Heard): void => {
    switch (heard.kind) {
      case "hearing": {
        if (state.get() !== "speaking") moveTo("hearing");
        return;
      }
      case "heard": {
        lastHeard.set(heard.text);
        send({ type: "heard", text: heard.text, final: false });
        return;
      }
      case "turn": {
        lastHeard.set(undefined);
        moveTo("turn_ended");
        void post(heard.text, heard.pcm);
        return;
      }
      case "barge": {
        if (state.get() !== "speaking") return;
        stopSpeaking();
        moveTo("hearing");
        return;
      }
      case "voiceprint": {
        options.voiceprints.save(heard.voiceprint);
        info("Learnt your voiceprint", { call });
        return;
      }
      case "problem": {
        void fail(heard.reason);
        return;
      }
    }
  };

  const start = async (): Promise<boolean> => {
    if (listening.get()) return true;
    const started = await voice.listen(call, options.voiceprints.load(), onHeard);
    if (!started.ok) {
      await fail(started.failure);
      return false;
    }
    listening.set(started.value);
    unsubscribe.set(followAgent());
    return true;
  };

  const end = async (reason?: string): Promise<void> => {
    if (isEnded.get()) return;
    isEnded.set(true);
    reconnect.get()?.();
    narration.get()?.();
    unsubscribe.get()?.();
    const current = listening.get();
    listening.set(undefined);
    if (current) {
      await current.flush();
      await current.stop();
    }
    store.endCall(call, reason);
    socket.get()?.close(1000, reason ?? "The call ended.");
    socket.set(undefined);
    options.onEnded();
  };

  return {
    attach: async (next) => {
      reconnect.get()?.();
      reconnect.set(undefined);
      const previous = socket.get();
      socket.set(next);
      previous?.close(replacedCode, "replaced");
      if (!(await start())) return;
      next.send({ type: "state", state: state.get() });
      const partial = lastHeard.get();
      if (partial !== undefined && state.get() === "hearing") next.send({ type: "heard", text: partial, final: false });
    },
    detach: (closed) => {
      if (socket.get() !== closed || isEnded.get()) return;
      socket.set(undefined);
      stopSpeaking();
      if (state.get() === "speaking") state.set(isAgentWorking.get() ? "working" : "listening");
      reconnect.set(
        clock.after(reconnectMs, () => {
          void end(droppedReason);
        }),
      );
    },
    receive: (frame) => {
      switch (frame.type) {
        case "mute": {
          isMuted.set(true);
          return;
        }
        case "unmute": {
          isMuted.set(false);
          return;
        }
        case "end": {
          void end();
          return;
        }
        case "played": {
          if (frame.cut === true) return;
          unplayed.set(new Set([...unplayed.get()].filter((id) => id !== frame.id)));
          settle();
          return;
        }
      }
    },
    hear: (pcm) => {
      if (!isMuted.get()) listening.get()?.hear(pcm);
    },
    end,
  };
};
