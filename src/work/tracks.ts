import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { DoneEntry, Track, TrackEvidence, TrackStage } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's learning tracks: any area it's getting to know them in, or learning to do well, such as sorting their mail,
// writing as them or planning their weekends. Each has a stage and what it stands on. Kumo moves a track by judgement,
// and a correction always steps it back. Kumo reads them as context, so its judgement follows them.
export type Tracks = {
  readonly list: () => readonly Track[];
  readonly find: (id: string) => Track | undefined;
  // "That was wrong" on a call that belongs to a track: it steps back, with the call as evidence.
  readonly corrected: (entry: DoneEntry, text: string) => void;
  readonly tools: readonly Tool[];
  readonly inMindText: () => string;
};

export type TracksOptions = {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly identifiers: { readonly track: () => string };
  readonly info: Info;
};

export const stages: readonly TrackStage[] = ["learning", "spot_checks", "trusted"];

const stageWords: Readonly<Record<TrackStage, string>> = {
  learning: "learning",
  spot_checks: "spot checks",
  trusted: "trusted",
};

const evidenceKept = 10;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const isStage = (value: unknown): value is TrackStage => stages.includes(value as TrackStage);

const stepBack = (stage: TrackStage): TrackStage => stages[Math.max(0, stages.indexOf(stage) - 1)] ?? "learning";

export const createTracks = ({ database, clock, identifiers, info }: TracksOptions): Tracks => {
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
        "Move a track to another stage when what it stands on says so, such as weeks of their confirmations with " +
        "no correction, or back when you've been getting it wrong. Learning shows them each call; Spot checks " +
        "checks now and then; Trusted brings only what needs them.",
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
        "a correction (they told you it was wrong) on a track. A correction always steps the track back.",
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
    tools,
    inMindText: () => {
      const listed = tracks.get();
      return listed.length === 0
        ? ""
        : [
            "<tracks>",
            "The areas you're learning, and how far you've come in each. Learning: show them your calls and ask when",
            "unsure. Spot checks: check with them now and then. Trusted: bring only what needs them. Move one when what",
            "it stands on says so; a correction steps it back.",
            ...listed.map(
              (track) =>
                `- ${track.name} (${track.id}): ${stageWords[track.stage]}, ${String(track.confirmed)} confirmed, ` +
                `${String(track.corrected)} corrected${track.note === undefined ? "" : `. ${track.note}`}`,
            ),
            "</tracks>",
          ].join("\n");
    },
  };
};
