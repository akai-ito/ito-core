import { createReports } from "#reports/reports.ts";
import { defineCapability, fail, ok } from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

const rejected = new Set(["github_pat_wrong", "github_pat_revoked"]);

const reports = createReports();

runCapability(
  defineCapability({
    ...reports,
    start: ({ values }) =>
      Promise.resolve(values.token === "github_pat_revoked" ? fail("GitHub rejected the token.") : ok(undefined)),
    check: (values) => Promise.resolve(rejected.has(String(values.token)) ? "GitHub rejected that token." : undefined),
    operations: reports.operations.map((operation) => ({
      ...operation,
      run: () => Promise.resolve(ok({ text: "Filed as issue #1: https://github.com/akai-ito/ito-core/issues/1" })),
    })),
  }),
);
