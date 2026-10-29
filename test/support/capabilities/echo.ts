import { writeFileSync } from "node:fs";
import { z } from "zod";
import { defineCapability, defineOperation, fail, ok } from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

const nothing = z.object({});

const say = defineOperation({
  name: "say",
  title: "Say something back",
  running: "Echoing",
  done: "Echoed",
  description: "Says the text back.",
  input: z.object({ text: z.string() }),
  tool: "echo_say",
  run: ({ text }, { values }) => Promise.resolve(ok({ text: values.loud === true ? text.toUpperCase() : text })),
});

const inspect = defineOperation({
  name: "inspect",
  title: "Show what it was given",
  running: "Looking",
  done: "Looked",
  description: "Shows its values, folder and environment.",
  input: nothing,
  run: (_input, { values }) =>
    Promise.resolve(
      ok({
        text: "Here's what I was given.",
        data: {
          values,
          cwd: process.cwd(),
          environment: Object.keys(process.env).toSorted((left, right) => left.localeCompare(right)),
        },
      }),
    ),
});

const crash = defineOperation({
  name: "crash",
  title: "Crash",
  running: "Crashing",
  done: "Crashed",
  description: "Exits at once.",
  input: nothing,
  run: () => {
    process.kill(process.pid, "SIGKILL");
    return Promise.resolve(fail("It didn't crash."));
  },
});

const wait = defineOperation({
  name: "wait",
  title: "Wait until cancelled",
  running: "Waiting",
  done: "Waited",
  description: "Answers only when cancelled.",
  input: nothing,
  run: (_input, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(fail("Cancelled."));
      });
    }),
});

const complain = defineOperation({
  name: "complain",
  title: "Say it needs you",
  running: "Complaining",
  done: "Complained",
  description: "Reports that it needs the person.",
  input: nothing,
  run: (_input, { status }) => {
    status({ state: "needs_you", detail: "The token stopped working." });
    return Promise.resolve(ok({ text: "Complained." }));
  },
});

const heartbeat = setInterval(Date.now, 60_000);

runCapability(
  defineCapability({
    id: "echo",
    version: "0.1",
    kind: "hand",
    title: "Echo",
    summary: "Says back what it's given.",
    setup: [
      { name: "token", kind: "secret", title: "Token" },
      { name: "loud", kind: "toggle", title: "Loud", optional: true },
    ],
    operations: [say, inspect, crash, wait, complain],
    skill: "Use echo to hear yourself.",
    uses: { hosts: [], folders: [] },
    start: ({ values }) => {
      if (values.token === "wrong") return Promise.resolve(fail("The token was rejected."));
      writeFileSync("pid", String(process.pid));
      return Promise.resolve(ok(undefined));
    },
    check: (values) => Promise.resolve(values.token === "wrong" ? "That token is wrong." : undefined),
  }),
  {
    input: process.stdin,
    output: process.stdout,
    onClose: () => {
      clearInterval(heartbeat);
      process.exit(0);
    },
  },
);
