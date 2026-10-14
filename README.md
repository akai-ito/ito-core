# <img src="https://raw.githubusercontent.com/akai-ito/.github/main/profile/mark.svg" width="34" alt=""> ito-core

**The server behind Ito: the agent loop and the client API that Ari talks to.**

[![CI](https://github.com/akai-ito/ito-core/actions/workflows/ci.yml/badge.svg)](https://github.com/akai-ito/ito-core/actions/workflows/ci.yml)

> [!NOTE]
> First comes the live conversation: streaming replies, an instant Stop, and never losing a
> message. The server keeps the client API's guarantees, checked by replaying every golden
> transcript through it, and Ari, the iPhone app, is being built against it. The
> [map](https://github.com/akai-ito/.github/blob/main/map.md) has the design.

## The client API

Commands in, one resumable event stream out. [protocol](protocol) holds the spec (OpenAPI for the
commands, JSON Schema for the events), the [guarantees](protocol/guarantees.md) the server keeps,
and a golden transcript of every scenario, which the server's tests replay through the real API.
Read it rendered at [akai-ito.github.io/ito-core](https://akai-ito.github.io/ito-core/): the API
reference, the guarantees, and a timeline of every transcript.

```sh
npm ci
npm test                    # every transcript through the server, a crash, Codex against a mock
npm run check:transcripts   # every transcript against the spec
npm run docs                # the API reference, built into site/
```

## Run the server

Ito runs on a machine you own and stays on your tailnet. It needs Node 24 and, to reach it from
your phone, [Tailscale](https://tailscale.com).

```sh
git clone https://github.com/akai-ito/ito-core.git ~/ito-core
cd ~/ito-core
npm ci --omit=dev
node bin/ito.ts login    # signs Codex in, in Ito's own home
node bin/ito.ts serve    # the first run prints your token, once
```

Over SSH, `node bin/ito.ts login --device-auth` signs Codex in with a code instead of a browser
redirect. `ito serve` listens on `127.0.0.1:8787` only. If you lose the token, `ito token new`
makes another. `--engine demo` answers without Codex, to try Ari before signing in: a message with
*long* in it gives a reply to stop, *fail* a failure, and *silent* a timeout.

Before reaching for your phone, check a real turn from the machine itself, with the server running
and your token in `TOKEN`. The stream should show the turn start, statuses, the reply's text
arriving, and `turn.ended` with `completed`:

```sh
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v0/events &
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"id\":\"$(cat /proc/sys/kernel/random/uuid)\",\"text\":\"List your workspace, then say hi.\"}" \
  http://127.0.0.1:8787/v0/messages
```

`tailscale serve --bg 8787` then makes it reachable over your tailnet, at an HTTPS address it
prints (turn on HTTPS certificates in the Tailscale admin console first). Add the server in Ari
with that address and your token.

To keep it running, install the systemd user unit from [deploy](deploy/ito.service), which expects
the clone in `~/ito-core` and Node on the default path:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/ito.service ~/.config/systemd/user/
systemctl --user enable --now ito
loginctl enable-linger "$USER"   # keeps it running while you're logged out
journalctl --user -u ito -f      # its logs
```

To update, pull and restart; a reply being written at that moment ends as interrupted:

```sh
cd ~/ito-core && git pull && npm ci --omit=dev && systemctl --user restart ito
```

Ito keeps everything in `~/.ito` (set `ITO_HOME` to move it): the conversation in `ito.db`, Codex's
sign-in and sessions in `codex`, and the agent's working directory in `workspace`.

## What it will do

- Hold one continuous conversation with your agent and stream it live: replies as they are
  written, what the agent is doing right now, and a Stop that works instantly.
- Never lose a message: send while the agent is busy, pick up after any disconnect, and retry
  without duplicates.
- Run the agent on Codex behind a small interface of its own, with cloud or local models.

## Licence

Source-available under your choice of the
[PolyForm Noncommercial](LICENSES/PolyForm-Noncommercial-1.0.0.md) or
[PolyForm Small Business](LICENSES/PolyForm-Small-Business-1.0.0.md) licence; see
[LICENSE.md](LICENSE.md).
