import type { Mail } from "#mail/message.ts";
import type { Letter } from "#mail/smtp.ts";
import { fail, ok, type Result } from "#result.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Unsubscriber = {
  readonly fetch: Fetch;
  readonly send: (letter: Letter) => Promise<Result<undefined, string>>;
  readonly from: string;
};

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

export const toLetter = (mailto: string, from: string): Letter | undefined => {
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
  const to = [decode(target), fields.get("to") ?? ""].filter((address) => address.trim() !== "").join(", ");
  const subject = fields.get("subject") ?? "";
  const body = fields.get("body") ?? "";
  return to === ""
    ? undefined
    : { from, to, subject: subject === "" ? "unsubscribe" : subject, text: body === "" ? "unsubscribe" : body };
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

export const unsubscribeFrom = async (
  mail: Pick<Mail, "unsubscribe">,
  unsubscriber: Unsubscriber,
): Promise<Result<"posted" | "mailed", string>> => {
  const { post, url, mailto } = mail.unsubscribe ?? {};
  const posted = post === undefined ? undefined : await postOneClick(unsubscriber.fetch, post);
  if (posted?.ok) return posted;
  const letter = mailto === undefined ? undefined : toLetter(mailto, unsubscriber.from);
  if (letter !== undefined) {
    const sent = await unsubscriber.send(letter);
    return sent.ok ? ok("mailed") : sent;
  }
  if (posted !== undefined) return posted;
  return fail(
    url === undefined ? "This mail has no unsubscribe link." : `This list only unsubscribes on its web page: ${url}`,
  );
};
