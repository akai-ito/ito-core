import os from "node:os";
import path from "node:path";

export type Paths = { readonly home: string; readonly codexHome: string; readonly workspace: string };

export const toPaths = (environment: NodeJS.ProcessEnv): Paths => {
  const home = environment.ITO_HOME ?? path.join(os.homedir(), ".ito");
  return { home, codexHome: path.join(home, "codex"), workspace: path.join(home, "workspace") };
};
