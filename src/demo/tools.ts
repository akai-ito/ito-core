import { randomUUID } from "node:crypto";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Checkins, DemoCheckin } from "#day/checkins.ts";
import { sampleDay } from "#day/samples.ts";
import { dayMs, toLocal } from "#desk/day.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { Moments } from "#desk/moments.ts";
import type { Identifiers } from "#identifiers.ts";
import type { GettingStarted } from "#onboarding/onboarding.ts";
import type { DoneEntry } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import type { Tool } from "#tools/mcp.ts";
import type { Trust } from "#work/trust.ts";

// The hidden tools the demo's scripts call: sample cards, a sample day of Kumo's work, and lines and check-ins
// whatever the time.
export type DemoToolsOptions = {
  readonly store: Pick<Store, "setOnboarding">;
  readonly desk: DeskKeeper;
  readonly trust: Pick<Trust, "hold" | "review">;
  readonly moments: Pick<Moments, "tell" | "dayNow">;
  readonly checkins: Pick<Checkins, "show">;
  readonly gettingStarted: Pick<GettingStarted, "state">;
  readonly identifiers: Identifiers;
  readonly clock: Clock;
  readonly timeZone: string;
};

const demoMail = (subject: string): NonNullable<DoneEntry["mail"]> => ({
  account: "icloud",
  message_id: `demo-${randomUUID()}@acme.com`,
  from: "Acme",
  subject,
});

