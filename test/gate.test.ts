import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const token = "ito_gate_test_not_a_real_token_000000000000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-gate-"));
const clock = createVirtualClock(Date.parse("2026-10-15T18:00:00.000Z"));
const server = createServer({
  dataDirectory: directory,
  createEngine: () =>
    createScriptEngine(clock, () => ({ events: [], steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at })),
  name: "studio",
  clock,
});
server.store.setSetting(tokenSetting, hashToken(token));

const statusOfAbsoluteForm = async (port: number, target: string): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    const sent = httpRequest({ host: "127.0.0.1", port, path: `http://127.0.0.1:${port}${target}` }, (answer) => {
      answer.resume();
      resolve(answer.statusCode);
    });
    sent.on("error", reject);
    sent.end();
  });

describe("the token gate", () => {
  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("guards a route however its path is spelled", async () => {
    for (const url of ["/v0/server", "/%760/server", "/v%30/server", "/v0/%73erver"]) {
      const refused = await server.app.inject({ method: "GET", url });
      expect(refused.statusCode, url).toBe(401);
    }
    const accepted = await server.app.inject({
      method: "GET",
      url: "/v%30/server",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("lets a pairing request through without a token, however it's spelled", async () => {
    for (const url of ["/v0/pair", "/v0/pair?from=qr", "/v%30/pair"]) {
      const answer = await server.app.inject({
        method: "POST",
        url,
        payload: { code: "ABCD-EFGH", device_name: "iPhone" },
      });
      expect(answer.json(), url).toMatchObject({ error: { code: "pairing_code_rejected" } });
    }
  });

  it("guards a request that names the whole URL", async () => {
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(await statusOfAbsoluteForm(port, "/v0/server")).toBe(401);
  });
});
