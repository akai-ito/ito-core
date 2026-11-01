import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import type { Capability } from "#capabilities/host.ts";
import type { Problem } from "#protocol/types.ts";

export type Health = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly isAuth: boolean };

export type Problems = {
  readonly report: (id: string, health: Health, toProblem: (reason: string, isAuth: boolean) => Problem) => void;
  readonly refresh: () => void;
  readonly start: () => void;
  readonly close: () => void;
};

export type ProblemsOptions = {
  readonly clock: Clock;
  readonly standing: () => readonly Problem[];
  readonly publish: (problems: readonly Problem[]) => void;
  readonly checkMs?: number;
};

type Failure = { readonly problem: Problem; readonly since: number; readonly isAuth: boolean };

// Long enough that a reconnect, such as Outlook's hourly one, never shows.
export const lastingMs = 10 * 60 * 1000;

const providerNames: Readonly<Record<string, string>> = { icloud: "iCloud", outlook: "Outlook", gmail: "Gmail" };

export const pushProblem: Problem = {
  id: "push",
  area: "notifications",
  title: "Notifications can't be sent",
  detail: "This server has no Apple push key, so nothing reaches your phone while Ito is closed.",
  fix: "On the server, run ito push setup with your APNs key. The server's README, under Notifications, has the steps.",
};

export const capabilityProblem = ({
  id,
  manifest,
  state,
  detail = "It stopped working.",
}: Capability): Problem | undefined => {
  const title = manifest === undefined ? id : manifest.title;
  switch (state) {
    case "setup": {
      return {
        id: `capability:${id}`,
        area: "capabilities",
        title: `${title} needs setting up`,
        detail: "It's switched on, but its setup isn't finished, so it can't do anything yet.",
        fix: `Finish its setup in Settings › Capabilities › ${title}, or switch it off.`,
      };
    }
    case "needs_you": {
      return {
        id: `capability:${id}`,
        area: "capabilities",
        title: `${title} isn't working`,
        detail,
        fix: `Open Settings › Capabilities › ${title} and do what it says.`,
      };
    }
    case "off":
    case "on": {
      return undefined;
    }
  }
};

const nameOf = (account: string): string => providerNames[account] ?? account;

const signInFix = (account: string): string =>
  account === "outlook"
    ? "Sign in to Outlook again in Settings › Capabilities › Outlook."
    : `Check the email address and the app password in Settings › Capabilities › ${nameOf(account)}.`;

export const mailProblem =
  (account: string) =>
  (reason: string, isAuth: boolean): Problem => ({
    id: `mail:${account}`,
    area: "mail",
    title: `${nameOf(account)} mail isn't working`,
    detail: `Kumo can't read or file your ${nameOf(account)} mail: ${reason}`,
    fix: isAuth ? signInFix(account) : "Kumo keeps trying. If it goes on, check the server's internet connection.",
  });

export const calendarId = "calendar:icloud";

export const calendarProblem = (reason: string, isAuth: boolean): Problem => ({
  id: calendarId,
  area: "calendar",
  title: "iCloud Calendar isn't working",
  detail: `Kumo can't read or change your calendar: ${reason}`,
  fix: isAuth ? signInFix("icloud") : "Kumo keeps trying. If it goes on, check the server's internet connection.",
});

export const memoryBackupId = "memory:backup";

const keepsTrying = "Ito keeps trying. If it goes on, check the server's internet connection.";

export const memoryBackupProblem =
  (fix: string) =>
  (reason: string, isAuth: boolean): Problem => ({
    id: memoryBackupId,
    area: "memory",
    title: "Memory isn't backed up",
    detail: `Memory is on this server only until this is fixed. ${reason}`,
    fix: isAuth ? fix : keepsTrying,
  });

export const contactsId = "contacts:icloud";

export const contactsProblem = (reason: string, isAuth: boolean): Problem => ({
  id: contactsId,
  area: "contacts",
  title: "iCloud Contacts isn't working",
  detail: `Kumo can't read or change your contacts: ${reason}`,
  fix: isAuth ? signInFix("icloud") : "Kumo keeps trying. If it goes on, check the server's internet connection.",
});

export const createProblems = ({ clock, standing, publish, checkMs = 60_000 }: ProblemsOptions): Problems => {
  const failures = createCell<ReadonlyMap<string, Failure>>(new Map());
  const timer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

  const lasting = (): readonly Problem[] => {
    const now = clock.now();
    return failures
      .get()
      .values()
      .filter(({ since, isAuth }) => isAuth || now - since >= lastingMs)
      .map(({ problem }) => problem)
      .toArray();
  };

  const refresh = (): void => {
    if (!isClosed.get()) publish([...standing(), ...lasting()]);
  };

  const check = (): void => {
    refresh();
    if (!isClosed.get()) timer.set(clock.after(checkMs, check));
  };

  return {
    report: (id, health, toProblem) => {
      if (health.ok) {
        if (!failures.get().has(id)) return;
        failures.update((current) => new Map([...current].filter(([key]) => key !== id)));
      } else {
        const since = failures.get().get(id)?.since ?? clock.now();
        const failure: Failure = { problem: toProblem(health.reason, health.isAuth), since, isAuth: health.isAuth };
        failures.update((current) => new Map([...current, [id, failure]]));
      }
      refresh();
    },
    refresh,
    start: check,
    close: () => {
      isClosed.set(true);
      timer.get()?.();
    },
  };
};
