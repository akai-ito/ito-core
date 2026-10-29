import { fileURLToPath } from "node:url";
import type { Installed } from "#capabilities/host.ts";

const entryOf = (id: string): string => fileURLToPath(new URL(`../../capabilities/${id}/main.ts`, import.meta.url));

export const installed: readonly Installed[] = [{ id: "reports", entry: entryOf("reports") }];

export const demoInstalled: readonly Installed[] = [...installed, { id: "sample", entry: entryOf("sample") }];
