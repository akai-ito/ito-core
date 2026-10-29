import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "#store/database.ts";
import { migrations } from "#store/migrations.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "ito-migration-"));
const file = path.join(directory, "ito.db");

describe("upgrading an older database", () => {
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("adds the steps table and gives existing message events their positions", () => {
    const old = new DatabaseSync(file);
    old.exec(migrations[0] ?? "");
    old.exec("PRAGMA user_version = 1");
    const accepted = {
      id: "e_old",
      type: "message.accepted",
      at: "2026-10-13T09:00:00.000Z",
      message: { id: "u_old", role: "user", text: "Hello", at: "2026-10-13T09:00:00.000Z" },
    };
    old
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (7, ?, ?, ?, ?)")
      .run(accepted.id, accepted.type, accepted.at, JSON.stringify(accepted));
    old.close();

    const upgraded = openDatabase(file);
    const { body } = upgraded.prepare("SELECT body FROM events WHERE id = 'e_old'").get() as { readonly body: string };
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'steps'").all();
    upgraded.close();
    expect(
      (JSON.parse(body) as typeof accepted & { readonly message: { readonly position: number } }).message.position,
    ).toBe(7);
    expect(tables).toHaveLength(1);
  });

  it("moves a saved gap-report token into the Reports capability, and switches it on", () => {
    const tokenFile = path.join(directory, "reports.db");
    const old = new DatabaseSync(tokenFile);
    const earlier = migrations.slice(
      0,
      migrations.findIndex((sql) => sql.includes("reports_github_token")),
    );
    for (const sql of earlier) old.exec(sql);
    old.exec(["PRAGMA user_version =", String(earlier.length)].join(" "));
    old.prepare("INSERT INTO settings (key, value) VALUES ('reports_github_token', 'github_pat_saved')").run();
    old.close();

    const upgraded = openDatabase(tokenFile);
    const settings = upgraded.prepare("SELECT key, value FROM settings ORDER BY key").all();
    upgraded.close();

    expect(settings).toEqual([
      { key: "capability:reports:on", value: "true" },
      { key: "capability:reports:values", value: '{"token":"github_pat_saved"}' },
    ]);
  });

  it("forgets the ticks, secret asks and corrections that 0.14 dropped, in the log and the tables", () => {
    const droppedFile = path.join(directory, "dropped.db");
    const old = new DatabaseSync(droppedFile);
    const earlier = migrations.slice(0, -1);
    for (const sql of earlier) old.exec(sql);
    old.exec(["PRAGMA user_version =", String(earlier.length)].join(" "));
    const at = "2026-10-28T09:00:00.000Z";
    const ask = { id: "a_1", turn: "t_1", kind: "question", question: "Code?", options: [], secret: true };
    const message = {
      id: "u_1",
      role: "user",
      text: "",
      secret: true,
      spoken: { call: "c_1", corrections: [{ offset: 0, length: 4, heard: "Bara" }] },
    };
    const events = [
      { id: "e_1", type: "ask.started", at, ask },
      { id: "e_2", type: "message.accepted", at, message },
      { id: "e_3", type: "plan.ticked", at, message: "m_1", part: 0, item: "pack", done: true },
    ];
    for (const [index, event] of events.entries()) {
      old
        .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (?, ?, ?, ?, ?)")
        .run(index + 1, event.id, event.type, at, JSON.stringify(event));
    }
    old.prepare("INSERT INTO asks (id, turn, position, body) VALUES ('a_1', 't_1', 1, ?)").run(JSON.stringify(ask));
    old
      .prepare(
        "INSERT INTO messages (id, position, role, text, at, secret, spoken, ticks) VALUES ('u_1', 2, 'user', '', ?, 1, ?, ?)",
      )
      .run(at, JSON.stringify(message.spoken), JSON.stringify([{ part: 0, item: "pack", done: true }]));
    old.prepare("INSERT INTO settings (key, value) VALUES ('vocabulary_learned', '[]')").run();
    old.close();

    const upgraded = openDatabase(droppedFile);
    const bodies = upgraded.prepare("SELECT type, body FROM events ORDER BY seq").all() as unknown as readonly {
      readonly type: string;
      readonly body: string;
    }[];
    const columns = upgraded.prepare("SELECT name FROM pragma_table_info('messages')").all() as unknown as readonly {
      readonly name: string;
    }[];
    const row = upgraded.prepare("SELECT spoken FROM messages").get() as { readonly spoken: string };
    const askRow = upgraded.prepare("SELECT body FROM asks").get() as { readonly body: string };
    const learned = upgraded.prepare("SELECT value FROM settings WHERE key = 'vocabulary_learned'").get();
    upgraded.close();

    expect(bodies.map(({ type }) => type)).toEqual(["ask.started", "message.accepted"]);
    expect(bodies.map(({ body }) => body).join("\n")).not.toMatch(/secret|corrections/u);
    expect(columns.map(({ name }) => name)).not.toContain("secret");
    expect(columns.map(({ name }) => name)).not.toContain("ticks");
    expect(JSON.parse(row.spoken)).toEqual({ call: "c_1" });
    expect(JSON.parse(askRow.body)).not.toHaveProperty("secret");
    expect(learned).toBeUndefined();
  });
});
