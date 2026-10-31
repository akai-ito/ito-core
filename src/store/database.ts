import { existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "#store/migrations.ts";

const migrate = (database: DatabaseSync): void => {
  const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
  for (const [index, sql] of migrations.slice(version).entries()) {
    database.exec("BEGIN");
    database.exec(sql);
    database.exec(`PRAGMA user_version = ${version + index + 1}`);
    database.exec("COMMIT");
  }
};

const open = (filePath: string): DatabaseSync => {
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  return database;
};

const isBefore016 = (database: DatabaseSync): boolean => {
  const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return (
    version > 0 &&
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'desk'").get() === undefined
  );
};

export const earlierFile = (filePath: string): string => `${filePath.replace(/\.db$/u, "")}-before-0.16.db`;

export const openDatabase = (filePath: string): DatabaseSync => {
  const database = open(filePath);
  if (!isBefore016(database)) {
    migrate(database);
    return database;
  }
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  renameSync(filePath, earlierFile(filePath));
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${filePath}${suffix}`)) renameSync(`${filePath}${suffix}`, `${earlierFile(filePath)}${suffix}`);
  }
  const fresh = open(filePath);
  migrate(fresh);
  return fresh;
};
