import type { FastifyInstance, FastifyReply } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { BrowserHand } from "#hands/browser.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Browser } from "#protocol/types.ts";
import type { Result } from "#result.ts";

export type BrowserRoutesOptions = {
  readonly hand: BrowserHand;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

// Kumo's browser, for the app: what it's doing, and the takeover lease. The live view is a WebSocket beside the call
// stream, in http/stream.ts.
const answer = (reply: FastifyReply, done: Result<Browser, string>): unknown =>
  done.ok
    ? { browser: done.value }
    : reply.code(503).send({ error: toCommandError("unavailable", done.failure, "Kumo's browser isn't available.") });

export const registerBrowser = (app: FastifyInstance, { hand, schemaFor }: BrowserRoutesOptions): void => {
  app.get("/v0/capabilities/browser/state", { schema: schemaFor("getBrowser") }, async (_request, reply) =>
    answer(reply, await hand.state()),
  );

  app.post("/v0/capabilities/browser/takeover", { schema: schemaFor("takeOverBrowser") }, async (_request, reply) =>
    answer(reply, await hand.take()),
  );

  app.delete("/v0/capabilities/browser/takeover", { schema: schemaFor("handBackBrowser") }, async (_request, reply) =>
    answer(reply, await hand.handBack()),
  );

  app.delete("/v0/capabilities/browser/task", { schema: schemaFor("stopBrowserTask") }, async (_request, reply) =>
    answer(reply, await hand.stop()),
  );
};
