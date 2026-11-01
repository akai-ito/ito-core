import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { Io } from "#cli/io.ts";
import { main, usage } from "#cli/main.ts";
import { systemClock } from "#clock.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { localDay } from "#log-file.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { packageVersion } from "#version.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-cli-"));

type Run = { readonly code: number; readonly printed: string; readonly errors: string };

const run = async (argv: readonly string[], isTerminal = false, itoHome = home): Promise<Run> => {
  const printed = createCell<readonly string[]>([]);
  const errors = createCell<readonly string[]>([]);
  const io: Io = {
    environment: { ITO_HOME: itoHome },
    isTerminal,
    print: (text) => {
      printed.set([...printed.get(), text]);
    },
    printError: (text) => {
      errors.set([...errors.get(), text]);
    },
    readSecret: () => Promise.resolve(""),
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

const entries = (printed: string): readonly string[] =>
  printed.split("\n").filter((each) => /^\d\d:\d\d:\d\d /u.test(each));

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

  it("pairs a device with a short-lived code, and a new token resets every paired one", async () => {
    const printed = createCell<readonly string[]>([]);
    const controller = new AbortController();
    const io: Io = {
      environment: { ITO_HOME: home },
      isTerminal: true,
      print: (text) => {
        printed.set([...printed.get(), text]);
      },
      printError: (text) => {
        printed.set([...printed.get(), text]);
      },
      readSecret: () => Promise.resolve(""),
      shutdown: controller.signal,
    };
    const pairing = main(["pair", "--address", "https://studio.example.ts.net:8443"], io);
    await expect.poll(() => printed.get().join("\n")).toMatch(/the code [2-9A-Z]{4}-[2-9A-Z]{4}\./u);
    const shown = /the code (?<code>[2-9A-Z]{4}-[2-9A-Z]{4})\./u.exec(printed.get().join("\n"))?.groups?.code ?? "";
    expect(printed.get().join("\n")).toContain("https://studio.example.ts.net:8443");
    const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
    const codeHash = hashToken(shown.replace("-", ""));
    expect(store.pairDevice(codeHash, "iPhone", hashToken("ito_paired_for_this_test"))).toBe(true);
    expect(store.pairDevice(codeHash, "iPad", hashToken("ito_paired_for_this_test_too"))).toBe(false);
    expect(store.pairedTokenHashes()).toEqual([hashToken("ito_paired_for_this_test")]);
    expect(await pairing).toBe(0);
    expect(printed.get().at(-1)).toBe("Paired iPhone.");

    const stopped = new AbortController();
    const cancelled = main(["pair", "--address", "https://studio.example.ts.net:8443"], {
      ...io,
      shutdown: stopped.signal,
    });
    await expect.poll(() => printed.get().filter((line) => line.includes("The code works once")).length).toBe(2);
    const cancelledCode =
      /the code (?<code>[2-9A-Z]{4}-[2-9A-Z]{4})\./u.exec(printed.get().at(-1) ?? "")?.groups?.code ?? "";
    stopped.abort();
    expect(await cancelled).toBe(1);
    const cancelledHash = hashToken(cancelledCode.replace("-", ""));
    expect(store.pairDevice(cancelledHash, "iPad", hashToken("unused"))).toBe(false);

    store.createPairingCode(hashToken("ABCDEFGH"), new Date(Date.now() + 60_000).toISOString());
    store.close();
    expect(await run(["token", "new"], true)).toMatchObject({ code: 0 });
    const after = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
    expect(after.pairedTokenHashes()).toEqual([]);
    expect(after.pairingCode(hashToken("ABCDEFGH"))).toBeUndefined();
    after.close();
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
    const today = path.join(home, "logs", `ito-${localDay(Date.now())}.log`);
    const logged = readFileSync(today, "utf8");
    expect(logged).toContain("Ito is listening on http://127.0.0.1:");
  });

  it("reads its own log back: by time, by area, only problems, or raw", async () => {
    const now = Date.now();
    const line = (minutesAgo: number, level: number, message: string, fields: Readonly<Record<string, unknown>> = {}) =>
      JSON.stringify({ level, time: now - minutesAgo * 60_000, pid: 1, hostname: "box", ...fields, msg: message });
    const lines = [
      line(180, 30, "Ito is listening on http://127.0.0.1:8787 with the codex engine"),
      line(90, 40, "Sent mail couldn't be read, so Kumo reads it next time", {
        account: "outlook",
        error: "Mail couldn't finish reading sent mail: Connection not available",
      }),
      line(60, 30, "incoming request", { reqId: "req-1", req: { method: "GET", url: "/v0/desk" } }),
      line(30, 50, "A notification didn't go out", { err: { message: "Notifications aren't set up" } }),
      line(10, 30, "Learnt your voiceprint"),
    ];
    const logs = path.join(home, "read-back", "logs");
    mkdirSync(logs, { recursive: true });
    for (const text of lines) {
      const { time } = JSON.parse(text) as { readonly time: number };
      appendFileSync(path.join(logs, `ito-${localDay(time)}.log`), `${text}\n`);
    }
    const readBack = (argv: readonly string[]): Promise<Run> => run(argv, false, path.dirname(logs));

    const problems = await readBack(["logs", "--problems", "--since", "2h"]);
    const mail = await readBack(["logs", "--about", "mail", "--since", "4h"]);
    const requests = await readBack(["logs", "--about", "requests", "--since", "4h", "--raw"]);
    const unknown = await readBack(["logs", "--about", "weather"]);

    expect(problems.code).toBe(0);
    expect(entries(problems.printed)).toEqual([
      expect.stringMatching(
        /^\d\d:\d\d:\d\d {2}WARN {3}Sent mail couldn't be read, so Kumo reads it next time {2}account=outlook error="Mail couldn't finish reading sent mail: Connection not available"$/u,
      ),
      expect.stringMatching(/ERROR {2}A notification didn't go out {2}error="Notifications aren't set up"$/u),
    ]);
    expect(mail.printed).toContain("Sent mail couldn't be read");
    expect(mail.printed).not.toContain("voiceprint");
    expect(mail.printed).not.toContain("incoming request");
    expect(requests.printed).toBe(lines[2]);
    expect(unknown.code).toBe(1);
    expect(unknown.errors).toContain('There\'s no area "weather"');
  });
});
