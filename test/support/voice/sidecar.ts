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

// A transcription that waits to be cancelled, as a long one would.
const waiting = new Map<string, number | string>();

const heardRecording = {
  seconds: 61.5,
  model: "nvidia/parakeet-tdt-0.6b-v2",
  segments: [
    { start: 0.4, end: 4.2, text: "Thanks for coming in. Could you tell me about Myra's team?", speaker: "S1" },
    { start: 5, end: 9.8, text: "Of course. I lead the tools group at Northwind.", speaker: "you" },
    { start: 10.5, end: 12, text: "Great." },
  ],
  speakers: [
    { id: "S1", seconds: 3.8, you: false },
    { id: "you", seconds: 4.8, you: true },
  ],
};

const transcribe = (id: number | string, parameters: Readonly<Record<string, unknown>>): void => {
  const job = String(parameters.job);
  appendFileSync("transcribe.log", `${JSON.stringify(parameters)}\n`);
  if (behaviour === "unreadable") {
    send({ id, error: { code: -32_003, message: "ffmpeg couldn't read the recording: Invalid data found" } });
    return;
  }
  send({ method: "transcribing", params: { job, done: 30, total: 61.5 } });
  if (behaviour === "slow-transcribe") {
    waiting.set(job, id);
    return;
  }
  send({ id, result: heardRecording });
};

const receive = ({ id, method = "", params: parameters = {} }: Message): void => {
  if (id === undefined) return;
  switch (method) {
    case "transcribe": {
      transcribe(id, parameters);
      return;
    }
    case "cancel_transcription": {
      const job = String(parameters.job);
      const pending = waiting.get(job);
      waiting.delete(job);
      if (pending !== undefined) send({ id: pending, error: { code: -32_004, message: "The transcription was cancelled." } });
      send({ id, result: {} });
      return;
    }
    case "initialize": {
      send({ id, result: { protocol: behaviour === "old" ? "0.0" : "0.3" } });
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
