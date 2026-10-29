import { createCell } from "#cell.ts";
import { ok, type Result } from "#result.ts";
import { fingerprintLine, toComment, toFingerprint, toIssue, type Gap, type Versions } from "./gap.ts";
import type { GitHub } from "./github.ts";

export type Filed = { readonly url: string; readonly action: "opened" | "commented" };

export type Report = {
  readonly github: GitHub;
  readonly turn: string | undefined;
  readonly versions: Versions;
};

export type Reporter = {
  readonly report: (gap: Gap, report: Report) => Promise<Result<Filed | "over_limit", string>>;
};

type TurnReports = { readonly turn: string | undefined; readonly filed: ReadonlyMap<string, Filed> };

export const defaultDailyLimit = 20;

const dayMs = 24 * 60 * 60 * 1000;

const file = async (gap: Gap, { github, versions }: Report, fingerprint: string): Promise<Result<Filed, string>> => {
  const found = await github.findIssue(fingerprintLine(fingerprint));
  if (!found.ok) return found;
  if (found.value) {
    const commented = await github.comment(found.value.number, toComment(gap, versions));
    return commented.ok ? ok({ url: commented.value, action: "commented" }) : commented;
  }
  const opened = await github.openIssue(toIssue(gap, versions));
  return opened.ok ? ok({ url: opened.value.url, action: "opened" }) : opened;
};

export const createReporter = (now: () => number, dailyLimit: number): Reporter => {
  const attempts = createCell<readonly number[]>([]);
  const thisTurn = createCell<TurnReports>({ turn: undefined, filed: new Map() });

  const filedEarlier = (turn: string | undefined, fingerprint: string): Filed | undefined => {
    const current = thisTurn.get();
    return current.turn === turn ? current.filed.get(fingerprint) : undefined;
  };

  const remember = (turn: string | undefined, fingerprint: string, filed: Filed): void => {
    const current = thisTurn.get();
    const filedSoFar = current.turn === turn ? current.filed : new Map<string, Filed>();
    thisTurn.set({ turn, filed: new Map([...filedSoFar, [fingerprint, filed]]) });
  };

  return {
    report: async (gap, report) => {
      const fingerprint = toFingerprint(gap);
      const earlier = filedEarlier(report.turn, fingerprint);
      if (earlier) return ok(earlier);
      const recent = attempts.get().filter((at) => now() - at < dayMs);
      if (recent.length >= dailyLimit) return ok("over_limit");
      attempts.set([...recent, now()]);
      const filed = await file(gap, report, fingerprint);
      if (filed.ok) remember(report.turn, fingerprint, filed.value);
      return filed;
    },
  };
};
