import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Installed } from "#capabilities/host.ts";

type PackageFile = { readonly ito?: { readonly capabilities?: Readonly<Record<string, string>> } };

export const capabilitiesPackage = "ito-capabilities";

export const bundledDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  capabilitiesPackage,
);

const readPackage = (directory: string): PackageFile | undefined => {
  try {
    return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as PackageFile;
  } catch {
    return undefined;
  }
};

export const findInstalled = (directory: string): readonly Installed[] =>
  Object.entries(readPackage(directory)?.ito?.capabilities ?? {}).map(([id, entry]) => ({
    id,
    entry: path.resolve(directory, entry),
  }));
