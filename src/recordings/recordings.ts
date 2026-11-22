import { createHash } from "node:crypto";
import { createReadStream, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Attachments } from "#attachments/attachments.ts";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Message, Recording, Transcript, TranscriptCorrection } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";
import { toMessageId, toThreadId } from "#conversation/ids.ts";
import type { HeardRecording, TranscriptionFailure, VoiceLoop, Voiceprint } from "#voice/loop.ts";
import { toTranscript, withCorrection, type StoredTranscript } from "#recordings/transcripts.ts";

// Every audio attachment they send becomes a recording: transcribed by the voice on the server's GPU, one at a time,
// with its progress on the event stream. Once it's ready Kumo reads it, in the turn that took the message or, when
// that turn has passed, in a piece of background work that brings them a summary and its proposals. Audio and
// transcript stay on the server until they're deleted.

export type RecordingsOptions = {
  readonly database: DatabaseSync;
  readonly store: Pick<
    Store,
    "subscribe" | "recordRecording" | "messageText" | "findMessage" | "runningTurn" | "pendingWork" | "findAttachment"
  >;
  readonly attachments: Pick<Attachments, "pathOf" | "remove">;
  readonly voice: Pick<VoiceLoop, "readiness" | "transcribe" | "cancelTranscription">;
  readonly voiceprint: () => Voiceprint | undefined;
  readonly work: (prompt: string) => Promise<unknown>;
  readonly workspace: string;
  readonly clock: Clock;
  readonly info: Info;
};

export type Found = { readonly recording: Recording; readonly transcript?: StoredTranscript };

export type TranscriptFailure =
  | { readonly code: "not_found" }
  | { readonly code: "not_transcribed"; readonly recording: Recording }
  | { readonly code: "unknown_speaker"; readonly speaker: string };

export type Correction = {
  readonly replace?: readonly TranscriptCorrection[];
  readonly speakers?: readonly { readonly id: string; readonly name: string }[];
};

export type Recordings = {
  readonly list: () => readonly Recording[];
  readonly find: (attachment: string) => Found | undefined;
  readonly transcript: (attachment: string) => Result<Transcript, TranscriptFailure>;
  readonly markRead: (attachment: string) => void;
  readonly retry: (
    attachment: string,
  ) => Result<{ readonly recording: Recording; readonly isQueued: boolean }, "not_found">;
  readonly correct: (attachment: string, correction: Correction) => Result<Transcript, TranscriptFailure>;
  readonly remove: (attachment: string) => Promise<Result<Recording, "not_found">>;
  readonly inMindText: () => string;
  readonly close: () => Promise<void>;
};

type Row = {
  readonly attachment: string;
  readonly body: string;
  readonly transcript: string | null;
  readonly attempts: number;
  readonly read: number;
  readonly followed_up: number;
};

// A recording that keeps failing because the voice went away is given up after this many tries.
const mostAttempts = 3;
// Progress goes on the event stream about every twentieth of the way, or every minute heard when the length isn't
// known.
const progressStep = 0.05;
const progressSeconds = 60;
// How long a recording stays in Kumo's mind once it's ready or failed.
const inMindMs = 2 * 24 * 60 * 60 * 1000;

const sha256Of = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });

const toFound = (row: Row): Found => ({
  recording: JSON.parse(row.body) as Recording,
  ...(row.transcript !== null && { transcript: JSON.parse(row.transcript) as StoredTranscript }),
});

// A file's SHA-256, or nothing when it can't be read.
const hashOf = async (file: string): Promise<string | undefined> => {
  try {
    return await sha256Of(file);
  } catch {
    return;
  }
};

const minutes = (seconds: number): string =>
  seconds < 90 ? `${String(Math.round(seconds))} seconds` : `${String(Math.round(seconds / 60))} minutes`;

