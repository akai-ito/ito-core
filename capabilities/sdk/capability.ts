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
};

export type CallContext = Context & {
  readonly turn?: string;
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

export type Capability = Omit<Manifest, "operations"> & {
  readonly operations: readonly Operation[];
  readonly start?: (context: Context) => Promise<Result<undefined, string>>;
  readonly check?: (values: Values, server: Server) => Promise<string | undefined>;
};

export const defineOperation = <Input extends z.ZodObject>(operation: Operation<Input>): Operation => operation;

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
