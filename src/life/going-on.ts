import { toDay } from "#memory/pages.ts";
import type { Memory, PageSummary } from "#memory/memory.ts";
import type { Fields } from "#motion/changes.ts";
import type { MotionDetail, Motions } from "#motion/motion.ts";
import type { GoingOnGroup, GoingOnThread, Motion } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Busy } from "#life/busy.ts";

// Going on: what's going on in their life as threads beside time, in three groups. Matters are things in motion
// with no shape of a project or a goal (a role, an occasion, a case); projects are projects and trips, in motion or
// on memory's projects shelf; goals are training and learning, in motion or on the goals shelf. A page that names a
// thing in motion (`motion:<id>`), or has its title, is one thread with it. Each thread has its recent marks (its
// changes), the next thing, its steps, and whether Kumo is working on it right now.
export type GoingOn = { readonly threads: () => Promise<readonly GoingOnThread[]> };

export type GoingOnOptions = {
  readonly memory: Pick<Memory, "sync" | "pages" | "page" | "changesOf">;
  readonly motions: Pick<Motions, "list" | "detail">;
  readonly busy: Pick<Busy, "isWorking">;
  readonly now: () => number;
  readonly timeZone: () => string;
};

const groups: readonly GoingOnGroup[] = ["matters", "projects", "goals"];

const groupOfKind: Readonly<Record<string, GoingOnGroup>> = {
  project: "projects",
  trip: "projects",
  body: "goals",
  training: "goals",
  learning: "goals",
};

const saliences = ["loud", "normal", "quiet"];

const stepStatuses = ["done", "doing", "planned"] as const;

const isStepStatus = (status: string): status is (typeof stepStatuses)[number] =>
  (stepStatuses as readonly string[]).includes(status);

const dayMs = 24 * 60 * 60 * 1000;

// Marks further back than this aren't drawn: the thread shows the last few months.
const marksSinceMs = 120 * dayMs;
const mostMarks = 12;

// A page on the shelves counts as going on while it's changed this lately, or joined to an active thing in motion.
const pageLivelyMs = 90 * dayMs;

const pageChangesRead = 200;

type Mark = GoingOnThread["marks"][number];

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dayIn = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : undefined;

// When it ends, for a goal's ringed end or a trip's last day.
const endOf = (content: Fields): string | undefined =>
  dayIn(fieldOf(fieldOf(content, "dates"), "end")) ?? dayIn(fieldOf(fieldOf(content, "goal"), "by"));

const stepsOf = (content: Fields): GoingOnThread["steps"] => {
  const listed = fieldOf(content, "parts") ?? fieldOf(content, "steps");
  if (!Array.isArray(listed)) return undefined;
  const steps = listed
    .map((part: unknown) => ({ title: textOf(part, "title"), status: textOf(part, "status") }))
    .filter(
      (step): step is { title: string; status: (typeof stepStatuses)[number] } =>
        step.title !== "" && isStepStatus(step.status),
    );
  return steps.length > 0 ? steps : undefined;
};

const nextOf = (content: Fields): GoingOnThread["next"] => {
  const next = fieldOf(content, "next");
  if (!isObject(next) || textOf(next, "text") === "") return undefined;
  const at = textOf(next, "at");
  return { text: textOf(next, "text"), ...(at !== "" && { at }) };
};

const byTime = (left: Mark, right: Mark): number => left.at.localeCompare(right.at);

const latestOf = (thread: GoingOnThread): string => thread.marks.at(-1)?.at ?? thread.began;

const order = (left: GoingOnThread, right: GoingOnThread): number =>
  groups.indexOf(left.group) - groups.indexOf(right.group) ||
  saliences.indexOf(left.salience ?? "normal") - saliences.indexOf(right.salience ?? "normal") ||
  latestOf(right).localeCompare(latestOf(left));

const sameTitle = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();

