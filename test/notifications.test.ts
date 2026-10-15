import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toDeviceId, toTurnId } from "#conversation/ids.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { createApns, type ApnsCredentials } from "#notifications/apns.ts";
import { openNotification, sealNotification } from "#notifications/crypto.ts";
import { createNotifier } from "#notifications/notifier.ts";
import { createPresence } from "#notifications/presence.ts";
import { toFirstLine } from "#notifications/text.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, toKeyId } from "#store/store.ts";
import { startFakeApns, type FakeApns } from "./support/fake-apns.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-notifications-"));
const apnsServer = createCell<FakeApns | undefined>(undefined);
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credentials: ApnsCredentials = {
  keyId: "KEY1234567",
  teamId: "TEAM123456",
  bundleId: "com.example.ari",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const notificationKey = Buffer.from("01234567890123456789012345678901").toString("base64");
const device = {
  id: toDeviceId("5d1c7a3e-2b4f-4c6d-8e9f-0a1b2c3d4e5f"),
  apnsToken: "0123456789abcdef".repeat(4),
  environment: "production" as const,
  notificationKey,
  keyId: toKeyId(notificationKey),
  registeredAt: "2026-10-15T12:00:00.000Z",
};

const currentApns = (): FakeApns => {
  const current = apnsServer.get();
  if (!current) throw new Error("No fake APNs is running.");
  return current;
};

describe("notifications", () => {
  beforeAll(async () => {
    apnsServer.set(await startFakeApns());
  });

  afterAll(async () => {
    await apnsServer.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("seal a notification so only the device that owns the key opens it", () => {
    const notification = { kind: "reply" as const, text: "Here's a shape for Saturday:", message: "m_1", turn: "t_1" };
    const sealed = sealNotification(notification, device);
    expect(sealed).toMatchObject({ v: 1, k: device.keyId });
    expect(Buffer.from(sealed.n, "base64")).toHaveLength(12);
    expect(openNotification(sealed, device)).toEqual(notification);
    expect(() => openNotification(sealed, { ...device, id: "another-device" })).toThrow();
  });

  it("push its first line, Markdown stripped and kept short", () => {
    expect(toFirstLine("\n## **Booked:** [Juno](https://juno.example) in Clapham\nMore")).toBe(
      "Booked: Juno in Clapham",
    );
    expect(toFirstLine(`${"word ".repeat(60)}end`)).toMatch(/^word( word)+…$/u);
  });

  it("send through APNs with a signed provider token, and hear when a device is gone", async () => {
    const fake = currentApns();
    const apns = createApns(() => credentials, { production: fake.origin, sandbox: fake.origin }, systemClock);
    expect(await apns.send(device, { aps: {} }, Date.parse("2026-10-16T12:00:00.000Z"))).toEqual(ok("sent"));
    const [pushed] = fake.pushed();
    expect(pushed?.path).toBe(`/3/device/${device.apnsToken}`);
    expect(pushed?.headers).toMatchObject({
      "apns-topic": "com.example.ari",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Date.parse("2026-10-16T12:00:00.000Z") / 1000),
    });
    const [header = "", claims = "", signature = ""] = String(pushed?.headers.authorization)
      .replace("bearer ", "")
      .split(".", 3);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "TEAM123456" });
    const isSigned = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: createPublicKey(credentials.privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(isSigned).toBe(true);
    fake.answerWith(410);
    expect(await apns.send(device, { aps: {} }, Date.now())).toEqual(ok("gone"));
    fake.answerWith(400);
    expect(await apns.send(device, { aps: {} }, Date.now())).toEqual({
      ok: false,
      failure: "APNs answered 400: BadDeviceToken",
    });
    fake.answerWith(200);
    const impatient = createApns(
      () => credentials,
      { production: fake.origin, sandbox: fake.origin },
      systemClock,
      200,
    );
    fake.holdAnswers(true);
    expect(await impatient.send(device, { aps: {} }, Date.now())).toEqual({
      ok: false,
      failure: "APNs didn't answer within 0.2 seconds.",
    });
    fake.holdAnswers(false);
    impatient.close();
    const unconfigured = createCell<ApnsCredentials | undefined>(undefined);
    const unset = createApns(() => unconfigured.get(), { production: fake.origin, sandbox: fake.origin }, systemClock);
    expect(await unset.send(device, { aps: {} }, Date.now())).toMatchObject({ ok: false });
    apns.close();
  });

  it("forget a device APNs says is gone", async () => {
    const store = createStore(openDatabase(path.join(home, "gone.db")), systemClock, randomIdentifiers);
    store.registerDevice(device.id, device);
    const sent = createCell(0);
    const logged = createCell<readonly string[]>([]);
    const notifier = createNotifier({
      store,
      apns: {
        send: () => {
          sent.update((count) => count + 1);
          return Promise.resolve(ok("gone"));
        },
        close: () => {
          sent.set(-1);
        },
      },
      clock: systemClock,
      presence: createPresence(),
      agentName: "Ari",
      log: (message) => {
        logged.set([...logged.get(), message]);
      },
      reminderMs: 60_000,
    });
    store.startAsk(toTurnId("t_1"), {
      kind: "question",
      question: "Which Juno did you mean?",
      options: [],
      allows_text: true,
      secret: false,
    });
    await expect.poll(() => store.devices().length).toBe(0);
    expect(sent.get()).toBe(1);
    expect(logged.get()).toEqual([]);
    notifier.close();
    store.close();
  });
});
