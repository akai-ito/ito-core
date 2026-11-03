import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { dayFiles, localDay, logDirectory } from "#log-file.ts";
import { fail, ok, type Result } from "#result.ts";

export const logsUsage = "ito logs [--since 7:00|2h|2026-11-01] [--about <area>] [--problems] [--raw]";

type Line = { readonly raw: string; readonly entry: Readonly<Record<string, unknown>> };

type Filter = {
  readonly since: number;
  readonly about?: string;
  readonly isProblemsOnly: boolean;
  readonly isRaw: boolean;
};

const minuteMs = 60 * 1000;

const dayMs = 24 * 60 * minuteMs;

const unitMs: Readonly<Record<string, number>> = { m: minuteMs, h: 60 * minuteMs, d: dayMs };

const levels: Readonly<Record<number, string>> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

const warnLevel = 40;

const plumbing = new Set(["level", "time", "pid", "hostname", "msg", "v", "reqId"]);

const valueLimit = 300;

// What each area's lines say, in their message or their fields' names.
const areas: Readonly<Record<string, RegExp>> = {
  mail: /\b(?:mail|imap|smtp|inbox|drafts?|sent|unsubscribe|unsubscribed|unsubscribing|sender|catch-up|attention pass|account)\b/iu,
  calendar: /\b(?:calendar|caldav|invites?|holds?)\b/iu,
  notifications: /\b(?:notifications?|push|apns|devices?)\b/iu,
  voice: /\b(?:voice\w*|calls?|spoken|speech|sentences?|sidecar)\b/iu,
  capabilities: /\b(?:capabilit(?:y|ies))\b/iu,
  memory: /\b(?:memory|thread|beliefs?)\b/iu,
  motion: /\b(?:things? in motion|motion)\b/iu,
  kumo: /\b(?:codex|engine|turns?|work|topics?|routing|cards?|steer)\b/iu,
  requests: /\b(?:incoming request|request completed|req|res)\b/iu,
};

export const logAreas: readonly string[] = Object.keys(areas);

const isRequest = (entry: Readonly<Record<string, unknown>>): boolean => "req" in entry || "res" in entry;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const parseSince = (text: string | undefined, now: number): Result<number, string> => {
  if (text === undefined) return ok(Date.parse(`${localDay(now)}T00:00:00`));
  const clock = /^(?<hours>\d{1,2}):(?<minutes>\d{2})$/u.exec(text)?.groups;
  if (clock?.hours !== undefined && clock.minutes !== undefined) {
    const today = Date.parse(`${localDay(now)}T${clock.hours.padStart(2, "0")}:${clock.minutes}:00`);
    if (Number.isNaN(today)) return fail(`"${text}" isn't a time of day.`);
    return ok(today > now ? today - dayMs : today);
  }
  const ago = /^(?<count>\d+)(?<unit>[mhd])$/u.exec(text)?.groups;
  if (ago?.count !== undefined && ago.unit !== undefined) return ok(now - Number(ago.count) * (unitMs[ago.unit] ?? 0));
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? `${text}T00:00:00` : text;
  const at = Date.parse(day);
  return Number.isNaN(at) ? fail(`"${text}" isn't a time: use 7:00, 2h, 30m, 3d or a date.`) : ok(at);
};

const parseFilter = (flags: readonly string[], now: number): Result<Filter, string> => {
  try {
    const { values } = parseArgs({
      args: [...flags],
      options: {
        since: { type: "string" },
        about: { type: "string" },
        problems: { type: "boolean", default: false },
        raw: { type: "boolean", default: false },
      },
    });
    const since = parseSince(values.since, now);
    if (!since.ok) return since;
    const about = values.about?.toLowerCase();
    if (about !== undefined && !logAreas.includes(about)) {
      return fail(`There's no area "${about}": use ${logAreas.join(", ")}.`);
    }
    return ok({
      since: since.value,
      ...(about !== undefined && { about }),
      isProblemsOnly: values.problems,
      isRaw: values.raw,
    });
  } catch (error) {
    return fail(describe(error));
  }
};

