import type { ModelChoice, ModelOption } from "#protocol/types.ts";
import type { Result } from "#result.ts";

const quickModel = "luna";

export type QuickChoice = () => Promise<ModelChoice | undefined>;

export const createQuickChoice =
  (models: () => Promise<Result<readonly ModelOption[], string>>): QuickChoice =>
  async () => {
    const listed = await models();
    const quick = listed.ok ? listed.value.find(({ id }) => id.includes(quickModel)) : undefined;
    const lowest = quick?.efforts[0];
    return quick && lowest ? { model: quick.id, effort: lowest.id } : undefined;
  };
