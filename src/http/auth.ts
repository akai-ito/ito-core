import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";

export const tokenSetting = "token_sha256";

export type GateVerdict = "accepted" | "rejected" | "slow_down";

export type Gate = {
  readonly check: (authorization: string | undefined) => GateVerdict;
  readonly refuse: () => GateVerdict;
  readonly isSlowedDown: () => boolean;
  readonly retryAfterSeconds: () => number;
};

export type FailureBudget = { readonly failures: number; readonly windowMs: number };

const defaultBudget: FailureBudget = { failures: 10, windowMs: 60_000 };

export const createToken = (): string => `ito_${randomBytes(32).toString("base64url")}`;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const isMatching = (token: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const bearerToken = (authorization = ""): string | undefined =>
  /^Bearer (?<token>\S+)$/u.exec(authorization)?.groups?.token;

export const createGate = (
  expectedHashes: () => readonly string[],
  clock: Clock,
  budget: FailureBudget = defaultBudget,
): Gate => {
  const failures = createCell<readonly number[]>([]);
  const recent = (): readonly number[] => failures.get().filter((at) => clock.now() - at < budget.windowMs);

  const refuse = (): GateVerdict => {
    if (recent().length >= budget.failures) return "slow_down";
    failures.set([...recent(), clock.now()]);
    return "rejected";
  };

  return {
    check: (authorization) => {
      const token = bearerToken(authorization);
      return token && expectedHashes().some((hash) => isMatching(token, hash)) ? "accepted" : refuse();
    },
    refuse,
    isSlowedDown: () => recent().length >= budget.failures,
    retryAfterSeconds: () => {
      const [oldest] = recent();
      return oldest === undefined ? 0 : Math.ceil((budget.windowMs - (clock.now() - oldest)) / 1000);
    },
  };
};
