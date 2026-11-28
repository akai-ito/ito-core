# Running Ito

The operator's guide to an Ito server: installing it, reaching it from your phone, keeping it
running, and what each part needs. The [README](../README.md) has the overview and a five-minute
demo.

## Install and sign in

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
in it walks a trail of steps, *long* gives a reply to stop, *fail* a failure, *silent* a quiet turn
that works until you stop it, *ask* a question, *approve* an approval, *remember* writes a page in
memory and a note for tonight's journal, *recall* looks it up, *trip* and *training* start things
in motion, *motion* fills In motion with every kind (a role, a hybrid block, a project and a goal
that ended unmet), *booked* books the trip's Uffizi, *mail* reads a sample mail, puts a draft on the
Desk and messages you about it, and *plan* lays out a sample day of Kumo's plan and guesses in
Coming up.

## Check a turn from the machine

Before reaching for your phone, check a real turn from the machine itself, with the server running
and your token in `TOKEN`. The stream should show the turn start, statuses, the reply's text
arriving, and `turn.ended` with `completed`:

```sh
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v0/events &
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d "{\"id\":\"$(node -p 'crypto.randomUUID()')\",\"text\":\"List your workspace, then say hi.\"}" \
  http://127.0.0.1:8787/v0/messages
```

## Reach it from your phone

`tailscale serve --bg --https=8443 8787` then makes it reachable over your tailnet at
`https://<machine>.<tailnet>.ts.net:8443` (turn on HTTPS certificates in the Tailscale admin console
first). Port 8443 leaves 443 alone, so Ito never replaces another service this machine already
serves or funnels there. Add the server in Ari with that address and your token, or pair it with a
QR code instead: run `node bin/ito.ts pair` on the server and scan the code with Ari. The code works
once, for five minutes, and gives that device a token of its own; `ito token new` replaces every
token at once.

## Keep it running

