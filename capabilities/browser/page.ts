import { createHash } from "node:crypto";
import type { Frame, Locator, Page } from "playwright";
import type { PageSignals } from "./gate.ts";
import { quietly } from "./quietly.ts";

// Reading a page: its accessibility snapshot with refs, as Playwright gives it for agents, with what's secret taken
// out, and the signs of a login, a code, a CAPTCHA or money that tell Kumo when the page is his to finish.

export type Line = { readonly role: string; readonly name: string };

export type Reading = {
  readonly text: string;
  readonly refs: ReadonlyMap<string, Line>;
  readonly site: string;
  readonly title: string;
  readonly url: string;
  readonly signals: PageSignals;
  readonly isCut: boolean;
};

const longest = 24_000;

const valuedRoles = /^(\s*- (?:textbox|searchbox|spinbutton|combobox)\b[^\n]*?): (.+)$/u;

const referenceLine = /^\s*- (?<role>[a-z]+)(?: "(?<name>(?:[^"\\]|\\.)*)")?[^\n]*\[ref=(?<ref>[a-z0-9]+)\]/u;

const unquote = (value: string): string => {
  if (!value.startsWith('"')) return value;
  try {
    return String(JSON.parse(value));
  } catch {
    return value;
  }
};

// Runs in each frame: the values of fields that are secret, such as a password, a card number or a code.
const secretValues = (): readonly string[] =>
  [...document.querySelectorAll("input, textarea")].flatMap((element): readonly string[] => {
    const input = element as HTMLInputElement;
    const labels = [...(input.labels ?? [])].map((label) => label.textContent);
    const words = [input.name, input.id, input.getAttribute("aria-label"), input.placeholder, ...labels]
      .join(" ")
      .toLowerCase();
    const isSecret =
      input.type === "password" ||
      /\b(?:cc-|one-time-code|current-password|new-password)/u.test(input.autocomplete) ||
      /password|passcode|cvv|cvc|csc|security.?code|card.?number|cardnumber|\botp\b|verification.?code|\bpin\b/u.test(
        words,
      );
    return isSecret && input.value !== "" ? [input.value] : [];
  });

// Runs in each frame: whether it asks for a password, a one-time code or card details.
const frameSigns = (): { readonly password: boolean; readonly code: boolean; readonly card: boolean } => {
  const inputs = [...document.querySelectorAll("input")].filter((input) => input.type !== "hidden");
  const words = inputs.map((input) =>
    [input.name, input.id, input.autocomplete, input.getAttribute("aria-label"), input.placeholder]
      .join(" ")
      .toLowerCase(),
  );
  return {
    password: inputs.some((input) => input.type === "password"),
    code: words.some((text) => /one-time-code|\botp\b|verification.?code|2fa|two.?factor/u.test(text)),
    card: words.some((text) => /cc-number|cc-csc|cc-exp|card.?number|cardnumber|cvv|cvc/u.test(text)),
  };
};

const siteName = (): string => {
  const meta = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
  return meta && meta.length <= 40 ? meta : location.hostname.replace(/^www\./u, "");
};

const providers =
  /stripe\.com|braintree|adyen|paypal\.com|klarna|checkout\.com|worldpay|squareup|recurly|chargebee|mollie|pay\.google\.com|apple-pay|payments?\.|\/pay(?:ment)?s?\//iu;

const captchas = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/iu;

const wallets = /\b(?:apple pay|google pay|g pay|buy with)\b/iu;

const totals = /\b(?:order total|total to pay|amount due|total due|pay now)\b/iu;

const robots = /i'?m not a robot|verify (?:you are|you're) (?:a )?human|are you a robot/iu;

const inFrames = async <Value>(page: Page, run: () => Value, fallback: Value): Promise<readonly Value[]> =>
  Promise.all(
    page.frames().map(async (frame: Frame) => {
      try {
        return await frame.evaluate(run);
      } catch {
        return fallback;
      }
    }),
  );

const signalsOf = async (page: Page, text: string): Promise<PageSignals> => {
  const signs = await inFrames(page, frameSigns, { password: false, code: false, card: false });
  const frames = page
    .frames()
    .slice(1)
    .map((frame) => frame.url());
  const provider = frames.find((url) => providers.test(url));
  const payment = [
    ...(signs.some((sign) => sign.card) ? ["card fields"] : []),
    ...(provider === undefined ? [] : [`a payment frame from ${new URL(provider).hostname}`]),
    ...(wallets.test(text) ? ["a wallet button"] : []),
    ...(totals.test(text) ? ["a total to pay"] : []),
  ];
  return {
    payment,
    login: signs.some((sign) => sign.password),
    code: signs.some((sign) => sign.code),
    captcha: frames.some((url) => captchas.test(url)) || robots.test(text),
  };
};

