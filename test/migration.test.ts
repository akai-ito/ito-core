import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { earlierFile, openDatabase } from "#store/database.ts";

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
