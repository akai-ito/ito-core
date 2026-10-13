import { createRequire } from "node:module";

export const codexScript = (): string => createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
