import path from "node:path";
import type { Installed } from "#capabilities/host.ts";

export const testCapability = (id: "echo" | "reports"): Installed => ({
  id,
  entry: path.join(import.meta.dirname, "capabilities", `${id}.ts`),
});
