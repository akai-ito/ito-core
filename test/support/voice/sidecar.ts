import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Message = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const behaviour = existsSync("behaviour") ? readFileSync("behaviour", "utf8").trim() : "ready";

if (behaviour === "crash-once" && !existsSync("crashed")) {
  writeFileSync("crashed", "");
  process.stderr.write("Segmentation fault\n");
  process.exit(3);
}

const send = (message: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const status = (state: string, reason?: string): void => {
  send({ method: "status", params: reason === undefined ? { state } : { state, reason } });
};

writeFileSync("pid", String(process.pid));
writeFileSync("environment", JSON.stringify(Object.keys(process.env).toSorted((left, right) => left.localeCompare(right))));

if (behaviour === "no-gpu") status("failed", "There's no NVIDIA GPU this box's PyTorch can use: no driver.");
else status("loading", "The voice models are still loading.");

const receive = ({ id, method = "", params: parameters = {} }: Message): void => {
  if (id === undefined) return;
  switch (method) {
    case "initialize": {
      send({ id, result: { protocol: behaviour === "old" ? "0.0" : "0.2" } });
      return;
    }
    case "vocabulary": {
      appendFileSync("vocabulary.log", `${JSON.stringify(parameters.phrases)}\n`);
      if (behaviour !== "no-gpu") status("ready");
      send({ id, result: {} });
      return;
    }
    case "speak": {
      if (behaviour === "no-gpu") {
        send({ id, error: { code: -32_002, message: "There's no NVIDIA GPU this box's PyTorch can use: no driver." } });
        return;
      }
      appendFileSync("spoken.log", `${JSON.stringify(parameters)}\n`);
      send({ id, result: { audio: Buffer.from([1, 0, 255, 127]).toString("base64"), rate: 24_000 } });
      return;
    }
    default: {
      send({ id, error: { code: -32_601, message: `No ${method}.` } });
    }
  }
};

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  if (line.trim() !== "") receive(JSON.parse(line) as Message);
}
