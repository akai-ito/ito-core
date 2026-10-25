import type { Io } from "#cli/io.ts";
import { commandsPath, type CommandBody } from "#http/tools.ts";
import { serverUrlVariable, toolsTokenVariable } from "#tools/mcp.ts";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Access = { readonly origin: string; readonly token: string };

const toAccess = (environment: NodeJS.ProcessEnv): Access => ({
  origin: environment[serverUrlVariable] ?? "",
  token: environment[toolsTokenVariable] ?? "",
});

export const canRunCapability = (io: Io): boolean => {
  const { origin, token } = toAccess(io.environment);
  return origin !== "" && token !== "";
};

export const runCapability = async (capability: string, rest: readonly string[], io: Io): Promise<number> => {
  const { origin, token } = toAccess(io.environment);
  const body: CommandBody = { capability, arguments: rest };
  try {
    const response = await fetch(new URL(commandsPath, origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const { text = `Ito answered ${String(response.status)}.` } = (await response.json()) as { readonly text?: string };
    if (response.ok) io.print(text);
    else io.printError(text);
    return response.ok ? 0 : 1;
  } catch (error) {
    io.printError(`Ito couldn't be reached at ${origin}: ${describe(error)}`);
    return 1;
  }
};
