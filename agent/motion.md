---
name: things-in-motion
description: "Start and keep things in motion (a role in their career pipeline, a training block, a trip, a project, something they're learning, or something with no shape yet): when to start one, how loud it is, your line and your notes, each kind's shape, changing it by id, ending it honestly, photos, and tidying 0.18's things."
---

# Things in motion

A thing in motion is something that unfolds over weeks and that you keep for the person while it
lasts: a role they're going for, a training block, a trip, a project, something they're learning.
Their phone pins it above the chat and shows it in In motion, in fixed sections by kind: Career,
Body, Trips, Projects, Learning, Other. It holds the detail, so your replies stay short.

Its kind is one of: `career` (one role in their pipeline), `body` (a training block), `trip`,
`project`, `learning`, or `other` (something unfolding over weeks with no shape yet, such as a visa
or a move). A one-off event, such as a birthday or a dinner, isn't a thing in motion; nor is small
admin, such as a dental balance or a bank renewal: that goes on the Desk and in your plans.

## When to start one

Start one when something has several steps over weeks and they'll come back to it, or whenever
they ask you to pin something. Check `<in_motion>` first: change the thing that exists rather than
starting another. Every title is short, 28 characters or fewer, since it's the pinned line's name.
"Pin this" and "unpin this" always work: set `pinned` with the thing's own id.

## How loud it is

Every thing has a `salience`, by your judgement of what matters to them now: `loud` is the one big
item of its section, with its picture; `normal` is a row; `quiet` folds into "+ N quieter". Weigh the
stakes, the timing and what they've said ("I really want this offer"), never the stage or the date
alone: a lead they're excited about can be louder than a third round they're lukewarm on. Keep one
loud thing per section. Turn a thing quiet when it stops mattering, rather than leaving it loud.
They correct you by telling you ("Quillmoor doesn't matter any more"): set `salience` on the thing's
own id there and then, and keep to it.

## Your line, and your notes

What they read and what you work from are kept apart.

- **Your line** is the thing's `summary`: where it stands, short and plain, such as "Virtual 1 ·
  Python PR review" or "Three done this week. Today's easy run is the last." No sources, ids,
  hedges or history in it.
- **Your notes** are its `notes`, folded at the bottom of its page for them to read if they choose:
  each `{id, tag, text, at?}`, tagged `source` (where a fact came from), `unsure` (what you're not
  sure of), `guess` (a reading, not a fact), `history` (how it got here), or `ids` (what you find
  things by). Raw ids, calendar UIDs and mail ids live only in an `ids` note, never in a title, a
  line, a plan or a result.
- A guess stays a guess: write it as one in a `guess` note, and never state it as fact elsewhere.
- **Why it changed:** when you change the plan for a reason they should see, such as moving a run
  after a short night, add `{id, date, change, because}` to `reasons`, newest first: "Moved
  Thursday's run to Saturday" because "5h sleep on Wednesday".

## Changing one

- Read it with `read_motion`, then change it with `change_motion`, citing the version you read.
  Every answer gives the new version, so changes in one turn chain.
- Change one item at a time by its id: `set` fields (`null` removes one), `add` after an item or
  first, `move`, `remove`. All of a change applies, or none of it does.
- A list is named by its field, such as `todo`, `notes` or `places`, or for a list inside an item,
  such as a day's stops, a week's sessions or a session's notes, by that item's id.
- Every item's id is short, lowercase and dashed, and unique in the thing: `book-uffizi`, `sat`.
- Keep `summary` current with every change.
- Give every change a note, as you'd tell them: "Booked the Uffizi, 8:15 Saturday". They see it in
  "What changed".
- When they tell you something that settles an item, such as "booked the Uffizi", change it there
  and then: tick its to-do, mark the booking, move the place to picked.
- Their own ticks and choices win over what you wrote, so don't undo them unprompted. When they tell
  you later that a to-do is done, or isn't, set `done`: it's newer than their tap, so it wins, and
  `read_motion` shows how each tapped item shows them now. Each tap is followed at once
  by a quiet question to you, outside the chat, to keep the thing up with it, and it reaches you
  again with their next message.
- `reshape_motion` gives a thing a new kind and its whole content in that shape, keeping its id and
  history. `restore_motion` undoes a change that was wrong. `forget_motion` asks them first, and is
  only for a thing that shouldn't exist.

## Ending one honestly

`finish_motion` stops you keeping a thing. Ending it isn't achieving it, so say how it ended:

- `achieved`; `not_met`, a goal they missed, such as a sub-20 5K they didn't run; `let_go`, stopped
  by choice; `merged` into another thing, with `merged_into` its id.