export const createDemoTools = ({
  store,
  desk,
  trust,
  moments,
  checkins,
  gettingStarted,
  identifiers,
  clock,
  timeZone,
}: DemoToolsOptions): readonly Tool[] => {
  // A made-up day for the demo: what Kumo did, where it stands on the ladder, and a card to glance at.
  const showWork = (): void => {
    const filed = { kind: "mail_filed", account: "icloud", id: "demo", back: "inbox" };
    const cleared = [
      ["Bank statement", "Routine, nothing due"],
      ["CI passed on ito-core", "You saw it on the PR"],
      ["Weekly running summary", "Nothing new"],
      ["Water bill", "Direct debit, nothing to do"],
      ["Daily digest from Acme", "You rarely open these"],
      ["Leo: “ha, see you there”", "A reply, no action"],
    ] as const;
    const clearedToday = Array.from({ length: 38 }, (_, at) => cleared[at % cleared.length] ?? cleared[0]);
    for (const [text, reason] of clearedToday) desk.addDone({ text, reason, mail: demoMail(text), quiet: true });
    const handled = [
      { text: "Drafted a thank-you to Tess Harlow at Halcyon", reason: "She sent the next steps.", work: "drafts" },
      { text: "Drafted a reply to Clara Voss at Northwind", reason: "She asked for times next week.", work: "drafts" },
      { text: "Northwind: Clara's note → Job search", reason: "A reply to yours; nothing to answer yet." },
      { text: "Climbing with Leo → your calendar, 20:00", reason: "Leo confirmed by mail.", work: "calendar" },
      { text: "Acme Pizza promos: unsubscribed, binned", reason: "You haven't opened one since March." },
      {
        text: "Quillfield Dental moved to Fri 13, 9:30",
        reason: "Their mail confirmed the new time.",
        work: "calendar",
      },
      { text: "Electricity bill → Admin, due 14 Nov", reason: "A bill with a date on it; a reminder's set." },
    ] as const;
    for (const entry of handled.toReversed()) {
      desk.addDone({
        text: entry.text,
        reason: entry.reason,
        quiet: false,
        ...("work" in entry ? { work: entry.work } : { mail: demoMail(entry.text), undo: filed }),
      });
    }
    const daysAgo = (days: number): string => toTimestamp(clock.now() - days * dayMs);
    trust.hold("sorting", { step: "trusted", since: daysAgo(1), change: { kind: "climb", days: 15 } });
    trust.hold("calendar", {
      step: "spot_checks",
      since: daysAgo(2),
      change: { kind: "corrected", quote: "Quillfield Dental moved to Thu 12", at: daysAgo(2), stepped: true },
    });
    trust.hold("drafts", { step: "learning", since: daysAgo(9), change: { kind: "start" } });
    trust.review(toLocal(clock.now(), timeZone).day, "Today");
  };
  return [
    {
      name: "show_getting_started",
      title: "Show what getting started found",
      audience: "hidden",
      description: "Finish a sample catch-up with a belief and a booking, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        if (gettingStarted.state().state === "done") return Promise.resolve({ text: "Getting started is done." });
        const start = toTimestamp(clock.now() + 25 * dayMs);
        const end = toTimestamp(clock.now() + 25 * dayMs + 2.5 * 60 * 60 * 1000);
        store.setOnboarding({ state: "reading", progress: { mails_read: 40, mails_total: 40 } });
        store.setOnboarding({
          state: "ready",
          proposal: {
            beliefs: [
              {
                id: identifiers.belief(),
                text: "You're training for a sub-20 5K, with parkrun on Saturdays.",
                page: "memory:now",
              },
            ],
            added: [
              {
                id: identifiers.calendarItem(),
                uid: `demo-flights-${start}@ito.local`,
                title: "Flights to Valencia",
                start,
                end,
                all_day: false,
                location: "Gatwick North",
                calendar: { name: "Home", kumo: false },
                status: "confirmed",
              },
            ],
            motions: [],
          },
        });
        return Promise.resolve({ text: "Showed what getting started found." });
      },
    },
    {
      name: "show_mail",
      title: "Show a sample mail's work",
      audience: "hidden",
      description: "Read a sample mail: put a draft on the Desk and tell them about it, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        desk.addCard({
          kind: "draft",
          title: "Note to Hotel Orto",
          options: [{ label: "Drop it" }],
          allows_text: true,
          draft: {
            account: "icloud",
            from: "you@icloud.com",
            to: ["reservations@hotelorto.it"],
            subject: "Re: Booking confirmed: 20–23 November",
            body:
              "Hi! We land at 22:10 on the 20th, so we'll reach you around 23:00, after reception closes. Could " +
              "you leave the keys for us, or tell us how late check-in works? Thanks",
            message_id: `demo-${String(clock.now())}@ito.local`,
            in_reply_to: "confirm-48213@hotelorto.it",
          },
        });
        desk.setLastMail(toTimestamp(clock.now()));
        moments.tell(
          "Hotel Orto confirmed you for 20–23 Nov. One snag: you land 22:10 and check-in closes 22:00, so I " +
            "drafted a note.",
          false,
        );
        return Promise.resolve({ text: "Put a sample draft on the Desk." });
      },
    },
    {
      name: "show_invite",
      title: "Show a sample invite",
      audience: "hidden",
      description: "Put a sample invite on the Desk, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        const start = toTimestamp(clock.now() + 26 * 60 * 60 * 1000);
        const end = toTimestamp(clock.now() + 27.5 * 60 * 60 * 1000);
        desk.addCard({
          kind: "invite",
          title: "Halcyon technical, tomorrow",
          options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
          allows_text: false,
          invite: {
            event: {
              id: identifiers.calendarItem(),
              uid: `demo-${start}@ito.local`,
              title: "Halcyon technical",
              start,
              end,
              all_day: false,
              location: "Microsoft Teams",
              calendar: { name: "Home", kumo: false },
              status: "tentative",
            },
          },
        });
        return Promise.resolve({ text: "Put a sample invite on the Desk." });
      },
    },
    {
      name: "show_work",
      title: "Show a sample day of Kumo's work",
      audience: "hidden",
      description: "Fill today's Done and the trust ladder with a sample day, and a card to glance at, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        showWork();
        return Promise.resolve({ text: "Filled today's work with a sample day." });
      },
    },
    {
      name: "show_day",
      title: "Show a sample day",
      audience: "hidden",
      description:
        "Put a sample day, Kumo's plan and its guesses, in Coming up, then write the day's line, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => {
        desk.setComingUp(sampleDay(clock.now(), timeZone, identifiers));
        await moments.dayNow();
        return { text: "Showed a sample day." };
      },
    },
    {
      name: "show_checkin",
      title: "Show a check-in",
      audience: "hidden",
      description: "Show one of Kumo's check-ins now, whatever the time, for the demo.",
      inputSchema: {
        type: "object",
        properties: { kind: { enum: ["commit", "pre", "past", "question", "drift"] } },
        required: ["kind"],
        additionalProperties: false,
      },
      call: async (input) => {
        const said = await checkins.show((input as { readonly kind: DemoCheckin }).kind);
        return { text: said === "" ? "Nothing to say." : `Said: ${said}` };
      },
    },
    {
      name: "moment_now",
      title: "Write Kumo's line now",
      audience: "hidden",
      description: "Write Kumo's first line of the day now, whatever the time, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => {
        await moments.dayNow();
        return { text: "Wrote Kumo's line." };
      },
    },
  ];
};
