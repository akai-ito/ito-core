import type { DatabaseSync } from "node:sqlite";
import type { Event, Snapshot, Tick } from "#protocol/types.ts";

export type LoggedEvent = Exclude<Event, Snapshot>;

const toJson = (value: unknown): string => JSON.stringify(value);

const appendTo = (json: string, value: string): string => toJson([...(JSON.parse(json) as readonly string[]), value]);

export const project = (database: DatabaseSync, seq: number, event: LoggedEvent): void => {
  switch (event.type) {
    case "message.accepted": {
      const { message } = event;
      database
        .prepare(
          `INSERT INTO messages (id, position, role, text, at, answers, secret, attachments, spoken)
            VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          seq,
          message.text,
          message.at,
          message.answers ?? null,
          message.secret ? 1 : 0,
          message.attachments?.length ? toJson(message.attachments) : null,
          message.spoken ? toJson(message.spoken) : null,
        );
      const attached = [...(message.attachments ?? []), ...(message.spoken?.audio ? [message.spoken.audio] : [])];
      for (const attachment of attached) {
        database.prepare("UPDATE attachments SET message = ? WHERE id = ?").run(message.id, attachment.id);
      }
      return;
    }
    case "message.started": {
      const { message } = event;
      database
        .prepare("INSERT INTO messages (id, position, role, kind, turn, text, at) VALUES (?, ?, 'agent', ?, ?, '', ?)")
        .run(message.id, seq, message.kind ?? "reply", message.turn ?? null, message.at);
      if (message.kind === "reply") {
        database.prepare("UPDATE turns SET has_started_reply = 1 WHERE id = ?").run(message.turn ?? null);
      }
      return;
    }
    case "message.delta": {
      database.prepare("UPDATE messages SET text = text || ? WHERE id = ?").run(event.text, event.message);
      return;
    }
    case "message.ended": {
      const row = database.prepare("SELECT text FROM messages WHERE id = ?").get(event.message) as
        { readonly text: string } | undefined;
      database
        .prepare("UPDATE messages SET text = ?, ended_at = ?, outcome = ?, error = ? WHERE id = ?")
        .run(
          (row?.text ?? "").slice(0, event.length),
          event.at,
          event.outcome,
          event.error ? toJson(event.error) : null,
          event.message,
        );
      return;
    }
    case "turn.started": {
      database
        .prepare("INSERT INTO turns (id, position, inputs, retry_of) VALUES (?, ?, ?, ?)")
        .run(event.turn, seq, toJson(event.inputs), event.retry_of ?? null);
      for (const input of event.inputs) database.prepare("DELETE FROM pending WHERE message = ?").run(input);
      database.prepare("DELETE FROM pending WHERE turn = ?").run(event.turn);
      return;
    }
    case "turn.status": {
      const status = { kind: event.kind, label: event.label, ...(event.detail && { detail: event.detail }) };
      database.prepare("UPDATE turns SET status = ? WHERE id = ?").run(toJson(status), event.turn);
      return;
    }
    case "message.read": {
      const row = database.prepare("SELECT read FROM turns WHERE id = ?").get(event.turn) as
        { readonly read: string } | undefined;
      if (row)
        database.prepare("UPDATE turns SET read = ? WHERE id = ?").run(appendTo(row.read, event.message), event.turn);
      return;
    }
    case "message.queued": {
      database.prepare("INSERT OR IGNORE INTO pending (kind, message) VALUES ('message', ?)").run(event.message);
      return;
    }
    case "step.started": {
      const { step } = event;
      database
        .prepare("INSERT INTO steps (id, turn, position, body, outcome) VALUES (?, ?, ?, ?, ?)")
        .run(step.id, step.turn, step.position, toJson(step), step.outcome ?? null);
      return;
    }
    case "step.updated":
    case "step.ended": {
      const { step } = event;
      database
        .prepare("UPDATE steps SET body = ?, outcome = ? WHERE id = ?")
        .run(toJson(step), step.outcome ?? null, step.id);
      return;
    }
    case "ask.started": {
      const { ask } = event;
      database
        .prepare("INSERT INTO asks (id, turn, position, body) VALUES (?, ?, ?, ?)")
        .run(ask.id, ask.turn, ask.position, toJson(ask));
      return;
    }
    case "ask.ended": {
      const { ask } = event;
      database
        .prepare("UPDATE asks SET body = ?, outcome = ? WHERE id = ?")
        .run(toJson(ask), ask.outcome ?? null, ask.id);
      return;
    }
    case "call.started": {
      const { call } = event;
      database
        .prepare("INSERT INTO calls (id, position, body, ended) VALUES (?, ?, ?, 0)")
        .run(call.id, call.position, toJson(call));
      return;
    }
    case "call.ended": {
      const { call } = event;
      database.prepare("UPDATE calls SET body = ?, ended = 1 WHERE id = ?").run(toJson(call), call.id);
      return;
    }
    case "call.audio_deleted": {
      const { call } = event;
      database.prepare("UPDATE calls SET body = ? WHERE id = ?").run(toJson(call), call.id);
      const spokenRows = database
        .prepare("SELECT id, spoken FROM messages WHERE json_extract(spoken, '$.call') = ?")
        .all(call.id) as unknown as readonly { readonly id: string; readonly spoken: string }[];
      for (const row of spokenRows) {
        const spoken = JSON.parse(row.spoken) as Readonly<Record<string, unknown>>;
        const silenced = Object.fromEntries(Object.entries(spoken).filter(([key]) => key !== "audio"));
        database.prepare("UPDATE messages SET spoken = ? WHERE id = ?").run(toJson(silenced), row.id);
      }
      return;
    }
    case "voice.status": {
      return;
    }
    case "plan.ticked": {
      const { message, part, item, done } = event;
      const row = database.prepare("SELECT ticks FROM messages WHERE id = ?").get(message) as
        { readonly ticks: string | null } | undefined;
      const ticks = row?.ticks ? (JSON.parse(row.ticks) as readonly Tick[]) : [];
      const latest = [...ticks.filter((tick) => tick.part !== part || tick.item !== item), { part, item, done }];
      database.prepare("UPDATE messages SET ticks = ? WHERE id = ?").run(toJson(latest), message);
      return;
    }
    case "topic.started": {
      const { topic } = event;
      database
        .prepare("INSERT INTO topics (id, position, body) VALUES (?, ?, ?)")
        .run(topic.id, topic.position, toJson(topic));
      return;
    }
    case "turn.ended": {
      database
        .prepare("UPDATE turns SET outcome = ?, error = ?, status = NULL WHERE id = ?")
        .run(event.outcome, event.error ? toJson(event.error) : null, event.turn);
      return;
    }
  }
};
