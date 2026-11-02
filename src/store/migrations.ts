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
  `CREATE TABLE done (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    body TEXT NOT NULL,
    undo_with TEXT
  );
  CREATE INDEX done_by_time ON done (at, id);`,
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    every_days INTEGER,
    body TEXT NOT NULL
  );`,
  // 0.17: Kumo's line for the moment replaces the morning briefing.
  `UPDATE desk SET body = json_set(json_remove(body, '$.briefing'), '$.handled', 0);
  UPDATE settings SET key = 'morning_not_before' WHERE key = 'briefing_not_before';
  DELETE FROM settings WHERE key = 'briefing_day';`,
  // Kumo's picture of your day: its plan and its guesses, on its own calendar, with why.
  `CREATE TABLE kumo_blocks (
    uid TEXT PRIMARY KEY,
    start TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX kumo_blocks_by_start ON kumo_blocks (start);`,
  // 0.18: Kumo speaks in messages, which may be urgent. Its line for the moment, the check-ins, the Focus it heard,
  // the trust ladder and the morning time are gone, and so are their records.
  `ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET kind = 'post' WHERE kind = 'moment';
  UPDATE events SET body = json_set(body, '$.message.kind', 'post')
    WHERE type = 'message.posted' AND json_extract(body, '$.message.kind') = 'moment';
  UPDATE events SET body = json_remove(body, '$.desk.moment') WHERE type = 'desk.changed';
  UPDATE desk SET body = json_set(
    json_remove(body, '$.moment'),
    '$.waiting',
    (SELECT json_group_array(json(json_remove(value, '$.quiet', '$.review'))) FROM json_each(desk.body, '$.waiting'))
  );
  UPDATE done SET body = json_remove(body, '$.work');
  ALTER TABLE asks DROP COLUMN reminded;
  DELETE FROM settings WHERE key IN (
    'moment_day', 'morning_not_before', 'day_drift', 'day_nights', 'day_last_active', 'day_questions',
    'day_planned', 'day_plan_note', 'status_focus', 'status_said', 'trust_ladder', 'trust_climb_calls',
    'trust_climb_days', 'trust_review_day', 'trust_checks', 'trust_checked'
  );`,
];
