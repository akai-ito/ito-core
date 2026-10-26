import { canRunCapability, runCapability } from "#cli/capability.ts";
import type { Io } from "#cli/io.ts";
import { login } from "#cli/login.ts";
import { memoryUsage, setMemoryRemote } from "#cli/memory.ts";
import { pair } from "#cli/pair.ts";
import { pushUsage, setUpPush } from "#cli/push.ts";
import { setReportsToken } from "#cli/reports.ts";
import { serve } from "#cli/serve.ts";
import { newToken } from "#cli/token.ts";
import { packageVersion } from "#version.ts";

export const usage = [
  "Usage:",
  "  ito serve [--engine codex|demo] [--port 8787] [--name <name>]",
  "  ito token new",
  "  ito pair [--address <https://machine.tailnet.ts.net:8443>]",
  "  ito reports token",
  `  ${memoryUsage}`,
  `  ${pushUsage}`,
  "  ito login [codex login options]",
  "  ito <capability> <operation> [--flag value]…   (inside Ari's agent sessions)",
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
    case "reports": {
      return rest.length === 1 && rest[0] === "token" ? setReportsToken(io) : usageError(io);
    }
    case "memory": {
      const [subcommand, ...flags] = rest;
      return subcommand === "remote" ? setMemoryRemote(flags, io) : usageError(io);
    }
    case "push": {
      const [subcommand, ...flags] = rest;
      return subcommand === "setup" ? setUpPush(flags, io) : usageError(io);
    }
    case "pair": {
      return pair(rest, io);
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
      return canRunCapability(io) && /^[a-z]/u.test(command) ? runCapability(command, rest, io) : usageError(io);
    }
  }
};
