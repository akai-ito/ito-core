import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { earlierFile, openDatabase } from "#store/database.ts";
import { migrations } from "#store/migrations.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "ito-migration-"));
const file = path.join(directory, "ito.db");

describe("a database from before 0.16", () => {
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is moved aside, and the box starts fresh", () => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT, type TEXT, at TEXT, body TEXT)");
    old.exec("INSERT INTO events VALUES (1, 'e_old', 'message.accepted', '2026-10-13T09:00:00.000Z', '{}')");
    old.exec("PRAGMA user_version = 13");
    old.close();

    const fresh = openDatabase(file);
    const events = fresh.prepare("SELECT COUNT(*) AS count FROM events").get() as { readonly count: number };
    const desk = fresh.prepare("SELECT COUNT(*) AS count FROM desk").get() as { readonly count: number };
    fresh.close();
    const kept = new DatabaseSync(earlierFile(file));
    const earlier = kept.prepare("SELECT id FROM events").all();
    kept.close();

    expect(events.count).toBe(0);
    expect(desk.count).toBe(0);
    expect(earlier).toEqual([{ id: "e_old" }]);
    expect(existsSync(earlierFile(file))).toBe(true);
  });

  it("leaves a 0.16 database alone", () => {
    const again = openDatabase(file);
    again.prepare("INSERT INTO settings (key, value) VALUES ('lead_name', 'Momo')").run();
    again.close();

    const reopened = openDatabase(file);
    const lead = reopened.prepare("SELECT value FROM settings WHERE key = 'lead_name'").get() as {
      readonly value: string;
    };
    reopened.close();

    expect(lead.value).toBe("Momo");
  });
});

describe("a 0.17 database", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-migration-0.17-"));
  const older = path.join(home, "ito.db");

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loses Kumo's line, the check-ins, the Focus and the trust ladder, and keeps its lines as posts", () => {
    const fresh = openDatabase(older);
    fresh.exec(`PRAGMA user_version = ${String(migrations.length - 1)}`);
    fresh.exec("ALTER TABLE messages DROP COLUMN urgent");
    fresh.exec("ALTER TABLE asks ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0");
    const moment = { id: "o_1", kind: "day", at: "2026-11-01T08:00:00.000Z", text: "A free Sunday." };
    const card = { id: "k_1", kind: "question", title: "Was this right?", quiet: true, review: { day: "2026-11-01" } };
    fresh
      .prepare("INSERT INTO desk (id, body) VALUES (1, ?)")
      .run(JSON.stringify({ moment, coming_up: [], waiting: [card], handled: 3 }));
    fresh
      .prepare("INSERT INTO messages (id, position, role, kind, text, at, outcome) VALUES (?, 1, 'agent', ?, ?, ?, ?)")
      .run("m_1", "moment", "A free Sunday.", moment.at, "completed");
    fresh
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (1, 'e_1', 'message.posted', ?, ?)")
      .run(moment.at, JSON.stringify({ type: "message.posted", message: { id: "m_1", kind: "moment" } }));
    fresh
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (2, 'e_2', 'desk.changed', ?, ?)")
      .run(moment.at, JSON.stringify({ type: "desk.changed", desk: { moment, waiting: [] } }));
    fresh
      .prepare("INSERT INTO done (id, at, body) VALUES ('d_1', ?, ?)")
      .run(moment.at, JSON.stringify({ id: "d_1", text: "Binned a mail", work: "sorting" }));
    for (const key of ["moment_day", "morning_not_before", "day_nights", "status_focus", "trust_ladder"]) {
      fresh.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(key);
    }
    fresh.prepare("INSERT INTO settings (key, value) VALUES ('lead_name', 'Momo')").run();
    fresh.close();

    const migrated = openDatabase(older);
    const read = (sql: string): unknown => migrated.prepare(sql).get();
    const desk = read("SELECT body FROM desk") as { readonly body: string };
    const message = read("SELECT kind, urgent FROM messages WHERE id = 'm_1'");
    const events = migrated.prepare("SELECT body FROM events ORDER BY seq").all() as unknown as readonly {
      readonly body: string;
    }[];
    const done = read("SELECT body FROM done") as { readonly body: string };
    const settings = migrated.prepare("SELECT key FROM settings ORDER BY key").all();
    const askColumns = migrated.prepare("SELECT name FROM pragma_table_info('asks')").all();
    migrated.close();

    expect(JSON.parse(desk.body)).toEqual({
      coming_up: [],
      waiting: [{ id: "k_1", kind: "question", title: "Was this right?" }],
      handled: 3,
    });
    expect(message).toEqual({ kind: "post", urgent: 0 });
    expect(events.map(({ body }) => JSON.parse(body) as unknown)).toEqual([
      { type: "message.posted", message: { id: "m_1", kind: "post" } },
      { type: "desk.changed", desk: { waiting: [] } },
    ]);
    expect(JSON.parse(done.body)).toEqual({ id: "d_1", text: "Binned a mail" });
    expect(settings).toEqual([{ key: "lead_name" }]);
    expect(askColumns).not.toContainEqual({ name: "reminded" });
  });
});
