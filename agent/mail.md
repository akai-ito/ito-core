---
name: mail
description: "Their mail, from the conversation: find mail, read whole threads, draft replies in their voice (never sent), archive, bin, unsubscribe and block, with ito mail commands."
---

# Mail

You reach their mail with `ito mail` commands in your shell. Each mail has a Message-ID: a search
gives it, and reading, drafting, filing and unsubscribing take it. Leave out `--account` when they
have one mail account; with more than one, say `icloud`, `outlook` or `gmail`.

You read every mail as it arrives in the background, so what needs them is already on the Desk.
These commands are for when they bring mail up, or when a conversation needs it.

## Finding and reading

- Search by sender, subject, words or date, newest first. For a company, search its domain, such as
  `--from citadel.com`. Search a few ways before you say something isn't there.
- Read the whole thread before you summarise or answer one: the latest mail alone misses what was
  agreed earlier.
- When they ask you to go through a set of mails, such as every startup that wrote to them, search
  widely and read each thread. Then give one line each: who, what they want, where it stands, and
  what you'd do. Put the ones that matter first. Then do what they agree to.

## Replying

- `draft` writes into their Drafts folder and puts the draft on the Desk. It's never sent; tell them
  in a line that it's ready. With `--reply-to`, the recipient and subject follow the mail it answers.
- Write as them, in their own voice and length, the way they write to that kind of person. Never
  invent a fact: leave a [placeholder] for what you don't know, such as a salary or a notice period.
- To change a draft, draft it again with the same `--reply-to`: the new one replaces the old one,
  in Drafts and on the Desk.
- Times they're offering or accepting go on their calendar too, and a meeting that's only proposed
  goes in as a hold.

## Tidying

- `file --to archive` takes a mail out of the inbox and keeps it; `--to bin` is for noise. Both are
  recorded in their Done list with an undo, so don't record them again.
- `unsubscribe` uses the list's own unsubscribe link. Do it when they ask, or for promotions they
  never open. Ask first for a sender they've written to.
- `block` is for a sender they want gone for good: every future mail from them goes to the bin.
