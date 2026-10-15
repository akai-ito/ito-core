import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { Io } from "#cli/io.ts";
import { main, usage } from "#cli/main.ts";
import { systemClock } from "#clock.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { reportsTokenSetting } from "#reports/reporter.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { packageVersion } from "#version.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-cli-"));

type Run = { readonly code: number; readonly printed: string; readonly errors: string };

const run = async (argv: readonly string[], isTerminal = false, secret = ""): Promise<Run> => {
  const printed = createCell<readonly string[]>([]);
  const errors = createCell<readonly string[]>([]);
  const io: Io = {
    environment: { ITO_HOME: home },
    isTerminal,
    print: (text) => {
      printed.set([...printed.get(), text]);
    },
    printError: (text) => {
      errors.set([...errors.get(), text]);
    },
    readSecret: () => Promise.resolve(secret),
    shutdown: AbortSignal.abort(),
  };
  const code = await main(argv, io);
  return { code, printed: printed.get().join("\n"), errors: errors.get().join("\n") };
};

const storedSetting = (key: string): string | undefined => {
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  const value = store.setting(key);
  store.close();
  return value;
};

const storedTokenHash = (): string | undefined => storedSetting(tokenSetting);

const printedToken = (text: string): string => /ito_[\w-]{43}/u.exec(text)?.[0] ?? "";

describe("the ito command", () => {
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("prints its version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, printed: packageVersion(), errors: "" });
  });

  it("explains its usage for an unknown command", async () => {
    expect(await run(["launch"])).toEqual({ code: 1, printed: "", errors: usage });
  });

  it("makes a token only in a terminal, so it never reaches a log", async () => {
    const refused = await run(["token", "new"]);
    expect(refused.code).toBe(1);
    expect(refused.errors).toContain("in a terminal");
    expect(storedTokenHash()).toBeUndefined();

    const first = await run(["token", "new"], true);
    const second = await run(["token", "new"], true);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(printedToken(first.printed)).not.toBe(printedToken(second.printed));
    expect(storedTokenHash()).toBe(hashToken(printedToken(second.printed)));
  });

  it("keeps the reports token, asked for in a terminal without showing it", async () => {
    const refused = await run(["reports", "token"], false, "github_pat_example");
    expect(refused).toMatchObject({ code: 1, errors: expect.stringContaining("in a terminal") as string });
    expect(await run(["reports", "token"], true, "  ")).toMatchObject({ code: 1 });
    expect(storedSetting(reportsTokenSetting)).toBeUndefined();

    const saved = await run(["reports", "token"], true, " github_pat_example\n");
    expect(saved.code).toBe(0);
    expect(saved.printed).not.toContain("github_pat_example");
    expect(storedSetting(reportsTokenSetting)).toBe("github_pat_example");
  });

  it("keeps the APNs key and ids for notifications, refusing a key that isn't one", async () => {
    const keyFile = path.join(home, "AuthKey_KEY1234567.p8");
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    writeFileSync(keyFile, pem);
    const flags = [
      "--key",
      keyFile,
      "--key-id",
      "KEY1234567",
      "--team-id",
      "TEAM123456",
      "--bundle-id",
      "com.example.ari",
    ];
    expect(await run(["push", "setup", "--key", keyFile])).toMatchObject({ code: 1 });
    const rsaFile = path.join(home, "not-apns.pem");
    writeFileSync(
      rsaFile,
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    const wrong = await run(["push", "setup", ...flags.map((flag) => (flag === keyFile ? rsaFile : flag))]);
    expect(wrong).toMatchObject({ code: 1, errors: expect.stringContaining("isn't an APNs key") as string });
    expect(storedSetting(apnsSettings.keyId)).toBeUndefined();

    expect(await run(["push", "setup", ...flags])).toMatchObject({ code: 0 });
    expect(storedSetting(apnsSettings.privateKey)).toBe(pem);
    expect(storedSetting(apnsSettings.bundleId)).toBe("com.example.ari");
  });

  it("refuses an unknown engine or a bad port before starting", async () => {
    expect(await run(["serve", "--engine", "gpt"])).toMatchObject({
      code: 1,
      errors: "Unknown engine gpt: use codex or demo.",
    });
    expect(await run(["serve", "--port", "99999"])).toMatchObject({
      code: 1,
      errors: "99999 isn't a port number.",
    });
    expect(await run(["serve", "--verbose"])).toMatchObject({ code: 1 });
  });

  it("serves until it's asked to shut down, never printing a token outside a terminal", async () => {
    const served = await run(["serve", "--engine", "demo", "--port", "0"]);
    expect(served).toMatchObject({ code: 0, errors: "" });
    expect(printedToken(served.printed)).toBe("");
  });
});
