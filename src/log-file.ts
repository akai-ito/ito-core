import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";

export type LogFile = { readonly write: (line: string) => void; readonly close: () => void };

export type DayFile = { readonly day: string; readonly file: string };

export const keptDays = 14;

const dayMs = 24 * 60 * 60 * 1000;

const filePattern = /^ito-(?<day>\d{4}-\d{2}-\d{2})\.log$/u;

const pad = (number: number): string => String(number).padStart(2, "0");

export const logDirectory = (home: string): string => path.join(home, "logs");

export const localDay = (milliseconds: number): string => {
  const date = new Date(milliseconds);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const dayFiles = (directory: string): readonly DayFile[] => {
  try {
    return readdirSync(directory)
      .flatMap((name) => {
        const day = filePattern.exec(name)?.groups?.day;
        return day === undefined ? [] : { day, file: path.join(directory, name) };
      })
      .toSorted((left, right) => left.day.localeCompare(right.day));
  } catch {
    return [];
  }
};

// Noon, so a day either side of a clock change is still a day.
const daysBefore = (day: string, count: number): string => localDay(Date.parse(`${day}T12:00:00`) - count * dayMs);

export const createLogFile = ({
  directory,
  clock,
  onFailure,
}: {
  readonly directory: string;
  readonly clock: Clock;
  readonly onFailure: (reason: string) => void;
}): LogFile => {
  const open = createCell<{ readonly day: string; readonly fd: number } | undefined>(undefined);
  const hasFailed = createCell(false);

  const prune = (today: string): void => {
    const oldest = daysBefore(today, keptDays - 1);
    for (const { day, file } of dayFiles(directory)) if (day < oldest) rmSync(file, { force: true });
  };

  const fileFor = (day: string): number => {
    const current = open.get();
    if (current?.day === day) return current.fd;
    if (current) closeSync(current.fd);
    mkdirSync(directory, { recursive: true });
    const fd = openSync(path.join(directory, `ito-${day}.log`), "a");
    open.set({ day, fd });
    prune(day);
    return fd;
  };

  return {
    write: (line) => {
      try {
        const today = localDay(clock.now());
        writeSync(fileFor(today), line);
        hasFailed.set(false);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!hasFailed.get()) onFailure(reason);
        hasFailed.set(true);
      }
    },
    close: () => {
      const current = open.get();
      open.set(undefined);
      if (current) closeSync(current.fd);
    },
  };
};
