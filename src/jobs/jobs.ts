import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Work } from "#desk/desk.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Job } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { JobStore, StoredJob } from "#store/jobs.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type Jobs = {
  readonly tools: readonly Tool[];
  readonly list: () => readonly Job[];
  readonly inMindText: () => string;
  readonly onEventEnded: (uid: string) => void;
  readonly close: () => void;
};

export type JobsOptions = {
  readonly store: JobStore;
  readonly isMotion: (id: string) => boolean;
  readonly clock: Clock;
  readonly identifiers: Pick<Identifiers, "job">;
  readonly work: Work;
  readonly info: Info;
};

const dayMs = 24 * 60 * 60 * 1000;

const defaultEveryDays = 7;

const retryMs = 60 * 60 * 1000;

const longestTimerMs = 2 ** 31 - 1;

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const failed = (text: string): ToolResult => ({ text, isError: true });

const toSortKey = ({ job }: StoredJob): string => job.at ?? "~";

const toWhen = ({ job, everyDays }: StoredJob): string =>
  [
    ...(everyDays === undefined ? [] : [`every ${String(everyDays)} days`]),
    ...(job.at === undefined ? [] : [`${everyDays === undefined ? "at" : "next at"} ${job.at}`]),
    ...(job.after_event ? [`after ${job.after_event.title}`] : []),
  ].join(", ");

export const toJobPrompt = ({ job, everyDays }: StoredJob): string =>
  [
    `It's time for a look you scheduled for yourself: “${job.why}”.`,
    ...(job.after_event ? [`It was for after ${job.after_event.title}, which has ended.`] : []),
    ...(job.motion === undefined ? [] : [`It's about ${job.motion}: read it with read_motion first.`]),
    ...(everyDays !== undefined && job.standing
      ? [`It's a standing job: you keep looking for ${job.standing.ask}, every ${String(everyDays)} days.`]
      : []),
    "",
    everyDays === undefined
      ? "- First judge whether now is a good moment for it. If it isn't, call schedule again for a better time, with " +
        "the same why, and stop."
      : "- First judge whether now is a good moment for it. If it isn't, stop: it comes back by itself.",
    "- Bring back only finished work worth having: post it once, or put a card on the Desk. When nothing is worth",
    "  their attention, bring nothing.",
    everyDays === undefined
      ? "- Otherwise don't schedule it again: it's done once this work ends."
      : `- Don't schedule it again: its next look is set for you, ${String(everyDays)} days on.`,
  ].join("\n");

