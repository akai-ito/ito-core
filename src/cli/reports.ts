import { mkdirSync } from "node:fs";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { systemClock } from "#clock.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { reportsTokenSetting } from "#reports/reporter.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";

export const setReportsToken = async (io: Io): Promise<number> => {
  if (!io.isTerminal) {
    io.printError("Run ito reports token in a terminal: it asks for the token without showing it.");
    return 1;
  }
  const answer = await io.readSecret("GitHub token for gap reports (it won't show as you paste): ");
  const token = answer.trim();
  if (!token) {
    io.printError("No token given, so nothing changed.");
    return 1;
  }
  const { home } = toPaths(io.environment);
  mkdirSync(home, { recursive: true });
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  try {
    store.setSetting(reportsTokenSetting, token);
  } finally {
    store.close();
  }
  io.print("Saved. Ari files its gap reports to akai-ito/ito-core with this token from now on.");
  return 0;
};
