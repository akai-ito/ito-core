# Guarantees

What the server and the protocol promise. Each promise is worded so that an integration test can
check it through the real API, and the [golden transcripts](transcripts) show them at work, one
scenario each. What only an app does (pacing text, scrolling, laying out Markdown) appears only
where the protocol has to make it possible, marked *App*.

## Across the protocol

| | Guarantee | Scenarios |
| --- | --- | --- |
| G1 | **Acknowledged means durable.** The server confirms a command only once its effect is on disk. A crash after the confirmation loses nothing. | 3, 12, 14 |
| G2 | **Exactly once.** Each message carries a key the app chooses before sending. Sending it again, any number of times, has the effect of sending it once. The duplicate check happens inside the same transaction that accepts the message. | 2, 3, 10, 12, 15 |
| G3 | **One order.** Everything in the conversation has one position, the same for every app. Messages take effect in the order the server accepted them, and an app's messages are accepted in the order it sent them. | 7, 9, 10, 12 |
| G4 | **Exact resume.** Every event carries a cursor. Reconnecting with the last cursor the app applied delivers every later event once: nothing missing, nothing repeated, including reply text streamed in the meantime. | 2, 11, 13 |
| G5 | **An honest reset.** When the server can't continue from a cursor (too old, restored from a backup, a different server), it says so and sends a fresh snapshot. It never resumes from the wrong place. Ids are never reused, even after a restore. | 14 |
| G6 | **Turns outlive connections.** A turn runs to its end whether or not any app is connected. Only Stop, a failure or a restart ends it early. | 13 |
| G7 | **Text only grows.** Reply text streams as appended pieces and is never revised. A finished message's text is exactly what was streamed, or exactly what was on screen when you tapped Stop. Stop cuts only a message still being written; one that already finished keeps all its text. | 5, 7, 8, 11 |
| G8 | **Every turn ends, with a reason.** Completed, stopped, interrupted by a restart, or failed with a typed error. Nothing is left "still writing", and live status never outlives its turn. | 4, 6, 14, 15 |
| G9 | **Stop jumps every queue.** Stop is a command of its own, addressed to one turn, safe to repeat, and handled ahead of everything else on both sides: never behind a send, a steer or a reconnect. It is confirmed only once the agent has really stopped. | 7 |
| G10 | **Plain words, typed errors.** Live status is plain words from a known vocabulary. Errors carry a stable code, a plain sentence and a technical detail. | 4, 15 |
| G11 | **The token stays secret.** It travels only over HTTPS (loopback excepted, for development), is never logged and is never sent back. | 1 |
| G12 | **Versioned and tolerant.** The server states its protocol version before asking for the token. Both sides ignore what they don't recognise. A major mismatch says which side to update. | 1 |
| G13 | **Several apps, one conversation.** An iPhone and a Mac can be connected at once. Every app receives every event, and a send or a Stop from either applies to the one shared conversation. | 2 |

## Scenario by scenario

### 1 · [First connection](transcripts/01-first-connection.jsonl)

- The server answers an unauthenticated version check with the protocol versions it speaks, so the
  app can tell *unreachable*, *wrong version* and *token rejected* apart. (G12)
- A wrong token gets its own typed rejection, and repeated wrong tokens are slowed down.
- Once the token is accepted, the server reports its name, its version and the agent's name.
- The token is accepted only over HTTPS or loopback, never logged, never echoed. (G11) *App:*
  keychain, masked display.

### 2 · [Open Ari](transcripts/02-open-ari.jsonl)

- Catching up is incremental: the app sends its cursor and receives only what is new. A good cursor
  never forces a reload. (G4)
- Message ids are stable, and the app can always match its own messages, so merging never shows a
  message twice. (G2)
- Nothing in the protocol has to happen before the app shows its cached history.

### 3 · [Send](transcripts/03-send.jsonl)

- The app chooses the message's id before sending, so the message can be shown and saved on the
  phone first. (G2)
- The server confirms as soon as the message is on disk, before the agent is involved: the send path
  never waits on the model. (G1)
- Sending the same message again returns the same confirmation and changes nothing. (G2)

### 4 · [The agent stirs](transcripts/04-the-agent-stirs.jsonl)

- When a message starts a turn, the server announces the turn at once, with its id (so Stop works
  immediately), without waiting for the model.
- Live status uses a known vocabulary (thinking, working, writing…) with a label in plain words:
  never a tool name, a command or JSON. (G10)
