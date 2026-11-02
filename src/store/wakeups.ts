import type { DatabaseSync } from "node:sqlite";
import type { WakeUp } from "#protocol/types.ts";

export type WakeUpStore = {
  readonly list: () => readonly WakeUp[];
  readonly save: (wakeUp: WakeUp) => void;
  readonly remove: (id: string) => void;
};

export const createWakeUpStore = (database: DatabaseSync): WakeUpStore => ({
  list: () =>
    (database.prepare("SELECT body FROM wake_ups ORDER BY at, id").all() as unknown as readonly { body: string }[]).map(
      ({ body }) => JSON.parse(body) as WakeUp,
    ),
  save: (wakeUp) => {
    database
      .prepare("INSERT OR REPLACE INTO wake_ups (id, at, body) VALUES (?, ?, ?)")
      .run(wakeUp.id, wakeUp.at, JSON.stringify(wakeUp));
  },
  remove: (id) => {
    database.prepare("DELETE FROM wake_ups WHERE id = ?").run(id);
  },
});
