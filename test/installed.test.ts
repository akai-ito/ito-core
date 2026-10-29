import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { maxTools } from "#capabilities/doors.ts";
import { createHost } from "#capabilities/host.ts";
import { demoInstalled, installed } from "#capabilities/installed.ts";
import { coreCommands } from "#cli/main.ts";
import { systemClock } from "#clock.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { memoryToolNames } from "#memory/tool-names.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-installed-"));
const coreToolNames = ["ask", ...memoryToolNames];

describe("the capabilities installed with the server", () => {
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("all start and describe themselves, within the tool budget and without taking core's names", async () => {
    const database = openDatabase(path.join(home, "ito.db"));
    const host = createHost({
      installed: demoInstalled,
      server: { version: "0.0.0", engine: "Codex test" },
      settings: createStore(database, systemClock, randomIdentifiers),
      folders: home,
      clock: systemClock,
      info: () => true,
    });
    await host.ready;
    const capabilities = host.list();
    await host.close();

    const tools = capabilities.flatMap(({ manifest }) => manifest?.operations.flatMap(({ tool }) => tool ?? []) ?? []);
    expect(installed.map(({ id }) => id)).toContain("reports");
    expect(capabilities.filter(({ manifest }) => manifest === undefined)).toEqual([]);
    expect(coreToolNames.length + tools.length).toBeLessThanOrEqual(maxTools);
    expect(new Set([...coreToolNames, ...tools]).size).toBe(coreToolNames.length + tools.length);
    expect(capabilities.map(({ id }) => id).filter((id) => coreCommands.includes(id))).toEqual([]);
  });
});
