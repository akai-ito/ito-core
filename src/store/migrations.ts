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
    error TEXT,
    answers TEXT,
    attachments TEXT,
    spoken TEXT,
    done TEXT
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
  );
  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    turn TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL,
    outcome TEXT
  );
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
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    at TEXT NOT NULL,
    message TEXT,
    kept INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE pairing_codes (
    hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    device_name TEXT
  );
  CREATE TABLE memory_changes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    title TEXT NOT NULL,
    file TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    at TEXT NOT NULL,
    before_sha TEXT,
    note TEXT
  );
  CREATE INDEX memory_changes_by_address ON memory_changes (address, at);
  CREATE TABLE memory_chunks (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    vector BLOB
  );
  CREATE INDEX memory_chunks_by_address ON memory_chunks (address);
  CREATE VIRTUAL TABLE memory_text USING fts5(text);
  CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    body TEXT NOT NULL,
    ended INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    body TEXT NOT NULL
  );
  CREATE TABLE motions (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE motion_changes (
    motion TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (motion, version)
  );
  CREATE TABLE motion_states (
    motion TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );
  CREATE TABLE desk (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL
  );`,
];
