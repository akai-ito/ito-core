---
name: contacts
description: "Their iCloud Contacts, the source of truth for people's emails, phones, addresses, birthdays and work: look people up, read a card, add and update details you're sure of, and propose merges and deletions, with ito contacts commands."
---

# Contacts

Their iCloud Contacts are the source of truth for the facts about people: names, labelled emails
and phones, addresses, birthdays and other dates, where they work and their title, and who they're
related to. You reach them with `ito contacts` commands in your shell. Each card has a uid: search
gives it, and the other commands take it.

The story about a person stays on their People page in memory: what's going on with them, how they
met, what they care about. Link the page to their card by giving `edit_page` (or `write_page`) the
`contact` uid, and keep facts in Contacts, not on the page.

A flag that takes a list takes one value each time: repeat it for more.

```text
ito contacts search --query "Clara"
ito contacts update --uid <uid> --email "work: clara.voss@northwind.example" --job-title "VP Product" --reason "Her new signature, 3 Nov"
```

## Look before you ask

- Before you ask them for someone's address, number, email or birthday, search Contacts. Ask only
  when it isn't there.
- Search by name, email, phone, company or a related person. Read a card for everything on it,
  with its labels and the People page linked to it.

## Keep it current, on your own

You keep Contacts up to date without asking, so they never have to remember: a new phone or
address in someone's signature, a job change, a birthday said in the chat, an address on a
booking. Each change goes into their Done list with your reason and an
undo, so don't record it again.

- Add only details you're sure belong to that person, never a guess. Say where you learned it in
  `--reason`, such as "Her signature, 3 Nov".
- Search first. A card with the same email or phone is the same person: update it rather than add
  another. `add --different` is for someone else with the same name.
- Give a label where you know it: `work`, `home`, `mobile`, `other` or their own words, such as
  `"work: clara.voss@northwind.example"`. Addresses go as `"home: 12 Harbour Row; London; ; E14 5AB;
  United Kingdom"` (street; city; region; postcode; country). A birthday is `1990-04-12`, or
  `04-12` when the year isn't known. Related people go as `"sister: Mira"`.
- When a detail is no longer theirs, remove it (`--remove-email`, `--remove-phone`,
  `--remove-address` with words from it, `--remove-related`) in the same update that adds the new
  one.
- Notes are theirs. The only thing you keep there is one line on when you last caught up with
  someone, through `--caught-up "coffee in Soho"`: it reads "Last caught up: Nov 2026 · coffee in
  Soho" and replaces the one before. Nothing else goes in notes.

## Merges and deletions ask first

- When two cards are one person, `merge` them: give the card to keep first, then the others, with
  why in a line. `search --duplicates` lists cards that look like one person.
- `delete` a card only when it's wrong or they ask. Both put one question on their Desk and wait
  for their answer: tell them it's there, and don't ask again in the chat.

## Writing to people

`ito mail draft --to "Clara Voss"` finds their address in Contacts: their only one, the label you
give in brackets, such as `--to "Clara Voss (work)"`, the one they last wrote from or you last
wrote to, or their preferred one. When it can't tell, it lists them: pick by what the mail is
about, or ask.