export const createGoingOn = ({ memory, motions, busy, now, timeZone }: GoingOnOptions): GoingOn => {
  const pageOf = (summary: PageSummary): { readonly summary: PageSummary; readonly markdown: string } => {
    const page = memory.page(summary.address);
    return { summary, markdown: page.ok ? page.value.markdown : "" };
  };

  const marksOf = (
    detail: MotionDetail | undefined,
    page: PageSummary | undefined,
  ): { readonly marks: Mark[]; readonly first?: string } => {
    const since = new Date(now() - marksSinceMs).toISOString();
    const fromMotion = (detail?.changes ?? []).map(({ at, note }) => ({ at, note }));
    const pageChanges = page === undefined ? [] : memory.changesOf(page.address, pageChangesRead);
    const fromPage = pageChanges.map(({ at, note }) => ({ at, ...(note !== undefined && { note }) }));
    const marks = [...fromMotion, ...fromPage]
      .filter(({ at }) => at >= since)
      .toSorted(byTime)
      .slice(-mostMarks);
    return { marks, ...(pageChanges.at(-1) && { first: pageChanges.at(-1)?.at }) };
  };

  const toThread = (
    motion: Motion | undefined,
    detail: MotionDetail | undefined,
    page: { readonly summary: PageSummary; readonly shelf: GoingOnGroup } | undefined,
  ): GoingOnThread => {
    const content = detail?.content ?? {};
    const { marks, first } = marksOf(detail, page?.summary);
    const began = toDay(Date.parse(motion?.started_at ?? first ?? page?.summary.changed_at ?? ""), timeZone());
    const ends = endOf(content);
    const steps = stepsOf(content);
    const next = nextOf(content);
    const targets = [...(motion ? [`motion:${motion.id}`] : []), ...(page ? [page.summary.address] : [])];
    const gist = page?.summary.gist;
    return {
      id: targets[0] ?? "",
      group: page?.shelf ?? groupOfKind[motion?.kind ?? ""] ?? "matters",
      title: motion?.title ?? page?.summary.title ?? "",
      ...(motion?.summary && { status: motion.summary }),
      ...(gist !== undefined && { line: gist }),
      began,
      ...(ends !== undefined && { ends }),
      marks,
      ...(steps && { steps }),
      ...(next && { next }),
      working: targets.some((target) => busy.isWorking(target)),
      ...(motion && { motion: motion.id, kind: motion.kind, salience: motion.salience }),
      ...(page && { page: page.summary.address }),
    };
  };

  return {
    threads: async () => {
      await memory.sync();
      const all = motions.list();
      const active = all.filter((motion) => motion.status === "active");
      const done = new Set(all.filter((motion) => motion.status === "done").map((motion) => motion.id));
      const pages = (["projects", "goals"] as const).flatMap((shelf) =>
        memory.pages(shelf).map((summary) => ({ ...pageOf(summary), shelf })),
      );
      const joinedTo = (motion: Motion) =>
        pages.find(
          ({ summary, markdown }) => markdown.includes(`motion:${motion.id}`) || sameTitle(summary.title, motion.title),
        );
      const isDoneElsewhere = (markdown: string): boolean =>
        markdown.matchAll(/motion:(?<id>[a-z0-9-]+)/gu).some((match) => done.has(match.groups?.id ?? ""));
      const fromMotions = await Promise.all(
        active.map(async (motion) => {
          const detail = await motions.detail(motion.id);
          const page = joinedTo(motion);
          return {
            thread: toThread(motion, detail.ok ? detail.value : undefined, page),
            page: page?.summary.address,
          };
        }),
      );
      const joined = new Set(fromMotions.map(({ page }) => page).filter((page) => page !== undefined));
      const lively = new Date(now() - pageLivelyMs).toISOString();
      const fromPages = pages
        .filter(
          ({ summary, markdown }) =>
            !joined.has(summary.address) && summary.changed_at >= lively && !isDoneElsewhere(markdown),
        )
        .map((page) => toThread(undefined, undefined, page));
      return [...fromMotions.map(({ thread }) => thread), ...fromPages].toSorted(order);
    },
  };
};
