import { createHash } from "node:crypto";
import { createCell } from "#cell.ts";

export type Embedder = {
  readonly model: string;
  readonly query: (text: string) => Promise<Float32Array>;
  readonly passages: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
};

type Extract = (
  texts: readonly string[],
  options: { readonly pooling: "cls"; readonly normalize: true },
) => Promise<{ readonly tolist: () => readonly (readonly number[])[] }>;

export const defaultEmbeddingModel = "Xenova/bge-small-en-v1.5";

const queryPrefix = "Represent this sentence for searching relevant passages: ";

export const createLocalEmbedder = (cacheDirectory: string, model = defaultEmbeddingModel): Embedder => {
  const loading = createCell<Promise<Extract> | undefined>(undefined);

  const load = (): Promise<Extract> => {
    const existing = loading.get();
    if (existing) return existing;
    const started = (async (): Promise<Extract> => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", model, {
        dtype: "q8",
        cache_dir: cacheDirectory,
      })) as unknown as Extract;
    })();
    loading.set(started);
    return started;
  };

  const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
    if (texts.length === 0) return [];
    const extract = await load();
    const output = await extract(texts, { pooling: "cls", normalize: true });
    return output.tolist().map((vector) => Float32Array.from(vector));
  };

  return {
    model,
    query: async (text) => {
      const [vector] = await embed([`${queryPrefix}${text}`]);
      return vector ?? new Float32Array();
    },
    passages: embed,
  };
};

const dimensions = 64;

const toWordVector = (text: string): Float32Array => {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Float32Array(dimensions);
  for (const word of words) {
    const index = createHash("sha256").update(word).digest().readUInt16BE(0) % dimensions;
    vector.set([(vector[index] ?? 0) + 1], index);
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
};

export const wordEmbedder: Embedder = {
  model: "words",
  query: (text) => Promise.resolve(toWordVector(text)),
  passages: (texts) => Promise.resolve(texts.map((text) => toWordVector(text))),
};
