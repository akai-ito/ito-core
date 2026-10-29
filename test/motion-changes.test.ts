import { describe, expect, it } from "vitest";
import { loadSchemas } from "#protocol/schemas.ts";
import { createKinds } from "#motion/kinds.ts";
import {
  applyChanges,
  danglingIds,
  mergePatch,
  pruneState,
  strayIds,
  type Applied,
  type Fields,
} from "#motion/changes.ts";

const trip: Fields = {
  destination: "Florence",
  dates: { start: "2026-11-06", end: "2026-11-09" },
  days: [
    { id: "fri", date: "2026-11-06", stops: [{ id: "duomo", title: "The Duomo" }] },
    { id: "sat", date: "2026-11-07", stops: [{ id: "uffizi", title: "Uffizi", time: "08:15" }] },
  ],
  todo: [
    { id: "book-uffizi", text: "Book the Uffizi", done: false },
    { id: "pisa-train", text: "Pisa train tickets", done: false },
  ],
};

const card = { title: "Florence with Janki", summary: "6–9 Nov · 2 to book", pinned: true };

const florence: Applied = { card, content: trip };

const apply = (changes: Parameters<typeof applyChanges>[2]) => applyChanges("florence", florence, changes);

describe("changing a thing in motion by id", () => {
  it("sets an item's fields, removing those set to null", () => {
    const changed = apply([{ set: "uffizi", fields: { time: null, note: "Before the groups" } }]);

    expect(changed).toMatchObject({
      ok: true,
      value: { content: { days: [{}, { stops: [{ id: "uffizi", title: "Uffizi", note: "Before the groups" }] }] } },
    });
    expect(changed.ok && JSON.stringify(changed.value.content)).not.toContain("08:15");
  });

  it("sets the card and the content's own fields by the thing's id, never a list", () => {
    const changed = apply([{ set: "florence", fields: { summary: "6–9 Nov · 1 to book", destination: "Firenze" } }]);
    const listed = apply([{ set: "florence", fields: { todo: [] } }]);

    expect(changed).toMatchObject({
      ok: true,
      value: { card: { summary: "6–9 Nov · 1 to book", pinned: true }, content: { destination: "Firenze" } },
    });
    expect(listed).toEqual({ ok: false, failure: "todo is a list: change it with add, move and remove." });
  });

  it("adds after an item or first, into a day's stops by the day's id, and moves between lists", () => {
    const changed = apply([
      { add: { id: "mario", title: "Trattoria Mario", time: "20:00" }, to: "fri", after: "duomo" },
      { add: { id: "book-duomo", text: "Book the Duomo climb", done: false }, to: "todo" },
      { move: "uffizi", to: "fri", after: "duomo" },
    ]);

    expect(changed.ok && changed.value.content.days).toEqual([
      {
        id: "fri",
        date: "2026-11-06",
        stops: [
          { id: "duomo", title: "The Duomo" },
          { id: "uffizi", title: "Uffizi", time: "08:15" },
          { id: "mario", title: "Trattoria Mario", time: "20:00" },
        ],
      },
      { id: "sat", date: "2026-11-07", stops: [] },
    ]);
    expect(changed.ok && (changed.value.content.todo as readonly Fields[]).map(({ id }) => id)).toEqual([
      "book-duomo",
      "book-uffizi",
      "pisa-train",
    ]);
  });

  it("applies all of a change or none of it, and says which part failed", () => {
    expect(
      apply([
        { set: "book-uffizi", fields: { done: true } },
        { set: "nowhere", fields: { done: true } },
      ]),
    ).toEqual({ ok: false, failure: "Change 2: There's no item nowhere." });
    expect(apply([{ add: { id: "duomo", title: "Again" }, to: "sat" }])).toEqual({
      ok: false,
      failure: "duomo is already used in this thing: give the new item an id of its own.",
    });
    expect(apply([{ move: "fri", to: "fri" }])).toEqual({ ok: false, failure: "fri can't move inside itself." });
  });

  it("refuses a change that would remove more than half of what the thing holds", () => {
    expect(apply([{ remove: "fri" }, { remove: "sat" }])).toEqual({
      ok: false,
      failure:
        "That would remove more than half of what this thing holds. Change it a part at a time, or forget it " +
        "with forget_motion if it should go.",
    });
    expect(apply([{ remove: "pisa-train" }]).ok).toBe(true);
  });
});

describe("a thing's state", () => {
  it("merges a patch, where null removes", () => {
    expect(
      mergePatch(
        { todo: { "book-uffizi": { done: true }, "pisa-train": { done: true } } },
        { todo: { "pisa-train": null, "book-duomo": { done: true } } },
      ),
    ).toEqual({ todo: { "book-uffizi": { done: true }, "book-duomo": { done: true } } });
  });

  it("names ids that aren't in their list, and drops them when a change removes the item", () => {
    const state = { todo: { "book-uffizi": { done: true }, gone: { done: true } } };

    expect(strayIds(state, trip)).toEqual(["gone"]);
    expect(pruneState(state, trip)).toEqual({ todo: { "book-uffizi": { done: true } } });
    expect(pruneState({ todo: { gone: { done: true } } }, trip)).toEqual({});
  });
});

describe("a trip's shape", () => {
  const kinds = createKinds(loadSchemas());
  const whole = { ...trip, timezone: "Europe/Rome", who: ["Janki"], places: [], travel: [], stays: [] };

  it("accepts a whole trip, and says plainly what's wrong with one that isn't", () => {
    expect(kinds.checkContent("trip", whole)).toEqual({ ok: true, value: undefined });
    expect(
      kinds.checkContent("trip", { ...whole, days: [{ id: "fri", date: "6 Nov", stops: [{ id: "duomo" }] }] }),
    ).toEqual({
      ok: false,
      failure:
        'days.0.date must match pattern "^\\d{4}-\\d{2}-\\d{2}$". days.0.stops.0 must have required property ' +
        "'title'.",
    });
    expect(kinds.checkState("trip", { todo: { "book-uffizi": { done: "yes" } } }).ok).toBe(false);
    expect(kinds.checkChanges([{ remove: "fri", extra: true }]).ok).toBe(false);
  });
});

describe("what a thing's items name", () => {
  it("lists the ids a stop's place or a to-do's about names that aren't in the thing", () => {
    expect(
      danglingIds({
        days: [{ id: "fri", stops: [{ id: "dinner", place: "mario" }] }],
        todo: [{ id: "book", text: "Book", done: false, about: ["dinner", "train"] }],
      }),
    ).toEqual(["mario", "train"]);
  });
});