- Status belongs to a turn: it changes as the work changes and ends with the turn. Nothing about the
  turn arrives after its end. (G8)

### 5 · [The reply streams](transcripts/05-the-reply-streams.jsonl)

- Reply text arrives as appended pieces, each with its position in the message, and is never
  revised. (G7)
- The text is GitHub-flavoured Markdown, sent as written, so the app can format it as it arrives.
- The server forwards text promptly and leaves pacing to the app. *App:* a steady reading pace,
  even when the network delivers text in bursts.

### 6 · [You scroll up mid-reply](transcripts/06-you-scroll-up-mid-reply.jsonl)

- A reply's start and end are explicit events, so the app can show that the agent is still writing,
  and that it finished, without guessing from silence.

### 7 · [Stop](transcripts/07-stop.jsonl)

- Stop jumps every queue. (G9)
- Stop says where the reply was cut on screen. The stopped message keeps exactly that and is marked
  stopped, so no reconnect ever brings back more. (G7)
- Once the server has the Stop, no more text for that turn is sent.
- The server confirms the stop only after the agent has stopped. If the agent doesn't stop in time,
  the server forces it.
- A message sent while a turn is stopping waits, and starts the next turn. (G3)
- A Stop that arrives after the reply already finished changes nothing.
- When the screen lags behind the server, Stop cuts the message still being written, at as much of
  it as was on screen (nothing, if it hadn't appeared yet). A reply that already finished keeps all
  its text, so every app, snapshot and history page agrees. (G7)

### 8 · [Copy and share](transcripts/08-copy-and-share.jsonl)

- Message text is the Markdown source, complete and clean (no labels or timestamps mixed in) and
  available while it is still streaming.

### 9 · [Scrolling back](transcripts/09-scrolling-back.jsonl)

- History pages backwards from any message, in a stable order, and each page says whether there is
  more. A page boundary is a message, not a count, so pages don't shift as new messages arrive.
  (G3)
- Every message carries the time the server accepted or started it. *App:* a date at the start of
  each day.
- The whole conversation stays available.

### 10 · [Send while it's busy](transcripts/10-send-while-it-s-busy.jsonl)

- The app sends every message the same way; the server decides whether it joins the running turn
  or waits as Next.
- The app learns which: read into the running turn, waiting as Next, or starting a new turn.
- The agent reads new input at its next step, between model calls, so a reply it was already
  writing finishes first and the adjustment follows as a new reply.
- A message never overtakes one sent before it. (G3)
- Each message reaches the agent exactly once, even when joining the turn fails or its outcome is
  unknown. (G2)

### 11 · [Signal drops mid-reply](transcripts/11-signal-drops-mid-reply.jsonl)

- Reply text goes into the durable event log as it streams, so resuming replays exactly the words
  missed. (G4, G7)
- If the reply finished while you were away, the replay includes its end, so the rest appears at
  once.
- The stream carries a heartbeat, so a dead connection is noticed within seconds.
- Resuming is a normal path, never an error.

### 12 · [Send while offline](transcripts/12-send-while-offline.jsonl)

- Waiting messages are sent one at a time, in order, each confirmed before the next. (G3)
- Retrying is safe even after the app was closed and opened again: the message's id is the retry
  key. (G1, G2)

### 13 · [Ari is closed mid-reply](transcripts/13-ari-is-closed-mid-reply.jsonl)

- Turns outlive connections. (G6)
- On return, the app resumes from its cursor: the finished reply, or the reply so far and then
  live. (G4)

### 14 · [The server restarts, or is restored](transcripts/14-the-server-restarts-or-is-restored.jsonl)

- Restart: on startup the server ends any turn that was cut off. Its text is kept and marked
  interrupted, and apps learn it through the normal replay. (G8)
- Restore: a cursor the server doesn't know triggers an explicit reset and a fresh snapshot, so the
  app shows exactly what the server has, and no copies. (G5)

### 15 · [Something fails](transcripts/15-something-fails.jsonl)

- A failed turn ends with a typed error: a stable code, a plain sentence ("The model didn't respond
  for 60 seconds") and the technical detail. (G10)
- Your message and any text already written are kept.
- Every turn is bounded: if the agent makes no progress for a set time, the turn fails with a
  timeout instead of spinning forever.
- Try again is a command keyed by the failed turn: it starts one new attempt and never sends your
  message twice.

## Not in this version

Attachments and voice, push notifications, editing or deleting messages, more than one
conversation, reactions, questions and approvals, model settings, and pairing beyond a pasted
token.
