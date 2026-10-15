# Guarantees

What the server and the protocol promise. Each promise is worded so that an integration test can
check it through the real API, and the [golden transcripts](transcripts) show them at work, one
scenario each. What only an app does (pacing text, scrolling, laying out Markdown) appears only
where the protocol has to make it possible, marked *App*.

## Across the protocol

| | Guarantee | Scenarios |
| --- | --- | --- |
| G1 | **Acknowledged means durable.** The server confirms a command only once its effect is on disk. A crash after the confirmation loses nothing. | 3, 12, 14 |
| G2 | **Exactly once.** Each message carries a key the app chooses before sending. Sending it again, any number of times, has the effect of sending it once. The duplicate check happens inside the same transaction that accepts the message. | 2, 3, 10, 12, 15, 29 |
| G3 | **One order.** Everything in the conversation has one position, the same for every app. Messages take effect in the order the server accepted them, and an app's messages are accepted in the order it sent them. | 7, 9, 10, 12 |
| G4 | **Exact resume.** Every event carries a cursor. Reconnecting with the last cursor the app applied delivers every later event once: nothing missing, nothing repeated, including reply text streamed in the meantime. | 2, 11, 13 |
| G5 | **An honest reset.** When the server can't continue from a cursor (too old, restored from a backup, a different server), it says so and sends a fresh snapshot. It never resumes from the wrong place. Ids are never reused, even after a restore. | 14 |
| G6 | **Turns outlive connections.** A turn runs to its end whether or not any app is connected. Only Stop, a failure or a restart ends it early. | 13 |
| G7 | **Text only grows.** Reply text streams as appended pieces and is never revised. A finished message's text is exactly what was streamed, or exactly what was on screen when you tapped Stop. Stop cuts only a message still being written; one that already finished keeps all its text. | 5, 7, 8, 11 |
| G8 | **Every turn ends, with a reason.** Completed, stopped, interrupted by a restart, or failed with a typed error. Nothing is left "still writing", and live status never outlives its turn. A turn that fails or is cut off before writing a reply still leaves one, empty and carrying the reason, so the conversation itself shows what happened. | 4, 6, 14, 15 |
| G9 | **Stop jumps every queue.** Stop is a command of its own, addressed to one turn, safe to repeat, and handled ahead of everything else on both sides: never behind a send, a steer or a reconnect. It is confirmed only once the agent has really stopped. | 7 |
| G10 | **Plain words, typed errors.** Every status label and step title is plain words written by the server, safe to show as it is. Specifics (commands, paths, queries, URLs, tool names, output) travel in typed fields, exactly as the agent used them, and the app decides what to show. Errors carry a stable code, a plain sentence and a technical detail. | 4, 15, 16, 17 |
| G11 | **The token stays secret.** It travels only over HTTPS (loopback excepted, for development), is never logged and is never sent back. | 1, 31 |
| G12 | **Versioned and tolerant.** The server states its protocol version before asking for the token. Both sides ignore what they don't recognise. A major mismatch says which side to update. | 1 |
| G13 | **Several apps, one conversation.** An iPhone and a Mac can be connected at once. Every app receives every event, and a send or a Stop from either applies to the one shared conversation. | 2, 30 |
| G14 | **The agent's steps are kept.** Every step the agent takes (thinking, a search, a command, an edit, a tool, a plan) streams as it happens and is stored in the conversation, in order with the messages, so it comes back in snapshots, in history and on every app. Every step ends with an outcome; a step still running when its turn ends, ends with the turn. | 4, 7, 9, 15, 16, 17 |
| G15 | **Notified only while you're away.** The server pushes when a reply finishes, when a turn fails, when the agent asks you something, and once more for an ask still waiting after three hours, and never for progress or notes. Nothing is pushed while any of your devices is looking at the conversation with a live stream. | 18, 21, 24, 26 |
| G16 | **Asks wait for you.** Asking ends the agent's turn, and the ask waits as long as it takes, through the app closing, the phone going offline and the server restarting. Your next message answers it, whichever way you write it, and only you can cancel it. Nothing happens on the agent's side until you answer. | 19, 20, 21, 22, 23, 24 |
| G17 | **Secrets stay out of the conversation.** The answer to a secret ask reaches the agent and nothing else: it never enters the server's log, a snapshot, history, a notification or a response. | 25 |
| G18 | **Notifications are private.** The text of every notification is encrypted on the server with a key the device made, so Apple's push service carries only ciphertext. | 18, 21, 24, 26 |
| G19 | **Attachments stay as you sent them.** A photo or file is uploaded once, under an id the app chooses, so a retry never makes a second copy. Its bytes never change, every app can fetch them, and the agent works on its own copy, so nothing it does changes what you sent. | 27, 28, 29, 30 |
| G20 | **Pairing never shows the token.** The QR code carries a short-lived code that works once, never a token. Each paired device gets a token of its own, and the server keeps only its hash. | 31 |

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
- Live status has a coarse kind (thinking, working, writing…) for the agent's presence and a label
  in plain words; while a step runs, the label is that step's title. (G10)
- Each step the agent takes streams as it happens: `step.started` with a present-tense title,
  `step.updated` as more is known, `step.ended` with its outcome, duration and past-tense title.
  Its specifics (the search query, the command, the files) travel in typed fields. (G10, G14)
