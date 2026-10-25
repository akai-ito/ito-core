import type { Chunk, StoredChunk } from "#store/memory.ts";

export type Passage = { readonly address: string; readonly title: string; readonly text: string; readonly at: string };

export const pastConversations = { address: "conversation:past", title: "Past conversations" } as const;

const longestChunk = 1200;

export const toPageChunks = (address: string, title: string, markdown: string, at: string): readonly Chunk[] =>
  markdown
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "" && !/^#+\s/u.test(paragraph))
    .map((paragraph) => ({ address, title, text: `${title}: ${paragraph.slice(0, longestChunk)}`, at }));

export const toMessageChunk = (message: string, isYours: boolean, text: string, at: string): Chunk => ({
  ...pastConversations,
  message,
  text: `${isYours ? "You said" : "Ari said"}: ${text.trim().slice(0, longestChunk)}`,
  at,
});

const cosine = (left: Float32Array, right: Float32Array): number =>
  left.length === right.length ? left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0) : 0;

const fusionConstant = 60;

export const rank = (
  chunks: readonly StoredChunk[],
  textMatches: readonly number[],
  query: Float32Array | undefined,
  limit: number,
): readonly StoredChunk[] => {
  const byVector = query
    ? chunks
        .filter((chunk) => chunk.vector !== undefined)
        .map((chunk) => ({ id: chunk.id, score: cosine(query, chunk.vector ?? new Float32Array()) }))
        .toSorted((left, right) => right.score - left.score)
        .slice(0, limit * 3)
        .map(({ id }) => id)
    : [];
  const scores = [textMatches, byVector].reduce(
    (total, ranking) =>
      ranking.reduce(
        (sum, id, index) => new Map([...sum, [id, (sum.get(id) ?? 0) + 1 / (fusionConstant + index + 1)]]),
        total,
      ),
    new Map<number, number>(),
  );
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return [...scores]
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, limit)
    .flatMap(([id]) => byId.get(id) ?? []);
};
