import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCell } from "#cell.ts";
import { recentCrashes, toRestartDecision } from "#capabilities/restarts.ts";
import { passedEnvironment, startChild, type Child } from "#child.ts";
import type { Cancel } from "#clock.ts";
import type { Connection, RpcFailure } from "#json-rpc.ts";
import { fail, ok } from "#result.ts";
import type { Heard, Readiness, SpeechFailure, VoiceContext, VoiceLoop, Voiceprint } from "#voice/loop.ts";

export const voiceProtocol = "0.2";

export const voiceDirectory = fileURLToPath(new URL("../../voice", import.meta.url));

export const voicePython = (directory: string): string => path.join(directory, ".venv", "bin", "python");

export const voiceModels = (home: string): string => path.join(home, "models", "huggingface");

export type SidecarOptions = VoiceContext & { readonly directory: string; readonly models: string };

const unavailableCodes: ReadonlySet<number> = new Set([-32_001, -32_002, -32_099]);

export const toVoiceEnvironment = (
  environment: NodeJS.ProcessEnv,
  models: string,
): Readonly<Record<string, string>> => ({
  ...passedEnvironment(["LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "ITO_VOICE_DEVICE", "HF_TOKEN"], environment),
  HF_HOME: models,
  PYTHONUNBUFFERED: "1",
});

const notInstalled: Readiness = {
  state: "failed",
  reason: "The voice isn't installed on this box: run ito voice check.",
};

const voiceStates: ReadonlySet<string> = new Set(["loading", "ready", "failed"]);

const isNews = (previous: Readiness, next: Readiness): boolean =>
  previous.state !== next.state || (next.state === "failed" && previous.reason !== next.reason);

const isReadiness = (value: unknown): value is Readiness => {
  if (typeof value !== "object" || value === null) return false;
  const { state, reason } = value as { readonly state?: unknown; readonly reason?: unknown };
  return (
    typeof state === "string" &&
    voiceStates.has(state) &&
    (reason === undefined || (typeof reason === "string" && reason !== ""))
  );
};

const toSpeech = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { audio } = value as { readonly audio?: unknown };
  return typeof audio === "string" ? audio : undefined;
};

type Notice = Readonly<Record<string, unknown>>;

const toVoiceprint = ({ vector, threshold }: Notice): Voiceprint | undefined =>
  typeof threshold === "number" && Array.isArray(vector) && vector.every((value) => typeof value === "number")
    ? { vector, threshold }
    : undefined;

const toHeard = (method: string, notice: Notice): Heard | undefined => {
  const { text, audio, reason } = notice;
  switch (method) {
    case "hearing": {
      return { kind: "hearing" };
    }
    case "heard": {
      return typeof text === "string" ? { kind: "heard", text } : undefined;
    }
    case "turn": {
      return typeof text === "string" && typeof audio === "string"
        ? { kind: "turn", text, pcm: Buffer.from(audio, "base64") }
        : undefined;
    }
    case "barge": {
      return { kind: "barge" };
    }
    case "dropped": {
      return { kind: "dropped" };
    }
    case "voiceprint": {
      const voiceprint = toVoiceprint(notice);
      return voiceprint && { kind: "voiceprint", voiceprint };
    }
    case "problem": {
      return typeof reason === "string" ? { kind: "problem", reason } : undefined;
    }
    default: {
      return undefined;
    }
  }
};

const toSpeechFailure = ({ code, message }: RpcFailure): SpeechFailure => ({
  code: unavailableCodes.has(code) ? "unavailable" : "failed",
  detail: message,
});

export const createSidecarVoice = ({
  directory,
  models,
  clock,
  onReadiness,
  vocabulary,
  info,
  log,
}: SidecarOptions): VoiceLoop => {
  const readiness = createCell<Readiness>({ state: "loading", reason: "The voice is starting." });
  const running = createCell<Child | undefined>(undefined);
  const crashes = createCell<readonly number[]>([]);
  const restart = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);
  const sessions = createCell<ReadonlyMap<string, (heard: Heard) => void>>(new Map());

  const forget = (session: string): void => {
    sessions.update((current) => new Map([...current].filter(([name]) => name !== session)));
  };

  const route = (method: string, parameters: unknown): void => {
    if (typeof parameters !== "object" || parameters === null) return;
    const notice = parameters as Notice;
    const onHeard = typeof notice.session === "string" ? sessions.get().get(notice.session) : undefined;
    const heard = toHeard(method, notice);
    if (onHeard && heard) onHeard(heard);
  };

  const report = (next: Readiness): void => {
    const previous = readiness.get();
    readiness.set(next);
    if (isNews(previous, next)) onReadiness(next);
  };

  const sendVocabulary = async (connection: Connection): Promise<void> => {
    const sent = await connection.request("vocabulary", { phrases: await vocabulary() });
    if (!sent.ok) log("The voice couldn't take memory's vocabulary", sent.failure);
  };

  const afterExit = (why: string): void => {
    running.set(undefined);
    for (const onHeard of sessions.get().values()) onHeard({ kind: "problem", reason: `The voice stopped: ${why}` });
    sessions.set(new Map());
    if (isClosed.get()) return;
    const now = clock.now();
    const recent = [...recentCrashes(crashes.get(), now), now];
    crashes.set(recent);
    const decision = toRestartDecision(recent);
    if (decision.giveUp) {
      report({ state: "failed", reason: `The voice keeps stopping: ${why}` });
      return;
    }
    report({ state: "loading", reason: `The voice stopped, and is starting again: ${why}` });
    restart.set(
      clock.after(decision.delayMs, () => {
        restart.set(undefined);
        start();
      }),
    );
  };

  const greet = async (connection: Connection): Promise<void> => {
    const initialized = await connection.request("initialize", {});
    if (!initialized.ok) return;
    const { protocol } = initialized.value as { readonly protocol?: unknown };
    if (protocol !== voiceProtocol) {
      report({
        state: "failed",
        reason: `The voice speaks protocol ${String(protocol)}, and ito-core speaks ${voiceProtocol}: run ito voice check.`,
      });
      return;
    }
    await sendVocabulary(connection);
  };

  const start = (): void => {
    const python = voicePython(directory);
    if (!existsSync(python)) {
      report(notInstalled);
      return;
    }
    const child = startChild({
      command: python,
      arguments: ["-m", "ito_voice", "serve"],
      cwd: directory,
      environment: toVoiceEnvironment(process.env, models),
      onNotification: ({ method, parameters }) => {
        if (method === "status" && isReadiness(parameters)) report(parameters);
        else route(method, parameters);
      },
      onLine: (line) => {
        info("Voice", { line });
      },
      closedMessage: "The voice stopped.",
    });
    running.set(child);
    void (async () => {
      const { how, lastLine } = await child.exited;
      afterExit(lastLine === undefined ? how : `${lastLine} (${how})`);
    })();
    void greet(child.connection);
  };

  start();

  return {
    readiness: () => readiness.get(),
    speak: async (text, voice) => {
      const current = running.get();
      if (!current) return fail({ code: "unavailable", detail: readiness.get().reason ?? "The voice isn't running." });
      const spoken = await current.connection.request("speak", { text, voice });
      if (!spoken.ok) return fail(toSpeechFailure(spoken.failure));
      const speech = toSpeech(spoken.value);
      return speech
        ? ok(Buffer.from(speech, "base64"))
        : fail({ code: "failed", detail: "The voice sent speech Ito can't read." });
    },
    listen: async (session, voiceprint, onHeard) => {
      const current = running.get();
      if (!current) return fail(readiness.get().reason ?? "The voice isn't running.");
      sessions.update((existing) => new Map([...existing, [session, onHeard]]));
      const started = await current.connection.request("listen", { session, ...(voiceprint && { voiceprint }) });
      if (!started.ok) {
        forget(session);
        return fail(started.failure.message);
      }
      const { connection } = current;
      return ok({
        hear: (pcm) => {
          connection.notify("audio", { session, pcm: Buffer.from(pcm).toString("base64") });
        },
        saying: (text) => {
          connection.notify("saying", { session, ...(text !== undefined && { text }) });
        },
        flush: async () => {
          await connection.request("flush", { session });
        },
        stop: async () => {
          forget(session);
          await connection.request("stop", { session });
        },
      });
    },
    refreshVocabulary: async () => {
      const current = running.get();
      if (current) await sendVocabulary(current.connection);
    },
    forgetVoiceprint: async () => {
      const current = running.get();
      if (current) await current.connection.request("forget", {});
    },
    close: async () => {
      isClosed.set(true);
      restart.get()?.();
      await running.get()?.stop();
    },
  };
};
