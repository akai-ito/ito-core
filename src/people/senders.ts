import type { DatabaseSync } from "node:sqlite";
import { plainName } from "#people/linking.ts";

// Who writes from which address, as mail arrives: the name on the latest mail from each. Linking reads it to find a
// People page's email when the page has the same name as the sender.
export type Senders = {
  readonly record: (name: string, address: string, at: string) => void;
  // The addresses that wrote under any of these names.
  readonly addressesOf: (names: readonly string[]) => readonly string[];
};

export const createSenders = (database: DatabaseSync): Senders => ({
  record: (name, address, at) => {
    const tidy = name.replaceAll(/\s+/gu, " ").trim();
    if (tidy === "" || !address.includes("@")) return;
    database
      .prepare(
        `INSERT INTO senders (address, name, at) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET name = excluded.name, at = excluded.at`,
      )
      .run(address.trim().toLowerCase(), tidy, at);
  },
  addressesOf: (names) => {
    const wanted = new Set(names.map((name) => plainName(name)).filter((name) => name.length >= 2));
    const rows =
      wanted.size === 0
        ? []
        : (database.prepare("SELECT address, name FROM senders").all() as unknown as readonly {
            readonly address: string;
            readonly name: string;
          }[]);
    return rows.filter(({ name }) => wanted.has(plainName(name))).map(({ address }) => address);
  },
});
