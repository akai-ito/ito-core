import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createCell } from "#cell.ts";

// A real IMAP server in the test, hoodiecrow, with ways to make it behave as real servers sometimes do: a
// Message-ID search that matches loosely, as a search index might, or one that hasn't caught up with new mail, and a
// command it takes but doesn't answer.

export type ImapConnection = {
  readonly socket?: { readonly destroy: () => void };
  readonly server?: { readonly getMailbox: (path: string) => unknown };
  readonly sendStatus?: (
    parsed: unknown,
    data: string,
    command: string,
    text: string,
    code: string | false,
    description: string,
  ) => void;
};

type CommandHandler = (connection: ImapConnection, parsed: unknown, data: string, callback: () => void) => void;

export type StoredMessage = { readonly raw: string | Buffer; readonly flags: readonly string[]; readonly uid: number };

export type Hoodiecrow = {
  readonly listen: (port: number, host: string, callback: () => void) => void;
  readonly close: (callback: () => void) => void;
  readonly address: () => AddressInfo;
  readonly appendMessage: (folder: string, flags: readonly string[], receivedAt: Date, raw: string) => unknown;
  readonly getMailbox: (path: string) => { readonly messages: readonly StoredMessage[] } | undefined;
  readonly getCommandHandler: (command: string) => CommandHandler;
  readonly setCommandHandler: (command: string, handler: CommandHandler) => void;
};

const createHoodiecrow = createRequire(import.meta.url)("hoodiecrow-imap") as (
  options: Readonly<Record<string, unknown>>,
) => Hoodiecrow;

export type Stored = { readonly raw: string; readonly internaldate: Date; readonly flags: readonly string[] };

export const wire = (raw: string): string => raw.replaceAll(/\r?\n/gu, "\r\n");

export const stored = (raw: string, receivedAt: string, flags: readonly string[] = []): Stored => ({
  raw: wire(raw),
  internaldate: new Date(receivedAt),
  flags,
});

export type Folders = Readonly<Record<string, { readonly specialUse?: string; readonly messages?: readonly Stored[] }>>;

export const startImap = async (
  user: string,
  password: string,
  inbox: readonly Stored[],
  folders: Folders,
): Promise<Hoodiecrow> => {
  const server = createHoodiecrow({
    plugins: ["IDLE", "MOVE", "SPECIAL-USE", "UIDPLUS", "ID", "NAMESPACE"],
    users: { [user]: { password } },
    storage: {
      INBOX: { messages: inbox },
      "": {
        separator: "/",
        folders: Object.fromEntries(
          Object.entries(folders).map(([name, { specialUse, messages = [] }]) => [
            name,
            { ...(specialUse !== undefined && { "special-use": specialUse }), messages },
          ]),
        ),
      },
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
};

export const stopImap = (server: Hoodiecrow): Promise<void> =>
  new Promise((resolve) => {
    server.close(resolve);
  });

type Attribute = { readonly type?: string; readonly value?: unknown };

type Attributes = readonly (Attribute | Attributes)[];

const valueOf = (attribute: Attribute | Attributes | undefined): string => {
  const value = attribute === undefined || Array.isArray(attribute) ? undefined : (attribute as Attribute).value;
  return typeof value === "string" || Buffer.isBuffer(value) ? value.toString() : "";
};

const ignore = (): void => undefined;

// The search's arguments with every HEADER MESSAGE-ID value changed, inside OR groups too.
const changedIds = (attributes: Attributes, change: (id: string) => string): Attributes =>
  attributes.map((attribute, index) => {
    if (Array.isArray(attribute)) return changedIds(attribute as Attributes, change);
    const isId =
      valueOf(attributes[index - 2]).toUpperCase() === "HEADER" &&
      valueOf(attributes[index - 1]).toUpperCase() === "MESSAGE-ID";
    return isId ? { ...(attribute as Attribute), value: change(valueOf(attribute)) } : attribute;
  });

// Message-ID searches answered by a different rule, such as matching on the id's domain alone, as a search index
// that splits ids into words might, or matching nothing in some folders, as an index that hasn't caught up.
export const changeIdSearch = (server: Hoodiecrow, change: (id: string, folder: string) => string): void => {
  for (const command of ["SEARCH", "UID SEARCH"]) {
    const original = server.getCommandHandler(command);
    server.setCommandHandler(command, (connection, parsed, data, callback) => {
      const selected = (connection as { readonly selectedMailbox?: { readonly path?: string } }).selectedMailbox;
      const folder = selected?.path ?? "";
      const { attributes = [] } = parsed as { readonly attributes?: Attributes };
      const changed = { ...(parsed as object), attributes: changedIds(attributes, (id) => change(id, folder)) };
      original(connection, changed, data, callback);
    });
  }
};

// The domain alone: "<req-4471@ats.example>" matches every id at ats.example.
export const domainOnly = (id: string): string => id.slice(id.indexOf("@"));

// An id no mail carries, for a search that finds nothing.
export const nothing = "<not-indexed-yet@ito.invalid>";

// The next time a command comes, it's taken or dropped as asked but never answered, as a server that stops
// responding mid-command.
export const silenceOnce = (server: Hoodiecrow, command: string, isTaken: boolean): void => {
  const original = server.getCommandHandler(command);
  const isSilenced = createCell(false);
  server.setCommandHandler(command, (connection, parsed, data, callback) => {
    if (isSilenced.get()) {
      original(connection, parsed, data, callback);
      return;
    }
    isSilenced.set(true);
    if (!isTaken) return;
    // Taken, as the server would, with its answer lost.
    const mute = { value: ignore };
    const muted = Object.create(connection, { send: mute, sendStatus: mute }) as ImapConnection;
    original(muted, parsed, data, ignore);
  });
};
