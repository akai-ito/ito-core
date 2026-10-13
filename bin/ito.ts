#!/usr/bin/env node
import { main } from "#cli/main.ts";

const shutdown = new AbortController();
const stop = (): void => {
  shutdown.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

process.exitCode = await main(process.argv.slice(2), {
  environment: process.env,
  isTerminal: process.stdout.isTTY,
  print: (text) => {
    process.stdout.write(`${text}\n`);
  },
  printError: (text) => {
    process.stderr.write(`${text}\n`);
  },
  shutdown: shutdown.signal,
});
