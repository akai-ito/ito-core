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

// The statement that marks a database as migrated up to and including one migration.
const versionAfter = (index: number): string => `PRAGMA user_version = ${String(index + 1)}`;

describe("a 0.17 database", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-migration-0.17-"));
  const older = path.join(home, "ito.db");

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loses Kumo's line, the check-ins, the Focus and the trust ladder, and keeps its lines as posts", () => {
    const version = migrations.findIndex((sql) => sql.includes("ADD COLUMN urgent"));
    const fresh = new DatabaseSync(older);
    for (const [index, sql] of migrations.slice(0, version).entries()) {
      fresh.exec(sql);
      fresh.exec(versionAfter(index));
    }
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
    fresh.prepare("INSERT INTO jobs (id, every_days, body) VALUES ('j_1', 7, ?)").run(
      JSON.stringify({
        id: "j_1",
        why: "Look for startups",
        at: "2026-11-06T09:30:00.000Z",
        standing: { ask: "startups" },
      }),
    );
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
    const wakeUp = read("SELECT id, at, body FROM wake_ups") as { readonly id: string; readonly body: string };
    migrated.close();

    expect(JSON.parse(desk.body)).toEqual({
      plans: [],
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
    expect(wakeUp.id).toBe("w_1");
    expect(JSON.parse(wakeUp.body)).toMatchObject({
      id: "w_1",
      at: "2026-11-06T09:30:00.000Z",
      what: "Look for startups",
      why: "A standing job: keep looking for startups.",
      repeat: { days: ["fri"], time: "09:30" },
      by: "kumo",
      source: { kind: "chat", title: "Look for startups" },
    });
  });
});

// A database migrated up to 0.18's last migration, with the things in motion given.
const at018 = (file: string, motions: readonly object[]): void => {
  const version = migrations.findIndex((sql) => sql.includes("CREATE TABLE tracks"));
  const upTo018 = migrations.slice(0, version + 1);
  const fresh = new DatabaseSync(file);
  for (const [index, sql] of upTo018.entries()) {
    fresh.exec(sql);
    fresh.exec(versionAfter(index));
  }
  for (const [index, motion] of motions.entries()) {
    const body = JSON.stringify(motion);
    fresh
      .prepare("INSERT INTO motions (id, position, status, changed_at, body) VALUES (?, 1, 'active', ?, ?)")
      .run(`thing-${String(index)}`, "2026-11-01T09:00:00.000Z", body);
    fresh
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (?, ?, 'motion.started', ?, ?)")
      .run(index + 1, `e_${String(index)}`, "2026-11-01T09:00:00.000Z", JSON.stringify({ motion }));
  }
  fresh.close();
};

describe("a 0.18 database", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-migration-0.18-"));

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("gives every thing in motion a normal salience, and has Kumo tidy them into the new kinds", () => {
    const file = path.join(home, "with-motions.db");
    at018(file, [{ id: "thing-0", kind: "pursuit", title: "Job search", status: "active", pinned: true }]);

    const migrated = openDatabase(file);
    const motion = migrated.prepare("SELECT body FROM motions").get() as { readonly body: string };
    const event = migrated.prepare("SELECT body FROM events").get() as { readonly body: string };
    const wakeUp = migrated.prepare("SELECT id, at, body FROM wake_ups").get() as {
      readonly id: string;
      readonly at: string;
      readonly body: string;
    };
    migrated.close();

    expect(JSON.parse(motion.body)).toMatchObject({ kind: "pursuit", salience: "normal" });
    expect(JSON.parse(event.body)).toMatchObject({ motion: { salience: "normal" } });
    expect(wakeUp.id).toBe("w_motion_0_19");
    expect(Date.parse(wakeUp.at)).toBeGreaterThan(Date.now());
    expect(JSON.parse(wakeUp.body)).toMatchObject({
      id: "w_motion_0_19",
      at: wakeUp.at,
      what: "Tidy In motion into its new shapes",
      by: "kumo",
      source: { kind: "chat", title: "Ito 0.19: In motion, rethought" },
    });
    expect((JSON.parse(wakeUp.body) as { readonly why: string }).why).toContain("what's over with an honest outcome");
  });

  it("sets no wake-up when nothing is in motion", () => {
    const file = path.join(home, "empty.db");
    at018(file, []);

    const migrated = openDatabase(file);
    const wakeUps = migrated.prepare("SELECT COUNT(*) AS count FROM wake_ups").get() as { readonly count: number };
    migrated.close();

    expect(wakeUps.count).toBe(0);
  });
});

