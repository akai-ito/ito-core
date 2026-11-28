import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { DoneEntry, Track, TrackEvidence, TrackStage } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's learning tracks: any area it's getting to know them in, or learning to do well, such as sorting their mail,
// writing as them or planning their weekends. Each has a stage and what it stands on. Kumo moves a track by judgement,
// and a correction always steps it back. Their corrections live here as evidence, not as rules on How to help you:
// Kumo reads the recent ones as context, so its judgement follows them the same day, and the nightly dream reads
// what came in since it last ran and distils what lasts into How to help you.
export type Tracks = {
  readonly list: () => readonly Track[];
  readonly find: (id: string) => Track | undefined;
  // "That was wrong" on a call that belongs to a track: it steps back, with the call as evidence.
  readonly corrected: (entry: DoneEntry, text: string) => void;
  // Said again about the same call, with words: they join its evidence, and the track stays where it is.
  readonly addWords: (entry: DoneEntry, words: string) => void;
  // What every track has stood on since a time, newest first, such as for the dream.
  readonly evidenceSince: (at: string) => readonly TrackEvidenceOf[];
  // The same, as a prompt reads it, or "" when there's none.
  readonly evidenceText: (at: string) => string;
  // They answered one of Kumo's questions on a track, in Understanding you: the answer is evidence on it.
  readonly answered: (id: string, text: string, question: string) => void;
  readonly tools: readonly Tool[];
  readonly inMindText: () => string;
};

export type TrackEvidenceOf = { readonly track: Track; readonly evidence: TrackEvidence };

export type TracksOptions = {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly identifiers: { readonly track: () => string };
  readonly info: Info;
  // Where they are, for the day a line of evidence names.
  readonly timeZone?: () => string;
};

export const stages: readonly TrackStage[] = ["learning", "spot_checks", "trusted"];

const stageWords: Readonly<Record<TrackStage, string>> = {
  learning: "learning",
  spot_checks: "spot checks",
  trusted: "trusted",
};

const evidenceKept = 10;

// The corrections each track shows in mind: the newest few, from the last month.
const correctionsInMind = 2;
const inMindMs = 30 * 24 * 60 * 60 * 1000;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const isStage = (value: unknown): value is TrackStage => stages.includes(value as TrackStage);

const stepBack = (stage: TrackStage): TrackStage => stages[Math.max(0, stages.indexOf(stage) - 1)] ?? "learning";

