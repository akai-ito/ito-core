import { createCell } from "#cell.ts";
import type { CardAnswer, DeskKeeper } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { Card, DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// The few folders Kumo files mail into once it needs nothing from them. Kumo proposes them from their mail on a
// Desk card; they confirm, or rename by replying. Mail that needs a folder before then waits in the inbox.

export type MailReference = NonNullable<DoneEntry["mail"]>;

export type FileInto = (mail: MailReference, folder: string, reason: string) => Promise<Result<undefined, string>>;

export type MailFolders = {
  // Files a mail into one of their folders, or keeps it until they've chosen them. Says what happened.
  readonly place: (mail: MailReference, folder: string, reason: string) => Promise<Result<string, string>>;
  // Adds a folder they asked for, and files the mail into it.
  readonly add: (mail: MailReference, folder: string, reason: string) => Promise<Result<string, string>>;
  readonly propose: (evidence: readonly string[]) => Promise<void>;
  readonly names: () => readonly string[];
  readonly note: () => string;
};

export type FoldersOptions = {
  readonly store: Pick<Store, "setting" | "setSetting">;
  readonly desk: Pick<DeskKeeper, "addCard" | "cards" | "handleCard" | "addDone">;
  readonly complete: Complete;
  readonly info: Info;
  readonly fileInto: FileInto;
  // A sample of their recent mail, one line each, to propose folders from when the first mail needs one.
  readonly evidence: () => Promise<readonly string[]>;
};

type Proposal = { readonly card: string; readonly names: readonly string[] };

type Waiting = { readonly mail: MailReference; readonly folder: string; readonly reason: string };

type Renamed = { readonly name: string; readonly from: readonly string[] };

export const foldersSetting = "mail_folders";

export const proposalSetting = "mail_folders_proposal";

export const waitingSetting = "mail_folders_waiting";

const evidenceLimit = 300;
const mostFolders = 6;

const proposalSchema: JsonSchema = {
  type: "object",
  properties: { folders: { type: "array", items: { type: "string" } } },
  required: ["folders"],
  additionalProperties: false,
};

const renameSchema: JsonSchema = {
  type: "object",
  properties: {
    folders: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, from: { type: "array", items: { type: "string" } } },
        required: ["name", "from"],
        additionalProperties: false,
      },
    },
  },
  required: ["folders"],
  additionalProperties: false,
};

const parsed = (text = "null"): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const sameName = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();

const namesOf = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : [])
    .flatMap((name) => (typeof name === "string" && name.trim() !== "" ? name.trim() : []))
    .filter((name, index, every) => every.findIndex((other) => sameName(other, name)) === index);

const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

const toProposal = (value: unknown): Proposal | undefined => {
  const card = fieldOf(value, "card");
  const names = namesOf(fieldOf(value, "names"));
  return typeof card === "string" && names.length > 0 ? { card, names } : undefined;
};

