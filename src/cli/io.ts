export type Io = {
  readonly environment: NodeJS.ProcessEnv;
  readonly isTerminal: boolean;
  readonly print: (text: string) => void;
  readonly printError: (text: string) => void;
  readonly shutdown: AbortSignal;
};
