import type { Mail } from "#mail/message.ts";
import { fail, ok, type Result } from "#result.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The mail that leaves a list which only takes mail, for them to send: Kumo never sends mail.
export type UnsubscribeLetter = { readonly to: readonly string[]; readonly subject: string; readonly body: string };

// How a list is left: by its one-click link, done, or with a mail of their own to send.
export type Unsubscribed = "posted" | { readonly letter: UnsubscribeLetter };

const answerMs = 30_000;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const toField = (pair: string): readonly [string, string] => {
  const equals = pair.indexOf("=");
  return equals === -1
    ? [decode(pair).toLowerCase(), ""]
    : [decode(pair.slice(0, equals)).toLowerCase(), decode(pair.slice(equals + 1))];
};

export const toLetter = (mailto: string): UnsubscribeLetter | undefined => {
  if (!/^mailto:/i.test(mailto)) return undefined;
  const rest = mailto.slice("mailto:".length);
  const question = rest.indexOf("?");
  const target = question === -1 ? rest : rest.slice(0, question);
  const query = question === -1 ? "" : rest.slice(question + 1);
  const fields = new Map(
    query
      .split("&")
      .filter((pair) => pair !== "")
      .map(toField),
  );
  const to = [decode(target), fields.get("to") ?? ""]
    .flatMap((addresses) => addresses.split(","))
    .map((address) => address.trim())
    .filter((address) => address !== "");
  const subject = fields.get("subject") ?? "";
  const body = fields.get("body") ?? "";
  return to.length === 0
    ? undefined
    : { to, subject: subject === "" ? "unsubscribe" : subject, body: body === "" ? "unsubscribe" : body };
};

const isHttps = (url: string): boolean => URL.canParse(url) && new URL(url).protocol === "https:";

export const postOneClick = async (fetcher: Fetch, url: string): Promise<Result<"posted", string>> => {
  if (!isHttps(url)) return fail("One-click unsubscribing needs an https link.");
  const { host } = new URL(url);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual",
      signal: AbortSignal.timeout(answerMs),
    });
    await response.body?.cancel();
    return response.status < 400
      ? ok("posted")
      : fail(`${host} answered ${String(response.status)} to the unsubscribe.`);
  } catch (error) {
    return fail(`${host} couldn't be reached: ${describe(error)}`);
  }
};

// One-click first; when there's none or it's refused, a list that takes mail gets the mail that leaves it, to send.
export const unsubscribeFrom = async (
  mail: Pick<Mail, "unsubscribe">,
  fetcher: Fetch,
): Promise<Result<Unsubscribed, string>> => {
  const { post, url, mailto } = mail.unsubscribe ?? {};
  const posted = post === undefined ? undefined : await postOneClick(fetcher, post);
  if (posted?.ok) return posted;
  const letter = mailto === undefined ? undefined : toLetter(mailto);
  if (letter !== undefined) return ok({ letter });
  if (posted !== undefined) return posted;
  return fail(
    url === undefined ? "This mail has no unsubscribe link." : `This list only unsubscribes on its web page: ${url}`,
  );
};
