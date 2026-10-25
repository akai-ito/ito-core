import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Message = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const manifest = {
  id: "echo",
  version: "0.1",
  kind: "hand",
  title: "Echo",
  summary: "Says back what it's given.",
  setup: [
    { name: "token", kind: "secret", title: "Token" },
    { name: "loud", kind: "toggle", title: "Loud", optional: true },
  ],
  operations: [
    {
      name: "say",
      title: "Say something back",
      running: "Echoing",
      done: "Echoed",
      description: "Says the text back.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      tool: "echo_say",
    },
    {
      name: "inspect",
      title: "Show what it was given",
      running: "Looking",
      done: "Looked",
      description: "Shows its values, folder and environment.",
      input: { type: "object" },
    },
    {
      name: "crash",
      title: "Crash",
      running: "Crashing",
      done: "Crashed",
      description: "Exits at once.",
      input: { type: "object" },
    },
    {
      name: "wait",
      title: "Wait until cancelled",
      running: "Waiting",
      done: "Waited",
      description: "Answers only when cancelled.",
      input: { type: "object" },
    },
    {
      name: "complain",
      title: "Say it needs you",
      running: "Complaining",
      done: "Complained",
      description: "Reports that it needs the person.",
      input: { type: "object" },
    },
  ],
  skill: "Use echo to hear yourself.",
  uses: { hosts: [], folders: [] },
};

const values = { current: {} as Readonly<Record<string, unknown>> };
const waiting = new Set<number | string>();

const send = (message: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const answer = (id: number | string, result: unknown): void => {
  send({ id, result });
};

const refuse = (id: number | string, message: string): void => {
  send({ id, error: { code: 1, message } });
};

const call = (id: number | string, operation: unknown, input: unknown): void => {
  switch (operation) {
    case "say": {
      const text = String((input as { readonly text?: unknown }).text);
      answer(id, { text: values.current.loud === true ? text.toUpperCase() : text });
      return;
    }
    case "inspect": {
      answer(id, {
        text: "Here's what I was given.",
        data: {
          values: values.current,
          cwd: process.cwd(),
          environment: Object.keys(process.env).toSorted((left, right) => left.localeCompare(right)),
        },
      });
      return;
    }
    case "crash": {
      process.kill(process.pid, "SIGKILL");
      return;
    }
    case "wait": {
      waiting.add(id);
      return;
    }
    case "complain": {
      send({ method: "status", params: { state: "needs_you", detail: "The token stopped working." } });
      answer(id, { text: "Complained." });
      return;
    }
    default: {
      refuse(id, `No operation ${String(operation)}.`);
    }
  }
};

const receive = ({ id, method = "", params: parameters = {} }: Message): void => {
  if (method === "cancel") {
    const cancelled = parameters.id as number | string;
    if (waiting.delete(cancelled)) refuse(cancelled, "Cancelled.");
    return;
  }
  if (id === undefined) return;
  switch (method) {
    case "initialize": {
      answer(id, { protocol: parameters.protocol, manifest });
      return;
    }
    case "start": {
      const given = parameters.values as Readonly<Record<string, unknown>>;
      if (given.token === "wrong") {
        refuse(id, "The token was rejected.");
        return;
      }
      values.current = given;
      writeFileSync("pid", String(process.pid));
      answer(id, {});
      return;
    }
    case "check": {
      const given = parameters.values as Readonly<Record<string, unknown>>;
      answer(id, given.token === "wrong" ? { problem: "That token is wrong." } : {});
      return;
    }
    case "call": {
      call(id, parameters.operation, parameters.input);
      return;
    }
    default: {
      refuse(id, `No method ${method}.`);
    }
  }
};

const heartbeat = setInterval(Date.now, 60_000);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  receive(JSON.parse(line) as Message);
});
lines.on("close", () => {
  clearInterval(heartbeat);
  process.exit(0);
});
