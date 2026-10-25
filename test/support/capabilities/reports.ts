import { createInterface } from "node:readline";

type Message = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const manifest = {
  id: "reports",
  version: "0.1",
  kind: "hand",
  title: "Reports",
  symbol: "exclamationmark.bubble",
  summary: "Files the gaps Ari hits as public issues on Ito's repositories.",
  setup: [
    {
      name: "token",
      kind: "secret",
      title: "GitHub token",
      description: "A fine-grained token for akai-ito/ito-core, with Issues set to read and write.",
    },
  ],
  operations: [
    {
      name: "report",
      title: "Report a gap to Ito",
      running: "Reporting it to Ito",
      done: "Reported it to Ito",
      description: "Reports a gap you hit to Ito's developers, as a public GitHub issue.",
      input: {
        type: "object",
        properties: { capability: { type: "string" }, operation: { type: "string" } },
        required: ["capability", "operation"],
      },
      tool: "report_gap",
      publishes: true,
    },
  ],
  skill: "Report gaps with the report_gap tool.",
  uses: { hosts: ["api.github.com"], folders: [] },
};

const rejected = new Set(["github_pat_wrong", "github_pat_revoked"]);

const send = (message: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const answer = (id: number | string, method: string, parameters: Readonly<Record<string, unknown>>): void => {
  const token = (parameters.values as Readonly<Record<string, unknown>> | undefined)?.token;
  switch (method) {
    case "initialize": {
      send({ id, result: { protocol: parameters.protocol, manifest } });
      return;
    }
    case "check": {
      send({ id, result: rejected.has(String(token)) ? { problem: "GitHub rejected that token." } : {} });
      return;
    }
    case "start": {
      send(
        token === "github_pat_revoked"
          ? { id, error: { code: 1, message: "GitHub rejected the token." } }
          : { id, result: {} },
      );
      return;
    }
    case "call": {
      send({ id, result: { text: "Reported as a new issue: https://github.com/akai-ito/ito-core/issues/1" } });
      return;
    }
    default: {
      send({ id, error: { code: -32_601, message: `No method ${method}.` } });
    }
  }
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, method = "", params: parameters = {} } = JSON.parse(line) as Message;
  if (id !== undefined) answer(id, method, parameters);
});
