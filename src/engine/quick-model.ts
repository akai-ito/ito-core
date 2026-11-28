import type { ModelChoice, ModelOption } from "#protocol/types.ts";
import type { Result } from "#result.ts";

const quickModel = "luna";
const thoroughEffort = "high";

// The quick model, thinking least, for a small judgement. One that must see images needs a model that can: the quick
// one if it does, or else the default model thinking least.
export type QuickChoice = (needs?: { readonly images?: boolean }) => Promise<ModelChoice | undefined>;

export type Stakes = "low" | "high";

// The model and effort for background work, by what's at stake: undefined leaves it to the person's choice.
export type StakesChoice = (stakes: Stakes) => Promise<ModelChoice | undefined>;

type Models = () => Promise<Result<readonly ModelOption[], string>>;

export const createQuickChoice =
  (models: Models): QuickChoice =>
  async ({ images = false } = {}) => {
    const listed = await models();
    const fits = ({ images: seesImages }: ModelOption): boolean => seesImages || !images;
    const quick = listed.ok
      ? (listed.value.find((model) => model.id.includes(quickModel) && fits(model)) ??
        (images ? listed.value.find((model) => model.is_default && fits(model)) : undefined))
      : undefined;
    const lowest = quick?.efforts[0];
    return quick && lowest ? { model: quick.id, effort: lowest.id } : undefined;
  };

const thoroughOn = (model: ModelOption, chosen: string | undefined): ModelChoice => {
  const efforts = model.efforts.map(({ id }) => id);
  const wanted = efforts.includes(thoroughEffort) ? thoroughEffort : (efforts.at(-1) ?? model.default_effort);
  // Never less than they chose themselves.
  const effort = chosen !== undefined && efforts.indexOf(chosen) > efforts.indexOf(wanted) ? chosen : wanted;
  return { model: model.id, effort };
};

const lightOn = (models: readonly ModelOption[], main: ModelOption): ModelChoice | undefined => {
  const quick = models.find(({ id }) => id.includes(quickModel));
  if (quick) return { model: quick.id, effort: quick.default_effort };
  const lowest = main.efforts[0];
  return lowest && { model: main.id, effort: lowest.id };
};

// Real stakes, such as a person writing or an interview, get their chosen model thinking hard; routine mail gets the
// quick model, or else their model thinking least.
export const createStakesChoice =
  (models: Models, chosen: () => ModelChoice | undefined): StakesChoice =>
  async (stakes) => {
    const listed = await models();
    if (!listed.ok) return;
    const choice = chosen();
    const main =
      listed.value.find(({ id }) => id === choice?.model) ??
      listed.value.find(({ is_default: isDefault }) => isDefault) ??
      listed.value[0];
    if (!main) return;
    return stakes === "high"
      ? thoroughOn(main, choice?.model === main.id ? choice.effort : undefined)
      : lightOn(listed.value, main);
  };
