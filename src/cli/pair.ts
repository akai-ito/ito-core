import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { renderUnicodeCompact } from "uqr";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { tailnetPort } from "#cli/serve.ts";
import { systemClock, toTimestamp } from "#clock.ts";
import { hashToken } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Store } from "#store/store.ts";

type Outcome = "expired" | "stopped" | { readonly deviceName: string };

const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const codeLength = 8;
const codeLifetimeMs = 5 * 60 * 1000;
const checkEveryMs = 1000;

const runFile = promisify(execFile);

export const createPairingCode = (): string =>
  Array.from({ length: codeLength }, () => codeAlphabet.charAt(randomInt(codeAlphabet.length))).join("");

export const toShownCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const tailnetAddress = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await runFile("tailscale", ["status", "--json"], { timeout: 5000 });
    const name = (JSON.parse(stdout) as { readonly Self?: { readonly DNSName?: string } }).Self?.DNSName;
    return name ? `https://${name.replace(/\.$/u, "")}:${String(tailnetPort)}` : undefined;
  } catch {
    return undefined;
  }
};

const waitForPairing = async (store: Store, hash: string, io: Io): Promise<Outcome> => {
  if (io.shutdown.aborted) return "stopped";
  const code = store.pairingCode(hash);
  if (code?.deviceName) return { deviceName: code.deviceName };
  if (!code || Date.parse(code.expiresAt) <= Date.now()) return "expired";
  await delay(checkEveryMs);
  return waitForPairing(store, hash, io);
};

export const pair = async (flags: readonly string[], io: Io): Promise<number> => {
  const { values } = parseArgs({ args: [...flags], options: { address: { type: "string" } } });
  const address = values.address ?? (await tailnetAddress());
  if (!address) {
    io.printError(
      "Couldn't find this machine's tailnet address. Pass it: ito pair --address https://<machine>.<tailnet>.ts.net:8443",
    );
    return 1;
  }
  const code = createPairingCode();
  const hash = hashToken(code);
  const { home } = toPaths(io.environment);
  mkdirSync(home, { recursive: true });
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  try {
    store.createPairingCode(hash, toTimestamp(Date.now() + codeLifetimeMs));
    const link = `ito://pair?address=${encodeURIComponent(address)}&code=${toShownCode(code)}`;
    io.print(
      [
        renderUnicodeCompact(link),
        "",
        `Scan this with Ari, or type the address ${address} and the code ${toShownCode(code)}.`,
        "The code works once, for five minutes.",
      ].join("\n"),
    );
    const outcome = await waitForPairing(store, hash, io);
    if (outcome === "stopped") {
      store.forgetPairingCode(hash);
      return 1;
    }
    if (outcome === "expired") {
      io.printError("The code expired. Run ito pair again for a new one.");
      return 1;
    }
    io.print(`Paired ${outcome.deviceName}.`);
    return 0;
  } finally {
    store.close();
  }
};