export const createJobs = ({ store, isMotion, clock, identifiers, work, info }: JobsOptions): Jobs => {
  const jobs = createCell<ReadonlyMap<string, StoredJob>>(
    new Map(store.list().map((stored) => [stored.job.id, stored])),
  );
  const timers = createCell<ReadonlyMap<string, Cancel>>(new Map());
  const running = createCell<ReadonlySet<string>>(new Set());
  const isClosed = createCell(false);

  const disarm = (id: string): void => {
    timers.get().get(id)?.();
    timers.update((current) => new Map([...current].filter(([other]) => other !== id)));
  };

  const attempt = async (stored: StoredJob): Promise<Result<string, string>> => {
    try {
      return await work(toJobPrompt(stored));
    } catch (error) {
      return fail(String(error));
    }
  };

  const run = async (id: string): Promise<void> => {
    const due = jobs.get().get(id);
    if (!due || running.get().has(id) || isClosed.get()) return;
    running.update((current) => new Set([...current, id]));
    disarm(id);
    const startedAt = clock.now();
    const done = await attempt(due);
    running.update((current) => new Set([...current].filter((other) => other !== id)));
    const after = jobs.get().get(id);
    if (!after || isClosed.get()) return;
    if (!done.ok) {
      info("A scheduled look didn't finish, so it will try again", { job: id, error: done.failure });
      save({ ...after, job: { ...after.job, at: toTimestamp(clock.now() + retryMs) } });
    } else if (after.everyDays === undefined) remove(id);
    else save({ ...after, job: { ...after.job, at: toTimestamp(startedAt + after.everyDays * dayMs) } });
  };

  const arm = ({ job }: StoredJob): void => {
    disarm(job.id);
    if (job.at === undefined || isClosed.get()) return;
    const wait = Math.min(Math.max(0, Date.parse(job.at) - clock.now()), longestTimerMs);
    const cancel = clock.after(wait, () => {
      timers.update((current) => new Map([...current].filter(([other]) => other !== job.id)));
      const current = jobs.get().get(job.id);
      if (current?.job.at === undefined) return;
      if (Date.parse(current.job.at) > clock.now()) arm(current);
      else void run(job.id);
    });
    timers.update((current) => new Map([...current, [job.id, cancel]]));
  };

  const save = (stored: StoredJob): void => {
    store.save(stored);
    jobs.update((current) => new Map([...current, [stored.job.id, stored]]));
    arm(stored);
  };

  const remove = (id: string): void => {
    disarm(id);
    store.remove(id);
    jobs.update((current) => new Map([...current].filter(([other]) => other !== id)));
  };

  const toStored = (input: unknown): Result<StoredJob, string> => {
    const why = lineOf(input, "why");
    if (why === "") return fail("Say why in a line, such as “Ask how the QRT interview went”.");
    const when = lineOf(input, "at");
    const at = when === "" ? undefined : Date.parse(when);
    if (at !== undefined && (Number.isNaN(at) || !instantPattern.test(when))) {
      return fail(`${when} isn't an ISO time with its offset, such as 2026-11-03T18:00:00Z.`);
    }
    if (at !== undefined && at < clock.now()) return fail(`${when} has already passed: give a time to come.`);
    const event = fieldOf(input, "after_event");
    const uid = lineOf(event, "uid");
    const title = lineOf(event, "title");
    if (event !== undefined && (uid === "" || title === "")) return fail("Give the event's uid and title.");
    const standing = fieldOf(input, "standing");
    const ask = lineOf(standing, "ask");
    if (standing !== undefined && ask === "") return fail("Say what the standing job keeps looking for, as ask.");
    const every = fieldOf(standing, "every_days") ?? defaultEveryDays;
    if (typeof every !== "number" || !Number.isSafeInteger(every) || every < 1) {
      return fail("every_days is a whole number of days, 1 or more.");
    }
    if (at === undefined && event === undefined && standing === undefined) {
      return fail("Say when: at a time, after_event, or as a standing job.");
    }
    const motion = lineOf(input, "motion");
    if (motion !== "" && !isMotion(motion)) return fail(`There's no thing ${motion} in motion.`);
    const everyDays = standing === undefined ? undefined : every;
    const next = at ?? (everyDays === undefined ? undefined : clock.now() + everyDays * dayMs);
    return ok({
      job: {
        id: identifiers.job(),
        why,
        ...(next !== undefined && { at: toTimestamp(next) }),
        ...(event !== undefined && { after_event: { uid, title } }),
        ...(standing !== undefined && { standing: { ask } }),
        ...(motion !== "" && { motion }),
      },
      ...(everyDays !== undefined && { everyDays }),
    });
  };

  const sorted = (): readonly StoredJob[] =>
    jobs
      .get()
      .values()
      .toArray()
      .toSorted((left, right) => toSortKey(left).localeCompare(toSortKey(right)));

  const tools: readonly Tool[] = [
    {
      name: "schedule",
      title: "Schedule a look",
      description:
        "Schedule your own next look: a follow-up with a real stake, a check-in after an event, or a " +
        "standing job they asked for. When it comes due, you work on it in the background, judging first whether " +
        "it's a good moment.",
      inputSchema: {
        type: "object",
        properties: {
          why: { type: "string", description: "What it's for, such as “Ask how the QRT interview went”." },
          at: { type: "string", description: "When, as an ISO time with its offset, such as 2026-11-03T18:00:00Z." },
          after_event: {
            type: "object",
            description: "A calendar event: the look comes due once it ends.",
            properties: { uid: { type: "string" }, title: { type: "string" } },
            required: ["uid", "title"],
            additionalProperties: false,
          },
          standing: {
            type: "object",
            description: "A standing job, which comes back by itself until they stop it.",
            properties: {
              ask: { type: "string", description: "What it keeps looking for, such as “startups I'd join”." },
              every_days: { type: "integer", minimum: 1, description: "How often, in days: 7 unless they say." },
            },
            required: ["ask"],
            additionalProperties: false,
          },
          motion: { type: "string", description: "The thing in motion it's about, by id." },
        },
        required: ["why"],
        additionalProperties: false,
      },
      call: (input) => {
        const stored = toStored(input);
        if (!stored.ok) return Promise.resolve(failed(stored.failure));
        save(stored.value);
        return Promise.resolve({ text: `Scheduled ${stored.value.job.id}, ${toWhen(stored.value)}.` });
      },
    },
    {
      name: "cancel",
      title: "Cancel a scheduled look",
      description: "Stop a look you scheduled, by its id, such as a standing job they no longer want.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      call: (input) => {
        const id = lineOf(input, "id");
        const found = jobs.get().get(id);
        if (!found) return Promise.resolve(failed(`There's no scheduled look ${id || "with that id"}.`));
        remove(id);
        return Promise.resolve({ text: `Cancelled ${id}: ${found.job.why}.` });
      },
    },
  ];

  for (const stored of jobs.get().values()) arm(stored);

  return {
    tools,
    list: () => sorted().map(({ job }) => job),
    inMindText: () => {
      const scheduled = sorted().map((stored) => `- ${stored.job.id}: ${stored.job.why} (${toWhen(stored)})`);
      return scheduled.length === 0
        ? ""
        : [
            "<scheduled>",
            "Looks you scheduled, soonest first. Stop one with cancel when they say so.",
            ...scheduled,
            "</scheduled>",
          ].join("\n");
    },
    onEventEnded: (uid) => {
      for (const { job } of jobs.get().values()) {
        if (job.after_event?.uid === uid) void run(job.id);
      }
    },
    close: () => {
      isClosed.set(true);
      for (const cancel of timers.get().values()) cancel();
      timers.set(new Map());
    },
  };
};