export const createTracks = ({ database, clock, identifiers, info, timeZone = () => "UTC" }: TracksOptions): Tracks => {
  const read = (): readonly Track[] =>
    (
      database.prepare("SELECT body FROM tracks ORDER BY position").all() as unknown as readonly {
        readonly body: string;
      }[]
    ).map(({ body }) => JSON.parse(body) as Track);

  const tracks = createCell<readonly Track[]>(read());

  const save = (track: Track): void => {
    const position = tracks.get().findIndex(({ id }) => id === track.id);
    database
      .prepare("INSERT OR REPLACE INTO tracks (id, position, body) VALUES (?, ?, ?)")
      .run(track.id, position === -1 ? tracks.get().length : position, JSON.stringify(track));
    tracks.set(read());
  };

  const find = (id: string): Track | undefined => tracks.get().find((track) => track.id === id);

  const withEvidence = (track: Track, evidence: TrackEvidence): Track => ({
    ...track,
    evidence: [evidence, ...track.evidence].slice(0, evidenceKept),
  });

  const now = (): string => toTimestamp(clock.now());

  // `26 Nov`, for a line of evidence.
  const dayOf = (at: string): string =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: timeZone() }).format(Date.parse(at));

  const evidenceSince = (at: string): readonly TrackEvidenceOf[] =>
    tracks
      .get()
      .flatMap((track) =>
        track.evidence.filter((evidence) => evidence.at >= at).map((evidence) => ({ track, evidence })),
      )
      .toSorted((left, right) => right.evidence.at.localeCompare(left.evidence.at));

  // A correction always steps a track back, whatever its stage.
  const correct = (track: Track, text: string, done?: string): Track => {
    const stage = stepBack(track.stage);
    const corrected: Track = {
      ...track,
      stage,
      since: stage === track.stage ? track.since : now(),
      corrected: track.corrected + 1,
    };
    info("A track stepped back after a correction", { track: track.id, stage });
    return withEvidence(corrected, { at: now(), kind: "corrected", text, stage, ...(done !== undefined && { done }) });
  };

  const tools: readonly Tool[] = [
    {
      name: "open_track",
      title: "Start learning an area",
      description:
        "Open a learning track for an area you're getting to know them in, or learning to do well, such as " +
        "“Sorting mail”, “Writing as you”, “Food habits” or “Planning weekends”. It starts at Learning: show them " +
        "your calls and ask when unsure. Name the track with done when you record a call in it.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "A few words, such as “Writing as you”." },
          note: { type: "string", description: "Where it stands, in a line." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      call: (input) => {
        const name = lineOf(input, "name");
        if (name === "" || name.length > 40) return Promise.resolve(failed("Name it in 40 characters or fewer."));
        const same = tracks.get().find((track) => track.name.toLowerCase() === name.toLowerCase());
        if (same) return Promise.resolve({ text: `${same.name} is already a track, ${same.id}.` });
        const note = lineOf(input, "note");
        const track: Track = {
          id: identifiers.track(),
          name,
          stage: "learning",
          since: now(),
          ...(note !== "" && { note }),
          confirmed: 0,
          corrected: 0,
          evidence: [],
        };
        save(track);
        return Promise.resolve({ text: `Opened ${track.id}: ${name}, at Learning.` });
      },
    },
    {
      name: "move_track",
      title: "Move a learning track",
      description:
        "Move a track to another stage on evidence, such as weeks of their confirmations with no correction, or " +
        "back when you've been getting it wrong.",
      inputSchema: {
        type: "object",
        properties: {
          track: { type: "string" },
          stage: { enum: stages },
          why: { type: "string", description: "In a line, such as “Three weeks of drafts sent as I wrote them”." },
          note: { type: "string", description: "Where it stands now, in a line." },
        },
        required: ["track", "stage", "why"],
        additionalProperties: false,
      },
      call: (input) => {
        const track = find(lineOf(input, "track"));
        if (!track) return Promise.resolve(failed("There's no such track."));
        const stage = fieldOf(input, "stage");
        if (!isStage(stage)) return Promise.resolve(failed("A stage is learning, spot_checks or trusted."));
        const why = lineOf(input, "why");
        if (why === "") return Promise.resolve(failed("Say why, in a line."));
        const note = lineOf(input, "note");
        const moved: Track = {
          ...track,
          stage,
          since: stage === track.stage ? track.since : now(),
          ...(note !== "" && { note }),
        };
        save(withEvidence(moved, { at: now(), kind: "moved", text: why, stage }));
        return Promise.resolve({ text: `${track.name} is at ${stageWords[stage]} now.` });
      },
    },
    {
      name: "note_track",
      title: "Note what a track stands on",
      description:
        "Note a confirmation (they said or showed you got it right, such as sending your draft as you wrote it) or " +
        "a correction (they told you it was wrong) on a track. A correction always steps the track back; its text " +
        "says what was wrong and what you'll do differently, general enough to apply next time.",
      inputSchema: {
        type: "object",
        properties: {
          track: { type: "string" },
          kind: { enum: ["confirmed", "corrected"] },
          text: { type: "string", description: "In a line, such as “Sent the Tess draft as I wrote it”." },
          done: { type: "string", description: "The Done entry it's about, if any." },
        },
        required: ["track", "kind", "text"],
        additionalProperties: false,
      },
      call: (input) => {
        const track = find(lineOf(input, "track"));
        if (!track) return Promise.resolve(failed("There's no such track."));
        const text = lineOf(input, "text");
        if (text === "") return Promise.resolve(failed("Say what happened, in a line."));
        const done = lineOf(input, "done");
        if (fieldOf(input, "kind") === "corrected") {
          const stepped = correct(track, text, done === "" ? undefined : done);
          save(stepped);
          return Promise.resolve({ text: `Noted. ${track.name} is at ${stageWords[stepped.stage]}.` });
        }
        save(
          withEvidence(
            { ...track, confirmed: track.confirmed + 1 },
            { at: now(), kind: "confirmed", text, ...(done !== "" && { done }) },
          ),
        );
        return Promise.resolve({ text: `Noted on ${track.name}.` });
      },
    },
  ];

  return {
    list: () => tracks.get(),
    find,
    corrected: (entry, text) => {
      const track = entry.track === undefined ? undefined : find(entry.track);
      if (track) save(correct(track, text, entry.id));
    },
    addWords: (entry, words) => {
      const track = entry.track === undefined ? undefined : find(entry.track);
      if (!track) return;
      save({
        ...track,
        evidence: track.evidence.map((evidence) =>
          evidence.kind === "corrected" && evidence.done === entry.id
            ? { ...evidence, text: `${evidence.text}${evidence.text.includes(": ") ? ";" : ":"} ${words}` }
            : evidence,
        ),
      });
    },
    evidenceSince,
    evidenceText: (at) => {
      const found = evidenceSince(at);
      return found.length === 0
        ? ""
        : [
            "<track_evidence>",
            "What your tracks stood on since then, newest first: corrections are what to do differently, " +
              "confirmations what's working.",
            ...found.map(
              ({ track, evidence }) =>
                `- ${track.name} (${track.id}), ${evidence.kind} ${dayOf(evidence.at)}: ${evidence.text}`,
            ),
            "</track_evidence>",
          ].join("\n");
    },
    answered: (id, text, question) => {
      const track = find(id);
      if (track) save(withEvidence(track, { at: now(), kind: "answered", text, question }));
    },
    tools,
    inMindText: () => {
      const listed = tracks.get();
      const recent = toTimestamp(clock.now() - inMindMs);
      return listed.length === 0
        ? ""
        : [
            "<tracks>",
            "The areas you're learning, with each one's stage and what it stands on, and their latest corrections:",
            "follow those until they're on How to help you.",
            ...listed.flatMap((track) => [
              `- ${track.name} (${track.id}): ${stageWords[track.stage]}, ${String(track.confirmed)} confirmed, ` +
                `${String(track.corrected)} corrected${track.note === undefined ? "" : `. ${track.note}`}`,
              ...track.evidence
                .filter(({ kind, at }) => kind === "corrected" && at >= recent)
                .slice(0, correctionsInMind)
                .map(({ at, text }) => `  - Corrected ${dayOf(at)}: ${text}`),
            ]),
            "</tracks>",
          ].join("\n");
    },
  };
};
