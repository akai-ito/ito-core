import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { codexScript } from "#engine/codex/binary.ts";

export const login = async (codexFlags: readonly string[], io: Io): Promise<number> => {
  const { codexHome } = toPaths(io.environment);
  mkdirSync(codexHome, { recursive: true });
  const child = spawn(process.execPath, [codexScript(), "login", ...codexFlags], {
    stdio: "inherit",
    env: { ...io.environment, CODEX_HOME: codexHome },
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return code ?? 1;
};
