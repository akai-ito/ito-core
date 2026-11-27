import type { DatabaseSync } from "node:sqlite";
import type { Dream } from "#protocol/types.ts";

// Kumo's dreams as they finished, each with the night it stands for: the dream time it was due at, so the scheduled
// dream knows a manual one already stood in for it.
export type DreamStore = {
  readonly latest: () => Dream | undefined;
  readonly find: (id: string) => Dream | undefined;
  readonly hasSlot: (slot: string) => boolean;
  readonly save: (dream: Dream, slot: string) => void;
  // The same dream, changed, such as once it's seen.
  readonly replace: (dream: Dream) => void;
};

type Row = { readonly body: string };

const toDream = (row: Row | undefined): Dream | undefined =>
  row === undefined ? undefined : (JSON.parse(row.body) as Dream);

export const createDreamStore = (database: DatabaseSync): DreamStore => ({
  latest: () =>
    toDream(
      database.prepare("SELECT body FROM dreams ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as Row | undefined,
    ),
  find: (id) => toDream(database.prepare("SELECT body FROM dreams WHERE id = ?").get(id) as Row | undefined),
  hasSlot: (slot) => database.prepare("SELECT 1 FROM dreams WHERE slot = ? LIMIT 1").get(slot) !== undefined,
  save: (dream, slot) => {
    database
      .prepare("INSERT OR REPLACE INTO dreams (id, slot, started_at, body) VALUES (?, ?, ?, ?)")
      .run(dream.id, slot, dream.started_at, JSON.stringify(dream));
  },
  replace: (dream) => {
    database.prepare("UPDATE dreams SET body = ? WHERE id = ?").run(JSON.stringify(dream), dream.id);
  },
});
