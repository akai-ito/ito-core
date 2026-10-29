import { z } from "zod";
import { defineCapability, defineOperation, ok } from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

const say = defineOperation({
  name: "say",
  title: "Say something back",
  running: "Saying it back",
  done: "Said it back",
  description: "Says the text back.",
  input: z.object({ text: z.string().describe("What to say.") }),
  run: ({ text }) => Promise.resolve(ok({ text })),
});

runCapability(
  defineCapability({
    id: "sample",
    version: "0.1",
    kind: "hand",
    title: "Sample",
    summary: "A capability to try setting up with the demo engine: it says back what it's given.",
    skill: "Sample says back what it's given.",
    uses: { hosts: [], folders: [] },
    setup: [{ name: "token", kind: "secret", title: "Token", description: "Anything but wrong." }],
    operations: [say],
    check: (values) => Promise.resolve(values.token === "wrong" ? "That token is wrong." : undefined),
  }),
);
