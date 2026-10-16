import { mkdirSync } from "node:fs";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { systemClock } from "#clock.ts";
import { createToken, hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";

export const tokenMessage = (heading: string, token: string): string => [heading, "", `  ${token}`, ""].join("\n");

export const newToken = (io: Io): number => {
  if (!io.isTerminal) {
    io.printError("Run ito token new in a terminal: the token is shown once and must never reach a log.");
    return 1;
  }
  const { home } = toPaths(io.environment);
  mkdirSync(home, { recursive: true });
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  const token = createToken();
  try {
    store.setSetting(tokenSetting, hashToken(token));
    store.clearPairing();
  } finally {
    store.close();
  }
  io.print(
    tokenMessage("Your new token, shown once. Every older token, paired devices' included, stops working now:", token),
  );
  return 0;
};
