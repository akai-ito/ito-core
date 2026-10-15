export type Io = {
  readonly environment: NodeJS.ProcessEnv;
  readonly isTerminal: boolean;
  readonly print: (text: string) => void;
  readonly printError: (text: string) => void;
  readonly readSecret: (prompt: string) => Promise<string>;
  readonly shutdown: AbortSignal;
};
