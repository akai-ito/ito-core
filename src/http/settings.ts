import type { FastifyInstance } from "fastify";
import type { RouteSchema } from "#http/validation.ts";
import type { Store } from "#store/store.ts";

export const leadSetting = "lead_name";

export const defaultLead = "Kumo";

export type SettingsOptions = {
  readonly store: Pick<Store, "setting" | "setSetting">;
  readonly onLeadRenamed: () => void;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

export const leadOf = (store: Pick<Store, "setting">): string => store.setting(leadSetting) ?? defaultLead;

export const registerSettings = (app: FastifyInstance, { store, onLeadRenamed, schemaFor }: SettingsOptions): void => {
  app.put<{ Body: { readonly name: string } }>("/v0/lead", { schema: schemaFor("renameLead") }, (request) => {
    const name = request.body.name.trim();
    store.setSetting(leadSetting, name);
    onLeadRenamed();
    return { name };
  });
};