const failureError = (failure: TranscriptionFailure): NonNullable<Recording["error"]> => {
  switch (failure.code) {
    case "unreadable": {
      return {
        code: "recording_unreadable",
        message: "The server couldn't read this recording.",
        detail: failure.detail,
      };
    }
    case "unavailable": {
      return {
        code: "voice_unavailable",
        message: "The server's voice wasn't there to transcribe it.",
        detail: failure.detail,
      };
    }
    case "cancelled":
    case "failed": {
      return { code: "transcription_failed", message: "The transcription failed.", detail: failure.detail };
    }
  }
};

export const createRecordings = (options: RecordingsOptions): Recordings => {
  const { database, store, attachments, voice, voiceprint, work, workspace, clock, info } = options;
  const now = (): string => toTimestamp(clock.now());
  const working = createCell<string | undefined>(undefined);
  const isClosed = createCell(false);
  const pumping = createCell<Promise<void>>(Promise.resolve());

  const rowOf = (attachment: string): Row | undefined =>
    database.prepare("SELECT * FROM recordings WHERE attachment = ?").get(attachment) as Row | undefined;

  const save = (recording: Recording, fields: { readonly transcript?: StoredTranscript | null } = {}): Recording => {
    database
      .prepare(
        `UPDATE recordings SET body = ?, transcript = CASE WHEN ? THEN ? ELSE transcript END WHERE attachment = ?`,
      )
      .run(
        JSON.stringify(recording),
        fields.transcript === undefined ? 0 : 1,
        fields.transcript ? JSON.stringify(fields.transcript) : null,
        recording.attachment,
      );
    store.recordRecording(recording);
    return recording;
  };

  // Moves a recording to a new state, keeping only the fields that state has.
  const moveTo = (
    before: Recording,
    state: Recording["state"],
    extra: Partial<Pick<Recording, "reason" | "progress" | "duration_seconds" | "speakers" | "error">> = {},
  ): Recording => ({
    attachment: before.attachment,
    message: before.message,
    name: before.name,
    state,
    ...extra,
    changed_at: now(),
  });

  const queuedReason = (): string | undefined => {
    const { state, reason } = voice.readiness();
    if (state === "ready") return undefined;
    return state === "loading"
      ? `The server's voice is still loading: ${reason ?? "it's starting."}`
      : `The server's voice isn't running: ${reason ?? "it failed."}`;
  };

  const nextQueued = (): Row | undefined =>
    database
      .prepare("SELECT * FROM recordings WHERE json_extract(body, '$.state') = 'queued' ORDER BY position LIMIT 1")
      .get() as Row | undefined;

  // Whether a turn in the chat may still read it: its message waits for one, or one is running now.
  // A turn in the conversation the message is in, the main chat or its thread, is running or about to take it.
  const isTaken = (message: string): boolean => {
    const place = store.findMessage(toMessageId(message))?.thread;
    const thread = place === undefined ? undefined : toThreadId(place);
    return (
      store.runningTurn(thread) !== undefined ||
      store.pendingWork(thread).some((pending) => pending.kind === "message" && pending.message === message)
    );
  };

  const followUpPrompt = (recording: Recording, heard: HeardRecording): string => {
    const said = store.messageText(toMessageId(recording.message))?.trim() ?? "";
    const thread = store.findMessage(toMessageId(recording.message))?.thread;
    const voices = heard.speakers.length;
    return [
      `A recording they sent is transcribed: ${recording.name} (${recording.attachment}), ` +
        `${minutes(heard.seconds)} long, ${voices > 1 ? `${String(voices)} voices told apart` : "one voice heard"}` +
        `${said === "" ? "" : `, sent with the words: "${said}"`}.`,
      "Read it with read_recording before you say anything about it: use from to read on, and find for a topic.",
      thread === undefined
        ? "A recording starts its own thread: post in a new one (new_thread), titled for what it was, such as " +
          '"Interview debrief".'
        : `It was sent in a thread, ${thread}: post there (thread).`,
      "Then message them once with post; longer than usual is right here. Say what it was in a line, then what",
      "they'd want from it: for an interview or a meeting, a debrief of how it went, what landed, what to improve and",
      "the follow-ups it implies. Your take comes first. Quote the transcript with its times for what was said, each",
      `time a link that opens the transcript there, such as [18:42](recording:${recording.attachment}?t=18:42), and`,
      "keep your reading separate and marked as yours. Voices are told apart by a best guess, so say so where it matters.",
      "Propose, don't do: end with the actions and memory updates you suggest as one ari:proposals block, a row each,",
      "and make none of them until they tap one. Don't write memory, start or change things in motion, add cards or",
      "set wake-ups from it until they do.",
      "End with one line saying what you posted.",
    ].join("\n");
  };

  // Kumo comes back to a transcript the chat didn't read: unless a turn is about to take its message, or is taking
  // it now, in which case it's looked at again when that turn ends.
  const followUp = (attachment: string): void => {
    const row = rowOf(attachment);
    if (!row || row.read === 1 || row.followed_up === 1 || row.transcript === null) return;
    const { recording, transcript } = toFound(row);
    if (!transcript || recording.state !== "ready" || isTaken(recording.message)) return;
    database.prepare("UPDATE recordings SET followed_up = 1 WHERE attachment = ?").run(attachment);
    info("Kumo reads a recording's transcript", { recording: attachment });
    void work(followUpPrompt(recording, transcript.heard));
  };

  const afterFailure = (row: Row, recording: Recording, failure: TranscriptionFailure): void => {
    if (failure.code === "cancelled") return;
    const attempts = row.attempts + 1;
    database.prepare("UPDATE recordings SET attempts = ? WHERE attachment = ?").run(attempts, recording.attachment);
    const isWorthAgain = failure.code === "unavailable" || failure.code === "failed";
    if (isWorthAgain && attempts < mostAttempts) {
      save(moveTo(recording, "queued", { reason: `It's tried again after: ${failure.detail}` }));
      return;
    }
    info("A recording couldn't be transcribed", { recording: recording.attachment, reason: failure.detail });
    save(moveTo(recording, "failed", { error: failureError(failure) }));
  };

  const transcribeNext = async (): Promise<void> => {
    if (isClosed.get() || working.get() !== undefined) return;
    try {
      await transcribeOne();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const current = working.get();
      working.set(undefined);
      info("Transcribing a recording went wrong", { error: detail });
      const row = current === undefined ? undefined : rowOf(current);
      if (row) save(moveTo(toFound(row).recording, "failed", { error: failureError({ code: "failed", detail }) }));
    }
  };

  const transcribeOne = async (): Promise<void> => {
    if (isClosed.get() || working.get() !== undefined) return;
    const row = nextQueued();
    if (!row) return;
    const queued = toFound(row).recording;
    const reason = queuedReason();
    if (reason !== undefined) {
      if (queued.reason !== reason) save(moveTo(queued, "queued", { reason }));
      return;
    }
    working.set(queued.attachment);
    const told = createCell({ share: 0, seconds: 0 });
    const transcribing = save(moveTo(queued, "transcribing", { progress: { done_seconds: 0 } }));
    const heard = await voice.transcribe(
      queued.attachment,
      attachments.pathOf(queued.attachment),
      voiceprint(),
      (done, total) => {
        const share = total === undefined || total === 0 ? 0 : done / total;
        const isNews =
          total === undefined ? done - told.get().seconds >= progressSeconds : share - told.get().share >= progressStep;
        if (!isNews || isClosed.get()) return;
        told.set({ share, seconds: done });
        save(
          moveTo(transcribing, "transcribing", {
            progress: { done_seconds: done, ...(total !== undefined && { total_seconds: total }) },
          }),
        );
      },
    );
    working.set(undefined);
    if (isClosed.get()) return;
    const latest = rowOf(queued.attachment);
    if (!latest || toFound(latest).recording.state !== "transcribing") return;
    if (!heard.ok) {
      afterFailure(latest, transcribing, heard.failure);
      return;
    }
    const transcript: StoredTranscript = { heard: heard.value, corrections: [], names: {}, madeAt: now() };
    save(
      moveTo(transcribing, "ready", {
        duration_seconds: heard.value.seconds,
        speakers: heard.value.speakers.length,
      }),
      { transcript },
    );
    info("A recording is transcribed", { recording: queued.attachment, seconds: heard.value.seconds });
    followUp(queued.attachment);
  };

  // One transcription at a time, each starting once the one before is done.
  const pump = (): void => {
    const before = pumping.get();
    pumping.set(
      (async () => {
        await before;
        await transcribeNext();
        if (!isClosed.get() && working.get() === undefined && nextQueued() && queuedReason() === undefined) pump();
      })(),
    );
  };

  const nextPosition = (): number =>
    (
      database.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM recordings").get() as {
        readonly next: number;
      }
    ).next;

  const take = (message: Message): void => {
    const audio = (message.attachments ?? []).filter(({ kind, id }) => kind === "audio" && !rowOf(id));
    for (const attachment of audio) {
      const recording: Recording = {
        attachment: attachment.id,
        message: message.id,
        name: attachment.name,
        state: "queued",
        changed_at: now(),
      };
      database
        .prepare("INSERT INTO recordings (attachment, position, body) VALUES (?, ?, ?)")
        .run(attachment.id, nextPosition(), JSON.stringify(recording));
      store.recordRecording(recording);
    }
    pump();
  };

  const followUpAll = (): void => {
    const waiting = database
      .prepare(
        "SELECT attachment FROM recordings WHERE json_extract(body, '$.state') = 'ready' AND read = 0 AND followed_up = 0",
      )
      .all() as unknown as readonly { readonly attachment: string }[];
    for (const { attachment } of waiting) followUp(attachment);
  };

  // The voice coming back may let a queued recording start, and a turn ending may leave a transcript unread.
  const nudges: ReadonlySet<string> = new Set(["voice.status", "turn.ended"]);
  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type === "message.accepted") {
      take(event.message);
      return;
    }
    if (!nudges.has(event.type)) return;
    pump();
    followUpAll();
  });

  // A recording cut off by a restart starts again.
  const cutOff = database
    .prepare("SELECT * FROM recordings WHERE json_extract(body, '$.state') = 'transcribing'")
    .all() as unknown as readonly Row[];
  for (const row of cutOff) save(moveTo(toFound(row).recording, "queued"));
  pump();

  // Copies of a recording's audio in Kumo's workspace, where a turn put it, found by their bytes.
  const workspaceCopies = async (attachment: string): Promise<readonly string[]> => {
    const kept = store.findAttachment(attachment);
    if (!kept) return [];
    const folder = path.join(workspace, "uploads");
    const candidates = (() => {
      try {
        return readdirSync(folder)
          .map((name) => path.join(folder, name))
          .filter((file) => statSync(file, { throwIfNoEntry: false })?.size === kept.attachment.size);
      } catch {
        return [];
      }
    })();
    const hashes = await Promise.all(candidates.map((file) => hashOf(file)));
    return candidates.filter((_, index) => hashes[index] === kept.sha256);
  };

  const transcript = (attachment: string): Result<Transcript, TranscriptFailure> => {
    const row = rowOf(attachment);
    if (!row) return fail({ code: "not_found" });
    const found = toFound(row);
    return found.recording.state === "ready" && found.transcript
      ? ok(toTranscript(found.recording, found.transcript))
      : fail({ code: "not_transcribed", recording: found.recording });
  };

  return {
    list: () =>
      (
        database
          .prepare("SELECT * FROM recordings WHERE json_extract(body, '$.state') != 'deleted' ORDER BY position DESC")
          .all() as unknown as readonly Row[]
      ).map((row) => toFound(row).recording),

    find: (attachment) => {
      const row = rowOf(attachment);
      return row ? toFound(row) : undefined;
    },

    transcript,

    markRead: (attachment) => {
      database.prepare("UPDATE recordings SET read = 1 WHERE attachment = ?").run(attachment);
    },

    retry: (attachment) => {
      const row = rowOf(attachment);
      if (!row) return fail("not_found");
      const { recording } = toFound(row);
      if (recording.state !== "failed") return ok({ recording, isQueued: false });
      database.prepare("UPDATE recordings SET attempts = 0 WHERE attachment = ?").run(attachment);
      const queued = save(moveTo(recording, "queued"));
      pump();
      return ok({ recording: queued, isQueued: true });
    },

    correct: (attachment, { replace = [], speakers = [] }) => {
      const row = rowOf(attachment);
      if (!row) return fail({ code: "not_found" });
      const found = toFound(row);
      if (found.recording.state !== "ready" || !found.transcript) {
        return fail({ code: "not_transcribed", recording: found.recording });
      }
      const known = new Set(found.transcript.heard.speakers.map(({ id }) => id));
      const stranger = speakers.find(({ id }) => !known.has(id));
      if (stranger) return fail({ code: "unknown_speaker", speaker: stranger.id });
      const next: StoredTranscript = {
        ...found.transcript,
        corrections: replace.reduce(withCorrection, found.transcript.corrections),
        names: { ...found.transcript.names, ...Object.fromEntries(speakers.map(({ id, name }) => [id, name.trim()])) },
      };
      database
        .prepare("UPDATE recordings SET transcript = ? WHERE attachment = ?")
        .run(JSON.stringify(next), attachment);
      return ok(toTranscript(found.recording, next));
    },

    remove: async (attachment) => {
      const row = rowOf(attachment);
      if (!row) return fail("not_found");
      const { recording } = toFound(row);
      if (recording.state === "deleted") return ok(recording);
      const copies = await workspaceCopies(attachment);
      const deleted = save(moveTo(recording, "deleted"), { transcript: null });
      if (working.get() === attachment) await voice.cancelTranscription(attachment);
      for (const copy of copies) rmSync(copy, { force: true });
      attachments.remove(attachment);
      info("A recording is deleted", { recording: attachment, copies: copies.length });
      return ok(deleted);
    },

    inMindText: () => {
      const recent = toTimestamp(clock.now() - inMindMs);
      const lines = (
        database
          .prepare(
            `SELECT * FROM recordings WHERE json_extract(body, '$.state') IN ('queued', 'transcribing')
              OR (json_extract(body, '$.state') IN ('ready', 'failed') AND json_extract(body, '$.changed_at') >= ?)
              ORDER BY position DESC LIMIT 5`,
          )
          .all(recent) as unknown as readonly Row[]
      ).map((row) => {
        const { recording, transcript: stored } = toFound(row);
        const named = `- ${recording.name} (${recording.attachment}): `;
        switch (recording.state) {
          case "queued": {
            return `${named}waiting to be transcribed.${recording.reason === undefined ? "" : ` ${recording.reason}`}`;
          }
          case "transcribing": {
            const { done_seconds: done, total_seconds: total } = recording.progress ?? { done_seconds: 0 };
            const so = total === undefined ? minutes(done) : `${minutes(done)} of ${minutes(total)}`;
            return `${named}being transcribed, ${so} so far; you'll be told when it's ready.`;
          }
          case "ready": {
            const voices = stored?.heard.speakers.length ?? 0;
            return (
              `${named}transcribed, ${minutes(recording.duration_seconds ?? 0)}, ` +
              `${voices > 1 ? `${String(voices)} voices` : "one voice"}${row.read === 1 ? "" : ", not read yet"}.`
            );
          }
          case "failed": {
            return `${named}couldn't be transcribed: ${recording.error?.detail ?? recording.error?.message ?? ""}`;
          }
          case "deleted": {
            return "";
          }
        }
      });
      return lines.length === 0
        ? ""
        : [
            "<recordings>",
            "Recordings they sent, which the server transcribes for you; read one with read_recording.",
            ...lines,
            "</recordings>",
          ].join("\n");
    },

    close: async () => {
      isClosed.set(true);
      unsubscribe();
      const current = working.get();
      if (current !== undefined) await voice.cancelTranscription(current);
    },
  };
};
