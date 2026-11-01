import { readFileSync } from "node:fs";
import type { ToolGroup } from "#tools/groups.ts";

// Mail in the conversation: the reader's own tools, as `ito mail` commands and a skill.
export const mailGroup: ToolGroup = {
  id: "mail",
  title: "Mail",
  summary:
    "their mail: find it, read whole threads, draft replies in their voice (never sent), archive, bin, " +
    "unsubscribe and block, with ito mail commands",
  skill: readFileSync(new URL("../../agent/mail.md", import.meta.url), "utf8"),
  operations: [
    { name: "search", tool: "mail_search", running: "Searching mail", done: "Searched mail" },
    { name: "read", tool: "mail_read", running: "Reading a mail", done: "Read a mail" },
    { name: "thread", tool: "mail_thread", running: "Reading a thread", done: "Read a thread" },
    { name: "draft", tool: "draft", running: "Drafting a mail", done: "Drafted a mail" },
    { name: "file", tool: "file_mail", running: "Filing a mail", done: "Filed a mail" },
    { name: "unsubscribe", tool: "unsubscribe", running: "Unsubscribing", done: "Unsubscribed" },
    { name: "block", tool: "block", running: "Blocking a sender", done: "Blocked a sender" },
  ],
};
