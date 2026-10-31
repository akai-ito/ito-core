---
name: things-in-motion
description: "Start and keep things in motion, such as a trip, a job search, a dinner or a refund: when to start one, each kind's shape, changing it by id, photos, and what the person sees."
---

# Things in motion

A thing in motion is something going on that you keep for the person while it lasts, such as a
trip being planned. Their phone pins it above the chat, lists it in In motion, and draws it as a
widget made for its kind. It holds the detail, so your replies stay short.

Its kind is one of: a `trip`, a `training` block, a `pursuit` (a job search, a flat hunt), an
`occasion` (a dinner, an appointment) or a `case` (the boiler, a refund).

## When to start one

Start one when a plan has several steps and will outlast this conversation, such as a weekend away,
or whenever they ask you to pin something. Check `<in_motion>` first: change the thing that exists
rather than starting another. Every title is short, 28 characters or fewer, since it's the pinned
line's name. "Pin this" and "unpin this" always work: set `pinned` with the
thing's own id.

## Changing one

- Read it with `read_motion`, then change it with `change_motion`, citing the version you read.
  Every answer gives the new version, so changes in one turn chain.
- Change one item at a time by its id: `set` fields (`null` removes one), `add` after an item or
  first, `move`, `remove`. All of a change applies, or none of it does.
- A list is named by its field, such as `todo` or `places`, or for a day's stops by the day's id.
- Every item's id is short, lowercase and dashed, and unique in the thing: `book-uffizi`, `sat`.
- Keep `summary` current with every change. It's the pinned line: when and what's left, such as
  "6–9 Nov · 3 to book".
- Give every change a note, as you'd tell them: "Booked the Uffizi, 8:15 Saturday". They see it in
  "What changed".
- When they tell you something that settles an item, such as "booked the Uffizi", change it there
  and then: tick its to-do, mark the booking, move the place to picked.
- Their own ticks and choices win over what you wrote, so don't undo them. Each is followed at once
  by a quiet question to you, outside the chat, to keep the thing up with it, and it reaches you
  again with their next message.
- `finish_motion` when it's over, such as when they're home. `restore_motion` undoes a change that
  was wrong. `forget_motion` asks them first, and is only for a thing that shouldn't exist.

## In your reply

After you start or change one, add a compact line, a fenced `ari:motion` block with the thing's
id and the version your change made: `{"motion": "florence-with-janki", "change": 2}`. Say in a
sentence what you did; the thing holds the rest.

## Trips

A trip is a day, a weekend or longer: its days with their stops, the places you found, travel,
where they're staying, and what's left to do.

**Make every trip properly, even a small or test one.** It has a cover, a photo for every place,
and every stop at its place: a station or an airport is a place too. Give it real detail: times,
why each place, hours, prices and locations. Its title is short, 28 characters or fewer, such as
"Florence with Janki"; anything more, such as "nothing's really booked", goes in the summary. A
trip without these is refused, with what's missing, so fix it and try again.

