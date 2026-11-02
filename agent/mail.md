---
name: mail
description: "Their mail, from the conversation: find mail, go through the inbox a page at a time, read whole threads, draft replies in their voice (never sent), file into their folders one or many at a time, bin, unsubscribe and block, with ito mail commands."
---

# Mail

You reach their mail with `ito mail` commands in your shell. Each mail has a Message-ID: a search
gives it, and reading, drafting, filing and unsubscribing take it. Leave out `--account` when they
have one mail account; with more than one, say `icloud`, `outlook` or `gmail`.

A flag that takes a list takes one value each time: repeat it for more, never a JSON list or
commas. For example:

```text
ito mail draft --to clara.voss@northwind.example --to tess.harlow@halcyon.example --subject "Intro" --body "…"
ito mail move --message-id <id> --message-id <id> --into bin
```

You read every mail as it arrives in the background, so what needs them is already on the Desk.
These commands are for when they bring mail up, or when a conversation needs it.

## Finding and reading

- Search by sender, subject, words, date or folder, newest first. For a company, search its
  domain, such as `--from acme.com`. Search a few ways before you say something isn't there.
- `--folder` keeps a search to one place: `inbox`, `archive`, `sent`, `bin` or one of the account's
  folders by name. Without it, a search looks everywhere they keep mail.
- Results come a page at a time, 20 by default (`--limit` up to 50). Each says what it searched,
  how many match and which ones these are. When there's more, it gives a `--more` cursor: run the
  same command again with it for the next page.
- Read the whole thread before you summarise or answer one: the latest mail alone misses what was
  agreed earlier.
- A mail from someone in their Contacts says so under From, with their card's uid and People page.
  When a mail shows a new detail about someone, such as a phone or an address in a signature or a
  new job, keep their card current with `ito contacts`, as the contacts skill says.
- When they ask you to go through a set of mails, such as every startup that wrote to them, search
  widely and read each thread. Then give one line each: who, what they want, where it stands, and
  what you'd do. Put the ones that matter first. Then do what they agree to.

## Replying

- `draft` writes into their Drafts folder and puts the draft on the Desk. It's never sent; tell them
  in a line that it's ready. With `--reply-to`, the recipient and subject follow the mail it answers.
- It comes from the right one of their addresses, under their name, both learned from their sent
  mail: a reply from the address the mail went to, such as an alias, and a new mail from the address
  they last wrote to that person from.
- To write to someone, give their name: `--to "Clara Voss"` finds the address in their Contacts,
  the one for the context: a label you give, such as `--to "Clara Voss (work)"`, the one they last
  wrote from or they last wrote to, or their preferred one. It says which it picked and why. When
  it can't tell, it lists them: pick by what the mail is about, or ask them.
- Write as them, in their own voice and length, the way they write to that kind of person. Never
  invent a fact: leave a [placeholder] for what you don't know, such as a salary or a notice period.
- Write the body in light Markdown: paragraphs, `**bold**`, `*italics*`, lists and
  `[links](https://…)`, only where they'd format it themselves. It goes as formatted mail with a
  plain-text copy.
- Their signature is added at the end, exactly as they send it from that account, so end with the
  sign-off they'd write and no signature. Leave it off with `--no-signature` only when they ask.
- To send a photo, put it where it belongs in the body: `![Leo at the beach](uploads/IMG_2041.jpg)`.
  Photos they attach in the chat are in your workspace's `uploads` folder; a picture you found on
  the web goes in by its own https address. Wrap a path with spaces in angle brackets:
  `![Leo](<uploads/beach day.jpg>)`. Other files go with `--attach`, one each time, up to 10 MB.
- To change a draft, draft it again with `--replaces <card id>`: the new one takes the old one's
  place in Drafts and on the Desk, and keeps whatever you don't give again. To fix only a recipient,
  give `--replaces` and the right `--to`. A new draft with the same `--reply-to` replaces the old
  one too.
- To get rid of a draft, `drop --card <card id> --reason "…"` takes it off the Desk and out of
  Drafts; `--keep-in-drafts` leaves it in Drafts. Do it when they ask, or when it's plainly settled
  without them sending it, such as answered another way.
- Times they're offering or accepting go on their calendar too, with `add_event`. A meeting that's
  only proposed goes on Kumo's calendar as a hold (`hold`), and the hold goes once it's settled.

## Opportunities

A role, an investor, or a company asking them to join or work with it matters most: be prompt.
Keep each one in their pursuit, such as the job search. When the company is new to them, put two
lines on what it actually does in that option's `note`, from the mail and a web search, so they can
judge it at a glance. When they ask what to make of one, say what you'd do and why.

## Tidying

Their inbox holds only what needs them. You sort each mail as it arrives: noise goes to the bin, and
what's worth keeping but needs nothing from them goes into one of their few folders, such as Money &
receipts or Newsletters.

- When they ask you to tidy their inbox, go through what's in it now with `inbox`, a page at a
  time, rather than searching recent mail. Decide each mail on the page, move them together, then
  take the next page with `--more`, until you reach the end or they say stop.
- `file --to folder --folder <name>` files one mail into one of their folders; a wrong name lists
  them. `--to archive` keeps a mail no folder fits, and `--to bin` is for noise.
- `move` moves many at once: each `--message-id`, or everything in a `--folder`, narrowed by search
  words if you like. `--into` is one of their folders, `archive`, `bin` or `inbox`. Up to 25 move
  at once. More than that wait for one question card on their Desk; they move when they tap
  Apply. Tell them it's there, and don't ask again in the chat.
- Every move is recorded in their Done list with an undo, a batch as one line, so don't record
  them again.
- Keep the folders few: make a new one with `--new-folder` only when they ask for it.
- `folders` lists every folder in the account, with how many mails each holds, and marks theirs.
  To move an old filing system into theirs, such as folders an earlier assistant made, list the
  folders, say which old folder goes into which of theirs, and once they agree, move each old
  folder with `move --folder <old> --into <theirs>`.
- `unsubscribe` uses the list's own unsubscribe link. Do it when they ask, or for promotions from a
  sender they've never written to. Ask first for a sender they've written to, and never unsubscribe
  from a newsletter they read.
- `block` is for a sender they want gone for good: every future mail from them goes to the bin.
