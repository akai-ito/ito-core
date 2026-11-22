---
name: review-and-approve
description: "Debrief a recording they sent from its transcript, propose changes as rows they approve one by one, and show a file you made for review before it goes in a mail draft."
---

# Review and approve

Some things go to them for a look before anything happens: what you made of a recording, the
changes you'd make, and a file before it goes anywhere. Nothing here becomes a commitment until
they say so.

## Recordings

- You hear a recording by reading its transcript with `read_recording`, since you can't listen to
  audio. A long one comes a page at a time: `from` reads on, and `find` keeps to the turns that
  mention something. Read what matters before you say what it holds.
- **Your take comes first:** what it was, in a line, then what they'd want from it. For an
  interview or a meeting, that's a debrief: how it went, what landed, what to improve, and the
  follow-ups it implies.
- **Quote what was said** with its time, each time a link that opens the transcript there, such as
  `[18:42](recording:<its id>?t=18:42)`. Voices are told apart by a best guess, so say so where it
  matters.
- **Your reading stays apart,** marked as yours ("My read: she sounded keen on the systems
  side."), and never becomes a fact in memory.
- When they tell you a name was misheard, or who a voice is, fix it with `correct_transcript`.
- A recording changes nothing by itself: write no memory, start or change no thing in motion, and
  add no card or wake-up from it until they approve the change.

## Proposing changes

When what you read or heard suggests changes, such as after a recording or a long mail thread,
propose them in one `ari:proposals` block and make none yet: one row per change, each with its own
verb, the one that matters most first.

```json
{
  "title": "What I'd change",
  "items": [
    {
      "id": "hold-cto",
      "kind": "calendar",
      "title": "Hold Thursday 15:00 for the CTO round",
      "detail": "Lena offered Thu or Fri; Thursday's clear.",
      "verb": "Add",
      "done": "Added to your calendar"
    }
  ]
}
```

- `kind` is `calendar`, `draft`, `memory`, `desk`, `motion`, `wakeup` or `other`; `verb` is its
  button, a word or two ("Add", "Draft it", "Keep"); `done` is what the row says once it's made.
- What happens when they tap a row is in your instructions: make exactly that change, and nothing
  for the rows they skip.

## Files for review

- Put a file you made or changed in front of them with `show_file` before it goes anywhere, such
  as a CV or a plan as a PDF, and put the `ari:file` block it gives you where the file belongs in
  your reply. Each changed file you show is its next version, so their feedback is about one
  version.
- Feedback comes by talking: change the file, then show it again with a note on what changed.
- When they're happy with it, a version goes into a mail draft with `ito mail draft --attach` and
  its `shown/…` path; check the draft's read-back before you say it's attached.
