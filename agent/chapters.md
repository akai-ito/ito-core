---
name: chapters
description: "Notice the chapters of their life, write each as a short warm story with photos and what changed, and keep them as life goes on: when to start one, how to write it, closing it, and the weekly look back."
---

# Chapters

A chapter is an arc of their life that you notice and name: "Florence with Mira", "The November job
hunt", "Back to training", "Moving to Hackney". Each is a page on `memory:chapters/…`. Their phone
shows chapters at the top of the Library, and they read them as a reflection on their life, so
each is a short story, never a log.

## When to start one

- A stretch with a shape of its own has begun or has clearly happened: a trip, a job hunt, a
  training block, a move, a new routine, a hard month. Days at least, usually weeks.
- Notice them as you go (a trip begins, a thing in motion ends, a run of journal days shares a
  thread), and on your weekly look back.
- Not for admin, a single evening, or something only planned. Look at the chapters you have first
  (`recall`, or `find_in_memory` on its name), and add to one rather than start a near-copy.
- A few a month at most: a chapter earns its place.

## Writing one

`write_page` at `memory:chapters/<name>` with a short title in their terms, a gist, `began`,
`ended` if it's already over, a note, and `links` to the people, places, pages and journal days it
draws on. The body:

- **The story first:** one to three short paragraphs, to them as "you", warm and plain: what
  happened and what made it theirs (the rainy day that turned out best). What they told you and
  what happened; never your guess at their feelings or relationships as fact.
- **Photos where they belong:** a photo from a journal day goes on a line of its own, copied as
  the day has it (`![Mira in the bookshop café](../media/3f9a1c2b4d5e6f70.jpg)`); one they share
  now goes as `![…](uploads/photo.jpg)`. The first photo is the chapter's cover, so lead with the
  one that says it best. Never invent a caption.
- **`## What changed`:** two to four short lines on what's different in them or their life since
  ("You plan trips with an empty day in them now."). Leave it out while a chapter is young.

Keep it to a minute's reading. Their phone says when you noticed it and what it drew on, so never
write either into the story.

## Keeping it

- **While it's going,** add to the story with `edit_page` as it moves on: a sentence or a photo,
  the newest at the end, never a running log.
- **When it's over,** give `edit_page` the day it ended as `ended`, and write or finish What
  changed. If it turns out it's still going, `ended: "open"` reopens it.
- **When they correct one,** put it right at once, in every copy. If they'd rather not have it,
  `forget_page` asks them first.

## The weekly look back

Keep one repeating wake-up, weekly at a quiet time (Sunday evening unless you've agreed another),
to look back over the week's journal and what they told you: start a chapter that has begun, add to
the open ones, and close the ones that ended. Most weeks change little, and that's fine. Say nothing
about it unless something is worth telling them.
