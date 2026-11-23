import { z } from "zod";
import type { Approval, CallResult, Manifest, Server, Status, Values } from "#capabilities/manifest.ts";
import type { Result } from "#result.ts";

export { fail, ok, type Result } from "#result.ts";
export type { Approval, CallResult, Field, Server, Status, Values } from "#capabilities/manifest.ts";

export type Context = {
  readonly values: Values;
  readonly folder: string;
  readonly server: Server;
  readonly status: (status: Status) => void;
  // Tells Ito something as it happens, such as a hand's live state, for the part of Ito that follows it.
  readonly publish: (topic: string, data: unknown) => void;
  // Asks Ito to do something only Ito can, such as putting a card on the Desk, and waits for its answer.
  readonly request: (name: string, data: unknown) => Promise<Result<unknown, string>>;
};

export type CallContext = Context & {
  readonly turn?: string;
  // The side thread the call comes from, and the piece of background work, when there's one.
  readonly thread?: string;
  readonly run?: string;
  readonly signal: AbortSignal;
  readonly approve: (approval: Approval) => Promise<Result<boolean, string>>;
};

export type Operation<Input extends z.ZodObject = z.ZodObject> = {
  readonly name: string;
  readonly title: string;
  readonly running: string;
  readonly done: string;
  readonly description: string;
  readonly input: Input;
  readonly tool?: string;
  readonly run: (input: z.infer<Input>, context: CallContext) => Promise<Result<CallResult, string>>;
};

// A control is for Ito alone, such as the app taking over a hand's page: it's never in the manifest, so the agent
// never sees it as a tool or a command.
export type Control<Input extends z.ZodObject = z.ZodObject> = {
  readonly name: string;
  readonly input: Input;
  readonly run: (input: z.infer<Input>, context: Context) => Promise<Result<unknown, string>>;
};

export type Capability = Omit<Manifest, "operations"> & {
  readonly operations: readonly Operation[];
  readonly controls?: readonly Control[];
  readonly start?: (context: Context) => Promise<Result<undefined, string>>;
  // Tidies up when Ito stops it, such as closing a browser so its profile is written whole.
  readonly stop?: () => Promise<void>;
  readonly check?: (values: Values, server: Server) => Promise<string | undefined>;
};

export const defineOperation = <Input extends z.ZodObject>(operation: Operation<Input>): Operation => operation;

export const defineControl = <Input extends z.ZodObject>(control: Control<Input>): Control => control;

export const defineCapability = (capability: Capability): Capability => capability;

const toInputSchema = (input: z.ZodObject): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(z.toJSONSchema(input)).filter(([key]) => key !== "$schema"));

export const toManifest = ({
  id,
  version,
  kind,
  title,
  symbol,
  summary,
  setup,
  operations,
  skill,
  uses,
}: Capability): Manifest => ({
  id,
  version,
  kind,
  title,
  ...(symbol !== undefined && { symbol }),
  summary,
  setup,
  operations: operations.map(({ name, title: operationTitle, running, done, description, input, tool }) => ({
    name,
    title: operationTitle,
    running,
    done,
    description,
    input: toInputSchema(input),
    ...(tool !== undefined && { tool }),
  })),
  skill,
  uses,
});