- Status and steps belong to a turn: they change as the work changes and end with the turn.
  Nothing about the turn arrives after its end. (G8)

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
- A Stop while a step runs ends the step too, as stopped. A step that didn't complete keeps its
  present-tense title. (G14)

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
  interrupted, and apps learn it through the normal replay. A turn cut off before it wrote a reply
  leaves an empty reply marked interrupted. (G8)
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
- A turn that fails before writing a reply still leaves one: empty, carrying the error. The failure
  stays in the conversation, in a snapshot, in history and on every app, with its Try again. (G8)

### 16 · [Working through a task](transcripts/16-working-through-a-task.jsonl)

- Each step has a plain title written by the server and its specifics in typed fields: a command's
  line, folder, actions, exit code and output; a file change's files and line counts; a tool's
  capability, operation and arguments; a wait's length. (G10, G14)
- A command that runs is completed whatever its exit code: a search that finds nothing exits 1 and
  is still completed. Failed means a step couldn't run, or a tool reported an error. (G14)
- A plan is a step that stays open while the agent works through it. Each update carries every
  item's state, and the plan ends with the turn. (G14)

### 17 · [Reporting a gap](transcripts/17-reporting-a-gap.jsonl)

- When the agent can't find something out, it reports the gap to Ito. The report is a `tool` step
  titled by what it did ("Reporting it to Ito", then "Reported it to Ito", or "Added to an Ito
  issue" when it adds to an existing one), and its `url` links the issue. (G10, G14)
- A command that couldn't fetch the page still ran: it's completed, with its exit code and
  output. (G14)

### 18 · [A reply while you're away](transcripts/18-a-reply-while-you-re-away.jsonl)

- With the conversation off screen, a finished reply arrives as a notification: its first line with
  Markdown stripped, and the reply's id so a tap opens Ari there. A failed turn arrives as "Couldn't
  finish: " and the error's message. (G15)
- The notification's text travels encrypted with the device's own key. (G18)

### 19 · [Ari asks before acting](transcripts/19-ari-asks-before-acting.jsonl)

- An ask is part of the conversation, with its position: a question, its options and whether a typed
  answer fits. Asking ends the turn. (G16)
- Tapping an option sends its label as an ordinary message naming the ask; `message.accepted` comes
  first, then `ask.ended`, and the message starts the next turn. (G16) *App:* the settled line,
  worded from the question.

### 20 · [An approval](transcripts/20-an-approval.jsonl)

- An approval shows a `preview` of exactly what would happen, and marks the one option that acts.
  Nothing happens until you agree. (G16)

### 21 · [An ask while you're away](transcripts/21-an-ask-while-you-re-away.jsonl)

- An ask made while you're away is a time-sensitive notification carrying its options and whether a
  typed answer fits, so you can answer from the notification. That answer is an ordinary send.
  (G15, G16, G18)

### 22 · [Waiting](transcripts/22-waiting.jsonl)

- An ask waits through the app closing and the server restarting. Cancelling it, which is what Stop
  does while an ask waits, ends it as `cancelled`, and it stays in the conversation. (G16)

### 23 · [Your own way, then Stop](transcripts/23-your-own-way-then-stop.jsonl)

- A message that doesn't name the ask still answers it: the server marks it `answers`. (G16)
- If the agent asks something new before you answer, the earlier ask ends as `cancelled`; at most
  one ask waits. (G16)

### 24 · [The reminder](transcripts/24-the-reminder.jsonl)

- An ask still waiting after three hours, with nobody looking, sends one reminder at normal level:
  "Still waiting on one thing: " and the question. Then nothing more. (G15, G16, G18)
- With you looking, nothing is pushed. (G15)

### 25 · [A secret](transcripts/25-a-secret.jsonl)

- A secret ask's answer, sent naming the ask, reaches the agent, while the conversation keeps an
  empty message marked `secret`: in the stream, in the send's response, and in snapshots and
  history. (G17)

### 26 · [Turning on notifications](transcripts/26-turning-on-notifications.jsonl)

- The app registers the device with its push token, its APNs environment and a notification key it
  made, and says when the conversation is on screen. The server forgets that when it restarts, so
  the app says it again after reconnecting. (G15, G18) *App:* when to offer notifications.

### 27 · [Send a photo](transcripts/27-send-a-photo.jsonl)

- The app uploads a photo under an id it made, then sends a message naming it. The message carries
  the photo's name, media type, size and dimensions; the agent sees the image itself. (G19)

### 28 · [Send a file](transcripts/28-send-a-file.jsonl)

- A file lands in the agent's workspace under `uploads/`, with its own name, and the agent reads it
  there like any file. The server keeps its own copy. (G19)

### 29 · [An upload that fails](transcripts/29-an-upload-that-fails.jsonl)

- A file over 20 MB is refused as `too_large` before it is stored.
- Uploading again under the same id, after an answer was lost, returns the same attachment and
  stores nothing new. (G2, G19)
- A message may carry only attachments, with empty text. (G19)

### 30 · [Another device sees an attachment](transcripts/30-another-device-sees-an-attachment.jsonl)

- Attachments arrive with their messages, in snapshots and history, on every device, and their
  bytes are one request away. (G13, G19)

### 31 · [Pair with a QR code](transcripts/31-pair-with-a-qr-code.jsonl)

- `ito pair` shows a QR code with the address and a code that works once, for five minutes. The app
  exchanges it for a token of its own, and connects with it. (G11, G20)
- A used, wrong or expired code is refused as `pairing_code_rejected`. (G20)

## Not in this version

Voice, editing or deleting messages, more than one conversation, reactions, model
settings, and pairing beyond a pasted token.
