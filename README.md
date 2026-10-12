# <img src="https://raw.githubusercontent.com/akai-ito/.github/main/profile/mark.svg" width="34" alt=""> ito-core

**The server behind Ito: the agent loop and the client API that Ari talks to.**

[![CI](https://github.com/akai-ito/ito-core/actions/workflows/ci.yml/badge.svg)](https://github.com/akai-ito/ito-core/actions/workflows/ci.yml)

> [!NOTE]
> The client API is drafted; the server comes next, built against it. First comes the live
> conversation: streaming replies, an instant Stop, and never losing a message. The
> [map](https://github.com/akai-ito/.github/blob/main/map.md) has the design.

## The client API

Commands in, one resumable event stream out. [protocol](protocol) holds the spec (OpenAPI for the
commands, JSON Schema for the events), the [guarantees](protocol/guarantees.md) the server keeps,
and a golden transcript of every scenario, which the server's tests replay through the real API.

```sh
npm ci
npm run check:transcripts   # every transcript against the spec
npm run docs                # the API reference, built into site/
```

## What it will do

- Hold one continuous conversation with your agent and stream it live: replies as they are
  written, what the agent is doing right now, and a Stop that works instantly.
- Never lose a message: send while the agent is busy, pick up after any disconnect, and retry
  without duplicates.
- Publish its API docs on GitHub Pages, so any client can be built against the spec.
- Run the agent on Codex behind a small interface of its own, with cloud or local models.

## Licence

Source-available under your choice of the
[PolyForm Noncommercial](LICENSES/PolyForm-Noncommercial-1.0.0.md) or
[PolyForm Small Business](LICENSES/PolyForm-Small-Business-1.0.0.md) licence; see
[LICENSE.md](LICENSE.md).
