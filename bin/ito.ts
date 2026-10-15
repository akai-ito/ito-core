#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { main } from "#cli/main.ts";

const shutdown = new AbortController();
const stop = (): void => {
  shutdown.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const readSecret = async (prompt: string): Promise<string> => {
  const hidden = new Writable({
    write: (_chunk, _encoding, done) => {
      done();
    },
  });
  const lines = createInterface({ input: process.stdin, output: hidden, terminal: true });
  const cancel = new AbortController();
  lines.once("SIGINT", () => {
    cancel.abort();
  });
  process.stdout.write(prompt);
  try {
    return await lines.question("", { signal: cancel.signal });
  } catch {
    return "";
  } finally {
    lines.close();
    process.stdout.write("\n");
  }
};

process.exitCode = await main(process.argv.slice(2), {
  environment: process.env,
  isTerminal: process.stdout.isTTY,
  print: (text) => {
    process.stdout.write(`${text}\n`);
  },
  printError: (text) => {
    process.stderr.write(`${text}\n`);
  },
  readSecret,
  shutdown: shutdown.signal,
});
