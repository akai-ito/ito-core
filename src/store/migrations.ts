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
  `CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL,
    outcome TEXT
  );
  UPDATE events SET body = json_set(body, '$.message.position', seq)
    WHERE type IN ('message.accepted', 'message.started');`,
  `ALTER TABLE messages ADD COLUMN answers TEXT;
  ALTER TABLE messages ADD COLUMN secret INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL,
    outcome TEXT,
    reminded INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    apns_token TEXT NOT NULL,
    environment TEXT NOT NULL,
    notification_key TEXT NOT NULL,
    key_id TEXT NOT NULL,
    registered_at TEXT NOT NULL
  );`,
];
