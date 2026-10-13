export const migrations: readonly string[] = [
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    role TEXT NOT NULL,
    kind TEXT,
    turn TEXT,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,
    error TEXT
  );
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    inputs TEXT NOT NULL,
    read TEXT NOT NULL DEFAULT '[]',
    retry_of TEXT,
    status TEXT,
    has_started_reply INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    error TEXT
  );
  CREATE TABLE pending (
    position INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT UNIQUE,
    turn TEXT UNIQUE,
    retry_of TEXT UNIQUE
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
];
