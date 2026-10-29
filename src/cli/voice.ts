import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { Io } from "#cli/io.ts";
import { toPaths } from "#cli/paths.ts";
import { toVoiceEnvironment, voiceDirectory, voiceModels, voicePython } from "#voice/sidecar.ts";

export const voiceUsage = "ito voice check";

type Run = { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly log?: string };

const run = (command: string, parameters: readonly string[], { cwd, env, log }: Run): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, parameters, { cwd, env, stdio: ["inherit", "inherit", log ? "pipe" : "inherit"] });
    if (log && child.stderr) {
      const kept = createWriteStream(log);
      child.stderr.pipe(process.stderr, { end: false });
      child.stderr.pipe(kept);
    }
    child.once("error", () => {
      resolve(127);
    });
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });

const isServing = (): boolean => spawnSync("pgrep", ["-f", "ito_voice serve"]).status === 0;

const hasUv = (environment: NodeJS.ProcessEnv): boolean =>
  spawnSync("uv", ["--version"], { env: environment }).status === 0;

export const checkVoice = async (io: Io, directory = voiceDirectory): Promise<number> => {
  if (isServing()) {
    io.printError(
      "ito serve's voice is running and holds the GPU: stop ito serve, run ito voice check, then start ito serve again.",
    );
    return 1;
  }
  if (!hasUv(io.environment)) {
    io.printError(
      "The voice installs with uv, which isn't on this box: curl -LsSf https://astral.sh/uv/install.sh | sh, " +
        "then run ito voice check again.",
    );
    return 1;
  }
  io.print("Installing the voice's Python packages. The first time, that's about 6 GB.");
  const installed = await run("uv", ["sync", "--frozen", "--no-dev"], { cwd: directory, env: io.environment });
  if (installed !== 0) {
    io.printError("uv couldn't install the voice; what it said is above.");
    return 1;
  }
  const { home } = toPaths(io.environment);
  const report = path.join(home, "voice-check.md");
  const details = path.join(home, "voice-check-details.md");
  const log = path.join(home, "voice-check.log");
  io.print("Checking the voice. The first time, it downloads the models (about 3 GB); then it measures it.");
  const checked = await run(
    voicePython(directory),
    ["-m", "ito_voice", "check", "--report", report, "--details", details],
    { cwd: directory, env: toVoiceEnvironment(io.environment, voiceModels(home)), log },
  );
  io.print(
    `\nThe report is in ${report}, the details of any problem in ${details}, ` +
      `and everything the check printed along the way in ${log}.`,
  );
  return checked;
};