```json
{
  "destination": "Florence",
  "dates": { "start": "2026-11-06", "end": "2026-11-09" },
  "timezone": "Europe/Rome",
  "who": ["Janki"],
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

## Training

A training block towards a goal, such as a sub-20 5K: the goal, results so far, and every week's
sessions.

```json
{
  "goal": { "title": "Sub-20 5K", "target": "19:59", "by": "2026-11-30" },
  "weeks": [
    {
      "id": "week-1",
      "start": "2026-09-21",
      "focus": "Base",
      "note": "Easy miles to build on; nothing fast yet.",
      "sessions": [
        { "id": "w1-mon", "date": "2026-09-21", "kind": "easy", "title": "Easy run", "detail": "5 km, conversational", "done": true }
      ]
    },
    {
      "id": "week-6",
      "start": "2026-10-26",
      "focus": "Speed",
      "note": "Two hard days, so keep the easy runs easy.",
      "sessions": [
        { "id": "w6-wed", "date": "2026-10-28", "kind": "intervals", "title": "Intervals", "detail": "6 × 800 m at 3:50/km · 90 s jog · 2 km warm-up", "done": false }
      ]
    }
  ],
  "results": [{ "id": "parkrun-oct-24", "date": "2026-10-24", "result": "20:41", "note": "Windy" }]
}
```

- **The whole block, up front.** When you start it, write every week from the first to the last,
  each with its dated sessions, even weeks that have passed. The app counts weeks by their place in
  `weeks`, as in "Week 6 of 10". Change a week as the plan changes, but never drop one.
- **Sessions** are `easy`, `intervals`, `tempo`, `long`, `strength`, `race` or `rest`, with ids
  that are unique across the block, such as `w6-wed`. When they tell you how one went, tick it and
  keep their words in `how`.
- **Each week** has a line from you in `note`: what matters this week, updated as it goes.
- **Results** are timed efforts towards the goal, oldest first, such as a parkrun. Add one whenever
  they tell you a time.
- The summary says where the block is: "Week 6 of 10 · intervals today".

## Pursuits

One outcome, with several options moving through stages: a job search, a flat hunt, a raise, a
hire.

```json
{
  "after": "A senior AI role in London that ships to real users, by January.",
  "play": ["No firms that only want dashboards", "Never below £140k base", "One polite reply to recruiters, then silence"],
  "options": [
    {
      "id": "qrt",
      "name": "Senior AI Engineer",
      "org": "QRT",
      "stage": "Interviews",
      "people": [{ "name": "Poppy", "role": "recruiter", "page": "memory:people/poppy" }],
      "next": { "text": "Second round with the team lead", "at": "2026-11-04T14:00" },
      "waiting_on": { "who": "Poppy", "since": "2026-10-30" }
    }
  ]
}
```

- **What you're after** (`after`) and **How you play it** (`play`, one rule a line) come from
  what they say, in their words where you can. Follow the rules for them, and when something comes
  up the rules don't cover, ask, then add their answer as a rule.
- **Options** go best first. Each has its `stage` in a word or two, such as "Screened" or
  "Interviews", the people in it, its `next` step and when, and who it's `waiting_on` since when.
  Move the stage as it moves, and drop `waiting_on` once they answer.
- The summary says where it stands: "3 live · QRT second round Tue".

## Occasions

A dated event with people and prep: an appointment, a birthday, a dinner, a wedding.

```json
{
  "start": "2026-11-14T19:30",
  "end": "2026-11-14T22:30",
  "timezone": "Europe/London",
  "where": "Brat, Shoreditch",
  "people": [{ "name": "Poppy", "page": "memory:people/poppy" }],
  "prep": [{ "id": "book-table", "text": "Book a table for four", "done": false }],
  "check_in": true
}
```

- `start` and `end` are local to its time zone. A birthday is `all_day`.
- **Prep** is what to do before, oldest first, as to-dos they tick on their phone.
- Set `check_in` when you should ask how it went, such as after an interview or a first date, and
  schedule that look with `schedule` for after it ends.
- Finish it once it's past and nothing after it is left.

## Cases

A problem with back-and-forth until it's resolved: the boiler, a refund, a visa.

```json
{
  "problem": "The boiler loses pressure every few days.",
  "status": "Engineer booked for Tuesday",
  "waiting_on": { "who": "British Gas", "since": "2026-10-28" },
  "timeline": [{ "id": "first-call", "at": "2026-10-28", "text": "Called British Gas; they'll send an engineer." }],
  "next": { "text": "Engineer visit", "at": "2026-11-03T08:00" }
}
```

- `status` is where it stands now, in a line. Keep it true with every change.
- **The timeline** is the back-and-forth, oldest first: a dated entry for each call, mail or
  visit, as it happens.
- `waiting_on` says who it's waiting on and since when, so a stalled case shows; `next` is the next
  step.
- Finish it once it's resolved.

## Photos

Real photos, chosen well, used freely: this is what the person would do themselves.

- Find strong, beautiful pictures: a cover for the trip, and a photo for every place. Look at
  official and tourism-board photography, Wikimedia Commons, and the place's own site, and prefer
  quality over the first result.
- Keep each with `keep_image` and use the id it gives, with the page it came from as `source_url`
  and its credit as the source asks. The phone shows the credit when they tap the photo.
- Every place gets one: when its own pictures are poor, find the best real one you can; Commons
  almost always has one. Never generate a picture.
