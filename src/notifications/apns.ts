import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings, StoredDevice } from "#store/store.ts";

export type ApnsCredentials = {
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly privateKey: string;
};

export type ApnsHosts = { readonly production: string; readonly sandbox: string };

export type ApnsOutcome = "sent" | "gone";

export type Apns = {
  readonly send: (
    device: Pick<StoredDevice, "apnsToken" | "environment">,
    payload: unknown,
    expiresAt: number,
  ) => Promise<Result<ApnsOutcome, string>>;
  readonly close: () => void;
};

type ProviderToken = { readonly value: string; readonly issuedAt: number; readonly keyId: string };

export const appleHosts: ApnsHosts = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export const apnsSettings = {
  privateKey: "apns_private_key",
  keyId: "apns_key_id",
  teamId: "apns_team_id",
  bundleId: "apns_bundle_id",
} as const;

const tokenLifetimeMs = 50 * 60 * 1000;
const defaultAnswerWithinMs = 30_000;

export const readApnsCredentials = (settings: Settings): ApnsCredentials | undefined => {
  const privateKey = settings.setting(apnsSettings.privateKey);
  const keyId = settings.setting(apnsSettings.keyId);
  const teamId = settings.setting(apnsSettings.teamId);
  const bundleId = settings.setting(apnsSettings.bundleId);
  return privateKey && keyId && teamId && bundleId ? { privateKey, keyId, teamId, bundleId } : undefined;
};

const base64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

export const toProviderToken = (credentials: ApnsCredentials, issuedAtMs: number): string => {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(issuedAtMs / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(credentials.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
};

const reasonOf = (body: string): string => {
  try {
    const reason: unknown = (JSON.parse(body) as { readonly reason?: unknown }).reason;
    return typeof reason === "string" ? reason : body;
  } catch {
    return body;
  }
};

const toOutcome = (status: number, body: string): Result<ApnsOutcome, string> => {
  if (status === 200) return ok("sent");
  return status === 410 ? ok("gone") : fail(`APNs answered ${String(status)}: ${reasonOf(body)}`);
};

export const createApns = (
  credentials: () => ApnsCredentials | undefined,
  hosts: ApnsHosts,
  clock: Clock,
  answerWithinMs = defaultAnswerWithinMs,
): Apns => {
  const sessions = createCell<ReadonlyMap<string, ClientHttp2Session>>(new Map());
  const token = createCell<ProviderToken | undefined>(undefined);

  const forget = (origin: string, session: ClientHttp2Session): void => {
    sessions.update((current) =>
      current.get(origin) === session ? new Map([...current].filter(([key]) => key !== origin)) : current,
    );
  };

  const sessionFor = (origin: string): ClientHttp2Session => {
    const existing = sessions.get().get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.on("error", () => {
      forget(origin, session);
    });
    session.on("close", () => {
      forget(origin, session);
    });
    sessions.update((current) => new Map([...current, [origin, session]]));
    return session;
  };

  const providerToken = (current: ApnsCredentials): string => {
    const cached = token.get();
    const now = clock.now();
    if (cached?.keyId === current.keyId && now - cached.issuedAt < tokenLifetimeMs) return cached.value;
    const value = toProviderToken(current, now);
    token.set({ value, issuedAt: now, keyId: current.keyId });
    return value;
  };

  return {
    send: async (device, payload, expiresAt) => {
      const current = credentials();
      if (!current) return fail("Notifications aren't set up on this server yet: run ito push setup there.");
      const authorization = `bearer ${providerToken(current)}`;
      return new Promise((resolve) => {
        const request = sessionFor(hosts[device.environment]).request({
          ":method": "POST",
          ":path": `/3/device/${device.apnsToken}`,
          authorization,
          "apns-topic": current.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(expiresAt / 1000)),
          "content-type": "application/json",
        });
        const status = createCell(0);
        const body = createCell("");
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status.set(Number(headers[":status"]));
        });
        request.on("data", (chunk: string) => {
          body.update((text) => text + chunk);
        });
        request.on("end", () => {
          resolve(toOutcome(status.get(), body.get()));
        });
        request.on("error", (error: Error) => {
          resolve(fail(`APNs couldn't be reached: ${error.message}`));
        });
        request.setTimeout(answerWithinMs, () => {
          request.close();
          resolve(fail(`APNs didn't answer within ${String(answerWithinMs / 1000)} seconds.`));
        });
        request.end(JSON.stringify(payload));
      });
    },
    close: () => {
      for (const session of sessions.get().values()) session.close();
      sessions.set(new Map());
    },
  };
};
