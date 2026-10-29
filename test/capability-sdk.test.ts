import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCell } from "#cell.ts";
import { defineCapability, defineOperation, ok } from "#sdk/capability.ts";
import { createTestCore, type TestCore } from "./support/capability-core.ts";

const cores = createCell<readonly TestCore[]>([]);

const say = defineOperation({
  name: "say",
  title: "Say something back",
  running: "Echoing",
  done: "Echoed",
  description: "Says the text back.",
  input: z.object({ text: z.string().describe("What to say.") }),
  tool: "echo_say",
  run: (input, { turn }) => Promise.resolve(ok({ text: input.text, data: { turn } })),
});

const echo = defineCapability({
  id: "echo",
  version: "0.1",
  kind: "hand",
  title: "Echo",
  summary: "Says back what it's given.",
  skill: "Use echo to hear yourself.",
  uses: { hosts: [], folders: [] },
  setup: [{ name: "token", kind: "secret", title: "Token" }],
  operations: [say],
});

const openCore = async (): Promise<TestCore> => {
  const core = createTestCore(echo);
  cores.update((current) => [...current, core]);
  await core.start({ token: "secret-1" });
  return core;
};

afterEach(() => {
  for (const core of cores.get()) core.close();
  cores.set([]);
});

describe("the SDK", () => {
  it("turns one definition into a manifest, with each input as JSON Schema", async () => {
    const core = await openCore();

    expect(await core.manifest()).toMatchObject({
      id: "echo",
      setup: [{ name: "token", kind: "secret", title: "Token" }],
      operations: [
        {
          name: "say",
          tool: "echo_say",
          input: {
            type: "object",
            properties: { text: { type: "string", description: "What to say." } },
            required: ["text"],
          },
        },
      ],
    });
  });

  it("checks input against the operation's schema before running it", async () => {
    const core = await openCore();

    expect(await core.call("say", { text: "hi" }, "t_1")).toEqual({
      ok: true,
      value: { text: "hi", data: { turn: "t_1" } },
    });
    expect(await core.call("say", { text: 3 })).toEqual({
      ok: false,
      failure: "That input doesn't fit: text: Invalid input: expected string, received number.",
    });
  });

  it("exits when its standard input closes, even with a timer running", async () => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "support", "capabilities", "ticking.ts")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await once(child.stdout, "data");

    child.stdin.end();

    expect(await once(child, "exit")).toEqual([0, null]);
  });
});