const toLine = (raw: string): Line | undefined => {
  try {
    const entry = JSON.parse(raw) as unknown;
    return entry !== null && typeof entry === "object" ? { raw, entry: entry as Record<string, unknown> } : undefined;
  } catch {
    return undefined;
  }
};

const timeOf = ({ entry }: Line): number => (typeof entry.time === "number" ? entry.time : 0);

const levelOf = ({ entry }: Line): number => (typeof entry.level === "number" ? entry.level : 30);

const messageOf = ({ entry }: Line): string => (typeof entry.msg === "string" ? entry.msg : "");

const isAbout = (line: Line, area: string | undefined): boolean => {
  const { entry } = line;
  if (area === "requests") return isRequest(entry);
  if (isRequest(entry)) return false;
  if (area === undefined) return true;
  const words = [messageOf(line), ...Object.keys(entry).filter((field) => !plumbing.has(field))].join(" ");
  return areas[area]?.test(words) ?? false;
};

const shown = (value: unknown): string => {
  if (typeof value === "number") return String(Number.isSafeInteger(value) ? value : Math.round(value * 10) / 10);
  if (typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const short = text.length > valueLimit ? `${text.slice(0, valueLimit)}…` : text;
  return typeof value === "string" && /^[^\s"=]+$/u.test(short) ? short : JSON.stringify(short);
};

const fieldsOf = (entry: Readonly<Record<string, unknown>>): string =>
  Object.entries(entry)
    .filter(([field]) => !plumbing.has(field))
    .map(([field, value]) => {
      if (field === "err" && value !== null && typeof value === "object") {
        return `error=${shown(Reflect.get(value, "message") ?? value)}`;
      }
      if (field === "req" && value !== null && typeof value === "object") {
        return `${String(Reflect.get(value, "method"))} ${String(Reflect.get(value, "url"))}`;
      }
      if (field === "res" && value !== null && typeof value === "object") {
        return `status=${String(Reflect.get(value, "statusCode"))}`;
      }
      return `${field}=${shown(value)}`;
    })
    .join(" ");

const clockTime = (milliseconds: number): string =>
  new Date(milliseconds).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const dayTitle = (milliseconds: number): string =>
  new Date(milliseconds).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const readable = (line: Line): string => {
  const level = (levels[levelOf(line)] ?? "INFO").padEnd(5);
  const fields = fieldsOf(line.entry);
  return `${clockTime(timeOf(line))}  ${level}  ${messageOf(line)}${fields === "" ? "" : `  ${fields}`}`;
};

export const showLogs = (flags: readonly string[], io: Io, now = Date.now()): number => {
  const filter = parseFilter(flags, now);
  if (!filter.ok) {
    io.printError(`${filter.failure}\nUsage: ${logsUsage}`);
    return 1;
  }
  const { since, about, isProblemsOnly, isRaw } = filter.value;
  const directory = logDirectory(toPaths(io.environment).home);
  const files = dayFiles(directory).filter(({ day }) => day >= localDay(since));
  const lines = files
    .flatMap(({ file }) => readFileSync(file, "utf8").split("\n"))
    .flatMap((raw) => toLine(raw) ?? [])
    .filter((line) => timeOf(line) >= since)
    .filter((line) => !isProblemsOnly || levelOf(line) >= warnLevel)
    .filter((line) => isAbout(line, about));
  if (lines.length === 0) {
    io.print(files.length === 0 ? `No logs in ${directory} since then.` : "Nothing logged that matches.");
    return 0;
  }
  if (isRaw) {
    for (const { raw } of lines) io.print(raw);
    return 0;
  }
  lines.reduce<string>((day, line) => {
    const today = localDay(timeOf(line));
    if (today !== day) io.print(`${day === "" ? "" : "\n"}${dayTitle(timeOf(line))}`);
    io.print(readable(line));
    return today;
  }, "");
  return 0;
};
