import { runCapability } from "#sdk/runtime.ts";
import { createReports } from "./reports.ts";

runCapability(createReports());
