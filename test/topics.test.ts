import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toMessageId, toTurnId } from "#conversation/ids.ts";
import type { Complete } from "#engine/engine.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { randomIdentifiers } from "#identifiers.ts";
import type { ModelChoice } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Store } from "#store/store.ts";
import { createTopics, historySetting } from "#topics/topics.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-topics-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

type Asked = { readonly prompt: string; readonly choice: ModelChoice | undefined };

const openStore = (name: string): Store =>
  createStore(openDatabase(path.join(home, `${name}.db`)), systemClock, randomIdentifiers);

const talk = (store: Store, id: string, said: string, answered: string): number => {
  const accepted = store.acceptMessage(toMessageId(`m_${id}`), said);
  const turn = toTurnId(`t_${id}`);
  store.startTurn(turn, [toMessageId(`m_${id}`)]);
  const reply = store.startMessage(turn, "reply");
  store.appendText(reply, answered);
  store.endMessage(reply, "completed", answered.length);
  store.endTurn(turn, "completed");
  return accepted.ok ? accepted.value.message.position : -1;
};

const answering = (answers: readonly unknown[]) => {
  const asked = createCell<readonly Asked[]>([]);
  const left = createCell(answers);
  const complete: Complete = (prompt, _schema, choice) => {
    asked.update((current) => [...current, { prompt, choice }]);
    const [next, ...rest] = left.get();
    left.set(rest);
    return Promise.resolve(ok(next));
  };
  return { asked, complete };
};

const models = () => Promise.resolve(ok(demoModels));

const info = (): void => undefined;

describe("topics", () => {
  it("labels the message that changed the subject after its turn, on the quick model, reusing earlier labels", async () => {
    const store = openStore("live");
    const { asked, complete } = answering([
      { changed: true, label: "Florence trip" },
      { changed: true, label: "QRT panel" },
      { changed: false, label: "" },
      { changed: true, label: " florence   trip " },
    ]);
    const topics = createTopics({ store, complete, models, info });
    await topics.idle();

    const florence = talk(store, "1", "Can you help me plan Florence with Janki?", "Of course! Three days fits it.");
    await topics.idle();
    const panel = talk(store, "2", "Different thing: what should I tell Bora about the QRT panel?", "Ask her.");
    await topics.idle();
    talk(store, "3", "And when should I send it?", "Before Friday.");
    await topics.idle();
    const back = talk(store, "4", "Back to Florence: which day for the Uffizi?", "The first morning.");
    await topics.idle();

    expect(store.listTopics().map(({ label, position }) => ({ label, position }))).toEqual([
      { label: "Florence trip", position: florence },
      { label: "QRT panel", position: panel },
      { label: "Florence trip", position: back },
    ]);
    expect(asked.get().map(({ choice }) => choice)).toEqual(
      Array.from({ length: 4 }, () => ({ model: "gpt-6-luna", effort: "low" })),
    );
    expect(asked.get()[2]?.prompt).toContain("Before it:\nThey said: Different thing:");
    expect(asked.get()[3]?.prompt).toContain('Labels so far: "QRT panel", "Florence trip".');
    expect(asked.get()[3]?.prompt).toContain('The subject now: "QRT panel".');
    topics.close();
  });

  it("labels the earlier conversation once, before any new turn", async () => {
    const store = openStore("history");
    const florence = talk(store, "1", "Can you help me plan Florence?", "Of course.");
    talk(store, "2", "Should we see Siena too?", "A morning is enough.");
    const panel = talk(store, "3", "What should I tell Bora about the QRT panel?", "Ask her.");
    const { asked, complete } = answering([
      {
        labels: [
          { exchange: 3, label: "QRT panel" },
          { exchange: 1, label: "Florence trip" },
        ],
      },
    ]);

    const topics = createTopics({ store, complete, models, info });
    await topics.idle();
    topics.close();
    const again = createTopics({ store, complete, models, info });
    await again.idle();
    again.close();

    expect(store.listTopics().map(({ label, position }) => ({ label, position }))).toEqual([
      { label: "Florence trip", position: florence },
      { label: "QRT panel", position: panel },
    ]);
    expect(asked.get()).toHaveLength(1);
    expect(asked.get()[0]?.prompt).toContain("2.\n   They said: Should we see Siena too?");
    expect(store.setting(historySetting)).toBe("done");
  });
});