const hide = (text: string, secrets: ReadonlySet<string>): string =>
  secrets.size === 0
    ? text
    : text
        .split("\n")
        .map((line) => {
          const match = valuedRoles.exec(line);
          return match?.[1] && match[2] && secrets.has(unquote(match[2])) ? `${match[1]}: (hidden)` : line;
        })
        .join("\n");

export const referencesOf = (text: string): ReadonlyMap<string, Line> =>
  new Map(
    text.split("\n").flatMap((line) => {
      const groups = referenceLine.exec(line)?.groups;
      return groups?.ref && groups.role
        ? [[groups.ref, { role: groups.role, name: unquote(`"${groups.name ?? ""}"`) }]]
        : [];
    }),
  );

export const readPage = async (page: Page): Promise<Reading> => {
  const snapshot = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 });
  const found = await inFrames(page, secretValues, []);
  const secrets = new Set(found.flat());
  const text = hide(snapshot, secrets);
  const site = (await quietly(page.evaluate(siteName))) ?? "";
  return {
    text: text.length > longest ? text.slice(0, longest) : text,
    refs: referencesOf(text),
    site: site || new URL(page.url()).hostname,
    title: (await quietly(page.title())) ?? "",
    url: page.url(),
    signals: await signalsOf(page, text),
    isCut: text.length > longest,
  };
};

