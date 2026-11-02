import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toDeviceId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { apnsSettings } from "#notifications/apns.ts";
import { createProblems, lastingMs, mailProblem, pushDeliveryProblem, pushProblem } from "#problems/problems.ts";
import type { Problem } from "#protocol/types.ts";
import { createServer } from "#server.ts";
import { startFakeApns } from "./support/fake-apns.ts";
import { createFakeMail } from "./support/fake-mail.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-problems-"));
const token = "ito_problems_test_not_a_real_token_0000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("problems", () => {
  it("shows a refused sign-in at once, anything else only once it has lasted ten minutes", () => {
    const clock = createVirtualClock(Date.parse("2026-11-01T09:00:00.000Z"));
    const published = createCell<readonly Problem[]>([]);
    const problems = createProblems({
      clock,
      standing: () => [],
      publish: (current) => {
        published.set(current);
      },
    });
    problems.start();

    problems.report(
      "mail:outlook",
      { ok: false, reason: "Connection not available", isAuth: false },
      mailProblem("outlook"),
    );
    expect(published.get()).toEqual([]);
    problems.report("mail:outlook", { ok: true }, mailProblem("outlook"));
    clock.runNext(clock.now() + lastingMs);
    expect(published.get()).toEqual([]);

    problems.report("mail:outlook", { ok: false, reason: "imap down", isAuth: false }, mailProblem("outlook"));
    clock.moveTo(Date.parse("2026-11-01T09:21:00.000Z"));
    problems.refresh();
    expect(published.get()).toMatchObject([{ id: "mail:outlook", area: "mail", title: "Outlook mail isn't working" }]);

    problems.report("mail:icloud", { ok: false, reason: "rejected", isAuth: true }, mailProblem("icloud"));
    expect(published.get().map(({ id }) => id)).toEqual(["mail:outlook", "mail:icloud"]);
    expect(published.get()[1]?.fix).toBe(
      "Check the email address and the app password in Settings › Capabilities › iCloud.",
    );

    problems.report("mail:outlook", { ok: true }, mailProblem("outlook"));
    problems.report("mail:icloud", { ok: true }, mailProblem("icloud"));
    expect(published.get()).toEqual([]);
    problems.close();
  });

  it("lists a mail account that refuses the sign-in, and push that isn't set up, on the server", async () => {
    const mail = createFakeMail(() => new Date().toISOString());
    const server = createServer({
      dataDirectory: home,
      name: "problems",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(createVirtualClock(0), demoScripts, callTool, undefined, demoAnswers),
      createMailSource: mail.create,
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const listed = async (): Promise<unknown> => {
      const response = await server.app.inject({
        method: "GET",
        url: "/v0/problems",
        headers: { authorization: `Bearer ${token}` },
      });
      return response.json();
    };
    try {
      await server.host.ready;
      await server.host.setUp("outlook", { address: "divy@outlook.com", token: "replay-token" });
      await server.host.switchTo("outlook", true);
      mail.health("outlook", { ok: false, reason: "Couldn't sign in to outlook: expired", isAuth: true });

      expect(await listed()).toEqual({
        problems: [{ ...mailProblem("outlook")("Couldn't sign in to outlook: expired", true) }],
      });
      expect(server.store.snapshot("no_cursor").event.problems).toHaveLength(1);

      mail.health("outlook", { ok: true });
      server.store.registerDevice(toDeviceId("d_phone"), {
        apnsToken: "apns-device-token",
        environment: "production",
        notificationKey: Buffer.alloc(32).toString("base64"),
      });
      server.problems.refresh();
      expect(await listed()).toEqual({ problems: [pushProblem] });

      server.store.setSetting(apnsSettings.privateKey, "key");
      server.store.setSetting(apnsSettings.keyId, "KEY1234567");
      server.store.setSetting(apnsSettings.teamId, "TEAM123456");
      server.store.setSetting(apnsSettings.bundleId, "com.example.ari");
      server.problems.refresh();
      expect(await listed()).toEqual({ problems: [] });
      expect(server.store.snapshot("no_cursor").event.problems).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("shows notifications Apple turns away until one gets through", async () => {
    const apns = await startFakeApns();
    const server = createServer({
      dataDirectory: path.join(home, "push"),
      name: "problems",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(createVirtualClock(0), demoScripts, callTool, undefined, demoAnswers),
      push: { hosts: { production: apns.origin, sandbox: apns.origin } },
    });
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    server.store.setSetting(
      apnsSettings.privateKey,
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    server.store.setSetting(apnsSettings.keyId, "KEY1234567");
    server.store.setSetting(apnsSettings.teamId, "TEAM123456");
    server.store.setSetting(apnsSettings.bundleId, "com.example.ari");
    server.store.registerDevice(toDeviceId("d_phone"), {
      apnsToken: "0123456789abcdef".repeat(4),
      environment: "production",
      notificationKey: Buffer.alloc(32).toString("base64"),
    });
    try {
      apns.answerWith(403);
      server.store.postMessage("Hotel Orto confirmed you for 20–23 Nov.");
      await apns.next(2000);
      await expect
        .poll(() => server.store.problems())
        .toEqual([pushDeliveryProblem("APNs answered 403: BadDeviceToken", true)]);

      apns.answerWith(200);
      server.store.postMessage("Climbing with Leo moved to 20:00.");
      await apns.next(2000);
      await expect.poll(() => server.store.problems()).toEqual([]);
    } finally {
      await server.close();
      await apns.close();
    }
  });
});
