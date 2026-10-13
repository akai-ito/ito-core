import type { Io } from "#cli/io.ts";
import { login } from "#cli/login.ts";
import { serve } from "#cli/serve.ts";
import { newToken } from "#cli/token.ts";
import { packageVersion } from "#version.ts";

export const usage = [
  "Usage:",
  "  ito serve [--engine codex|demo] [--port 8787] [--name <name>]",
  "  ito token new",
  "  ito login [codex login options]",
  "  ito --version",
].join("\n");

const usageError = (io: Io): number => {
  io.printError(usage);
  return 1;
};

export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const [command = "", ...rest] = argv;
  switch (command) {
    case "serve": {
      return serve(rest, io);
    }
    case "token": {
      return rest.length === 1 && rest[0] === "new" ? newToken(io) : usageError(io);
    }
    case "login": {
      return login(rest, io);
    }
    case "--version": {
      io.print(packageVersion());
      return 0;
    }
    case "--help": {
      io.print(usage);
      return 0;
    }
    default: {
      return usageError(io);
    }
  }
};