To keep it running, install the systemd user unit from [deploy](../deploy/ito.service), which
expects the clone in `~/ito-core` and Node on the default path:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/ito.service ~/.config/systemd/user/
systemctl --user enable --now ito
loginctl enable-linger "$USER"   # keeps it running while you're logged out
journalctl --user -u ito -f      # its logs
```

## Update

To update, pull and restart; a reply being written at that moment ends as interrupted:

```sh
cd ~/ito-core && git pull && npm ci --omit=dev && systemctl --user restart ito
```

When Playwright's version changes, run `npx playwright install --with-deps chromium` too, before
the restart.

## The model and the agent's instructions

Ari runs on Codex's default model until you choose another, and how hard it thinks, in Ari's
Settings › Model; the choice applies from your next message.

The agent's instructions, Ari's voice and how it works, are in
[agent/instructions.md](../agent/instructions.md). Change them and restart: the next message picks
them up, in the same conversation.

## Full access

Kumo's commands run in Codex's `workspace-write` sandbox: it writes only in its workspace,
`~/.ito/workspace`, reads the rest of the machine and reaches the network. When you want it to fix
the server itself, such as installing what a capability needs, turn on full access in the app's
Settings, with Face ID. From Kumo's next turn, in the chat, in the background and in the night's
dream, its commands run with no sandbox at all: anything your user can do, Ito's own checkout
included, with no approval asked. Kumo is told so on every turn, and says what it's about to do
before it does it. A turn already running keeps the sandbox it started with.

The chat shows a marker while it's on, and Kumo's work notes each change. Turn it off in Settings
once you're done: the sandbox is back from the next turn. From the machine, the same switch is
`POST /v0/access/full` with `{"confirm": true}` and `DELETE /v0/access/full`.

## Capabilities and Reports

Capabilities, such as Reports, live in [capabilities](../capabilities) and start switched off;
switch them on and set them up in Ari's Settings › Capabilities. Each runs as its own process with
only its own setup values, and each is one definition written with the SDK in
[capabilities/sdk](../capabilities/sdk). Reports files the gaps Ari hits, such as a page it couldn't
load or a mistake you corrected, as public [issues labelled
`gap`](https://github.com/akai-ito/ito-core/issues?q=label%3Agap) on ito-core, never with anything
from your conversation. Tap *Connect GitHub* on its sheet and approve the code on GitHub: Ito's
GitHub app can only open and comment on issues in Ito's own repositories, and GitHub hands its token
to your server, never to the phone. Up to 20 reports a day are filed; any more go to Ito's log.

## Kumo's browser

The Browser capability is a Chromium on the server that Kumo uses for you, with takeover on the
phone for logins, codes, CAPTCHAs and payments. It needs Playwright's Chromium and, on Linux, Xvfb,
a virtual display, so Chromium runs headful, as a person's browser does: sites trust that more than
a headless one, so logins and CAPTCHAs behave as they do on a laptop.

```sh
sudo apt install xvfb                          # the virtual display
cd ~/ito-core && npm ci --omit=dev             # Playwright comes with Ito's packages
npx playwright install --with-deps chromium    # Chromium and the libraries it needs
systemctl --user restart ito
```

Switch it on in Ari's Settings › Capabilities. If it can't start, its row there says why and how to
fix it, such as a package missing because `npm ci` was skipped. The browser starts Xvfb itself on a
free display while Chromium runs, or uses `$DISPLAY` if one is set, such as under `xvfb-run`.
Without either it falls back to headless and says so in Ito's log (`journalctl --user -u ito`),
with the fix. On a Mac it runs headless unless `ITO_BROWSER=headful` is set, which opens a window
on the desktop; `ITO_BROWSER=headless` forces headless anywhere. The page always browses at your
phone's size: a takeover tells the server the room the page has on screen, and it's kept.

## Memory

Ari remembers you in the Thread, a git repository of Markdown pages in `~/.ito/thread` that you can
read without Ito: your portrait, what's going on now, how you like to be helped, pages on people,
goals, projects, places and topics, and a journal. Ari writes it as you talk, and finds things in it
and in past conversations with a small embedding model it downloads once and runs on the CPU.
Pages say what you told Kumo and what happened, never Kumo's reading of you, and when you correct
something, Kumo finds every copy, journal previews included. The journal is your own diary, in the
first person: during the day Kumo only keeps notes for it, and its nightly dream writes each day.
A photo you share in the chat can stay with the story: Kumo puts it where it belongs in the journal
or on a page, and the Thread keeps a copy in its `media` folder, scaled down to at most 2,000 pixels
on the long edge as JPEG, without its location or camera details, so it goes to the backup too.
Kumo also notices the chapters of your life, such as a trip or a training block, and keeps each as a
short story with its photos on `chapters/`, with when it began and ended. When a change teaches it
something about you, it says so in a line to you, kept with the change (in the Thread too, as a
`Learnt:` line in its commit); the Library shows the newest few, and tidying a page adds none.

### The nightly dream

Once a day, at the dream time (04:00 on your phone's clock until you change it in Ari's Settings),
Kumo dreams: a background run of up to an hour that looks back over everything since the last one,
every thread and the main chat, the wake-ups that ran, the mail you read or sent, your calendar, the
photos you shared (by the day each was taken) and its own notes from the day, and puts it in order.
It rewrites memory pages rather than adding to them, keeps Now to what's live and How to help you to
lasting preferences, reconciles tomorrow's blocks, guesses and wake-ups, writes each day's journal in
the first person (filling in earlier days with what you mentioned later), and folds lasting lessons
from your corrections into How to help you. It leaves a record on the Desk of what it planned,
tidied, noticed and saved for you; each change is in Kumo's work with an undo that puts it back as it
was before the dream. If the box was off at the dream time, it dreams as soon as it's back; if the
model couldn't, it tries again every half hour until the next one is due. *Dream now* runs an extra
one at once; the night's dream still runs, looking back only since. A dream never notifies; Kumo
messages you only when something from the night is worth it.

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

## Mail, calendar and contacts

Connect iCloud, Outlook or Gmail in Ari's Settings › Capabilities, and Kumo, the agent working in
the background, reads every mail as it arrives: it puts bookings on your calendar, drafts replies in
your voice into your Drafts folder, and records what it did in Done, with an undo. It never sends a
mail: a list you can only leave by mail gets that mail drafted onto your Desk, for you to send.

A turn in the chat is never cut off for being quiet: Kumo can show nothing for minutes, such as while
it writes a long document in one tool call, and the app says how long it has been working, next to
Stop. Stop always works, even when Codex has stopped answering: the box restarts it and ends the turn.
Work in the background, with nobody watching, gets a backstop instead: after 15 minutes without a sign
of life it's stopped and tried once more, and if that goes quiet too, the problem shows.

When your plan's usage limit is reached, Kumo's background work pauses until the limit resets, with
nothing retried meanwhile, and the app shows "Kumo's paused until 18:00" with the other problems.
Wake-ups that come due wait. At the reset, or as soon as a message in the chat goes through, Kumo
catches up once on what it missed and tells you in one message.

With iCloud connected, Kumo keeps a picture of your day on its own calendar, never yours: soft
blocks for what keeps your goals going (the session from a training block, prep for a coming
presentation, proper meals, winding down) and its guesses at the rest (working, building, seeing
people, chilling). It plans through its own wake-ups: when a day looks unplanned, it starts a
conversation to shape it with you, and puts what you agree on the calendar. Coming up shows the
blocks, guesses marked as guesses with why; tell Kumo one was wrong there, or in the chat, and its
next guesses learn from it. You can move or remove any of Kumo's blocks there too, never your own
events: Done keeps each change with an undo, removing a block in an area Kumo is learning counts as
a correction, and Kumo sees what you changed when it next looks at your day. Kumo can also put a
short line and its mood at the top of the Desk, such as how something's going, and it changes them
when the moment changes.

Replies show what has a shape: a menu as a table that fits a phone, with Kumo's verdict on each
dish as a chip, then its picks with pictures and the total; places, events, drafts and Desk
questions as cards with their buttons (a draft opens in Mail, never sends); names you can tap for
who someone is. A rich answer worth keeping, such as a gallery guide, becomes a page Kumo made: a
card in the reply and a place on the Made shelf, with sections that fold and things to tick. Kumo
keeps a page current and says what changed. Pages live in the box's database, not in memory: they
are things Kumo made for you, not what it knows about you.

In the conversation, Ari reaches the same mail through `ito mail` commands and a skill file, rather
than more tools in every turn: ask it to go through the club members who wrote this month, and it
searches, reads each thread, and drafts the replies you agree to. Ask it to tidy your inbox, and it
goes through what's there a page at a time and moves mails together; a move of more than 25, such as
an old folder into one of yours, waits for one Apply on the Desk, and Done keeps it as one line with
an undo. Each mail step in the chat says what it did, such as "Binned “50% off”
from a shop", and opens onto the mails it read.

Ari reads the files mails carry too, so a booking's seats or an invoice's total don't have to be
retyped: a mail lists its files, and Ari reads a PDF's words page by page (pages that are only a
scan or a code are drawn for it to look at), looks at pictures, and reads an invitation's times,
time zone, organiser, attendees, repeats, updates and cancellations. A file is data, never
instructions, and it's kept in Ari's private workspace, so it can go into a draft. Reading never
marks a mail read; Ari marks mail read, unread or flagged when you ask. It all runs inside Node,
with [pdf.js](https://mozilla.github.io/pdf.js/) for PDFs and `@napi-rs/canvas` (its own bundled
Skia) to draw pages, so the box needs no system packages for it. Mail you sent reads whole too,
including rich mail written as HTML alone, and a mail with no words says so, apart from one whose
words couldn't be read.

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

A draft is one thing, held together: changing its words keeps its recipients, its files, the mail it
answers with the thread's whole References chain, and its quote, exactly as first written, and two
drafts changed at once can't cross. Every save is read back from the server's Drafts and checked
against what was meant (recipients, words, thread, each file and its size) before Kumo says it's
ready; anything that didn't save is said plainly. A mail is only ever taken by its exact
Message-ID, never one a server's search finds that only resembles it. Each try at the mail server
has a time limit; reading is tried once more on a fresh connection, and a draft save that's cut
short is looked for before it's made again, so it's never saved twice and Kumo can say whether
anything changed. A draft's card leaves the Desk by itself once you send the draft, bin it, or delete
it in your mail app, and Done says so.

## How Kumo decides to act

Kumo has no fixed times and no rules about when to speak; it decides, from four simple building
blocks:

- **It messages you** in the conversation, one message per thing. Every message notifies your phone,
  and your Focus decides what makes a sound. Kumo marks a message urgent only when it can't wait,
  and then it's time-sensitive, to break through Focus.
- **It sets itself wake-ups:** a concrete time, what it's for and why, one-off or repeating (such as
  weekdays at 9, with an end when Kumo knows one: eight more times, or until a day), who asked for
  it, and where it came from. "After the dentist" is when the appointment ends, and Kumo moves a
  wake-up when life moves. Setting one is quiet: it shows in Kumo's plans on the Desk, where you can
  move it, skip a repeating one's next time, or stop it. When one comes due, Kumo looks first, then
  messages you, moves it or drops it, and Done says which.
- **It wakes on what happens:** a new mail, a change on your calendars, the mail you send. Kumo looks
  at each with the same memory pages and plans it has in the chat, and the end of your conversation,
  and decides; nothing is said by rule.
- **It acts and records:** cards on the Desk, blocks on its own calendar, memory, and every action in
  Kumo's work with an undo.

When Kumo's model can't act, nothing robotic goes out in its place: what was due waits, the Desk and
Settings show the problem, and Kumo catches up once its model answers.

Kumo learns one area at a time, in the open. It opens a learning track for anything it's getting
to know you in or learning to do well, such as sorting your mail, writing as you or planning your
weekends. Each track has a stage (Learning, where it shows you its calls; Spot checks; Trusted, where
only what needs you reaches you) and the confirmations and corrections it stands on, and Kumo's work
shows them as bars. Kumo moves a track by judgement. "That was wrong" on anything in Kumo's work
undoes it where it can, keeps what to do differently on your How to help you page (the attention
pass reads the "Sorting mail" part as it sorts), and steps its track back. To be shown everything
again, tell Kumo.

What Kumo would like you to explain, which only you can tell it, waits in **Understanding you**, a
quiet page that grows out of its tracks (tap Kumo on the Desk). Each question says what Kumo already
understands, the missing piece and why it would help, often with a few honest guesses to tap. Answer
with taps, your own words or your voice (heard on the box's GPU, as recordings are), or say none
fit, not sure or not now. Nothing there is due or overdue, and it never reaches Waiting on you or
notifies you. An answer is enough: it becomes evidence on its track, Kumo files what it learned in
memory in the background, and asks nothing more about it. If you explain something in the chat
instead, Kumo settles the question with a note on where, and the nightly dream can add and settle
questions too.

## Time zone, location and weather

Ari tells the box its time zone and, if you allow it, roughly where you are; the box keeps only the
latest, rounded to about 10 km. Kumo lives by that time zone, so a weekday-morning wake-up comes at
9 wherever you are, and a new zone wakes Kumo to move what should follow you. With a place, the Desk
shows the weather there and today's sunset, read every half hour from
[Open-Meteo](https://open-meteo.com) (the box needs to reach `api.open-meteo.com`); without one,
there's no weather at all.

## Places

Places are off until you turn them on in Ari, which needs location set to **Always** with **Precise**
on (otherwise they stay off rather than draw a trail full of gaps). While they're on, the phone
uploads in batches, whenever the box is reachable:

- **Visits:** iOS's "arrived here at 08:58" and later "left at 18:12", with Apple's name for the
  spot where the phone could find one. They're the backbone: places, arrive and leave times.
- **Live points:** GPS about every 10 seconds, only while you're moving (never in Low Power Mode or
  under 20% battery), and the significant-change pings iOS sends. They draw the way between.
- **Photo locations:** once, to seed the past: when and where each photo was taken, read from its
  metadata on the phone, never the photo itself. They're kept apart, marked as seeded, and never
  wake Kumo or make a question.

**What's kept, and where:** everything stays on your box, in `ito.db` (tables `location_points`,
`location_visits`, `location_photos`, `places`, and the per-day `location_days` and `location_heat`),
forever, until you forget it. Nothing goes to Apple or anyone else from the box; Kumo reads it only
through its own read-only tools (where you were, time at places, a day's route, your places) and the
night's dream, when it looks at a day or a place, so that's when it reaches the model. A point is
about 40 bytes: a year of the hybrid trail is tens of megabytes.

**Forgetting:** Ari forgets a day, a range of days or everything with `POST /v0/location/forget`.
A visit that touches the range goes whole, along with the places that have no visits left (and their
questions); the rest, home, the heat and trips, are worked out again from what's left. The box
keeps nothing else about those days, but the journal Kumo already wrote stays as it is: change it
in memory if it says too much.

**What the box works out:** visits within about 75 m gather into places, ranked by true hours. Home
is the place you slept at most at 03:00 over the last two months (a home you set wins). A day mostly
50 km or more from home is a day away, and two or more in a row make a trip, with the countries and
cities Apple named. Each day's hours are kept by geohash cell (7 characters, about 150 m; any coarser
cell is a prefix of it, so a week or a year is a cheap sum), home included, with a day away counted
as 14 hours. The map glows on `(1 − e^(−3h/full)) / (1 − e^(−3))`, full at 10 h for a week,
40 h for a month and 500 h for a year.

**Comings and goings:** arriving at a place and leaving it wake Kumo as a mail does, three minutes
after the moment settles and at most every 15 minutes. Leaving and coming back within 15 minutes,
stops under 10 minutes, points, photo seeds and visits that arrive an hour late never wake it. Kumo
mostly keeps a note for the dream; a place it can't name becomes a quiet question in Understanding
you, which names the place when you answer.

## Notifications

The steps to switch notifications on are in the
[README, under Notifications](../README.md#notifications), where the app's own fix-it line points.

## Voice

Ari's voice runs on the box's NVIDIA GPU, in a sidecar in [voice](../voice) that `ito serve` starts:
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

## When something needs you

When something on the box needs you, the app says so until it's fixed: on the Desk, in a quiet
line per problem that opens how to fix it, and at the top of Settings. That's notifications that
can't be sent (a phone wants them, but there's no APNs key), a mail or calendar account that
refuses its sign-in or keeps failing for ten minutes (a reconnect never counts), a capability that
needs setting up, Kumo's model not answering its work in the background for ten minutes, and Kumo
paused by your plan's usage limit (at once, saying until when). Each clears on its own once it's
fixed.

## Logs

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

## Recordings and files

A recording you send in the chat, such as an interview, is transcribed on your server by the same
voice: ffmpeg reads any format your phone records in, Parakeet hears it in pieces, steered toward the
names in memory, and TitaNet voiceprints tell the speakers apart, finding you by the voiceprint your
calls taught it. No other model is downloaded for it, and nothing leaves the box. The app shows how
far along it is, and once it's ready Kumo reads it and brings you what it heard (a debrief, for an
interview) with the actions and memory updates it suggests, for you to choose. It hears English, and
telling voices apart is a best guess: voices that overlap, or that sound alike, can be mixed up. You
can correct a misheard name and delete a recording with its transcript. It needs ffmpeg on the box
(`sudo apt install ffmpeg`); `ito voice check` times a two-person recording through it.

When Kumo makes or changes a file for you, such as a PDF, it shows it in the chat at one version,
so what you say about it is about that version. Every version stays on the server exactly as made,
until you delete the file, and a mail draft can attach exactly the version you looked at.

Photos and files you attach in the chat stay on your server and never go into the Thread, unless
Kumo keeps a photo with a story. Up to 20 MB goes in one request; anything bigger, such as an hour's
recording, goes up in chunks that carry on after a dropped connection: recordings up to 1 GB,
documents such as PDFs up to 100 MB and photos up to 50 MB. To change the first two, set
`ITO_MAX_RECORDING_MB` or `ITO_MAX_FILE_MB` for the server, such as
`Environment=ITO_MAX_RECORDING_MB=2048` in its systemd unit. An upload nothing reaches for two days
is deleted, and so is a finished one no message names after a day.

## Where Ito keeps its data

Ito keeps everything in `~/.ito` (set `ITO_HOME` to move it): the conversation in `ito.db`, Codex's
sign-in and sessions in `codex`, the agent's working directory in `workspace`, its memory in
`thread`, where you've been while places are on (in `ito.db`, until you forget it), what you attach
in `attachments` (and big uploads on their way in `uploads`), the
embedding and voice models in `models`, each capability's own folder in `capabilities`, and the log
in `logs`.
