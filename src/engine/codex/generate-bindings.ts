import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexScript } from "#engine/codex/binary.ts";

const bindingsDirectory = path.join(import.meta.dirname, "bindings");

const toFileSpecifier = (directory: string, specifier: string): string =>
  existsSync(path.join(directory, `${specifier}.ts`)) ? `${specifier}.ts` : `${specifier}/index.ts`;

const withExtensions = (file: string): string =>
  readFileSync(file, "utf8").replaceAll(
    /from "(?<specifier>\.{1,2}\/[^"]+)"/gu,
    (_match, specifier: string) => `from "${toFileSpecifier(path.dirname(file), specifier)}"`,
  );

const emptyHome = mkdtempSync(path.join(os.tmpdir(), "ito-codex-"));
try {
  rmSync(bindingsDirectory, { recursive: true, force: true });
  execFileSync(process.execPath, [codexScript(), "app-server", "generate-ts", "--out", bindingsDirectory], {
    stdio: "inherit",
    env: { ...process.env, CODEX_HOME: emptyHome },
  });
  const files = globSync("**/*.ts", { cwd: bindingsDirectory }).map((file) => path.join(bindingsDirectory, file));
  for (const file of files) writeFileSync(file, withExtensions(file));
} finally {
  rmSync(emptyHome, { recursive: true, force: true });
}
