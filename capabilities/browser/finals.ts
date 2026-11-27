import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";

// A final step: a press that commits something, such as booking a table. Each is written down before it's pressed,
// so one whose answer was lost, or that a restart cut off, is known to be uncertain, and nothing on that site is
// committed again until Kumo has looked on the site and said how it went.
export type FinalState = "pending" | "done" | "uncertain" | "went_through" | "not_through";

export type Final = {
  readonly id: string;
  readonly at: number;
  readonly site: string;
  readonly origin: string;
  readonly url: string;
  readonly button: string;
  readonly state: FinalState;
  readonly reason?: string;
  readonly how?: string;
  // The site's own reference for what went through, such as a booking number, as Kumo read it on the confirmation.
  readonly reference?: string;
};

export type Finals = {
  readonly begin: (given: Pick<Final, "site" | "origin" | "url" | "button">) => Final;
  readonly finish: (id: string, state: "done" | "uncertain", reason?: string) => void;
  readonly uncertainOn: (origin: string) => Final | undefined;
  readonly settle: (
    id: string,
    outcome: "went_through" | "not_through",
    how: string,
    lastRead: number,
    reference?: string,
  ) => Result<Final, string>;
  readonly find: (id: string) => Final | undefined;
};

const kept = 100;

const parse = (file: string): readonly Final[] => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as readonly Final[]) : [];
  } catch {
    return [];
  }
};

export const createFinals = (folder: string, now: () => number): Finals => {
  const file = path.join(folder, "finals.json");
  // A step still pending when the capability starts was cut off: its answer never came.
  const finals = createCell<readonly Final[]>(
    parse(file).map((final) =>
      final.state === "pending"
        ? { ...final, state: "uncertain", reason: "Ito stopped before the site answered." }
        : final,
    ),
  );
  const save = (): void => {
    mkdirSync(folder, { recursive: true });
    const temporary = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, JSON.stringify(finals.get().slice(-kept), undefined, 1), { mode: 0o600 });
    renameSync(temporary, file);
  };
  const change = (id: string, changed: (final: Final) => Final): void => {
    finals.update((current) => current.map((final) => (final.id === id ? changed(final) : final)));
    save();
  };
  save();

  return {
    begin: (given) => {
      const final: Final = {
        id: `final-${String(now())}-${String(finals.get().length + 1)}`,
        at: now(),
        ...given,
        state: "pending",
      };
      finals.update((current) => [...current, final]);
      save();
      return final;
    },
    finish: (id, state, reason) => {
      change(id, (final) => ({ ...final, state, ...(reason !== undefined && { reason }) }));
    },
    uncertainOn: (origin) => finals.get().find((final) => final.state === "uncertain" && final.origin === origin),
    // An uncertain step is settled either way; one the site answered can be confirmed, with its reference, or found
    // not to have gone through after all.
    settle: (id, outcome, how, lastRead, reference) => {
      const final = finals.get().find((candidate) => candidate.id === id);
      if (!final) return fail(`There's no final step ${id}.`);
      if (final.state === "pending" || final.state === "not_through")
        return fail(`${final.button} on ${final.site} can't be settled: it's ${final.state}.`);
      if (lastRead <= final.at) {
        return fail(
          `Look on ${final.site} first: read the page that shows whether “${final.button}” went through, such as ` +
            "its bookings or orders, then settle it.",
        );
      }
      const settled: Final = {
        ...final,
        state: outcome,
        how,
        ...(reference !== undefined && outcome === "went_through" && { reference }),
      };
      change(id, () => settled);
      return ok(settled);
    },
    find: (id) => finals.get().find((final) => final.id === id),
  };
};
