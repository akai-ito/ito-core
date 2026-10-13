import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { Io } from "#cli/io.ts";
import { main, usage } from "#cli/main.ts";
import { systemClock } from "#clock.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { databaseFile } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { packageVersion } from "#version.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-cli-"));

type Run = { readonly code: number; readonly printed: string; readonly errors: string };

const run = async (argv: readonly string[], isTerminal = false): Promise<Run> => {
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
    shutdown: AbortSignal.abort(),
  };
  const code = await main(argv, io);
  return { code, printed: printed.get().join("\n"), errors: errors.get().join("\n") };
};

const storedTokenHash = (): string | undefined => {
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  const hash = store.setting(tokenSetting);
  store.close();
  return hash;
};

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