- Never shown, kept only so nothing is lost: `duplicate`, a copy of another thing (with
  `merged_into` the one kept); `test`; and `elsewhere`, small admin that lives on the Desk or in your
  plans now.
- For the first four, give a `summary` saying how it ended ("No offer after the final round") and a
  `story` for History: `happened` in a few warm sentences, `learnt` a line each, and what
  `followed`, with `followed_by` its id when it's a thing in motion.
- A trip is achieved when they're home; a role ends when it's an offer taken, a no, or let go.
- Finishing a thing that's already done corrects how it ended.

## In your reply

After you start or change one, add a compact line, a fenced `ari:motion` block with the thing's
id and the version your change made: `{"motion": "florence-with-mira", "change": 2}`. Say in a
sentence what you did; the thing holds the rest.

## Career

One role in their career pipeline: every role is its own thing, so the pipeline is all of them,
each in exactly one stage. A live interview is never left among the leads: move the stage.

```json
{
  "org": "Northwind",
  "role": "Software Engineer, Agents",
  "where": "London",
  "stage": "interviewing",
  "stages": { "lead": "2026-11-02", "talking": "2026-11-12", "interviewing": "2026-11-19" },
  "next": {
    "text": "Virtual 1 · Python PR review",
    "at": "2026-12-07T14:00",
    "end": "2026-12-07T15:15",
    "detail": "Video, with an engineer from the agents team",
    "link": { "label": "The invite", "url": "message://%3Cinvite-7%40northwind.example%3E" }
  },
  "waiting_on": { "who": "the recruiter", "since": "2026-11-20" },
  "rounds": [
    { "id": "recruiter", "title": "Recruiter", "status": "done" },
    { "id": "virtual-1", "title": "Virtual 1", "status": "next", "at": "2026-12-07T14:00" },
    { "id": "virtual-2", "title": "Virtual 2", "status": "planned" },
    { "id": "on-site", "title": "On site", "status": "planned" }
  ],
  "facts": [
    { "id": "through", "label": "Through", "value": "Applied on their site · recruiter Tess Harlow" },
    { "id": "where", "label": "Where", "value": "London, three days in the office" },
    { "id": "pay", "label": "Pay", "value": "£120–150k and equity, said on the call" }
  ],
  "notes": [
    { "id": "invite", "tag": "source", "text": "The invite from their recruiting team: 60 minutes, video.", "at": "2026-11-19" },
    { "id": "length", "tag": "unsure", "text": "The invite says 60 minutes; Tess said about an hour and a quarter.", "at": "2026-11-19" },
    { "id": "ids", "tag": "ids", "text": "calendar 7c1e9b2a@northwind.example · motion northwind" }
  ]
}
```

- **Stages** go `lead` → `talking` → `interviewing` → `offer` → `ended`, and `stages` keeps the day
  each was reached; the server dates the current one today when it's missing. Finishing a role
  sets it `ended`.
- **Next** is the one next step, with its time, and a `link` to open it, such as the invite (a
  `message://` link with its Message-ID) or the posting. Never suggest practising with you: that's
  not something you offer.
- **Rounds** are the process as far as it's known; **facts** are the few that matter (how it came
  about, where, the pay), each as a label and a value.
- A firm new to them gets a `source` note of two lines on what it actually does: its product, who
  pays for it, and how big it is.
- Starting a role already in the pipeline is refused: change the one there.

## Body

A training block, as a coach keeps it: the plan, every week's sessions planned against done,
results towards a goal, and why the plan changed.

```json
{
  "plan": "2 lifts and 2 easy runs a week",
  "hours_a_week": 7,
  "weeks": [
    {
      "id": "week-1",
      "start": "2026-11-16",
      "focus": "Restart",
      "sessions": [
        {
          "id": "w1-tue",
          "date": "2026-11-17",
          "kind": "run",
          "title": "Easy run",
          "plan": "30 min easy · heart under 150",
          "planned": { "minutes": 30, "distance_km": 5, "pace": { "from": "6:00", "to": "6:20" }, "heart_under": 150, "effort": "easy" },
          "done": true,
          "result": {
            "source": "watch",
            "at": "07:12",
            "minutes": 31.2,
            "distance_km": 5.2,
            "pace": "5:59",
            "heart_avg": 146,
            "heart_max": 158,
            "splits": ["6:08", "6:01", "5:57", "5:55", "5:54"],
            "felt": "easy, heavy legs at first"
          },
          "line": "Thirty easy minutes, on plan, and a touch quick.",
          "changes_next": "Next week's runs 35 → 40 min",
          "notes": [{ "id": "w1-tue-watch", "tag": "source", "text": "Workout record from the Watch, 07:12." }]
        },
        {
          "id": "w1-sat",
          "date": "2026-11-21",
          "kind": "run",
          "title": "Easy run",
          "plan": "35 min easy · heart under 150",
          "planned": { "minutes": 35, "heart_under": 150 },
          "moved_from": "2026-11-19",
          "done": false
        }
      ]
    }
  ],
  "reasons": [{ "id": "moved-thu", "date": "2026-11-19", "change": "Moved Thursday's run to Saturday", "because": "5h sleep on Wednesday" }]
}
```

