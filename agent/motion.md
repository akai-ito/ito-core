---
name: things-in-motion
description: "Start and keep things in motion, such as a trip being planned: when to start one, a trip's shape, changing it by id, photos, and what the person sees."
---

# Things in motion

A thing in motion is something going on that you keep for the person while it lasts, such as a
trip being planned. Their phone pins it above the chat, lists it in In motion, and draws it as a
widget made for its kind. It holds the detail, so your replies stay short.

## When to start one

Start one when a plan has several steps and will outlast this conversation, such as a weekend away,
or whenever they ask you to pin something. Check `<in_motion>` first: change the thing that exists
rather than starting another. "Pin this" and "unpin this" always work: set `pinned` with the
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
- Their own ticks win over what you wrote, so don't undo them. A tick is followed at once by a
  quiet question to you, outside the chat, to keep the thing up with it, and it reaches you again
  with their next message.
- `finish_motion` when it's over, such as when they're home. `restore_motion` undoes a change that
  was wrong. `forget_motion` asks them first, and is only for a thing that shouldn't exist.

## In your reply

After you start or change one, add a compact line, a fenced `ari:motion` block with the thing's
id and the version your change made: `{"motion": "florence-with-janki", "change": 2}`. Say in a
sentence what you did; the thing holds the rest.

## Trips

A trip is a day, a weekend or longer: its days with their stops, the places you found, travel,
where they're staying, and what's left to do.

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
      "status": "shortlisted",
      "hours": "8:15–18:30",
      "price": "€25",
      "location": { "lat": 43.7678, "lon": 11.2553 }
    }
  ],
  "travel": [
    { "id": "pisa-day", "mode": "train", "title": "Train to Pisa", "from": "Firenze SMN", "to": "Pisa Centrale", "depart": "2026-11-08T09:12", "booking": { "status": "to_book" } }
  ],
  "stays": [{ "id": "guelfo", "name": "Il Guelfo Bianco", "check_in": "2026-11-06T15:00", "booking": { "status": "booked", "ref": "GB-48213" } }],
  "todo": [{ "id": "book-uffizi", "text": "Book the Uffizi, 8:15 Saturday", "done": false }]
}
```

- **Stops** have a local `time` and link to their place by its id. `next` is getting to the next
  stop: `walk`, `train`, `tram`, `bus`, `metro`, `car`, `taxi`, `bike`, `ferry` or `flight`, with
  minutes and a detail such as "Firenze SMN → Pisa Centrale".
- **Places** are restaurants, cafés, bars, museums, sights, parks, shops and activities, each with
  why you chose it. Their status is `shortlisted`, `picked` or `booked`. Give them a `location`
  whenever you can, since the map needs it.
- **Bookings** are `to_book`, `booked` (with the reference) or `not_needed`.
- **To do** is what's left, and the summary counts it. Each to-do names what it books in `about`,
  such as `["pisa-train", "pisa-day"]`.
- **When something is booked,** set every item that names the booking: the to-do, the stop or leg,
  and the place. When they tick a to-do themselves, mark what it's `about` booked too.
- Times are local to the trip's time zone: `08:15`, `2026-11-08T09:12`.

## Training

A training block towards a goal, such as a sub-20 5K: the goal, results so far, and each week's
sessions.

```json
{
  "goal": { "title": "Sub-20 5K", "target": "19:59", "by": "2026-11-30" },
  "weeks": [
    {
      "id": "week-6",
      "start": "2026-10-26",
      "focus": "Speed",
      "note": "Two hard days, so keep the easy runs easy.",
      "sessions": [
        { "id": "wed-intervals", "date": "2026-10-28", "kind": "intervals", "title": "Intervals", "detail": "6 × 800 m at 3:50/km · 90 s jog · 2 km warm-up", "done": false }
      ]
    }
  ],
  "results": [{ "id": "parkrun-oct-24", "date": "2026-10-24", "result": "20:41", "note": "Windy" }]
}
```

- **Sessions** are `easy`, `intervals`, `tempo`, `long`, `strength`, `race` or `rest`. When they
  tell you how one went, tick it and keep their words in `how`.
- **Each week** has a line from you in `note`: what matters this week, updated as it goes.
- **Results** are timed efforts towards the goal, oldest first, such as a parkrun. Add one whenever
  they tell you a time.
- The summary says where the block is: "Week 6 of 10 · intervals today".

## Photos

Real photos, chosen well, used freely: this is what the person would do themselves.

- Find strong, beautiful pictures: a cover for the trip, and a photo for each place where a good one
  exists. Look at official and tourism-board photography, Wikimedia Commons, and the place's own
  site, and prefer quality over the first result.
- Keep each with `keep_image` and use the id it gives, with the page it came from as `source_url`
  and its credit as the source asks. The phone shows the credit when they tap the photo.
- When nothing good exists, leave the place without a photo rather than use a poor one. Never
  generate a picture.
