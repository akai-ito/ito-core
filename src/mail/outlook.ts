import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { fail, ok, type Result } from "#result.ts";

export type OutlookToken = {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at?: number;
};

export type TokenStore = {
  readonly read: () => string | undefined;
  readonly write: (token: string) => void;
};

const earlyMs = 60_000;

const toToken = (text: string | undefined): OutlookToken | undefined => {
  if (text === undefined || text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<OutlookToken>;
    return typeof parsed.access_token === "string" ? (parsed as OutlookToken) : undefined;
  } catch {
    return { access_token: text };
  }
};

export const createOutlookToken = ({
  tokens,
  fetch: fetcher,
  clock,
  tokenUrl,
  clientId,
  scope,
}: {
  readonly tokens: TokenStore;
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scope: string;
}): (() => Promise<Result<string, string>>) => {
  const renew = async (refreshToken: string): Promise<Result<string, string>> => {
    try {
      const response = await fetcher(tokenUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const answer = (await response.json()) as Readonly<Record<string, unknown>>;
      const accessToken = answer.access_token;
      if (typeof accessToken !== "string") {
        const reason = typeof answer.error_description === "string" ? answer.error_description : "no token";
        return fail(`Microsoft didn't renew the sign-in (${reason}). Sign in to Outlook again in Settings.`);
      }
      const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
      const renewed: OutlookToken = {
        access_token: accessToken,
        refresh_token: typeof answer.refresh_token === "string" ? answer.refresh_token : refreshToken,
        expires_at: clock.now() + expiresIn * 1000,
      };
      tokens.write(JSON.stringify(renewed));
      return ok(accessToken);
    } catch (error) {
      return fail(`Microsoft couldn't be reached to renew the sign-in: ${String(error)}`);
    }
  };

  const renewing = createCell<Promise<Result<string, string>> | undefined>(undefined);

  return async () => {
    const token = toToken(tokens.read());
    if (!token) return fail("Outlook isn't signed in.");
    const isFresh = token.expires_at === undefined || token.expires_at - earlyMs > clock.now();
    if (isFresh || token.refresh_token === undefined) return ok(token.access_token);
    const running = renewing.get();
    if (running) return running;
    const renewal = renew(token.refresh_token);
    renewing.set(renewal);
    try {
      return await renewal;
    } finally {
      renewing.set(undefined);
    }
  };
};
