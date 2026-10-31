import { fail, ok, type Result } from "#result.ts";

export type Fields = Readonly<Record<string, unknown>>;

export type Item = Fields & { readonly id: string };

export type Change =
  | { readonly set: string; readonly fields: Fields }
  | { readonly add: Item; readonly to: string; readonly after?: string }
  | { readonly move: string; readonly to?: string; readonly after?: string }
  | { readonly remove: string };

export type Card = { readonly title: string; readonly summary: string; readonly pinned: boolean };

export type Applied = { readonly card: Card; readonly content: Fields };

type Lists = (list: string, items: readonly Item[]) => readonly Item[];

const cardFields: ReadonlySet<string> = new Set(["title", "summary", "pinned"]);

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isItem = (value: unknown): value is Item => isObject(value) && typeof value.id === "string";

export const listFields: ReadonlySet<string> = new Set([
  "days",
  "stops",
  "places",
  "travel",
  "stays",
  "todo",
  "weeks",
  "sessions",
  "results",
  "options",
  "prep",
  "timeline",
]);

const isList = (value: unknown, field: string): value is readonly Item[] =>
  listFields.has(field) && Array.isArray(value) && value.every((item) => isItem(item));

const rebuildItem = (item: Item, lists: Lists): Item =>
  Object.fromEntries(
    Object.entries(item).map(([field, value]) => [
      field,
      isList(value, field)
        ? lists(
            item.id,
            value.map((child) => rebuildItem(child, lists)),
          )
        : value,
    ]),
  ) as Item;

const rebuild = (content: Fields, lists: Lists): Fields =>
  Object.fromEntries(
    Object.entries(content).map(([field, value]) => [
      field,
      isList(value, field)
        ? lists(
            field,
            value.map((item) => rebuildItem(item, lists)),
          )
        : value,
    ]),
  );

const listsInItem = (item: Item): readonly (readonly [string, readonly Item[]])[] =>
  Object.entries(item)
    .filter((entry): entry is [string, readonly Item[]] => isList(entry[1], entry[0]))
    .flatMap(([, items]) => [[item.id, items] as const, ...items.flatMap((child) => listsInItem(child))]);

export const listsOf = (content: Fields): ReadonlyMap<string, readonly Item[]> =>
  new Map(
    Object.entries(content).flatMap(([field, value]) =>
      isList(value, field) ? [[field, value] as const, ...value.flatMap((item) => listsInItem(item))] : [],
    ),
  );

const listOf = (lists: ReadonlyMap<string, readonly Item[]>, id: string): string | undefined =>
  [...lists].find(([, items]) => items.some((item) => item.id === id))?.[0];

export const countItems = (content: Fields): number =>
  listsOf(content)
    .values()
    .reduce((total, items) => total + items.length, 0);

const withFields = (target: Fields, fields: Fields): Fields =>
  Object.fromEntries(
    [...Object.entries(target), ...Object.entries(fields)].filter(
      ([field], index, entries) => entries.findLastIndex(([other]) => other === field) === index,
    ),
  );

const withoutNulls = (fields: Fields): Fields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));

const insertAfter = (items: readonly Item[], item: Item, after: string | undefined): readonly Item[] => {
  if (after === undefined) return [item, ...items];
  const index = items.findIndex((candidate) => candidate.id === after);
  return [...items.slice(0, index + 1), item, ...items.slice(index + 1)];
};

const setThing = (applied: Applied, fields: Fields): Result<Applied, string> => {
  const lists = listsOf(applied.content);
  const listed = Object.keys(fields).find((field) => lists.has(field));
  if (listed !== undefined) return fail(`${listed} is a list: change it with add, move and remove.`);
  const card = Object.entries(fields).filter(([field]) => cardFields.has(field));
  const content = Object.entries(fields).filter(([field]) => !cardFields.has(field));
  const nextCard = { ...applied.card, ...Object.fromEntries(card) };
  const nextContent = withFields(applied.content, Object.fromEntries(content));
  return ok({ card: nextCard, content: withoutNulls(nextContent) });
};

const setItem = (applied: Applied, id: string, fields: Fields): Result<Applied, string> => {
  if ("id" in fields) return fail(`An item's id can't change: remove ${id} and add it again with the new id.`);
  const target = listsOf(applied.content)
    .values()
    .flatMap((items) => items)
    .find((item) => item.id === id);
  if (!target) return fail(`There's no item ${id}.`);
  const listed = Object.keys(fields).find((field) => listFields.has(field));
  if (listed !== undefined) return fail(`${listed} in ${id} is a list: change it with add, move and remove.`);
  const content = rebuild(applied.content, (_, items) =>
    items.map((item) => (item.id === id ? (withoutNulls(withFields(item, fields)) as Item) : item)),
  );
  return ok({ ...applied, content });
};

const add = (applied: Applied, thing: string, item: Item, to: string, after?: string): Result<Applied, string> => {
  const lists = listsOf(applied.content);
  if (item.id === thing || lists.has(item.id) || listOf(lists, item.id) !== undefined) {
    return fail(`${item.id} is already used in this thing: give the new item an id of its own.`);
  }
  const list = lists.get(to);
  if (!list) return fail(`There's no list ${to}.`);
  if (after !== undefined && list.every((candidate) => candidate.id !== after)) {
    return fail(`There's no item ${after} in ${to}.`);
  }
  return ok({
    ...applied,
    content: rebuild(applied.content, (name, items) => (name === to ? insertAfter(items, item, after) : items)),
  });
};

