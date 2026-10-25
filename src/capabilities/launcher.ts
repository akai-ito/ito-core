import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliFile = fileURLToPath(new URL("../../bin/ito.ts", import.meta.url));

const quoted = (text: string): string => `'${text.replaceAll("'", String.raw`'\''`)}'`;

export const writeLauncher = (file: string): string => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(cliFile)} "$@"\n`, { mode: 0o755 });
  return file;
};
