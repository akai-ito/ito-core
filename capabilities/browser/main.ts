import { runCapability } from "#sdk/runtime.ts";
import { createBrowser } from "./browser.ts";

runCapability(createBrowser());
