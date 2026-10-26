import path from "node:path";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { openThread } from "#memory/thread.ts";

export const memoryUsage = "ito memory remote <git url> | ito memory pull";

const threadDirectory = (io: Io): string => path.join(toPaths(io.environment).home, "thread");

export const pullMemory = async (io: Io): Promise<number> => {
  const thread = await openThread(threadDirectory(io));
  const pulled = await thread.pull();
  if (!pulled.ok) {
    io.printError(pulled.failure);
    return 1;
  }
  io.print(
    pulled.value === "pulled"
      ? "Pulled. Ito takes the new pages into its search, and shows them as recently changed, the next time Ari uses memory."
      : "Memory already has everything the remote has.",
  );
  return 0;
};

export const setMemoryRemote = async (rest: readonly string[], io: Io): Promise<number> => {
  const [url] = rest;
  if (!url || rest.length !== 1) {
    io.printError(`Usage: ${memoryUsage}`);
    return 1;
  }
  const thread = await openThread(threadDirectory(io));
  const set = await thread.setRemote(url);
  if (!set.ok) {
    io.printError(`Git couldn't set the remote: ${set.failure}`);
    return 1;
  }
  io.print(
    `Saved. Ito pushes memory to ${url} after each change, with this machine's git credentials; ` +
      "it starts with the next change.",
  );
  return 0;
};