// An element's own words, for the gate: its label, its text and its value.
// Runs on the element: its label, its words, its value and its title.
const ownWords = (element: Element): string =>
  [
    element.getAttribute("aria-label"),
    element.textContent,
    (element as HTMLInputElement).value,
    element.getAttribute("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);

export const targetText = async (locator: Locator): Promise<string> =>
  (await quietly(locator.evaluate(ownWords))) ?? "";

// Whether a field is secret, which Kumo never types into: a password, a card number, a code.
// Runs on the element: whether it's a password, a card number or a code.
const isSecret = (element: Element): boolean => {
  const input = element as HTMLInputElement;
  const words = [
    input.type,
    input.autocomplete,
    input.name,
    input.id,
    input.getAttribute("aria-label"),
    input.placeholder,
  ]
    .join(" ")
    .toLowerCase();
  return (
    input.type === "password" ||
    /\bcc-|one-time-code|current-password|new-password|password|passcode|cvv|cvc|csc|security.?code|card.?number|cardnumber|\botp\b|\bpin\b/u.test(
      words,
    )
  );
};

export const isSecretField = async (locator: Locator): Promise<boolean> =>
  (await quietly(locator.evaluate(isSecret))) ?? false;

// Runs in each frame that can be read: what a press would commit, which is the fields' values, what's chosen, and
// every price shown. A timer or an advert changing doesn't change it; a different time, guest or price does.
const frameState = (): unknown => {
  const fields = [...document.querySelectorAll("input, select, textarea")].map((element) => {
    const input = element as HTMLInputElement;
    if (input.type === "password") return input.value === "" ? "" : "•";
    return input.type === "checkbox" || input.type === "radio" ? String(input.checked) : input.value;
  });
  const chosen = [
    ...document.querySelectorAll(
      '[aria-pressed="true"], [aria-selected="true"], [aria-checked="true"], [aria-current]:not([aria-current="false"])',
    ),
  ].map((element) => element.textContent.trim().slice(0, 80));
  const prices = (document.body.textContent.match(/[£$€¥₹]\s?\d[\d,.]*/gu) ?? []).slice(0, 50);
  return { fields, chosen, prices };
};

export const stateOf = async (page: Page, target: Line): Promise<string> => {
  const frames = await inFrames(page, frameState, null);
  const url = page.url().split("#", 1)[0];
  return createHash("sha256").update(JSON.stringify({ url, target, frames })).digest("hex");
};

// The field with the focus during a takeover: what it takes, its label, where it is in the viewport and how many
// characters it holds, so the phone can lay a native field over it. Its value never leaves the server.
export type Field = {
  readonly kind: string;
  readonly label: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly length: number;
  readonly multiline?: true;
};

// Runs in a frame: the field with the focus there, if it's one to type in.
export const focusedField = (): Field | undefined => {
  const element = document.activeElement;
  if (!element) return undefined;
  const input = element as HTMLInputElement;
  const isArea = element instanceof HTMLTextAreaElement;
  const uneditable = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"];
  const isEditable =
    (element instanceof HTMLInputElement && !uneditable.includes(input.type)) ||
    isArea ||
    (element as HTMLElement).isContentEditable;
  if (!isEditable) return undefined;
  const hint = `${input.autocomplete || ""} ${input.getAttribute("inputmode") ?? ""} ${input.name || ""}`.toLowerCase();
  const kind =
    input.type === "password"
      ? "password"
      : /one-time-code|\botp\b|code/u.test(hint)
        ? "code"
        : input.type === "email" || hint.includes("email")
          ? "email"
          : input.type === "tel" || hint.includes("tel")
            ? "tel"
            : input.type === "number" || /numeric|decimal/u.test(hint)
              ? "number"
              : input.type === "url"
                ? "url"
                : input.type === "search"
                  ? "search"
                  : "text";
  const label = input.getAttribute("aria-label") ?? input.labels?.[0]?.textContent.trim() ?? input.placeholder;
  const { x, y, width, height } = element.getBoundingClientRect();
  const value = typeof input.value === "string" ? input.value : element.textContent;
  return {
    kind,
    label: label.slice(0, 80),
    box: { x, y, width, height },
    length: value.length,
    ...((isArea || (element as HTMLElement).isContentEditable) && { multiline: true as const }),
  };
};

// Runs on a frame's element: whether its document's focus is in it.
const isActiveFrame = (element: Element): boolean => element.ownerDocument.activeElement === element;

type Focused = {
  readonly frame: Frame;
  readonly field: Field;
  readonly offset: { readonly x: number; readonly y: number };
};

// Follows the focus from the page down through the frames that hold it, to the field, if any, with where its frame
// sits in the page's viewport. A headless page never has the window's focus, so this follows the documents' own.
const findFocus = async (frame: Frame, offset: Focused["offset"]): Promise<Focused | undefined> => {
  const field = await quietly(frame.evaluate(focusedField));
  if (field) return { frame, field, offset };
  const children = await Promise.all(
    frame.childFrames().map(async (child) => {
      const element = await quietly(child.frameElement());
      const isActive = element && (await quietly(element.evaluate(isActiveFrame)));
      const box = isActive === true ? await quietly(element.boundingBox()) : undefined;
      return isActive === true ? { child, at: box ? { x: box.x, y: box.y } : offset } : undefined;
    }),
  );
  const active = children.find((candidate) => candidate !== undefined);
  return active && findFocus(active.child, active.at);
};

// The field with the focus, its box in the page's viewport.
export const focusOf = async (page: Page): Promise<Field | undefined> => {
  const found = await findFocus(page.mainFrame(), { x: 0, y: 0 });
  if (!found) return undefined;
  const { field, offset } = found;
  return { ...field, box: { ...field.box, x: field.box.x + offset.x, y: field.box.y + offset.y } };
};

// Runs in a frame: selects all of the field with the focus, so text typed next replaces it.
const selectAll = (): boolean => {
  const element = document.activeElement;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.select();
    return true;
  }
  if (!(element as HTMLElement | null)?.isContentEditable) return false;
  const range = document.createRange();
  range.selectNodeContents(element as Node);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
};

// Selects all of the field with the focus, wherever it is, so text typed next replaces it.
export const selectFocused = async (page: Page): Promise<boolean> => {
  const found = await findFocus(page.mainFrame(), { x: 0, y: 0 });
  return found !== undefined && (await quietly(found.frame.evaluate(selectAll))) === true;
};

const outline = (element: Element): void => {
  const { style } = element as HTMLElement;
  style.setProperty("outline", "4px solid #ff8a3d", "important");
  style.setProperty("outline-offset", "3px", "important");
};

const unoutline = (element: Element): void => {
  const { style } = element as HTMLElement;
  style.removeProperty("outline");
  style.removeProperty("outline-offset");
};

// Outlines the element a commit card would press, for its picture, and takes the outline away after.
export const withOutline = async <Value>(locator: Locator, work: () => Promise<Value>): Promise<Value> => {
  await quietly(locator.scrollIntoViewIfNeeded({ timeout: 5000 }));
  await quietly(locator.evaluate(outline));
  try {
    return await work();
  } finally {
    await quietly(locator.evaluate(unoutline));
  }
};
