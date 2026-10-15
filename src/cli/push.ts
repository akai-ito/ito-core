import { createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { systemClock } from "#clock.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { fail, ok, type Result } from "#result.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";

type PushSetup = {
  readonly privateKey: string;
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
};

export const pushUsage = "ito push setup --key <AuthKey.p8> --key-id <id> --team-id <id> --bundle-id <id>";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readKey = (file: string): Result<string, string> => {
  try {
    const privateKey = readFileSync(file, "utf8");
    const details = createPrivateKey(privateKey).asymmetricKeyDetails;
    return details?.namedCurve === "prime256v1"
      ? ok(privateKey)
      : fail(`${file} isn't an APNs key: it should be the P-256 .p8 file from your Apple Developer account.`);
  } catch (error) {
    return fail(`Couldn't read the key in ${file}: ${describe(error)}`);
  }
};

const parsePushSetup = (flags: readonly string[]): Result<PushSetup, string> => {
  try {
    const { values } = parseArgs({
      args: [...flags],
      options: {
        key: { type: "string" },
        "key-id": { type: "string" },
        "team-id": { type: "string" },
        "bundle-id": { type: "string" },
      },
    });
    const { key, "key-id": keyId, "team-id": teamId, "bundle-id": bundleId } = values;
    if (!key || !keyId || !teamId || !bundleId) return fail(`Usage: ${pushUsage}`);
    const privateKey = readKey(key);
    return privateKey.ok ? ok({ privateKey: privateKey.value, keyId, teamId, bundleId }) : privateKey;
  } catch (error) {
    return fail(describe(error));
  }
};

export const setUpPush = (flags: readonly string[], io: Io): number => {
  const parsed = parsePushSetup(flags);
  if (!parsed.ok) {
    io.printError(parsed.failure);
    return 1;
  }
  const { home } = toPaths(io.environment);
  mkdirSync(home, { recursive: true });
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  try {
    store.setSetting(apnsSettings.privateKey, parsed.value.privateKey);
    store.setSetting(apnsSettings.keyId, parsed.value.keyId);
    store.setSetting(apnsSettings.teamId, parsed.value.teamId);
    store.setSetting(apnsSettings.bundleId, parsed.value.bundleId);
  } finally {
    store.close();
  }
  io.print(`Saved. Ito sends notifications to ${parsed.value.bundleId} from now on; no restart needed.`);
  return 0;
};
