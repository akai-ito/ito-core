import { createCell } from "#cell.ts";
import { defaultVoice, isKnownVoice, voices } from "#speech/voices.ts";
import type { Voice } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Info, Log } from "#turns/turns.ts";

export type SpeechFailure = { readonly code: "loading" | "unknown_voice" | "failed"; readonly detail: string };

export type Speech = {
  readonly voices: readonly Voice[];
  readonly defaultVoice: string;
  readonly speak: (text: string, voice?: string) => Promise<Result<Uint8Array, SpeechFailure>>;
  readonly warm: () => Promise<void>;
};

type Rendered = { readonly audio: Float32Array; readonly sampling_rate: number };

type Kokoro = { readonly generate: (text: string, options: { readonly voice: string }) => Promise<Rendered> };

const kokoroModel = "onnx-community/Kokoro-82M-v1.0-ONNX";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const toWav = (samples: Float32Array, rate: number): Uint8Array => {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    bytes.set(new TextEncoder().encode(value), offset);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (const [index, sample] of samples.entries()) {
    const clamped = Math.min(1, Math.max(-1, sample));
    view.setInt16(44 + index * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
};

export const unknownVoice = (voice: string): SpeechFailure => ({
  code: "unknown_voice",
  detail: `There's no voice called ${voice}: choose one from GET /v0/voices.`,
});

export const createKokoroSpeech = (cacheDirectory: string, info: Info, log: Log): Speech => {
  const model = createCell<Kokoro | undefined>(undefined);
  const loading = createCell<Promise<void> | undefined>(undefined);
  const queue = createCell<Promise<unknown>>(Promise.resolve());

  const load = async (device: "cuda" | "cpu"): Promise<Kokoro> => {
    const { KokoroTTS } = await import("kokoro-js");
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = cacheDirectory;
    const options = { dtype: "fp32", device } as unknown as Parameters<typeof KokoroTTS.from_pretrained>[1];
    return (await KokoroTTS.from_pretrained(kokoroModel, options)) as unknown as Kokoro;
  };

  const loadOnce = async (): Promise<void> => {
    try {
      model.set(await load("cuda"));
      info("Ari's voice is ready, on the GPU", {});
    } catch (gpuError) {
      try {
        model.set(await load("cpu"));
        info("Ari's voice is ready, on the CPU", { gpu: describe(gpuError) });
      } catch (error) {
        log("Ari's voice couldn't load, so it'll try again when asked", error);
        loading.set(undefined);
      }
    }
  };

  const warm = (): Promise<void> => {
    const current = loading.get() ?? loadOnce();
    loading.set(current);
    return current;
  };

  return {
    voices,
    defaultVoice,
    speak: async (text, voice = defaultVoice) => {
      if (!isKnownVoice(voice)) return fail(unknownVoice(voice));
      const kokoro = model.get();
      if (!kokoro) {
        void warm();
        return fail({ code: "loading", detail: "Ari's voice is still loading." });
      }
      const render = async (): Promise<Result<Uint8Array, SpeechFailure>> => {
        try {
          const rendered = await kokoro.generate(text, { voice });
          return ok(toWav(rendered.audio, rendered.sampling_rate));
        } catch (error) {
          return fail({ code: "failed", detail: `Ari's voice couldn't say that: ${describe(error)}` });
        }
      };
      const previous = queue.get();
      const next = (async (): Promise<Result<Uint8Array, SpeechFailure>> => {
        try {
          await previous;
        } catch {
          info("An earlier sentence failed", {});
        }
        return render();
      })();
      queue.set(next);
      return next;
    },
    warm,
  };
};
