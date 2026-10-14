import { toTimestamp } from "#clock.ts";
import type { StepFacts } from "#engine/engine.ts";
import type { Outcome, Step, StepKind } from "#protocol/types.ts";

export type Tense = "present" | "past";

type Title = { readonly present: string; readonly past: string };

const title = (present: string, past: string): Title => ({ present, past });

const fileName = (filePath: string | undefined): string | undefined => filePath?.split("/").findLast(Boolean);

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const seconds = (milliseconds: number): string =>
  milliseconds < 1000 ? "a moment" : plural(Math.round(milliseconds / 1000), "second");

const commandWords = (command: string): readonly string[] =>
  command
    .trim()
    .split(/\s+/u)
    .filter(
      (word, index, words) => !/^\w+=/u.test(word) || words.slice(0, index).some((earlier) => !/^\w+=/u.test(earlier)),
    )
    .filter((word, index) => index > 0 || (word !== "sudo" && word !== "time"));

const gitTitles: Readonly<Record<string, Title>> = {
  log: title("Looking at the project's history", "Looked at the project's history"),
  status: title("Checking the project's changes", "Checked the project's changes"),
  diff: title("Comparing changes", "Compared changes"),
  commit: title("Saving a commit", "Saved a commit"),
  clone: title("Copying a project", "Copied a project"),
  pull: title("Fetching the latest changes", "Fetched the latest changes"),
  push: title("Sending changes", "Sent changes"),
};

const programTitles: Readonly<Record<string, Title>> = {
  curl: title("Fetching a web page", "Fetched a web page"),
  wget: title("Fetching a web page", "Fetched a web page"),
  python: title("Running a script", "Ran a script"),
  python3: title("Running a script", "Ran a script"),
  node: title("Running a script", "Ran a script"),
  mkdir: title("Making a folder", "Made a folder"),
  rm: title("Deleting files", "Deleted files"),
  mv: title("Moving files", "Moved files"),
  cp: title("Copying files", "Copied files"),
  ls: title("Looking through a folder", "Looked through a folder"),
  cat: title("Reading a file", "Read a file"),
  grep: title("Searching files", "Searched files"),
  rg: title("Searching files", "Searched files"),
  find: title("Finding files", "Found files"),
  date: title("Checking the time", "Checked the time"),
};

const runTitle = (command = ""): Title => {
  const [program = "", subcommand = "", argument = ""] = commandWords(command);
  if (program === "sleep" && Number.isFinite(Number(subcommand))) {
    const waited = seconds(Number(subcommand) * 1000);
    return title(`Waiting ${waited}`, `Waited ${waited}`);
  }
  if (program === "git") return gitTitles[subcommand] ?? title("Using git", "Used git");
  if (["npm", "pnpm", "yarn"].includes(program)) {
    if (subcommand === "install" || subcommand === "ci") return title("Installing packages", "Installed packages");
    if (subcommand === "test") return title("Running the tests", "Ran the tests");
    if (subcommand === "run" && argument) return title(`Running ${argument}`, `Ran ${argument}`);
  }
  const isPipInstall = subcommand === "install" && (program === "pip" || program === "pip3");
  return isPipInstall
    ? title("Installing packages", "Installed packages")
    : (programTitles[program] ?? title("Running a command", "Ran a command"));
};

const commandTitle = ({ actions = [], command }: StepFacts): Title => {
  const [first] = actions;
  if (!first || first.type === "run") return runTitle(command);
  if (first.type === "read") {
    const reads = actions.filter((action) => action.type === "read");
    if (reads.length > 1)
      return title(`Reading ${plural(reads.length, "file")}`, `Read ${plural(reads.length, "file")}`);
    const name = fileName(first.path) ?? "a file";
    return title(`Reading ${name}`, `Read ${name}`);
  }
  if (first.type === "search") {
    const term = first.query ? ` for “${first.query}”` : "";
    return title(`Searching${term}`, `Searched${term}`);
  }
  const folder = fileName(first.path) ?? "a folder";
  return title(`Looking through ${folder}`, `Looked through ${folder}`);
};

const changeVerbs = {
  added: title("Creating", "Created"),
  modified: title("Editing", "Edited"),
  deleted: title("Deleting", "Deleted"),
  moved: title("Moving", "Moved"),
} as const;

const fileChangeTitle = ({ files = [] }: StepFacts): Title => {
  const [only] = files;
  if (only && files.length === 1) {
    const verb = changeVerbs[only.change];
    const name = fileName(only.path) ?? "a file";
    return title(`${verb.present} ${name}`, `${verb.past} ${name}`);
  }
  const count = files.length > 1 ? plural(files.length, "file") : "files";
  return title(`Editing ${count}`, `Edited ${count}`);
};

const webSearchTitle = ({ query, url, pattern }: StepFacts): Title => {
  if (url && pattern)
    return title(`Looking for “${pattern}” on ${hostOf(url)}`, `Looked for “${pattern}” on ${hostOf(url)}`);
  if (url) return title(`Opening ${hostOf(url)}`, `Opened ${hostOf(url)}`);
  return query
    ? title(`Searching the web for ${query}`, `Searched the web for ${query}`)
    : title("Searching the web", "Searched the web");
};

const titleOf = (kind: StepKind, facts: StepFacts): Title => {
  switch (kind) {
    case "thinking": {
      return title("Thinking it through", "Thought it through");
    }
    case "web_search": {
      return webSearchTitle(facts);
    }
    case "command": {
      return commandTitle(facts);
    }
    case "file_change": {
      return fileChangeTitle(facts);
    }
    case "tool": {
      const capability = facts.capability ?? "a tool";
      return title(`Using ${capability}`, `Used ${capability}`);
    }
    case "plan": {
      const items = facts.items?.length ?? 0;
      return items > 0
        ? title(`Planning ${plural(items, "step")}`, `Planned ${plural(items, "step")}`)
        : title("Planning", "Planned");
    }
    case "wait": {
      const waited = seconds(facts.wait_ms ?? 0);
      return title(`Waiting ${waited}`, `Waited ${waited}`);
    }
    case "image_view": {
      const name = fileName(facts.path) ?? "an image";
      return title(`Looking at ${name}`, `Looked at ${name}`);
    }
    case "compacting": {
      return title("Tidying up its notes", "Tidied up its notes");
    }
  }
};

export const toStepTitle = (kind: StepKind, facts: StepFacts, tense: Tense): string => titleOf(kind, facts)[tense];

const commonFields: ReadonlySet<string> = new Set([
  "id",
  "turn",
  "kind",
  "title",
  "at",
  "position",
  "ended_at",
  "outcome",
  "duration_ms",
]);

export const factsOf = (step: Step): StepFacts =>
  Object.fromEntries(Object.entries(step).filter(([field]) => !commonFields.has(field)));

export const toUpdatedStep = (step: Step, facts: StepFacts): Step => {
  const merged = { ...factsOf(step), ...facts };
  return { ...step, ...facts, title: toStepTitle(step.kind, merged, "present") };
};

export const toEndedStep = (step: Step, outcome: Outcome, facts: StepFacts, endedAt: number): Step => {
  const merged = { ...factsOf(step), ...facts };
  return {
    ...step,
    ...facts,
    title: toStepTitle(step.kind, merged, "past"),
    ended_at: toTimestamp(endedAt),
    outcome,
    duration_ms: Math.max(0, endedAt - Date.parse(step.at)),
  };
};
