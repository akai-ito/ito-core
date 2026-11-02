import { readFileSync } from "node:fs";
import type { ToolGroup } from "#tools/groups.ts";

// Mail in the conversation: the reader's own tools, as `ito mail` commands and a skill.
export const mailGroup: ToolGroup = {
  id: "mail",
  title: "Mail",
  summary:
    "their mail: find it, go through the inbox a page at a time, read whole threads, draft replies in their voice " +
    "(never sent), file into their folders one or many at a time, bin, unsubscribe and block, with ito mail commands",
  skill: readFileSync(new URL("../../agent/mail.md", import.meta.url), "utf8"),
  operations: [
    {
      name: "search",
      tool: "mail_search",
      running: "Searching mail",
      done: "Searched mail",
      run: { present: "Searching mail", past: "Searched mail {count} times" },
    },
    {
      name: "inbox",
      tool: "mail_inbox",
      running: "Looking through your inbox",
      done: "Looked through your inbox",
      run: { present: "Looking through your inbox", past: "Looked through {count} pages of your inbox" },
    },
    {
      name: "read",
      tool: "mail_read",
      running: "Reading a mail",
      done: "Read a mail",
      run: { present: "Reading {count} mails", past: "Read {count} mails" },
    },
    {
      name: "thread",
      tool: "mail_thread",
      running: "Reading a thread",
      done: "Read a thread",
      run: { present: "Reading {count} threads", past: "Read {count} threads" },
    },
    {
      name: "draft",
      tool: "draft",
      running: "Drafting a mail",
      done: "Drafted a mail",
      run: { present: "Drafting {count} mails", past: "Drafted {count} mails" },
    },
    {
      name: "drop",
      tool: "drop_draft",
      running: "Dropping a draft",
      done: "Dropped a draft",
      run: { present: "Dropping {count} drafts", past: "Dropped {count} drafts" },
    },
    {
      name: "file",
      tool: "file_mail",
      running: "Filing a mail",
      done: "Filed a mail",
      run: { present: "Sorting {count} mails", past: "Sorted {count} mails" },
    },
    { name: "move", tool: "mail_move", running: "Moving mails", done: "Moved mails" },
    {
      name: "folders",
      tool: "mail_folders",
      running: "Looking at your mail folders",
      done: "Looked at your mail folders",
    },
    {
      name: "unsubscribe",
      tool: "unsubscribe",
      running: "Unsubscribing",
      done: "Unsubscribed",
      run: { present: "Unsubscribing from {count} lists", past: "Unsubscribed from {count} lists" },
    },
    {
      name: "block",
      tool: "block",
      running: "Blocking a sender",
      done: "Blocked a sender",
      run: { present: "Blocking {count} senders", past: "Blocked {count} senders" },
    },
  ],
};
