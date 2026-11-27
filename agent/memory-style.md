---
name: memory-style
description: "How memory pages and the journal should read: second person on pages, first person in the journal, no disclaimers or process notes, dates only where they matter, summaries over raw data, and the format the server parses."
---

# How memory should read

You keep these pages about them, and they read them in Ito's Library; Portrait, Now and How to help
you are in your mind on every turn. Write what a sharp, warm friend would keep: plain, current,
short, specific, and true to what they said and did, with nothing invented. Whatever style the
pages have is the style you'll imitate later, so every page you write is the example to follow.

## Voice

- **Pages:** second person, talking to them ("You're…", "You want…"). British spelling.
- **Journal:** first person, as their own diary ("I…").

## Rules

1. **No disclaimers.** No "this doesn't establish…", "not evidence of…", "remains unconfirmed",
   "your account, not…". When an uncertainty matters for a decision later, say it once, briefly
   and naturally: "not confirmed yet", "you think", "my guess".
2. **No process notes.** Nothing about tools that failed, what you looked up, record or workout ids,
   coverage numbers, approvals, "no change made" or where a fact came from. One short pointer to
   where something lives is fine when it helps find it ("the receipt is in Mail › Receipts").
3. **Dates only where they matter.** Date events, deadlines and changes ("since 16 Nov", "on 7 Dec
   at noon"), in short forms like "27 Nov". Don't open paragraphs with "As of …".
4. **Spaces around numbers.** "As of 3 Nov", "PB 1:44:56", "bench, 40 kg", "milestone 1"; never
   glued ("As of3 Nov"). Real tokens stay as they are: 5K, 1:44, version numbers, URLs, ids, file
   names and `memory:`, `made:` or `motion:` links.
5. **Summaries, not raw data.** No nightly sleep lists or second-level timestamps. Keep the trend
   and what it means ("sleep's been short this week, under 6 h twice"), personal bests, goals, the
   current block, and anything they'd want remembered.
6. **Closed things condensed.** A finished role, trip or project becomes a short paragraph: what
   happened, how it ended and what's worth remembering. On a living page it goes under `## Earlier`.
7. **Research condensed.** Keep the findings and decisions that still matter (what they decided and
   why, the shortlist, facts they'd need again); drop superseded analysis. Around 600 words is
   plenty, unless it's genuine reference material.
8. **One page per subject.** When two pages repeat each other, merge them into the one that owns the
   subject, fix the links that pointed at the other, and forget it.
9. **`## Earlier`** keeps turning points only (decisions, outcomes, real changes), one dated line
   each, newest first; never rescheduling back and forth or proposals that were superseded.
10. **Gists** state the current state in one line, about 120 characters, with no disclaimers.
11. **Keep** facts worth remembering, their own words when meaningful (short quotes), preferences,
    people's context, links that still resolve, and every photo: never drop one.
12. **Facts, not readings.** Say what they said ("you said you felt better"); never your guess at
    their feelings, motives or relationships as fact.

## Example

Not this:

> As of 22 November 2026, you appear to be training for a 10K (this does not establish a race
> entry). Kumo checked the workout log (ids 8812, 8813): runs on 18 Nov 06:02:11 and 20 Nov
> 06:10:45.

But this:

> You're training for the Riverside 10K on 14 Dec, three runs a week before work. Your long run is
> up to 9 km (20 Nov), and you want to go under 50 minutes.

## The journal

- One entry per day, in the first person: the day's moments, what happened, people, places, food,
  training when it mattered, how they felt only when they said so, and their own words. Honest:
  nothing invented, no guessed feelings.
- No time headings: one flowing entry in short paragraphs. Admin (scheduling back and forth, filing
  mail) goes, unless it shaped the day; then one sentence.
- Photos stay where they belong in the story, with alt text in the first person ("My flat white on
  the walk back").
- Length follows the day: most entries 80 to 300 words.
- The gist is one line in the first person ("Long lunch with Mira; I finally booked Lisbon"). The
  title stays the date.

For example:

> Slow start, then a good long run along the river with Leo: 14 km, my longest since the summer. We
> stopped for pastries at the market and he talked me into the Lisbon trip.
>
> ![The river path at the turnaround](../media/3f9a1c2b4d5e6f70.jpg)
>
> Clara's mail came in the afternoon: the offer from Northwind, in writing. I read it twice and
> said I'd sleep on it.

**Length is a nudge, never a limit.** No page has a cap: when one runs long, move detail to a shelf
page or `## Earlier`. Never shorten words or squeeze out spaces to make something fit.

## Format (the server parses it)

- Front matter is YAML between the first two `---` lines, with `title` (required), `gist`,
  `aliases`, `links`, `circle`, `contact`, and on chapters `began`, `ended` and `noticed`
  (YYYY-MM-DD). Keep `contact` and chapter dates exactly as they are. The page tools write it for
  you from their fields.
- The body is Markdown with `##` headings.
