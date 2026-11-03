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

```sh
npm ci
npm test                    # every transcript through the server, a crash, Codex against a mock
npm run check:transcripts   # every transcript against the spec
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
*recall* looks it up, *trip* and *training* start things in motion, *booked* books the trip's
Uffizi, *mail* reads a sample mail, puts a draft on the Desk and messages you about it, and *plan*
lays out a sample day of Kumo's plan and guesses in Coming up.

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
never with anything from your conversation. Tap *Connect GitHub* on its sheet and approve the code
on GitHub: Ito's GitHub app can only open and comment on issues in Ito's own repositories, and
GitHub hands its token to your server, never to the phone. Up to 20 reports a day are filed; any
more go to Ito's log.

Ari remembers you in the Thread, a git repository of Markdown pages in `~/.ito/thread` that you can
read without Ito: your portrait, what's going on now, how you like to be helped, pages on people,
goals, projects, places and topics, and a journal. Ari writes it as you talk, and finds things in it
and in past conversations with a small embedding model it downloads once and runs on the CPU.

To back it up, tap *Back up to GitHub* in Ari's Settings › Memory and approve the code on GitHub.
Your server finds your private `ito-thread` repository, or makes one, and GitHub asks you to install
Ito Memory, Ito's GitHub app, on just that repository; from then on Ito pushes after each change.
The app can only read and write the repositories it's installed on, and make that one; GitHub hands
its token to your server, never to the phone, and the server renews it itself. If a backup stops,
because the repository went or GitHub stopped accepting the sign-in, Settings and the Desk say so
and how to fix it; Ito never falls back to the machine's own credentials. *Disconnect* forgets the
token and keeps the repository. A repository that already holds memory carries on: Ito
fast-forwards to what's there, and a new server with nothing in its Thread yet takes on the backup.

Or, without the app, point the Thread at any git remote, and Ito pushes after each change with this
machine's own git credentials:

```sh
node bin/ito.ts memory remote git@github.com:<you>/ito-thread.git
```

If pages change on the remote, say by merging a pull request there, Ito fast-forwards to them the
next time a push is turned away, or at once with `node bin/ito.ts memory pull`, and Ari takes the new
pages into its search the next time it uses memory. Either way it refuses, rather than merge, when
pages changed on both sides.

Connect iCloud, Outlook or Gmail in Ari's Settings › Capabilities, and Kumo, the agent working in
the background, reads every mail as it arrives: it puts bookings on your calendar, drafts replies in
your voice into your Drafts folder, and records what it did in Done, with an undo. It never sends a
mail: a list you can only leave by mail gets that mail drafted onto your Desk, for you to send.

Kumo has no fixed times and no rules about when to speak; it decides, from four simple building
blocks:

- **It messages you** in the conversation, one message per thing. Every message notifies your phone,
  and your Focus decides what makes a sound. Kumo marks a message urgent only when it can't wait,
  and then it's time-sensitive, to break through Focus.
- **It sets itself wake-ups:** a concrete time, what it's for and why, one-off or repeating (such as
  weekdays at 9), who asked for it, and where it came from. "After the interview" is when the
  interview ends, and Kumo moves a wake-up when life moves. Setting one is quiet: it shows in Kumo's
  plans on the Desk, where you can move or cancel it. When one comes due, Kumo looks first, then
  messages you, moves it or drops it, and Done says which.
- **It wakes on what happens:** a new mail, a change on your calendars, the mail you send. Kumo looks
  at each with the same memory pages and plans it has in the chat, and the end of your conversation,
  and decides; nothing is said by rule.
- **It acts and records:** cards on the Desk, blocks on its own calendar, memory, and every action in
  Kumo's work with an undo.

When Kumo's model can't act, nothing robotic goes out in its place: what was due waits, the Desk and
Settings show the problem, and Kumo catches up once its model answers.

With iCloud connected, Kumo keeps a picture of your day on its own calendar, never yours: soft
blocks for what keeps your goals going (the session from a training block, prep for a coming
interview, proper meals, winding down) and its guesses at the rest (working, building, seeing
people, chilling). It plans through its own wake-ups: when a day looks unplanned, it starts a
conversation to shape it with you, and puts what you agree on the calendar. Coming up shows the
blocks, guesses marked as guesses with why; tell Kumo one was wrong there, or in the chat, and its
next guesses learn from it. Kumo can also put a short line and its mood at the top of the Desk,
such as how something's going, and it changes them when the moment changes.

Ari tells the box its time zone and, if you allow it, roughly where you are; the box keeps only the
latest, rounded to about 10 km. Kumo lives by that time zone, so a weekday-morning wake-up comes at
9 wherever you are, and a new zone wakes Kumo to move what should follow you. With a place, the Desk
shows the weather there and today's sunset, read every half hour from
[Open-Meteo](https://open-meteo.com) (the box needs to reach `api.open-meteo.com`); without one,
there's no weather at all.

In the conversation, Ari reaches the same mail through `ito mail` commands and a skill file, rather
than more tools in every turn: ask it to go through the recruiters who wrote this month, and it
searches, reads each thread, and drafts the replies you agree to. Ask it to tidy your inbox, and it
goes through what's there a page at a time and moves mails together; a move of more than 25, such as
an old folder into one of yours, waits for one Apply on the Desk, and Done keeps it as one line with
an undo. Each mail step in the chat says what it did, such as "Binned “50% off”
from a shop", and opens onto the mails it read.

Your iCloud Contacts come with the same iCloud connection, over CardDAV, with nothing more to set
up. They're the source of truth for the facts about people (labelled emails and phones, addresses,
birthdays, work, related names), and Kumo keeps them current on its own from what it reads, such as
a new number in a signature or a birthday you mention. Each change is in Done with its reason and an
undo that puts the card back; merging or deleting cards always waits for one question on the Desk.
The story about a person stays on their People page in memory, linked to their card. Drafts find
people's addresses in Contacts by name, and a few days before the birthday of someone you're close
to, Kumo messages you about it at a good moment. In the conversation it's `ito contacts` commands
and a skill file.

Drafts go into Drafts as proper formatted mail: Kumo writes in light Markdown, and the draft is HTML
with a clean plain-text copy, photos you sent in the chat (or that Kumo found on the web) shown
inline, small files attached, and your own signature at the end, exactly as you send it. A reply
quotes the mail it answers below it ("On 3 Nov 2026, Clara Voss wrote:"), so the thread reads on in
any mail app. Kumo learns
each account's signature from your recent sent mail, and adds none if you don't use one. Sent mail
also tells it which addresses are yours and the name you send under: a reply comes from the address
the mail went to, aliases included, and a new mail from the one you last used with that person.
Replies keep everyone on the thread, To and Cc, unless you ask for the sender alone or it's plainly
a mail to a big list. The
Desk's draft card shows the formatted words, the signature and what's attached.

Kumo learns one area at a time, in the open. It opens a learning track for anything it's getting
to know you in or learning to do well, such as sorting your mail, writing as you or planning your
weekends. Each track has a stage (Learning, where it shows you its calls; Spot checks; Trusted, where
only what needs you reaches you) and the confirmations and corrections it stands on, and Kumo's work
shows them as bars. Kumo moves a track by judgement. "That was wrong" on anything in Kumo's work
undoes it where it can, keeps what to do differently on your How to help you page (the attention
pass reads the "Sorting mail" part as it sorts), and steps its track back. To be shown everything
again, tell Kumo.

Ari notifies you of every reply, failure, question and message from Kumo, at once and whatever the
hour; your phone's Focus decides what makes a sound. To switch notifications on, create
an APNs key in your Apple Developer account (Certificates, Identifiers & Profiles, then Keys, with
Apple Push Notifications service), download its `.p8` file once, and run:

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
loads each on the GPU, times Ari's first audio, and holds a call through the box, watching GPU
memory. It prints a report and keeps it in `~/.ito/voice-check.md`, with the details of any problem
in `~/.ito/voice-check-details.md`. Then start `ito serve` again. Ari offers Talk only once the
voice is ready, and otherwise says why. After your first few minutes of calls, the voice learns a
voiceprint of you, kept in `~/.ito/voice` and never sent anywhere, so people talking nearby don't
hold your turn open. If espeak-ng, which says names Kokoro doesn't know, won't load from its Python
package, install it with `sudo apt install espeak-ng`.

When something on the box needs you, the app says so until it's fixed: on the Desk, in a quiet
line per problem that opens how to fix it, and at the top of Settings. That's notifications that
can't be sent (a phone wants them, but there's no APNs key), a mail or calendar account that
refuses its sign-in or keeps failing for ten minutes (a reconnect never counts), a capability that
needs setting up, and Kumo's model not answering its work in the background for ten minutes. Each
clears on its own once it's fixed.

`ito serve` writes its log to `~/.ito/logs` as well as to the terminal, one file a day, kept for 14
days, so it's there however the server was started: in tmux, under systemd or launchd. The log
stays on the box, and it can hold mail subjects. To read it:

```sh
node bin/ito.ts logs                          # today, as readable lines
node bin/ito.ts logs --problems --since 7:00  # warnings and errors since 7 this morning
node bin/ito.ts logs --about mail --since 2h  # one area: mail, calendar, notifications, voice,
                                              # capabilities, memory, motion, kumo or requests
node bin/ito.ts logs --since 2026-10-31 --raw # the JSON lines themselves
```

Each readable line has the local time, the level, the message and its details. Requests to the
API only show with `--about requests`.

Ito keeps everything in `~/.ito` (set `ITO_HOME` to move it): the conversation in `ito.db`, Codex's
sign-in and sessions in `codex`, the agent's working directory in `workspace`, its memory in
`thread`, the embedding and voice models in `models`, each capability's own folder in
`capabilities`, and the log in `logs`.

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
