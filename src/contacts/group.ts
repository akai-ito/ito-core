import { readFileSync } from "node:fs";
import type { ToolGroup } from "#tools/groups.ts";

// Their contacts in the conversation and in background work: the keeper's own tools, as `ito contacts` commands
// and a skill.
export const contactsGroup: ToolGroup = {
  id: "contacts",
  title: "Contacts",
  summary:
    "their iCloud Contacts, the source of truth for people's emails, phones, addresses, birthdays and work: look " +
    "people up, read a card, add and update details you're sure of, and propose merges and deletions, with ito " +
    "contacts commands",
  skill: readFileSync(new URL("../../agent/contacts.md", import.meta.url), "utf8"),
  operations: [
    {
      name: "search",
      tool: "contacts_search",
      running: "Looking in your contacts",
      done: "Looked in your contacts",
      run: { present: "Looking in your contacts", past: "Looked in your contacts {count} times" },
    },
    {
      name: "read",
      tool: "contacts_read",
      running: "Reading a contact",
      done: "Read a contact",
      run: { present: "Reading {count} contacts", past: "Read {count} contacts" },
    },
    {
      name: "add",
      tool: "contacts_add",
      running: "Adding a contact",
      done: "Added a contact",
      run: { present: "Adding {count} contacts", past: "Added {count} contacts" },
    },
    {
      name: "update",
      tool: "contacts_update",
      running: "Updating a contact",
      done: "Updated a contact",
      run: { present: "Updating {count} contacts", past: "Updated {count} contacts" },
    },
    { name: "merge", tool: "contacts_merge", running: "Asking about a merge", done: "Asked about a merge" },
    { name: "delete", tool: "contacts_delete", running: "Asking about a deletion", done: "Asked about a deletion" },
  ],
};
