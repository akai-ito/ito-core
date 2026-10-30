import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createReports } from "#reports/reports.ts";
import type { Approval } from "#sdk/capability.ts";
import { createTestCore, testServer, type TestCore } from "./support/capability-core.ts";
import { startFakeGitHub, type FakeGitHub } from "./support/fake-github.ts";

const github = createCell<FakeGitHub | undefined>(undefined);
const workspace = mkdtempSync(path.join(os.tmpdir(), "ito-reports-"));
const screenshot = Buffer.from("the Library shelves, as a picture");
const shelves = path.join(workspace, "uploads", "library.png");

const library = {
  title: "Library shelves need icons, not clipped names",
  body: "The shelves show fragments of page titles that end in ellipses, so they read like search results.",
};

const currentGitHub = (): FakeGitHub => {
  const current = github.get();
  if (!current) throw new Error("No fake GitHub is running.");
  return current;
};

const openReports = async (
  token: string,
  answers: readonly boolean[] = [],
): Promise<{ readonly core: TestCore; readonly asked: () => readonly Approval[] }> => {
  const fake = currentGitHub();
  const asked = createCell<readonly Approval[]>([]);
  const core = createTestCore(
    createReports({
      apiUrl: fake.apiUrl,
      repository: fake.repository,
      mediaRepository: fake.mediaRepository,
      now: () => new Date("2026-10-30T12:00:00Z"),
    }),
    {
      server: { ...testServer, workspace },
      approve: (approval) => {
        const count = asked.update((current) => [...current, approval]).length;
        return answers[count - 1] ?? false;
      },
    },
  );
  await core.start({ token });
  return { core, asked: () => asked.get() };
};

describe("Reports", () => {
  beforeAll(async () => {
    github.set(await startFakeGitHub());
    mkdirSync(path.dirname(shelves), { recursive: true });
    writeFileSync(shelves, screenshot);
  });

  afterAll(async () => {
    await github.get()?.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("files a draft only once they agree, with their screenshot stored and shown in the issue", async () => {
    const fake = currentGitHub();
    const { core, asked } = await openReports(fake.token, [false, true]);
    const report = { ...library, screenshots: [{ file: "uploads/library.png", shows: "the Library shelves" }] };

    const declined = await core.call("report", report);
    const filed = await core.call("report", report);

    const issue = `https://github.com/${fake.repository}/issues/1`;
    const media = `2026/10/${createHash("sha256").update(screenshot).digest("hex").slice(0, 16)}.png`;
    expect(declined).toEqual({
      ok: false,
      failure: "They didn't file it. If they said what to change, change the draft and report again.",
    });
    expect(filed).toEqual({
      ok: true,
      value: { text: `Filed as issue #1: ${issue}`, data: { url: issue, action: "opened" } },
    });
    expect(asked()[1]).toEqual({
      question: "File this on GitHub?",
      preview: [
        library.title,
        "",
        library.body,
        "",
        "Screenshots: the Library shelves",
        "Public, on akai-ito/ito-core.",
      ].join("\n"),
      options: [{ label: "File it", acts: true }, { label: "Don't" }],
      pictures: [shelves],
    });
    expect(fake.issues()).toEqual([
      {
        number: 1,
        title: library.title,
        body: [
          library.body,
          `![the Library shelves](https://raw.githubusercontent.com/${fake.mediaRepository}/main/${media})`,
          "Ito 0.0.0-test · codex test",
        ].join("\n\n"),
        labels: ["from-ari"],
        comments: [],
      },
    ]);
    expect(fake.media().keys().toArray()).toEqual([media]);
    core.close();
  });

  it("adds a follow-up to the issue it belongs to, found among the open issues", async () => {
    const fake = currentGitHub();
    const { core, asked } = await openReports(fake.token, [true]);

    const recent = await core.call("recent", {});
    const followed = await core.call("report", {
      body: "An icon with the shelf's name and count, and no description, is a good outcome too.",
      issue: 1,
    });

    expect(recent).toEqual({
      ok: true,
      value: { text: `#1 ${library.title} (active 2026-10-30) https://github.com/${fake.repository}/issues/1` },
    });
    expect(asked()[0]).toMatchObject({
      question: "Add this to issue #1 on GitHub?",
      options: [{ label: "Add it", acts: true }, { label: "Don't" }],
    });
    expect(followed).toMatchObject({ ok: true, value: { data: { action: "commented" } } });
    expect(fake.issues()[0]?.comments).toEqual([
      "An icon with the shelf's name and count, and no description, is a good outcome too.\n\nIto 0.0.0-test · codex test",
    ]);
    core.close();
  });

  it("refuses a picture from outside what they sent, and a new report without a title", async () => {
    const fake = currentGitHub();
    const { core, asked } = await openReports(fake.token, [true]);

    const stray = await core.call("report", {
      ...library,
      screenshots: [{ file: "../ito.db", shows: "the database" }],
    });
    const untitled = await core.call("report", { body: library.body });

    expect(stray).toEqual({ ok: false, failure: "../ito.db isn't a picture they sent: use one saved in uploads/." });
    expect(untitled).toEqual({ ok: false, failure: "A new report needs a title." });
    expect(asked()).toEqual([]);
    core.close();
  });

  it("tests a token before it's saved", async () => {
    const fake = currentGitHub();
    const { core } = await openReports(fake.token);

    expect(await core.check({ token: "github_pat_wrong" })).toBe("GitHub rejected that token.");
    expect(await core.check({ token: fake.token })).toBeUndefined();
    core.close();
  });

  it("says it needs you when GitHub rejects the token", async () => {
    const { core } = await openReports("github_pat_wrong", [true]);

    expect(await core.call("report", library)).toEqual({ ok: false, failure: "GitHub answered 401: Bad credentials." });
    expect(core.statuses()).toEqual([{ state: "needs_you", detail: "GitHub rejected the token." }]);
    core.close();
  });
});