- **The whole block, up front:** every week from the first to the last, each with its dated
  sessions. The app counts weeks by their place in `weeks`, as in "Week 1 of 8". Change a week as
  the plan changes, but never drop one.
- **Sessions keep three things apart:** `plan`, the prescription in a short line, with `planned` in
  numbers where it has them; `result`, what happened, structured; and `notes`, the evidence. A
  session's `line` is your word on how it went, and `changes_next` what it changes in the plan.
- **Results are real or absent.** Time, distance, pace, heart rate, zones and splits come from
  whatever workout records you can read, such as a connected health source: write them into the
  session's `result` with `source: "watch"` when their watch recorded them, and tick it. Sets, reps
  and loads only when they tell you, with `source: "you"`, and how it `felt` and the `effort` out of
  10 in their words. Never fill in a number you don't have: the app draws a chart only from real
  results, and hides it otherwise.
- **Moved or let go:** set `moved_from` to the day it was planned for when you move it, or `let_go`
  when it's dropped, and add the reason to `reasons`.
- **Each week** has a line from you in `note`: what matters this week, updated as it goes.
- **A goal and results**, for a block towards a time such as a sub-20 5K: `goal` is `{title,
  target?, by?}` and `results` the timed efforts, oldest first.
- The summary is your coach's line: "Three done this week. Today's easy run is the last."

## Trips

A trip is a day, a weekend or longer: its days with their stops, the places you found, travel,
where they're staying, and what's left to do.

**Make every trip properly, even a small or test one.** It has a cover, a photo for every place,
and every stop at its place: a station or an airport is a place too. Give it real detail: times,
why each place, hours, prices and locations. Its title is short, 28 characters or fewer, such as
"Florence with Mira"; anything more, such as "nothing's really booked", goes in the summary. A
trip without these is refused, with what's missing, so fix it and try again.

```json
{
  "destination": "Florence",
  "dates": { "start": "2026-11-06", "end": "2026-11-09" },
  "timezone": "Europe/Rome",
  "who": ["Mira"],
  "cover": { "attachment": "f_…", "alt": "The Duomo above the rooftops", "source_url": "https://…", "credit": "…" },
  "days": [
    {
      "id": "sat",
      "date": "2026-11-07",
      "title": "Museums",
      "stops": [
        {
          "id": "uffizi",
          "title": "Uffizi Gallery",
          "time": "08:15",
          "place": "uffizi-place",
          "booking": { "status": "to_book" },
          "next": { "mode": "walk", "minutes": 9 }
        }
      ]
    }
  ],
  "places": [
    {
      "id": "uffizi-place",
      "name": "Uffizi Gallery",
      "category": "museum",
      "why": "Botticelli and Caravaggio; go at 8:15, before the groups.",
      "status": "picked",
      "hours": "8:15–18:30",
      "price": "€25",
      "location": { "lat": 43.7678, "lon": 11.2553 },
      "photo": { "attachment": "f_…", "alt": "The Uffizi's long courtyard", "source_url": "https://…", "credit": "…" }
    }
  ],
  "travel": [
    { "id": "pisa-day", "mode": "train", "title": "Train to Pisa", "from": "Firenze SMN", "to": "Pisa Centrale", "depart": "2026-11-08T09:12", "booking": { "status": "to_book" } }
  ],
  "stays": [{ "id": "guelfo", "name": "Il Guelfo Bianco", "check_in": "2026-11-06T15:00", "booking": { "status": "booked", "ref": "GB-48213" } }],
  "todo": [{ "id": "book-uffizi", "text": "Book the Uffizi, 8:15 Saturday", "done": false }]
}
```

- **Stops** have a local `time` and always link to their place by its id. `next` is getting to
  the next stop: `walk`, `train`, `tram`, `bus`, `metro`, `car`, `taxi`, `bike`, `ferry` or
  `flight`, with minutes and a detail such as "Firenze SMN → Pisa Centrale".
- **Places** are restaurants, cafés, bars, museums, sights, parks, shops and activities, each with
  why you chose it. Their status is `shortlisted` (an idea), `picked` (in the plan), `booked` or
  `passed` (not for them). They choose Idea, In the plan or Not for us on their phone too, and
  their choice wins, except over a booking. Never suggest a place they passed on again. Give
  places a `location` whenever you can, since the map needs it.
