import type { FastifyInstance } from "fastify";
import type { AccessKeeper } from "#access/access.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { FullAccessConsent } from "#protocol/types.ts";

export type AccessRouteOptions = {
  readonly access: AccessKeeper;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

// Full access goes on only through its own command, whose body says it's meant: no other call turns it on.
export const registerAccess = (app: FastifyInstance, { access, schemaFor }: AccessRouteOptions): void => {
  app.get("/v0/access", { schema: schemaFor("getAccess") }, () => access.current());

  app.post<{ Body: FullAccessConsent }>("/v0/access/full", { schema: schemaFor("giveFullAccess") }, () =>
    access.giveFull(),
  );

  app.delete("/v0/access/full", { schema: schemaFor("endFullAccess") }, () => access.endFull());
};
