import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "#store/database.ts";
import { migrations } from "#store/migrations.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "ito-migration-"));
const file = path.join(directory, "ito.db");

describe("upgrading a 0.1 database", () => {
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
    const earlier = migrations.slice(0, -1);
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
});
