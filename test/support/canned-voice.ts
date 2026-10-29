import { createCell } from "#cell.ts";
import { fail, ok } from "#result.ts";
import type { Heard, Readiness, VoiceLoop } from "#voice/loop.ts";

export type YouSay = { readonly text: string; readonly heard: readonly string[]; readonly held?: boolean };

export type CannedVoice = VoiceLoop & { readonly fail: (reason: string) => void };

export const createCannedVoice = (
  pcm: Uint8Array,
  readiness: () => Readiness,
  takeScript: () => YouSay | undefined,
): CannedVoice => {
  const sessions = createCell<ReadonlyMap<string, (heard: Heard) => void>>(new Map());

  const forget = (session: string): void => {
    sessions.update((current) => new Map([...current].filter(([name]) => name !== session)));
  };

  return {
    readiness,
    speak: () => {
      const { state, reason = "" } = readiness();
      return Promise.resolve(state === "ready" ? ok(pcm) : fail({ code: "unavailable", detail: reason }));
    },
    listen: (session, _voiceprint, onHeard) => {
      const isSpeaking = createCell(false);
      const held = createCell<{ readonly text: string; readonly pcm: Uint8Array } | undefined>(undefined);
      sessions.update((current) => new Map([...current, [session, onHeard]]));
      return Promise.resolve(
        ok({
          hear: (audio) => {
            const script = takeScript();
            if (!script) return;
            if (isSpeaking.get()) onHeard({ kind: "barge" });
            onHeard({ kind: "hearing" });
            for (const text of script.heard) onHeard({ kind: "heard", text });
            if (script.held === true) held.set({ text: script.text, pcm: audio });
            else onHeard({ kind: "turn", text: script.text, pcm: audio });
          },
          saying: (text) => {
            isSpeaking.set(text !== undefined);
          },
          flush: () => {
            const turn = held.get();
            held.set(undefined);
            if (turn) onHeard({ kind: "turn", ...turn });
            return Promise.resolve();
          },
          stop: () => {
            forget(session);
            return Promise.resolve();
          },
        }),
      );
    },
    fail: (reason) => {
      const listening = sessions.get().values().toArray();
      sessions.set(new Map());
      for (const onHeard of listening) onHeard({ kind: "problem", reason });
    },
    refreshVocabulary: () => Promise.resolve(),
    forgetVoiceprint: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
};
