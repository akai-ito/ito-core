import type { DatabaseSync } from "node:sqlite";
import type { Job } from "#protocol/types.ts";

export type StoredJob = { readonly job: Job; readonly everyDays?: number };

export type JobStore = {
  readonly list: () => readonly StoredJob[];
  readonly save: (stored: StoredJob) => void;
  readonly remove: (id: string) => void;
};

type JobRow = { readonly every_days: number | null; readonly body: string };

export const createJobStore = (database: DatabaseSync): JobStore => ({
  list: () =>
    (database.prepare("SELECT every_days, body FROM jobs").all() as unknown as readonly JobRow[]).map((row) => ({
      job: JSON.parse(row.body) as Job,
      ...(row.every_days !== null && { everyDays: row.every_days }),
    })),
  save: ({ job, everyDays }) => {
    database
      .prepare("INSERT OR REPLACE INTO jobs (id, every_days, body) VALUES (?, ?, ?)")
      .run(job.id, everyDays ?? null, JSON.stringify(job));
  },
  remove: (id) => {
    database.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  },
});
