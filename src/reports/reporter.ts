import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import type { TurnId } from "#conversation/ids.ts";
import { fingerprintLine, toComment, toFingerprint, toIssue, type Gap, type Versions } from "#reports/gap.ts";
import type { GitHub } from "#reports/github.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

export type Filed = { readonly url: string; readonly action: "opened" | "commented" };

export type Reporter = {
  readonly report: (turn: TurnId | undefined, gap: Gap) => Promise<Result<Filed, string>>;
};

export type ReporterOptions = {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly info: Info;
  readonly versions: Versions;
  readonly connect: (token: string) => GitHub;
  readonly dailyLimit: number;
};

type TurnReports = { readonly turn: TurnId | undefined; readonly filed: ReadonlyMap<string, Filed> };

export const reportsTokenSetting = "reports_github_token";

export const defaultDailyLimit = 20;

const dayMs = 24 * 60 * 60 * 1000;

export const createReporter = ({ settings, clock, info, versions, connect, dailyLimit }: ReporterOptions): Reporter => {
  const attempts = createCell<readonly number[]>([]);
  const thisTurn = createCell<TurnReports>({ turn: undefined, filed: new Map() });

  const filedEarlier = (turn: TurnId | undefined, fingerprint: string): Filed | undefined => {
    const current = thisTurn.get();
    return current.turn === turn ? current.filed.get(fingerprint) : undefined;
  };

  const remember = (turn: TurnId | undefined, fingerprint: string, filed: Filed): void => {
    const current = thisTurn.get();
    const filedSoFar = current.turn === turn ? current.filed : new Map<string, Filed>();
    thisTurn.set({ turn, filed: new Map([...filedSoFar, [fingerprint, filed]]) });
  };

  const file = async (github: GitHub, gap: Gap, fingerprint: string): Promise<Result<Filed, string>> => {
    const found = await github.findIssue(fingerprintLine(fingerprint));
    if (!found.ok) return found;
    if (found.value) {
      const commented = await github.comment(found.value.number, toComment(gap, versions));
      return commented.ok ? ok({ url: commented.value, action: "commented" }) : commented;
    }
    const opened = await github.openIssue(toIssue(gap, versions));
    return opened.ok ? ok({ url: opened.value.url, action: "opened" }) : opened;
  };

  return {
    report: async (turn, gap) => {
      const fingerprint = toFingerprint(gap);
      const earlier = filedEarlier(turn, fingerprint);
      if (earlier) return ok(earlier);
      const token = settings.setting(reportsTokenSetting);
      if (!token) return fail("Reporting isn't set up on this server yet: run ito reports token there.");
      const recent = attempts.get().filter((at) => clock.now() - at < dayMs);
      if (recent.length >= dailyLimit) {
        info("A gap report went to the log instead, past today's limit", { fingerprint, ...gap });
        return fail(`Today's ${dailyLimit} reports are used up, so this one went to the server log.`);
      }
      attempts.set([...recent, clock.now()]);
      const filed = await file(connect(token), gap, fingerprint);
      if (filed.ok) remember(turn, fingerprint, filed.value);
      return filed;
    },
  };
};
