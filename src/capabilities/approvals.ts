import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Approval } from "#capabilities/manifest.ts";
import type { AskFields } from "#engine/engine.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";

export type CapabilityApprovalsOptions = {
  readonly store: Pick<Store, "sentAttachment" | "runningTurn">;
  readonly approve: (fields: AskFields) => Promise<boolean>;
};

export const createCapabilityApprovals =
  ({ store, approve }: CapabilityApprovalsOptions) =>
  async ({ question, preview, options, pictures = [] }: Approval): Promise<Result<boolean, string>> => {
    const sent = (file: string): string | undefined => {
      try {
        return store.sentAttachment(createHash("sha256").update(readFileSync(file)).digest("hex"));
      } catch {
        return undefined;
      }
    };
    const shown = pictures.map((file) => ({ file, attachment: sent(file) }));
    const strangers = shown.filter(({ attachment }) => attachment === undefined).map(({ file }) => path.basename(file));
    if (strangers.length > 0) {
      return fail(`Only pictures the person sent can go out, and ${strangers.join(", ")} isn't one.`);
    }
    if (!store.runningTurn()) return fail("Ari can only ask while it's answering them.");
    const attachments = shown.flatMap(({ attachment }) => attachment ?? []);
    return ok(
      await approve({
        kind: "approval",
        question,
        options: [...options],
        allows_text: true,
        preview,
        ...(attachments.length > 0 && { attachments }),
      }),
    );
  };
