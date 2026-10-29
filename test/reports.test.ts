import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createTestCore, type TestCore } from "./support/capability-core.ts";
import { toFingerprint } from "#reports/gap.ts";
import { createReports } from "#reports/reports.ts";
import { startFakeGitHub, type FakeGitHub } from "./support/fake-github.ts";

const github = createCell<FakeGitHub | undefined>(undefined);

const parkrun = {
  capability: "web search",
  operation: "open a page",
  tried: "Opened the parkrun event page to read the start time",
  failed: "The page answered 403 to every fetch",
  would_help: "A browser that can load pages behind bot protection",
};

const currentGitHub = (): FakeGitHub => {
  const current = github.get();
  if (!current) throw new Error("No fake GitHub is running.");
  return current;
};

const openReports = async (token: string, dailyLimit = 20): Promise<TestCore> => {
  const fake = currentGitHub();
  const core = createTestCore(createReports({ apiUrl: fake.apiUrl, repository: fake.repository, dailyLimit }));
  await core.start({ token });
  return core;
};

describe("Reports", () => {
  beforeAll(async () => {
    github.set(await startFakeGitHub());
  });

  afterAll(async () => {
    await github.get()?.close();
  });

  it("opens a labelled issue from the template, then adds to it when the gap comes back", async () => {
    const fake = currentGitHub();
    const reports = await openReports(fake.token);

    const opened = await reports.call("report", parkrun, "t_one");
    const repeated = await reports.call("report", { ...parkrun, tried: "Opened it again" }, "t_one");
    const later = await reports.call(
      "report",
      { ...parkrun, would_help: " a browser that can load  pages behind bot protection " },
      "t_two",
    );

    const issue = `https://github.com/${fake.repository}/issues/1`;
    expect(opened).toEqual({
      ok: true,
      value: { text: `Reported as a new issue: ${issue}`, data: { url: issue, action: "opened" } },
    });
    expect(repeated).toEqual(opened);
    expect(later).toMatchObject({ ok: true, value: { data: { action: "commented" } } });
    expect(fake.issues()).toHaveLength(1);
    expect(fake.issues()[0]?.labels).toEqual(["gap"]);
    expect(fake.issues()[0]?.body.split("\n").slice(-3)).toEqual([
      "Ito 0.0.0-test · codex test",
      "",
      `Fingerprint: ${toFingerprint({ ...parkrun, wouldHelp: parkrun.would_help })}`,
    ]);
    expect(fake.issues()[0]?.comments).toHaveLength(1);
    reports.close();
  });

  it("tests a token before it's saved", async () => {
    const fake = currentGitHub();
    const reports = await openReports(fake.token);

    expect(await reports.check({ token: "github_pat_wrong" })).toBe("GitHub rejected that token.");
    expect(await reports.check({ token: fake.token })).toBeUndefined();
    reports.close();
  });

  it("says it needs you when GitHub rejects the token, and keeps reports past the daily limit in the log", async () => {
    const rejected = await openReports("github_pat_wrong");
    expect(await rejected.call("report", parkrun)).toEqual({
      ok: false,
      failure: "GitHub answered 401: Bad credentials.",
    });
    expect(rejected.statuses()).toEqual([{ state: "needs_you", detail: "GitHub rejected the token." }]);
    rejected.close();

    const limited = await openReports(currentGitHub().token, 1);
    await limited.call("report", { ...parkrun, would_help: "A maps source" }, "t_three");
    expect(await limited.call("report", { ...parkrun, would_help: "A trains source" }, "t_three")).toEqual({
      ok: false,
      failure: "Today's 1 reports are used up, so this one went to the log.",
    });
    limited.close();
  });
});
