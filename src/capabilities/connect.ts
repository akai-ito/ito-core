import type { Clock } from "#clock.ts";
import type { DeviceConnect } from "#capabilities/manifest.ts";
import { fail, ok, type Result } from "#result.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type DeviceCode = {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly deviceCode: string;
  readonly intervalMs: number;
};

type Answer = Readonly<Record<string, unknown>>;

type Poll =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "pending"; readonly intervalMs: number }
  | { readonly kind: "ended"; readonly reason: string };

const grantType = "urn:ietf:params:oauth:grant-type:device_code";
const answerMs = 30_000;
const slowDownMs = 5000;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isAnswer = (value: unknown): value is Answer =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const secondsOf = (value: unknown, fallback: number): number =>
  typeof value === "number" && value > 0 ? value : fallback;

const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const post = async (
  fetcher: Fetch,
  url: string,
  fields: Readonly<Record<string, string>>,
): Promise<Result<Answer, string>> => {
  const { host } = new URL(url);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(answerMs),
    });
    const answer: unknown = await response.json();
    return isAnswer(answer) ? ok(answer) : fail(`${host} answered ${String(response.status)}.`);
  } catch (error) {
    return fail(`${host} couldn't be reached: ${describe(error)}`);
  }
};

const reasonOf = (answer: Answer, fallback: string): string =>
  textOf(answer.error_description) ?? textOf(answer.error) ?? fallback;

export const requestDeviceCode = async (
  connect: DeviceConnect,
  fetcher: Fetch,
  now: number,
): Promise<Result<DeviceCode, string>> => {
  const answered = await post(fetcher, connect.deviceUrl, {
    client_id: connect.clientId,
    ...(connect.scope !== undefined && { scope: connect.scope }),
  });
  if (!answered.ok) return answered;
  const {
    device_code: deviceCode,
    user_code: code,
    verification_uri: url,
    expires_in: expiresIn,
    interval,
  } = answered.value;
  if (typeof deviceCode !== "string" || typeof code !== "string" || typeof url !== "string") {
    return fail(reasonOf(answered.value, `${new URL(connect.deviceUrl).host} didn't give a code.`));
  }
  return ok({
    code,
    url,
    deviceCode,
    expiresAt: now + secondsOf(expiresIn, 900) * 1000,
    intervalMs: secondsOf(interval, 5) * 1000,
  });
};

export const toPoll = (answer: Answer, intervalMs: number): Poll => {
  const token = textOf(answer.access_token);
  if (token !== undefined) return { kind: "token", token };
  switch (answer.error) {
    case "authorization_pending": {
      return { kind: "pending", intervalMs };
    }
    case "slow_down": {
      return { kind: "pending", intervalMs: secondsOf(answer.interval, 0) * 1000 || intervalMs + slowDownMs };
    }
    default: {
      return { kind: "ended", reason: reasonOf(answer, "The provider didn't hand over a token.") };
    }
  }
};

const sleep = (clock: Clock, delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const cancel = clock.after(delayMs, resolve);
    signal.addEventListener(
      "abort",
      () => {
        cancel();
        resolve();
      },
      { once: true },
    );
  });

export const awaitToken = (
  connect: DeviceConnect,
  device: DeviceCode,
  fetcher: Fetch,
  clock: Clock,
  signal: AbortSignal,
): Promise<Result<string, string>> => {
  const poll = async (intervalMs: number): Promise<Result<string, string>> => {
    await sleep(clock, intervalMs, signal);
    if (signal.aborted) return fail("Connecting started again.");
    if (clock.now() >= device.expiresAt) return fail("The code expired before it was approved.");
    const answered = await post(fetcher, connect.tokenUrl, {
      client_id: connect.clientId,
      device_code: device.deviceCode,
      grant_type: grantType,
    });
    if (!answered.ok) return poll(intervalMs);
    const next = toPoll(answered.value, intervalMs);
    switch (next.kind) {
      case "token": {
        return ok(next.token);
      }
      case "pending": {
        return poll(next.intervalMs);
      }
      case "ended": {
        return fail(next.reason);
      }
    }
  };
  return poll(device.intervalMs);
};
