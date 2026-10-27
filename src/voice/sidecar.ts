import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createCell } from "#cell.ts";
import { recentCrashes, toRestartDecision } from "#capabilities/restarts.ts";
import type { Cancel } from "#clock.ts";
import { createConnection, type Connection, type RpcFailure } from "#json-rpc.ts";
import { fail, ok } from "#result.ts";
import { toWav, type Readiness, type SpeechFailure, type VoiceContext, type VoiceLoop } from "#voice/loop.ts";

export const voiceProtocol = "0.1";

export const voiceDirectory = fileURLToPath(new URL("../../voice", import.meta.url));

export const voicePython = (directory: string): string => path.join(directory, ".venv", "bin", "python");

export const voiceModels = (home: string): string => path.join(home, "models", "huggingface");

export const vocabularyFile = (home: string): string => path.join(home, "voice", "vocabulary.json");

export type SidecarOptions = VoiceContext & { readonly directory: string; readonly models: string };

type Running = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: Connection;
  readonly exited: Promise<string>;
};

const gracefulExitMs = 3000;

const unavailableCodes: ReadonlySet<number> = new Set([-32_001, -32_002, -32_099]);

const passedVariables = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "LD_LIBRARY_PATH",
  "CUDA_VISIBLE_DEVICES",
  "ITO_VOICE_DEVICE",
  "HF_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export const toVoiceEnvironment = (
  environment: NodeJS.ProcessEnv,
  models: string,
): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(
    passedVariables.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  ),
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

const toSpeech = (value: unknown): { readonly audio: string; readonly rate: number } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { audio, rate } = value as { readonly audio?: unknown; readonly rate?: unknown };
  return typeof audio === "string" && typeof rate === "number" ? { audio, rate } : undefined;
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
  const running = createCell<Running | undefined>(undefined);
  const crashes = createCell<readonly number[]>([]);
  const restart = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

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
    const child = spawn(python, ["-m", "ito_voice", "serve"], {
      cwd: directory,
      env: toVoiceEnvironment(process.env, models),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const lastLine = createCell<string | undefined>(undefined);
    child.stdin.on("error", (error) => {
      log("Couldn't write to the voice", error);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        lastLine.set(line);
        info("Voice", { line });
      }
    });
    const exited = new Promise<string>((resolve) => {
      child.once("error", (error) => {
        resolve(`it couldn't start: ${error.message}`);
      });
      child.once("exit", (code, signal) => {
        const how = signal ? `killed by ${signal}` : `exit code ${String(code)}`;
        const last = lastLine.get();
        resolve(last ? `${last} (${how})` : how);
      });
    });
    const connection = createConnection({
      input: child.stdout,
      output: child.stdin,
      onNotification: ({ method, parameters }) => {
        if (method === "status" && isReadiness(parameters)) report(parameters);
      },
      onRequest: ({ method }) => fail({ code: -32_601, message: `Ito doesn't handle ${method}.` }),
      onMalformed: (line) => {
        info("Voice", { line });
      },
      closedMessage: "The voice stopped.",
    });
    running.set({ child, connection, exited });
    void (async () => {
      afterExit(await exited);
    })();
    void greet(connection);
  };

  const stop = async ({ child, exited }: Running): Promise<void> => {
    child.stdin.end();
    const didExit = async (): Promise<boolean> => {
      await exited;
      return true;
    };
    const hasExited = await Promise.race([didExit(), delay(gracefulExitMs, false)]);
    if (hasExited || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    process.kill(-child.pid, "SIGKILL");
    await exited;
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
        ? ok(toWav(Buffer.from(speech.audio, "base64"), speech.rate))
        : fail({ code: "failed", detail: "The voice sent speech Ito can't read." });
    },
    refreshVocabulary: async () => {
      const current = running.get();
      if (current) await sendVocabulary(current.connection);
    },
    close: async () => {
      isClosed.set(true);
      restart.get()?.();
      const current = running.get();
      if (current) await stop(current);
    },
  };
};
