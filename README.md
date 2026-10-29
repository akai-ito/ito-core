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
redirect. `ito serve` listens on `127.0.0.1:8787` only. If you lose the token, `ito token new` makes
another. `--engine demo` answers without Codex, to try Ari before signing in: a message with *busy*
in it walks a trail of steps, *long* gives a reply to stop, *fail* a failure, *silent* a timeout,
*ask* a question, *approve* an approval, *remember* writes a page and the journal in memory,
*recall* looks it up, *trip* and *training* start things in motion, and *booked* books the trip's
Uffizi.

Before reaching for your phone, check a real turn from the machine itself, with the server running
and your token in `TOKEN`. The stream should show the turn start, statuses, the reply's text
arriving, and `turn.ended` with `completed`:

```sh
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v0/events &
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"id\":\"$(cat /proc/sys/kernel/random/uuid)\",\"text\":\"List your workspace, then say hi.\"}" \
  http://127.0.0.1:8787/v0/messages
```

`tailscale serve --bg --https=8443 8787` then makes it reachable over your tailnet at
`https://<machine>.<tailnet>.ts.net:8443` (turn on HTTPS certificates in the Tailscale admin console
first). Port 8443 leaves 443 alone, so Ito never replaces another service this machine already
serves or funnels there. Add the server in Ari with that address and your token, or pair it with a
QR code instead: run `node bin/ito.ts pair` on the server and scan the code with Ari. The code works
once, for five minutes, and gives that device a token of its own; `ito token new` replaces every
token at once.

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

Ari runs on Codex's default model until you choose another, and how hard it thinks, in Ari's
Settings › Model; the choice applies from your next message.

The agent's instructions, Ari's voice and how it works, are in
[agent/instructions.md](agent/instructions.md). Change them and restart: the next message picks
them up, in the same conversation.

Capabilities, such as Reports, live in [capabilities](capabilities) and start switched off; switch
them on and set them up in Ari's Settings › Capabilities. Each runs as its own process with only its
own setup values, and each is one definition written with the SDK in
[capabilities/sdk](capabilities/sdk). Reports files the gaps Ari hits, such as a page it couldn't
load or a mistake you corrected, as public
[issues labelled `gap`](https://github.com/akai-ito/ito-core/issues?q=label%3Agap) on ito-core,
never with anything from your conversation: give it a
[fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) for
akai-ito/ito-core with *Issues: read and write*. Up to 20 reports a day are filed; any more go to
Ito's log.

Ari remembers you in the Thread, a git repository of Markdown pages in `~/.ito/thread` that you can
read without Ito: your portrait, what's going on now, how you like to be helped, pages on people,
goals, projects, places and topics, and a journal. Ari writes it as you talk, and finds things in it
and in past conversations with a small embedding model it downloads once and runs on the CPU. To
back it up, create a private repository and point the Thread at it; Ito pushes after each change
with this machine's own git credentials:

```sh
node bin/ito.ts memory remote git@github.com:<you>/ito-thread.git
```

If pages change on the remote, say by merging a pull request there, `node bin/ito.ts memory pull`
fast-forwards the Thread, and Ari takes the new pages into its search the next time it uses memory.
It refuses, rather than merge, when pages changed on both sides.

Ari notifies you while you're away: when a reply finishes, when something fails, and when it asks
you something. To switch notifications on, create an APNs key in your Apple Developer account
(Certificates, Identifiers & Profiles, then Keys, with Apple Push Notifications service), download
its `.p8` file once, and run:

```sh
node bin/ito.ts push setup --key AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG \
  --team-id <your team id> --bundle-id <Ari's bundle id>
```

The box needs to reach `api.push.apple.com` on port 443. Notifications travel encrypted with a key
each phone makes, so Apple only ever carries ciphertext.

Ari's voice runs on the box's NVIDIA GPU, in a sidecar in [voice](voice) that `ito serve` starts:
Silero VAD and Smart Turn hear when you've finished, Parakeet recognises what you said, steered
toward the names in your memory, and Kokoro speaks. It needs a driver for CUDA 12 on a Pascal card,
such as a GTX 1050 Ti, or newer, and [uv](https://docs.astral.sh/uv/getting-started/installation/).
With `ito serve` stopped, one command installs it and measures the box:

```sh
node bin/ito.ts voice check
```

It installs the Python packages (about 6 GB the first time), downloads the models (about 3 GB),
loads each on the GPU, and times listening, turn-taking, recognition with and without your
vocabulary, telling your voice from others', and speaking. It prints a report and keeps it in
`~/.ito/voice-check.md`; the details, which quote your memory, stay in
`~/.ito/voice-check-details.md`. Then start `ito serve` again. Ari offers Talk only once the voice is
ready, and otherwise says why. After your first few minutes of calls, the voice learns a voiceprint
of you, kept in `~/.ito/voice` and never sent anywhere, so people talking nearby don't hold your turn
open. If espeak-ng, which says names Kokoro doesn't know, won't load from
its Python package, install it with `sudo apt install espeak-ng`.

Ito keeps everything in `~/.ito` (set `ITO_HOME` to move it): the conversation in `ito.db`, Codex's
sign-in and sessions in `codex`, the agent's working directory in `workspace`, its memory in
`thread`, the embedding and voice models in `models`, and each capability's own folder in
`capabilities`.

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