// A database migrated up to 0.19's last migration.
const at019 = (file: string): DatabaseSync => {
  const version = migrations.findIndex((sql) => sql.includes("CREATE TEMP TABLE wake_up_titles"));
  const fresh = new DatabaseSync(file);
  for (const [index, sql] of migrations.slice(0, version).entries()) {
    fresh.exec(sql);
    fresh.exec(versionAfter(index));
  }
  return fresh;
};

// A wake-up as 0.19 kept it, with no title.
const wakeUp019 = (id: string, what: string) => ({
  id,
  at: "2026-11-30T09:00:00.000Z",
  what,
  why: "Because.",
  by: "kumo",
  source: { kind: "chat", title: "Chat" },
  set_at: "2026-11-20T09:00:00.000Z",
});

describe("a 0.19 database", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-migration-0.19-"));

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("titles every wake-up from the first clause of what it was for, and has Kumo give them plain titles", () => {
    const file = path.join(home, "with-wake-ups.db");
    const fresh = at019(file);
    const long = wakeUp019(
      "w_1",
      "Quietly fetch and reconcile recent sleep and workouts; use real records, not guesses",
    );
    const short = wakeUp019("w_2", "Ask how the technical went");
    for (const given of [long, short]) {
      fresh
        .prepare("INSERT INTO wake_ups (id, at, body) VALUES (?, ?, ?)")
        .run(given.id, given.at, JSON.stringify(given));
    }
    fresh
      .prepare("INSERT INTO desk (id, body) VALUES (1, ?)")
      .run(JSON.stringify({ plans: [long, short], coming_up: [], waiting: [], handled: 0 }));
    const gone = wakeUp019("w_0", "Check the slides went out. If not, nudge");
    fresh
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (1, 'e_1', 'desk.changed', ?, ?)")
      .run(gone.at, JSON.stringify({ type: "desk.changed", desk: { plans: [gone] } }));
    fresh.close();

    const migrated = openDatabase(file);
    const titles = (
      migrated.prepare("SELECT id, body FROM wake_ups ORDER BY id").all() as unknown as readonly {
        readonly id: string;
        readonly body: string;
      }[]
    ).map(({ body }) => JSON.parse(body) as { readonly id: string; readonly title: string; readonly what: string });
    const desk = migrated.prepare("SELECT body FROM desk").get() as { readonly body: string };
    const event = migrated.prepare("SELECT body FROM events").get() as { readonly body: string };
    migrated.close();

    expect(titles.map(({ id, title }) => [id, title])).toEqual([
      ["w_1", "Quietly fetch and reconcile recent sleep and…"],
      ["w_2", "Ask how the technical went"],
      ["w_titles_0_20", "Tidy your plans"],
    ]);
    expect(titles[0]?.what).toBe(long.what);
    expect(
      (JSON.parse(desk.body) as { readonly plans: readonly { readonly title: string }[] }).plans.map(
        ({ title }) => title,
      ),
    ).toEqual(["Quietly fetch and reconcile recent sleep and…", "Ask how the technical went"]);
    expect(JSON.parse(event.body)).toMatchObject({
      desk: { plans: [{ id: "w_0", title: "Check the slides went out" }] },
    });
  });

  it("sets no wake-up to tidy them when there are none", () => {
    const file = path.join(home, "empty.db");
    at019(file).close();

    const migrated = openDatabase(file);
    const wakeUps = migrated.prepare("SELECT COUNT(*) AS count FROM wake_ups").get() as { readonly count: number };
    migrated.close();

    expect(wakeUps.count).toBe(0);
  });
});
