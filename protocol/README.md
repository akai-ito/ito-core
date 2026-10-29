# The Ito client API

**Commands in, one resumable event stream out.** Ari speaks it, and so can any other client.

| File | What it is |
| --- | --- |
| [openapi.yaml](openapi.yaml) | The commands, as OpenAPI 3.1 |
| [events.schema.json](events.schema.json) | Every event on the stream, as JSON Schema |
| [push.schema.json](push.schema.json) | What a push notification carries, encrypted and decrypted |
| [blocks.schema.json](blocks.schema.json) | The `ari:` blocks a reply may hold: places, choices, pictures and things in motion |
| [guarantees.md](guarantees.md) | What the server and the protocol promise |
| [transcripts](transcripts) | One golden transcript per scenario: what crosses the API, step by step |
| [types.ts](types.ts) | TypeScript types generated from the spec |
| [tools](tools) | The scenarios that generate the transcripts, and the checks that run in CI |

## How it fits together

```mermaid
sequenceDiagram
  participant App as Ari
  participant Server as Ito server
  App->>Server: GET /.well-known/ito
  Server-->>App: the protocol versions it speaks
  App->>Server: GET /v0/server (Authorization: Bearer …)
  Server-->>App: its name, its version, the agent's name
  App->>Server: GET /v0/events (Last-Event-ID: the last event applied)
  Server-->>App: every later event, then live (or a snapshot)
  App->>Server: POST /v0/messages {id, text}
  Server-->>App: 201 once the message is on disk
  Server-->>App: message.accepted, turn.started, step.started, turn.status, message.delta …
  App->>Server: POST /v0/turns/{turn}/stop
  Server-->>App: message.ended (stopped), turn.ended (stopped)
```

- **Discover** which protocol versions a server speaks, before there is a token.
- **Authenticate** every other request with the token `ito serve` printed. Tokens travel only
  over HTTPS, or to a loopback address during development.
- **Listen** on one Server-Sent Events stream that carries everything the server says. Each event
  has an id that is never reused; send the last one you applied as `Last-Event-ID` and you
  receive every later event exactly once. When the server can't resume from it, the stream starts
  with a `snapshot` instead.
- **Send** messages under an id the app chooses, so retrying is always safe. The server answers
  once the message is on disk; what it does next arrives on the stream.
- **Stop** a turn, or **try again** after one failed, with commands addressed to the turn.
- **Attach** photos and files: upload each under an id the app makes, then name them in a message.
- **Pair** a new app with the short-lived code in the QR code `ito pair` shows, for a token of its
  own.
- **Answer** what the agent asks by sending a message, or cancel the ask. Asking ends the agent's
  turn, and the ask waits for you as long as it takes.
- **Notify** a device while you're not looking: the app registers it with a key it made, and says
  when the conversation is on screen. Notifications travel encrypted.

## Events

Every event carries `id`, `type` and `at`, plus the fields of its type.

| Type | When |
| --- | --- |
| `snapshot` | The server can't resume from your cursor, or you sent none |
| `message.accepted` | A message you sent is on the server's disk |
| `message.queued` | It can't join the running turn, so it waits as Next |
| `message.read` | The agent took it into the running turn |
| `turn.started` | The agent starts working; Stop works from here |
| `turn.status` | What the agent is doing now, in plain words |
| `step.started` | The agent starts a step (thinking, a search, a command, an edit…), with its title |
| `step.updated` | More is known about a running step |
| `step.ended` | A step is over, with its outcome, duration and past-tense title |
| `ask.started` | The agent asks you something; its turn ends next |
| `ask.ended` | The ask is answered by a message, or cancelled |
| `message.started` | The agent begins a reply, or a note while it works |
| `message.delta` | Text appended to a message, at an offset |
| `message.ended` | A message is finished: completed, stopped, interrupted or failed |
| `turn.ended` | The turn is over, and its status is cleared |

## Versioning

Routes carry the protocol's major version, and every response carries an `Ito-Protocol` header
with the full `MAJOR.MINOR`. Until 1.0, every protocol change may break, so an app and a server
must speak the same `0.MINOR`; from 1.0, a minor version only adds. Apps ignore fields and event
types they don't recognise, and servers ignore unknown request fields.

## Working on it

- `npm run generate` rewrites the transcripts from [tools/scenarios.ts](tools/scenarios.ts) and
  the types from the spec.
- `npm run check:transcripts` checks every transcript against the spec and the guarantees it can
  see: offsets, unique ids, exactly-once delivery, every turn ending.