const remove = (applied: Applied, id: string): Result<Applied, string> => {
  if (listOf(listsOf(applied.content), id) === undefined) return fail(`There's no item ${id}.`);
  return ok({
    ...applied,
    content: rebuild(applied.content, (_, items) => items.filter((item) => item.id !== id)),
  });
};

const move = (applied: Applied, id: string, to?: string, after?: string): Result<Applied, string> => {
  const lists = listsOf(applied.content);
  const from = listOf(lists, id);
  if (from === undefined) return fail(`There's no item ${id}.`);
  const target = to ?? from;
  const item = lists.get(from)?.find((candidate) => candidate.id === id);
  if (!item || !lists.has(target)) return fail(`There's no list ${target}.`);
  if (after === id || target === id || listsOf({ inside: [item] }).has(target)) {
    return fail(`${id} can't move inside itself.`);
  }
  const removed = rebuild(applied.content, (_, items) => items.filter((candidate) => candidate.id !== id));
  if (
    after !== undefined &&
    !listsOf(removed)
      .get(target)
      ?.some((candidate) => candidate.id === after)
  ) {
    return fail(`There's no item ${after} in ${target}.`);
  }
  return ok({
    ...applied,
    content: rebuild(removed, (name, items) => (name === target ? insertAfter(items, item, after) : items)),
  });
};

const applyOne = (applied: Applied, thing: string, change: Change): Result<Applied, string> => {
  if ("set" in change) {
    return change.set === thing ? setThing(applied, change.fields) : setItem(applied, change.set, change.fields);
  }
  if ("add" in change) return add(applied, thing, change.add, change.to, change.after);
  if ("move" in change) return move(applied, change.move, change.to, change.after);
  return remove(applied, change.remove);
};

export const applyChanges = (thing: string, applied: Applied, changes: readonly Change[]): Result<Applied, string> => {
  const result = changes.reduce<Result<Applied, string>>((current, change, index) => {
    if (!current.ok) return current;
    const next = applyOne(current.value, thing, change);
    return next.ok || changes.length === 1 ? next : fail(`Change ${String(index + 1)}: ${next.failure}`);
  }, ok(applied));
  if (!result.ok) return result;
  const before = countItems(applied.content);
  const removesItems = changes.some((change) => "remove" in change);
  return removesItems && countItems(result.value.content) < before / 2
    ? fail(
        `That would remove more than half of what this thing holds. Change it a part at a time, or forget it with ` +
          "forget_motion if it should go.",
      )
    : result;
};

export const mergePatch = (target: unknown, patch: unknown): unknown => {
  if (!isObject(patch)) return patch;
  const base = isObject(target) ? target : {};
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(patch)])]
      .filter((key) => patch[key] !== null)
      .map((key) => [key, Object.hasOwn(patch, key) ? mergePatch(base[key], patch[key]) : base[key]]),
  );
};

const itemsInField = (value: unknown, field: string): readonly (readonly [string, Item])[] => {
  if (isList(value, field)) {
    return value.flatMap((item) => [
      [field, item] as const,
      ...Object.entries(item).flatMap(([child, nested]) => itemsInField(nested, child)),
    ]);
  }
  return [];
};

export const itemsByField = (content: Fields): ReadonlyMap<string, readonly Item[]> => {
  const pairs = Object.entries(content).flatMap(([field, value]) => itemsInField(value, field));
  return new Map(
    [...new Set(pairs.map(([field]) => field))].map((field) => [
      field,
      pairs.filter(([other]) => other === field).map(([, item]) => item),
    ]),
  );
};

export const strayIds = (state: Fields, content: Fields): readonly string[] => {
  const lists = itemsByField(content);
  return Object.entries(state).flatMap(([list, entries]) => {
    const ids = new Set((lists.get(list) ?? []).map((item) => item.id));
    return isObject(entries) ? Object.keys(entries).filter((id) => !ids.has(id)) : [];
  });
};

export const pruneState = (state: Fields, content: Fields): Fields => {
  const lists = itemsByField(content);
  return Object.fromEntries(
    Object.entries(state)
      .map(([list, entries]) => {
        const ids = new Set((lists.get(list) ?? []).map((item) => item.id));
        const kept = isObject(entries) ? Object.entries(entries).filter(([id]) => ids.has(id)) : [];
        return [list, Object.fromEntries(kept)] as const;
      })
      .filter(([, entries]) => Object.keys(entries).length > 0),
  );
};

const references = (item: Item): readonly string[] => [
  ...(typeof item.place === "string" ? [item.place] : []),
  ...(Array.isArray(item.about) ? item.about.filter((id): id is string => typeof id === "string") : []),
];

export const danglingIds = (content: Fields): readonly string[] => {
  const items = listsOf(content)
    .values()
    .flatMap((list) => list)
    .toArray();
  const ids = new Set(items.map((item) => item.id));
  return [...new Set(items.flatMap((item) => references(item)).filter((id) => !ids.has(id)))];
};
