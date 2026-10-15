import { createRequire } from "node:module";

export const codexScript = (): string => createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");

export const codexVersion = (): string =>
  (createRequire(import.meta.url)("@openai/codex/package.json") as { readonly version: string }).version;
