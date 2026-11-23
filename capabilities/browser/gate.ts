// Where Kumo's hand stops. Money never moves on Kumo's click: whatever kind of step Kumo declares, a press that
// would pay is refused here, and Kumo asks him to take over so he presses the site's real button himself.

// What Kumo says a click is: `browse` moves around or chooses, `final` commits something free (books, submits,
// sends), and `payment` moves money.
export type ClickKind = "browse" | "final" | "payment";

// The element about to be pressed: its role and name as the page read them, and its own words, such as a styled
// `<div>`'s text, which the role and name can miss.
export type Target = { readonly role: string; readonly name: string; readonly text: string };

// What the page shows of money: card fields, a payment provider's frame, a wallet button, a total to pay.
export type PageSignals = {
  readonly payment: readonly string[];
  readonly login: boolean;
  readonly code: boolean;
  readonly captcha: boolean;
};

export type Verdict =
  { readonly kind: "browse" } | { readonly kind: "final" } | { readonly kind: "money"; readonly why: string };

const pressable = new Set(["button", "link", "menuitem", "generic", "img", "text", ""]);

const moneyPhrases: readonly RegExp[] = [
  /^\s*(?:pay|buy|purchase|checkout|subscribe|donate|top[ -]?up)\b/iu,
  /\b(?:place|submit|complete|confirm|finish)\s+(?:my\s+|your\s+|the\s+)?(?:order|purchase|payment)\b/iu,
  /\b(?:and|&)\s+pay\b/iu,
  /\bpay\s+(?:now|securely|with|later|in\s+full|[£$€¥₹])/iu,
  /\b(?:buy|order)\s+now\b/iu,
  /\b(?:start|begin)\b.*\b(?:subscription|membership|paid\s+plan)\b/iu,
  /\bsend\s+money\b/iu,
  /\btransfer\s+(?:money|funds|[£$€¥₹]\s?\d)/iu,
  /\bauthori[sz]e\s+(?:the\s+)?(?:payment|card|transaction)\b/iu,
];

const moneyVerb = /\b(?:pay|book|buy|order|confirm|complete|checkout|reserve|purchase|subscribe|donate|rent|hire)\b/iu;

const amounts =
  /(?:[£$€¥₹]|\b(?:gbp|usd|eur|inr)\b)\s?(?<before>\d[\d,.]*)|(?<after>\d[\d,.]*)\s?(?:[£$€¥₹]|\b(?:gbp|usd|eur|inr)\b)/giu;

// A price in the words, other than nothing: "Book for £0.00" is free.
export const hasAmount = (text: string): boolean =>
  text
    .matchAll(amounts)
    .some(({ groups = {} }) => Number((groups.before ?? groups.after ?? "0").replaceAll(",", "")) > 0);

const committing =
  /^\s*(?:book|reserve|confirm|submit|send|apply|register|sign\s+up|join|place|complete|finish|request|schedule|accept|rsvp|agree\s+and)\b|\b(?:book\s+now|confirm\s+(?:booking|reservation|appointment)|submit\s+(?:application|form|request))\b/iu;

// Pressing on, which near money may be the press that pays.
const proceeding = /^\s*(?:continue|next|proceed|review|done|save|go)\b/iu;

const wordsOf = ({ name, text }: Target): string => `${name} ${text}`.replaceAll(/\s+/gu, " ").trim();

export const isMoneyPress = (target: Target): string | undefined => {
  if (!pressable.has(target.role)) return undefined;
  const words = wordsOf(target);
  if (moneyPhrases.some((phrase) => phrase.test(words))) return `“${words.slice(0, 60)}” moves money`;
  return moneyVerb.test(words) && hasAmount(words) ? `“${words.slice(0, 60)}” names a price to pay` : undefined;
};

export const isCommitting = (target: Target): boolean => pressable.has(target.role) && committing.test(wordsOf(target));

// The verdict on one click. A payment Kumo declares, or a press whose own words pay, is money. On a page that shows
// payment, so is any press that commits or presses on: the final step there is his. Anything else that commits is a
// final step, whatever Kumo declared, so a lost answer is known to be uncertain.
export const judgeClick = (target: Target, declared: ClickKind, signals: PageSignals): Verdict => {
  if (declared === "payment") return { kind: "money", why: "you said this step moves money" };
  const own = isMoneyPress(target);
  if (own !== undefined) return { kind: "money", why: own };
  const words = wordsOf(target);
  const isPressingOn = pressable.has(target.role) && (committing.test(words) || proceeding.test(words));
  if (signals.payment.length > 0 && (declared === "final" || isPressingOn)) {
    return { kind: "money", why: `this page takes payment (${signals.payment.join(", ")})` };
  }
  return declared === "final" || isCommitting(target) ? { kind: "final" } : { kind: "browse" };
};

// Keys that send a form, which near money is the same as pressing its button.
export const isSubmitKey = (key: string): boolean => /^(?:enter|numpadenter|return)$/iu.test(key.trim());

export const moneyRefusal = (why: string): string =>
  [
    `Refused: money moves here (${why}). Kumo never presses a button that pays.`,
    "Stop on this page, as it is, and ask him to take over with browser_takeover, need `payment`, saying what he's",
    "paying for and how much: he presses the site's own button himself.",
  ].join(" ");
