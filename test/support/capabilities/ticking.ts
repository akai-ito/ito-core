import { z } from "zod";
import { defineCapability, defineOperation, ok } from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

const ticking = setInterval(Date.now, 60_000);

const stop = defineOperation({
  name: "stop",
  title: "Stop ticking",
  running: "Stopping",
  done: "Stopped",
  description: "Clears the timer.",
  input: z.object({}),
  run: () => {
    clearInterval(ticking);
    return Promise.resolve(ok({ text: "Stopped." }));
  },
});

runCapability(
  defineCapability({
    id: "ticking",
    version: "0.1",
    kind: "hand",
    title: "Ticking",
    summary: "Keeps a timer running, as a capability that watches a source would.",
    skill: "",
    uses: { hosts: [], folders: [] },
    setup: [],
    operations: [stop],
  }),
);