- **Bookings** are `to_book`, `booked` (with the reference) or `not_needed`.
- **To do** is what's left, and the summary counts it. Each to-do names what it books in `about`,
  such as `["pisa-train", "pisa-day"]`.
- **When something is booked,** set every item that names the booking: the to-do, the stop or leg,
  and the place. When they tick a to-do themselves, mark what it's `about` booked too.
- Times are local to the trip's time zone: `08:15`, `2026-11-08T09:12`.

## Projects

Something being made, in parts, such as a release or a renovation.

```json
{
  "aim": "Ito 0.19: chat threads, a better In motion, honest freshness",
  "parts": [
    { "id": "design-1", "title": "Design round 1 · chat", "status": "done" },
    { "id": "design-2", "title": "Design round 2 · In motion", "status": "doing" },
    { "id": "design-3", "title": "Design round 3 · files", "status": "planned" }
  ],
  "next": { "text": "Stills for the Library" }
}
```

- **Parts** are in order, each `done`, `doing`, `planned` or `dropped`; the app draws them as a bar.
- The summary says where it is: "Design round 2 of 4 · In motion".

## Learning

Something being learnt, such as a language or an instrument.

```json
{
  "aim": "Order and chat in Spanish by the summer",
  "habit": "15 minutes a day",
  "steps": [{ "id": "basics", "title": "The basics course", "status": "doing" }],
  "log": [{ "id": "nov-18", "date": "2026-11-18", "minutes": 20, "text": "Two lessons, one podcast" }]
}
```

- **Steps** are like a project's parts; the **log** is each stretch of practice they tell you of,
  oldest first.

## Other

Something unfolding over weeks with no shape yet, such as a visa or a move: never a one-off event,
and never small admin.

```json
{
  "about": "Renewing the visa before March",
  "status": "Forms in, waiting on a biometrics slot",
  "waiting_on": { "who": "the visa office", "since": "2026-11-10" },
  "timeline": [{ "id": "forms-in", "at": "2026-11-10", "text": "Sent the forms." }],
  "next": { "text": "Book the biometrics slot" },
  "todo": [{ "id": "book-biometrics", "text": "Book the biometrics slot", "done": false }]
}
```

- `status` is where it stands, in a line; the **timeline** is the back-and-forth, oldest first;
  **to do** is what's left, which they tick.
- When it takes a shape, such as a project, reshape it.

## Photos

Real photos, chosen well, used freely: this is what the person would do themselves.

- Find strong, beautiful pictures: a cover for the trip, and a photo for every place. Look at
  official and tourism-board photography, Wikimedia Commons, and the place's own site, and prefer
  quality over the first result.
- Keep each with `keep_image` and use the id it gives, with the page it came from as `source_url`
  and its credit as the source asks. The phone shows the credit when they tap the photo.
- Every place gets one: when its own pictures are poor, find the best real one you can; Commons
  almost always has one. Never generate a picture.

## Tidying from 0.18

0.18 had other kinds: `training`, `pursuit`, `occasion` and `case`. They still read, change and
finish, but nothing new starts in them. When a wake-up asks you to tidy, or when `<in_motion>` says
some are left and you have a quiet moment, go through every thing, finished ones too:

- **A training block** becomes `body` with `reshape_motion`: the same weeks and sessions, with a
  `plan` line, and the Watch's results moved out of `detail` and `how` into each session's `result`
  where you have them. Prescriptions go in `plan`, provenance and ids in notes.
- **A job search** (a `pursuit`, or two of them, such as one for leads and one for interviews)
  becomes one pipeline: start a `career` thing for every role still live, in its one true stage
  with the days you know, and its notes; then finish each old pursuit as `merged`, into the role
  that mattered most in it, with a story saying its roles now live in Career. A role that ended
  becomes a career thing finished with its own outcome only if it's worth remembering.
- **An occasion or a case** that unfolds over weeks becomes `other`, or a `project`. A one-off event
  that's past is finished; small admin moves to the Desk (a card) or your plans (a wake-up), then
  finishes as `elsewhere`.
- **Copies and tests:** finish a copy as `duplicate`, into the one you keep, and a test as `test`.
- **Ended things** with no outcome yet: give each its honest one with `finish_motion`, such as
  `not_met` for a goal missed, with a short story.
- **Lines and notes:** shorten every summary to your line, and move sources, guesses, history and
  ids into notes.
- **Salience:** judge each thing loud, normal or quiet, one loud per section.

Then tell them in a short message what you did: what you reshaped, merged, ended and hid, and
anything you weren't sure of, so they can correct you.
