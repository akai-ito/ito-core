import type { DreamStep } from "#protocol/types.ts";

// What Kumo is doing in a dream, in a short line, read from the tool it's about to call: the app weaves these while it
// dreams. The server writes them from what it holds, so they're honest and cost nothing; a call with nothing to show,
// such as the record itself, has none.
export type StepLine = Pick<DreamStep, "group" | "text">;

export type StepLookups = {
  readonly pageTitle: (address: string) => string | undefined;
  readonly threadTitle: (id: string) => string | undefined;
  readonly wakeUpTitle: (id: string) => string | undefined;
  readonly eventTitle: (uid: string) => string | undefined;
  // A day as a line says it, such as "Monday" within the week, or "3 Nov".
  readonly dayName: (day: string) => string;
};

// The tools a step can come from.
export const steppedTools: ReadonlySet<string> = new Set([
  "read_page",
  "read_thread",
  "recall",
  "find_in_memory",
  "mail_read",
  "mail_thread",
  "calendar_events",
  "edit_page",
  "write_page",
  "forget_page",
  "restore_page",
  "journal",
  "set_wake_up",
  "move_wake_up",
  "drop_wake_up",
  "plan_block",
  "add_event",
  "change_event",
  "correct_guess",
  "delete_event",
]);

// A dream's first step: it reads the digest before anything else.
export const firstStep: StepLine = { group: "gathering", text: "Reading back over the day" };

const fieldText = (input: unknown, field: string): string => {
  if (typeof input !== "object" || input === null) return "";
  const value = (input as Readonly<Record<string, unknown>>)[field];
  return typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim() : "";
};

const quoted = (title: string | undefined): string => (title === undefined || title === "" ? "" : ` “${title}”`);

const pageName = (address: string, lookups: StepLookups): string => {
  const title = lookups.pageTitle(address);
  if (title !== undefined && title !== "") return title;
  const last =
    address
      .split("/")
      .at(-1)
      ?.replace(/^memory:/u, "") ?? "";
  return last === "" ? "a page" : last.replaceAll("-", " ");
};

export const stepOf = (tool: string, input: unknown, lookups: StepLookups): StepLine | undefined => {
  const address = fieldText(input, "address");
  switch (tool) {
    case "read_page": {
      return {
        group: "gathering",
        text: address.startsWith("memory:journal/")
          ? `Reading ${lookups.dayName(address.slice("memory:journal/".length))}'s journal`
          : `Reading ${pageName(address, lookups)}`,
      };
    }
    case "read_thread": {
      const title = lookups.threadTitle(fieldText(input, "thread"));
      return { group: "gathering", text: title === undefined ? "Rereading a thread" : `Rereading “${title}”` };
    }
    case "recall":
    case "find_in_memory": {
      return { group: "gathering", text: "Looking back through what you said" };
    }
    case "mail_read":
    case "mail_thread": {
      return { group: "gathering", text: "Reading your mail" };
    }
    case "calendar_events": {
      return { group: "gathering", text: "Looking at your calendar" };
    }
    case "edit_page": {
      return { group: "tidying", text: `Tidying ${pageName(address, lookups)}` };
    }
    case "write_page": {
      const title = fieldText(input, "title");
      return { group: "tidying", text: `Writing ${title === "" ? pageName(address, lookups) : title}` };
    }
    case "forget_page": {
      return { group: "tidying", text: `Folding away ${pageName(address, lookups)}` };
    }
    case "restore_page": {
      return { group: "tidying", text: `Bringing back ${pageName(address, lookups)}` };
    }
    case "journal": {
      const day = fieldText(input, "day");
      return {
        group: "journal",
        text: day === "" ? "Writing the journal" : `Writing ${lookups.dayName(day)}'s journal`,
      };
    }
    case "set_wake_up": {
      return { group: "planning", text: `Planning${quoted(fieldText(input, "title")) || " a wake-up"}` };
    }
    case "move_wake_up": {
      return {
        group: "planning",
        text: `Moving${quoted(lookups.wakeUpTitle(fieldText(input, "id"))) || " a wake-up"}`,
      };
    }
    case "drop_wake_up": {
      return {
        group: "planning",
        text: `Dropping${quoted(lookups.wakeUpTitle(fieldText(input, "id"))) || " a wake-up"}`,
      };
    }
    case "plan_block":
    case "add_event": {
      const title = fieldText(input, "title");
      return { group: "planning", text: title === "" ? "Planning tomorrow" : `Planning ${title}` };
    }
    case "change_event":
    case "correct_guess": {
      const title = lookups.eventTitle(fieldText(input, "uid"));
      return { group: "planning", text: title === undefined ? "Moving things around" : `Moving ${title}` };
    }
    case "delete_event": {
      const title = lookups.eventTitle(fieldText(input, "uid"));
      return { group: "planning", text: title === undefined ? "Clearing your calendar" : `Clearing ${title}` };
    }
    default: {
      return undefined;
    }
  }
};
