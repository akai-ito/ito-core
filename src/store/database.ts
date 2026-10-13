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

export const openDatabase = (filePath: string): DatabaseSync => {
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  migrate(database);
  return database;
};
