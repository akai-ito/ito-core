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
    json((SELECT json_group_array(json(json_remove(value, '$.quiet', '$.review'))) FROM json_each(desk.body, '$.waiting')))
  );
  UPDATE done SET body = json_remove(body, '$.work');
  ALTER TABLE asks DROP COLUMN reminded;
  DELETE FROM settings WHERE key IN (
    'moment_day', 'morning_not_before', 'day_drift', 'day_nights', 'day_last_active', 'day_questions',
    'day_planned', 'day_plan_note', 'status_focus', 'status_said', 'trust_ladder', 'trust_climb_calls',
    'trust_climb_days', 'trust_review_day', 'trust_checks', 'trust_checked'
  );`,
  // Kumo's scheduled looks become wake-ups: a concrete time, what it's for and why, and who set it from where. One
  // that waited on an event comes due at once, so Kumo looks and moves it; a standing job repeats on the weekday and
  // the time it was next due, every day when it was daily.
  `CREATE TABLE wake_ups (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX wake_ups_by_time ON wake_ups (at);
  INSERT INTO wake_ups (id, at, body)
  SELECT
    'w_' || substr(id, 3),
    at,
    json_object(
      'id', 'w_' || substr(id, 3),
      'at', at,
      'what', json_extract(body, '$.why'),
      'why', CASE
        WHEN json_extract(body, '$.standing.ask') IS NOT NULL
          THEN 'A standing job: keep looking for ' || json_extract(body, '$.standing.ask') || '.'
        WHEN json_extract(body, '$.after_event.title') IS NOT NULL
          THEN 'For after ' || json_extract(body, '$.after_event.title') || ': move it to when that ends.'
        ELSE json_extract(body, '$.why')
      END,
      'by', 'kumo',
      'source', CASE
        WHEN json_extract(body, '$.after_event.uid') IS NOT NULL THEN json_object(
          'kind', 'calendar',
          'title', json_extract(body, '$.after_event.title'),
          'event', json_object('uid', json_extract(body, '$.after_event.uid'))
        )
        ELSE json_object('kind', 'chat', 'title', json_extract(body, '$.why'))
      END,
      'set_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  FROM (
    SELECT id, body, every_days,
      coalesce(json_extract(body, '$.at'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS at
    FROM jobs
  );
  UPDATE wake_ups SET body = json_set(body, '$.repeat', json_object(
    'days', CASE
      WHEN (SELECT every_days FROM jobs WHERE 'w_' || substr(jobs.id, 3) = wake_ups.id) = 1
        THEN json_array('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
      ELSE json_array(CASE strftime('%w', at)
        WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue' WHEN '3' THEN 'wed'
        WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' ELSE 'sat' END)
    END,
    'time', strftime('%H:%M', at)
  ))
  WHERE id IN (SELECT 'w_' || substr(id, 3) FROM jobs WHERE every_days IS NOT NULL);
  UPDATE wake_ups SET body = json_set(body, '$.motion', (
    SELECT json_extract(jobs.body, '$.motion') FROM jobs WHERE 'w_' || substr(jobs.id, 3) = wake_ups.id
  ))
  WHERE id IN (SELECT 'w_' || substr(id, 3) FROM jobs WHERE json_extract(body, '$.motion') IS NOT NULL);
  DROP TABLE jobs;
  UPDATE desk SET body = json_set(body, '$.plans', json('[]'));`,
  // Kumo's learning tracks: any area it's getting to know them in, with its stage and what it stands on.
  `CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    body TEXT NOT NULL
  );`,
  // In motion, rethought: every thing has a salience, normal until Kumo judges it, and a thing already ended keeps no
  // outcome, so it shows as ended, never as achieved. Where there's anything in motion, a one-off wake-up a few
  // minutes on has Kumo tidy it into the new kinds and tell them what it did.
  `UPDATE motions SET body = json_set(body, '$.salience', 'normal') WHERE json_extract(body, '$.salience') IS NULL;
  UPDATE events SET body = json_set(body, '$.motion.salience', 'normal')
    WHERE type IN ('motion.started', 'motion.changed', 'motion.finished')
    AND json_extract(body, '$.motion.salience') IS NULL;
  INSERT INTO wake_ups (id, at, body)
  SELECT id, at, json_object(
    'id', id,
    'at', at,
    'what', 'Tidy In motion into its new shapes',
    'why', 'In motion changed shape with Ito 0.19. Follow "Tidying from 0.18" in the Things in motion skill: ' ||
      'reshape what fits, make the job search one pipeline of roles, end what''s over with an honest outcome and ' ||
      'story, hide duplicates and tests, move small admin to the Desk and your plans, and judge how loud each ' ||
      'thing is. Then tell them with post what you did, in a short message: this is worth their attention.',
    'by', 'kumo',
    'source', json(json_object('kind', 'chat', 'title', 'Ito 0.19: In motion, rethought')),
    'set_at', set_at
  )
  FROM (
    SELECT 'w_motion_0_19' AS id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes') AS at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS set_at
  )
  WHERE EXISTS (SELECT 1 FROM motions);`,
  // What Kumo learnt about them from a change to memory, in a line to them: only real learnings, never housekeeping.
  `ALTER TABLE memory_changes ADD COLUMN learnt TEXT;`,
  // 0.19: side threads replace topics. Each message and turn may belong to a thread; the main chat is the rest, so
  // every earlier message stays where it was, readable as before. The topic labels, their events and the labeller's
  // progress go: threads by day take their place from here on.
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    anchor TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX threads_by_position ON threads (position);
  CREATE INDEX threads_by_start ON threads (started_at, id);
  ALTER TABLE messages ADD COLUMN thread TEXT;
  ALTER TABLE messages ADD COLUMN quotes TEXT;
  CREATE INDEX messages_by_thread ON messages (thread, position);
  ALTER TABLE turns ADD COLUMN thread TEXT;
  DROP TABLE topics;
  DELETE FROM events WHERE type = 'topic.started';
  DELETE FROM settings WHERE key = 'topics_history';`,
  // 0.19: the recordings they send, each with where its transcript stands, the transcript itself once it's made, and
  // whether Kumo has read it or come back to it. Audio and transcripts stay on the server, never in memory.
  `CREATE TABLE recordings (
    attachment TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    body TEXT NOT NULL,
    transcript TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    read INTEGER NOT NULL DEFAULT 0,
    followed_up INTEGER NOT NULL DEFAULT 0
  );`,
  // 0.19: the files Kumo shows them to look at, each version an attachment kept as it was made.
  `CREATE TABLE shown_files (
    attachment TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (file, version)
  );
  CREATE INDEX shown_files_by_path ON shown_files (path);
  CREATE INDEX shown_files_by_bytes ON shown_files (sha256);`,
  // Pages Kumo makes: the page as the shelf lists it, each version's content, what changed, and their ticks.
  `CREATE TABLE made (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE made_contents (
    made TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (made, version)
  );
  CREATE TABLE made_changes (
    made TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (made, version)
  );
  CREATE TABLE made_states (
    made TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );`,
  // 0.20: each wake-up has a short title for Kumo's plans, apart from what Kumo will do and why. One set before has a
  // provisional title, the first clause of what it was for, cut at a word to fit, in the Desk and its events too;
  // where there are any, a one-off wake-up a few minutes on has Kumo give each a plain title and fold repeats.
  `CREATE TEMP TABLE wake_up_titles (what TEXT PRIMARY KEY, title TEXT);
  INSERT OR IGNORE INTO wake_up_titles SELECT json_extract(body, '$.what'), json_extract(body, '$.what') FROM wake_ups;
  INSERT OR IGNORE INTO wake_up_titles
    SELECT json_extract(value, '$.what'), json_extract(value, '$.what') FROM desk, json_each(desk.body, '$.plans');
  INSERT OR IGNORE INTO wake_up_titles
    SELECT json_extract(value, '$.what'), json_extract(value, '$.what')
    FROM events, json_each(events.body, '$.desk.plans') WHERE events.type = 'desk.changed';
  DELETE FROM wake_up_titles WHERE what IS NULL;
  UPDATE wake_up_titles SET title = substr(title, 1, instr(title || ';', ';') - 1);
  UPDATE wake_up_titles SET title = substr(title, 1, instr(title || '. ', '. ') - 1);
  UPDATE wake_up_titles SET title = substr(title, 1, instr(title || ' — ', ' — ') - 1);
  UPDATE wake_up_titles SET title = rtrim(trim(title), '.');
  UPDATE wake_up_titles SET title = coalesce(
    nullif(rtrim(rtrim(substr(title, 1, 47),
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789''’'), ' ,:;-–—'), ''),
    substr(title, 1, 47)
  ) || '…' WHERE length(title) > 48;
  UPDATE wake_up_titles SET title = 'A look Kumo set' WHERE title = '';
  UPDATE wake_ups SET body = json_set(body, '$.title',
    (SELECT title FROM wake_up_titles WHERE what = json_extract(wake_ups.body, '$.what')));
  UPDATE desk SET body = json_set(body, '$.plans', json((
    SELECT json_group_array(json(json_set(value, '$.title',
      (SELECT title FROM wake_up_titles WHERE what = json_extract(value, '$.what')))))
    FROM json_each(desk.body, '$.plans')
  ))) WHERE json_array_length(body, '$.plans') > 0;
  UPDATE events SET body = json_set(body, '$.desk.plans', json((
    SELECT json_group_array(json(json_set(value, '$.title',
      (SELECT title FROM wake_up_titles WHERE what = json_extract(value, '$.what')))))
    FROM json_each(events.body, '$.desk.plans')
  ))) WHERE type = 'desk.changed' AND json_array_length(body, '$.desk.plans') > 0;
  DROP TABLE wake_up_titles;
  INSERT INTO wake_ups (id, at, body)
  SELECT id, at, json_object(
    'id', id,
    'at', at,
    'title', 'Tidy your plans',
    'what', 'Give each of your wake-ups a plain title, and fold repeats into one',
    'why', 'Ito 0.20 shows your plans by a short title of their own. Give each of your wake-ups one with ' ||
      'move_wake_up: a few plain words as they''d say it, such as "Ask how the technical went", not a note to ' ||
      'yourself. Where several one-offs are the same reminder on different days, keep one with a repeat and drop ' ||
      'the rest. Say nothing to them about it.',
    'by', 'kumo',
    'source', json(json_object('kind', 'chat', 'title', 'Ito 0.20: plain titles for your plans')),
    'set_at', set_at
  )
  FROM (
    SELECT 'w_titles_0_20' AS id,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes') AS at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS set_at
  )
  WHERE EXISTS (SELECT 1 FROM wake_ups);`,
  // Understanding you: the questions Kumo would like them to explain, on its learning tracks.
  `CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    body TEXT NOT NULL
  );`,
  // 0.20: what they share from their phone's share sheet, as it came, from when the server accepts it, through Kumo
  // placing it in a thread, which makes it their message under the same id; and on that message, what they shared
  // besides their note.
  `CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  ALTER TABLE messages ADD COLUMN share TEXT;`,
  // 0.20: Kumo's dreams, each with the night it stands for (`slot`, the dream time it was due at), and the notes
  // Kumo keeps during the day for the next dream, each with the day it's about and the dream that took it in.
  `CREATE TABLE dreams (
    id TEXT PRIMARY KEY,
    slot TEXT NOT NULL,
    started_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX dreams_by_slot ON dreams (slot);
  CREATE INDEX dreams_by_start ON dreams (started_at);
  CREATE TABLE day_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    day TEXT NOT NULL,
    body TEXT NOT NULL,
    dream TEXT
  );
  CREATE INDEX day_notes_by_dream ON day_notes (dream, id);`,
];