const toWaiting = (value: unknown): readonly Waiting[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((item) => {
    const mail = fieldOf(item, "mail") as MailReference | undefined;
    return typeof mail?.message_id === "string"
      ? { mail, folder: textOf(item, "folder"), reason: textOf(item, "reason") }
      : [];
  });

const toRenamed = (value: unknown): readonly Renamed[] =>
  (Array.isArray(fieldOf(value, "folders")) ? (fieldOf(value, "folders") as readonly unknown[]) : []).flatMap(
    (item) => {
      const name = textOf(item, "name").trim();
      const from = fieldOf(item, "from");
      return name === "" ? [] : { name, from: namesOf(from) };
    },
  );

const proposalPrompt = (evidence: readonly string[]): string =>
  [
    "You keep the person's inbox to what needs them. Mail worth keeping that needs nothing from them, such as a",
    "receipt, a statement, a booking already on their calendar or a newsletter, goes into a folder, so they can",
    "still find it. Propose the folders: three to six, from what their mail below actually holds, grouped by what",
    'they would look for later, not by sender. Short, plain names, such as "Bookings & travel" or "Money &',
    'receipts". Include "Newsletters" if they get any to read. Here is their recent mail, one a line:',
    "",
    ...evidence.slice(0, evidenceLimit),
  ].join("\n");

const renamePrompt = (names: readonly string[], reply: string): string =>
  [
    `You proposed these folders for the person's mail: ${names.join(", ")}.`,
    `They replied: ${reply}`,
    "Give the folders they want now, at most six, in their words. For each, list in from the proposed names it",
    "takes over, so mail meant for those goes there; a new folder takes over none.",
  ].join("\n");

const cardText = (names: readonly string[]): string =>
  `I'll keep your inbox to what needs you. Mail worth keeping that needs nothing from you goes into ${listed(names)}. ` +
  "Use these, or reply with what you'd call them.";

const useThese = "Use these";

export const createMailFolders = ({ store, desk, complete, info, fileInto, evidence }: FoldersOptions): MailFolders => {
  const proposing = createCell<Promise<void> | undefined>(undefined);

  const names = (): readonly string[] => namesOf(parsed(store.setting(foldersSetting)));

  const proposal = (): Proposal | undefined => toProposal(parsed(store.setting(proposalSetting)));

  const waiting = (): readonly Waiting[] => toWaiting(parsed(store.setting(waitingSetting)));

  const setWaiting = (all: readonly Waiting[]): void => {
    store.setSetting(waitingSetting, JSON.stringify(all));
  };

  const fileNow = async (mail: MailReference, folder: string, reason: string): Promise<Result<string, string>> => {
    const filed = await fileInto(mail, folder, reason);
    return filed.ok ? ok(`Filed it into ${folder}.`) : filed;
  };

  const confirm = async (chosen: readonly string[], renamed: readonly Renamed[]): Promise<void> => {
    store.setSetting(foldersSetting, JSON.stringify(chosen));
    store.setSetting(proposalSetting, "null");
    desk.addDone({ text: `Your mail folders: ${listed(chosen)}`, quiet: false });
    const held = waiting();
    setWaiting([]);
    for (const { mail, folder, reason } of held) {
      const target =
        chosen.find((name) => sameName(name, folder)) ??
        renamed.find(({ from }) => from.some((name) => sameName(name, folder)))?.name;
      // A mail meant for a folder they dropped stays in the inbox, where they'll see it.
      const filed = target === undefined ? fail(`No folder for ${folder}.`) : await fileInto(mail, target, reason);
      if (!filed.ok) info("A mail waiting for its folder stays in the inbox", { error: filed.failure });
    }
  };

  const answer = async (card: Card, given: CardAnswer, offered: readonly string[]): Promise<undefined> => {
    if (given.text === undefined) {
      await confirm(offered, []);
      return undefined;
    }
    const answered = await complete(renamePrompt(offered, given.text), renameSchema);
    const renamed = answered.ok ? toRenamed(answered.value).slice(0, mostFolders) : [];
    if (renamed.length > 0) {
      await confirm(
        renamed.map(({ name }) => name),
        renamed,
      );
      return undefined;
    }
    info("Their answer about folders couldn't be read, so Kumo asks again", {
      error: answered.ok ? "no folders in it" : answered.failure,
    });
    ask(offered, card.title);
    return undefined;
  };

  const ask = (offered: readonly string[], title = "Folders for your mail"): void => {
    const card = desk.addCard({
      kind: "question",
      title,
      options: [{ label: useThese }],
      allows_text: true,
      question: { text: cardText(offered) },
    });
    store.setSetting(proposalSetting, JSON.stringify({ card: card.id, names: offered }));
    desk.handleCard(card.id, (answered, given) => answer(answered, given, offered));
  };

  const isAsking = (): boolean => {
    const current = proposal();
    return current !== undefined && desk.cards().some((card) => card.id === current.card);
  };

  const proposeFrom = async (lines: readonly string[]): Promise<void> => {
    if (names().length > 0 || isAsking() || lines.length === 0) return;
    const answered = await complete(proposalPrompt(lines), proposalSchema);
    const offered = answered.ok ? namesOf(fieldOf(answered.value, "folders")).slice(0, mostFolders) : [];
    if (offered.length === 0) {
      info("Kumo couldn't propose folders, so it tries again when a mail next needs one", {
        error: answered.ok ? "no folders in the answer" : answered.failure,
      });
      return;
    }
    ask(offered);
  };

  // One proposal at a time, however many mails need a folder at once.
  const propose = async (lines: readonly string[]): Promise<void> => {
    const current = proposing.get();
    if (current) return current;
    const next = (async (): Promise<void> => {
      try {
        await proposeFrom(lines);
      } finally {
        proposing.set(undefined);
      }
    })();
    proposing.set(next);
    return next;
  };

  const hold = async (mail: MailReference, folder: string, reason: string): Promise<Result<string, string>> => {
    setWaiting([...waiting().filter((held) => held.mail.message_id !== mail.message_id), { mail, folder, reason }]);
    if (!isAsking()) await propose(await evidence());
    return ok(`It stays in the inbox until they've chosen their folders, then goes into ${folder}.`);
  };

  // Ask again on startup for a proposal whose card is still waiting.
  const pending = proposal();
  if (pending && desk.cards().some((card) => card.id === pending.card)) {
    desk.handleCard(pending.card, (card, given) => answer(card, given, pending.names));
  }

  return {
    place: async (mail, folder, reason) => {
      const chosen = names();
      if (chosen.length === 0) return hold(mail, folder, reason);
      const target = chosen.find((name) => sameName(name, folder));
      return target === undefined
        ? fail(`They have no folder called ${folder}. Their folders: ${listed(chosen)}.`)
        : fileNow(mail, target, reason);
    },
    add: async (mail, folder, reason) => {
      const chosen = names();
      if (chosen.length === 0) return hold(mail, folder, reason);
      if (chosen.every((name) => !sameName(name, folder))) {
        store.setSetting(foldersSetting, JSON.stringify([...chosen, folder.trim()]));
        desk.addDone({ text: `Added a mail folder: ${folder.trim()}`, ...(reason !== "" && { reason }), quiet: false });
      }
      return fileNow(mail, chosen.find((name) => sameName(name, folder)) ?? folder.trim(), reason);
    },
    propose,
    names,
    note: () => {
      const chosen = names();
      if (chosen.length > 0) return `Their folders: ${listed(chosen)}.`;
      const offered = proposal()?.names ?? [];
      return offered.length > 0
        ? `The folders you proposed, which they haven't chosen yet: ${listed(offered)}.`
        : "They have no folders yet.";
    },
  };
};
