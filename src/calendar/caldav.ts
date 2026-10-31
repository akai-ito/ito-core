import { randomUUID } from "node:crypto";
import {
  calendarMultiGet,
  calendarQuery,
  createAccount,
  fetchCalendarUserAddresses,
  makeCalendar,
  propfind,
  syncCollection,
  type DAVAccount,
  type DAVResponse,
} from "tsdav";
import {
  byStart,
  toAddress,
  toCalendarEvent,
  toIcs,
  toOccurrences,
  toRange,
  withChanges,
  withoutOccurrence,
  withResponse,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarObject,
  type NewCalendarEvent,
  type Partstat,
  type Range,
} from "#calendar/icalendar.ts";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";

export type CalendarChanges = {
  readonly token: string;
  readonly changed: readonly CalendarEvent[];
  readonly removed: readonly string[];
};

export type CalendarSource = {
  readonly check: () => Promise<Result<{ readonly calendars: readonly CalendarInfo[] }, string>>;
  readonly calendars: () => Promise<Result<readonly CalendarInfo[], string>>;
  readonly ensureKumo: () => Promise<Result<CalendarInfo, string>>;
  readonly events: (from: string, to: string) => Promise<Result<readonly CalendarEvent[], string>>;
  readonly create: (calendar: CalendarInfo, event: NewCalendarEvent) => Promise<Result<CalendarEvent, string>>;
  readonly update: (event: CalendarEvent, changes: Partial<NewCalendarEvent>) => Promise<Result<CalendarEvent, string>>;
  readonly remove: (event: CalendarEvent) => Promise<Result<undefined, string>>;
  readonly respond: (
    event: CalendarEvent,
    answer: Exclude<Partstat, "needs-action">,
  ) => Promise<Result<CalendarEvent, string>>;
  readonly changes: (token?: string) => Promise<Result<CalendarChanges, string>>;
};

export type ICloudOptions = {
  readonly appleId: string;
  readonly appPassword: string;
  readonly addresses?: readonly string[];
  readonly serverUrl?: string;
  readonly fetch?: typeof fetch;
};

type Session = { readonly homeUrl: string; readonly addresses: readonly string[] };

type Collection = { readonly info: CalendarInfo; readonly syncToken?: string };

type Progress = {
  readonly token?: string;
  readonly changed: readonly CalendarEvent[];
  readonly removed: readonly string[];
};

type Condition = Readonly<Record<string, never>> | { readonly "if-match": string } | { readonly "if-none-match": "*" };

const rejected = "iCloud rejected that Apple ID or app-specific password.";
const changedSince = "That event changed in iCloud since it was read; read it again first.";
const kumoName = "Kumo";
const answerMs = 30_000;
const writePrivileges = new Set(["all", "write", "writeContent", "bind"]);
const objectProperties = { "d:getetag": {}, "c:calendar-data": {} };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

const textOf = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value : (field(value, "_cdata") ?? field(value, "_text"));
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
};

const bareEtag = (etag: string): string => etag.replace(/^W\//u, "").replaceAll('"', "");

const withSlash = (url: string): string => (url.endsWith("/") ? url : `${url}/`);

const davTime = (epoch: number): string => `${new Date(epoch).toISOString().slice(0, 19).replaceAll(/[-:]/gu, "")}Z`;

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return `iCloud failed: ${String(error)}`;
  if (error.message === rejected) return rejected;
  if (error.name === "TimeoutError") return "iCloud didn't answer in time.";
  if (error instanceof TypeError && error.cause instanceof Error) {
    return `iCloud couldn't be reached: ${error.cause.message}`;
  }
  return `iCloud failed: ${error.message.split(/(?<=\.)\s/u, 1)[0] ?? error.message}`;
};

const attempt = async <Value>(work: () => Promise<Result<Value, string>>): Promise<Result<Value, string>> => {
  try {
    return await work();
  } catch (error) {
    return fail(describeFailure(error));
  }
};

const refusalOf = (status: number): string => {
  switch (status) {
    case 403: {
      return "iCloud doesn't allow changes to that calendar.";
    }
    case 404: {
      return "That event or calendar isn't in iCloud any more.";
    }
    case 409:
    case 412: {
      return changedSince;
    }
    default: {
      return `iCloud answered ${status}.`;
    }
  }
};

const toCollection = (response: DAVResponse, homeUrl: string): readonly Collection[] => {
  const properties: unknown = response.props;
  const resourceType = field(properties, "resourcetype");
  const isCalendar = isRecord(resourceType) && "calendar" in resourceType;
  if (!isCalendar || response.href === undefined) return [];
  const components = listOf(field(field(properties, "supportedCalendarComponentSet"), "comp")).map((component) =>
    textOf(field(field(component, "_attributes"), "name")),
  );
  if (components.length > 0 && !components.includes("VEVENT")) return [];
  const privileges = listOf(field(field(properties, "currentUserPrivilegeSet"), "privilege")).flatMap((privilege) =>
    isRecord(privilege) ? Object.keys(privilege) : [],
  );
  const name = textOf(field(properties, "displayname")) ?? "Untitled";
  const syncToken = textOf(field(properties, "syncToken"));
  return [
    {
      info: {
        url: new URL(response.href, homeUrl).href,
        name,
        isKumo: name.trim().toLowerCase() === kumoName.toLowerCase(),
        readOnly: privileges.length > 0 && privileges.every((privilege) => !writePrivileges.has(privilege)),
      },
      ...(syncToken !== undefined && { syncToken }),
    },
  ];
};

const toObject = (response: DAVResponse, calendar: CalendarInfo): readonly CalendarObject[] => {
  const properties: unknown = response.props;
  const ics = textOf(field(properties, "calendarData"));
  const etag = textOf(field(properties, "getetag"));
  return ics === undefined || response.href === undefined
    ? []
    : [{ ics, url: new URL(response.href, calendar.url).href, ...(etag !== undefined && { etag }), calendar }];
};

const isRefusal = (response: DAVResponse): boolean => !response.ok && response.propStats === undefined;

const encodeToken = (tokens: Readonly<Record<string, string>>): string =>
  Buffer.from(JSON.stringify(tokens)).toString("base64url");

const decodeToken = (token: string): Result<Readonly<Record<string, string>>, string> => {
  const unknownToken = fail("That changes token isn't one this calendar source gave out.");
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return isRecord(value)
      ? ok(
          Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string")) as Record<
            string,
            string
          >,
        )
      : unknownToken;
  } catch {
    return unknownToken;
  }
};

const combined = <Value>(results: readonly Result<Value, string>[]): Result<readonly Value[], string> =>
  results.reduce<Result<readonly Value[], string>>(
    (all, result) => (all.ok ? (result.ok ? ok([...all.value, result.value]) : result) : all),
    ok([]),
  );

const eventsOf = (objects: readonly CalendarObject[], addresses: readonly string[]): readonly CalendarEvent[] =>
  objects.flatMap((object) => {
    const event = toCalendarEvent(object, addresses);
    return event.ok ? [event.value] : [];
  });

export const createCalendarSource = (options: ICloudOptions): CalendarSource => {
  const serverUrl = options.serverUrl ?? "https://caldav.icloud.com";
  const fetcher = options.fetch ?? fetch;
  const headers = {
    authorization: `Basic ${Buffer.from(`${options.appleId}:${options.appPassword}`).toString("base64")}`,
  };
  const session = createCell<Session | undefined>(undefined);

  const send: typeof fetch = async (input, init) => {
    const response = await fetcher(input, { ...init, signal: AbortSignal.timeout(answerMs) });
    if (response.status !== 401) return response;
    await response.body?.cancel();
    throw new Error(rejected);
  };

  const servedAddresses = async (account: DAVAccount): Promise<readonly string[]> => {
    try {
      return await fetchCalendarUserAddresses({ account, headers, fetch: send });
    } catch {
      return [];
    }
  };

  const login = (): Promise<Result<Session, string>> =>
    attempt(async () => {
      const account = await createAccount({ account: { serverUrl, accountType: "caldav" }, headers, fetch: send });
      if (account.homeUrl === undefined) return fail("iCloud didn't say where the calendars are.");
      const served = await servedAddresses(account);
      const addresses = [...(options.addresses ?? []), options.appleId, ...served]
        .map(toAddress)
        .filter((address) => address.includes("@"));
      const current = { homeUrl: withSlash(account.homeUrl), addresses: [...new Set(addresses)] };
      session.set(current);
      return ok(current);
    });

  const connected = async (): Promise<Result<Session, string>> => {
    const known = session.get();
    return known ? ok(known) : login();
  };

  const collections = async (current: Session): Promise<Result<readonly Collection[], string>> => {
    const responses = await propfind({
      url: current.homeUrl,
      depth: "1",
      props: {
        "d:displayname": {},
        "d:resourcetype": {},
        "d:current-user-privilege-set": {},
        "d:sync-token": {},
        "c:supported-calendar-component-set": {},
      },
      headers,
      fetch: send,
    });
    const refusal = responses.find(isRefusal);
    return refusal
      ? fail(`iCloud wouldn't list the calendars (${refusal.status}).`)
      : ok(responses.flatMap((response) => toCollection(response, current.homeUrl)));
  };

  const withSession = <Value>(
    work: (current: Session) => Promise<Result<Value, string>>,
  ): Promise<Result<Value, string>> =>
    attempt(async () => {
      const current = await connected();
      return current.ok ? work(current.value) : current;
    });

  const withCollections = <Value>(
    work: (current: Session, listed: readonly Collection[]) => Promise<Result<Value, string>>,
  ): Promise<Result<Value, string>> =>
    withSession(async (current) => {
      const listed = await collections(current);
      return listed.ok ? work(current, listed.value) : listed;
    });

  const read = async (url: string, calendar: CalendarInfo): Promise<Result<CalendarObject, string>> => {
    const response = await send(url, { headers: { ...headers, accept: "text/calendar" } });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(response.status === 404 ? "That event isn't in iCloud any more." : refusalOf(response.status));
    }
    const etag = response.headers.get("etag");
    return ok({ ics: await response.text(), url, ...(etag !== null && { etag }), calendar });
  };

  const write = async (url: string, ics: string, condition: Condition): Promise<Result<undefined, string>> => {
    const response = await send(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/calendar; charset=utf-8", ...condition },
      body: ics,
    });
    await response.body?.cancel();
    return response.ok ? ok(undefined) : fail(refusalOf(response.status));
  };

  const erase = async (url: string, etag: string | undefined): Promise<Result<undefined, string>> => {
    const response = await send(url, {
      method: "DELETE",
      headers: { ...headers, ...(etag !== undefined && { "if-match": etag }) },
    });
    await response.body?.cancel();
    return response.ok || response.status === 404 ? ok(undefined) : fail(refusalOf(response.status));
  };

  const readBack = async (
    current: Session,
    url: string,
    calendar: CalendarInfo,
    recurrenceId?: string,
  ): Promise<Result<CalendarEvent, string>> => {
    const object = await read(url, calendar);
    return object.ok ? toCalendarEvent(object.value, current.addresses, recurrenceId) : object;
  };

  const rewrite = async (
    event: CalendarEvent,
    change: (ics: string) => Result<string | undefined, string>,
  ): Promise<Result<undefined, string>> => {
    const object = await read(event.url, event.calendar);
    if (!object.ok) return object;
    const { etag } = object.value;
    if (etag !== undefined && event.etag !== undefined && bareEtag(event.etag) !== bareEtag(etag)) {
      return fail(changedSince);
    }
    const changed = change(object.value.ics);
    if (!changed.ok) return changed;
    if (changed.value === undefined) return erase(event.url, etag);
    return write(event.url, changed.value, etag === undefined ? {} : { "if-match": etag });
  };

  const rewritten = (
    event: CalendarEvent,
    change: (ics: string, current: Session) => Result<string, string>,
  ): Promise<Result<CalendarEvent, string>> =>
    withSession(async (current) => {
      const done = await rewrite(event, (ics) => change(ics, current));
      return done.ok ? readBack(current, event.url, event.calendar, event.recurrenceId) : done;
    });

  const query = async (calendar: CalendarInfo, range: Range): Promise<Result<readonly CalendarObject[], string>> => {
    const responses = await calendarQuery({
      url: calendar.url,
      depth: "1",
      props: objectProperties,
      filters: {
        "comp-filter": {
          _attributes: { name: "VCALENDAR" },
          "comp-filter": {
            _attributes: { name: "VEVENT" },
            "time-range": { _attributes: { start: davTime(range.from), end: davTime(range.to) } },
          },
        },
      },
      headers,
      fetch: send,
    });
    return ok(responses.flatMap((response) => toObject(response, calendar)));
  };

  const sync = async (
    collection: Collection,
    since: string | undefined,
    current: Session,
  ): Promise<Result<Progress, string>> => {
    const unchanged = { token: collection.syncToken ?? since, changed: [], removed: [] };
    if (since === undefined || collection.syncToken === undefined || since === collection.syncToken) {
      return ok(unchanged);
    }
    const responses = await syncCollection({
      url: collection.info.url,
      props: { "d:getetag": {} },
      syncLevel: 1,
      syncToken: since,
      headers,
      fetch: send,
    });
    const refusal = responses.find(isRefusal);
    if (refusal) {
      const answer: unknown = refusal.raw;
      const isStale =
        [403, 409].includes(refusal.status) || (typeof answer === "string" && answer.includes("valid-sync-token"));
      return isStale ? ok({ ...unchanged, token: collection.syncToken }) : fail(refusalOf(refusal.status));
    }
    const members = responses.filter((response) => response.href !== undefined && !response.href.endsWith("/"));
    const removed = members
      .filter((member) => member.status === 404)
      .map((member) => new URL(member.href ?? "", collection.info.url).href);
    const changedHrefs = members.filter((member) => member.status !== 404).map((member) => member.href ?? "");
    const fetched =
      changedHrefs.length === 0
        ? []
        : await calendarMultiGet({
            url: collection.info.url,
            props: objectProperties,
            objectUrls: changedHrefs,
            depth: "1",
            headers,
            fetch: send,
          });
    const objects = fetched.flatMap((response) => toObject(response, collection.info));
    const token = textOf(field(field(responses[0]?.raw, "multistatus"), "syncToken")) ?? collection.syncToken;
    return ok({ token, changed: eventsOf(objects, current.addresses), removed });
  };

  return {
    check: () => {
      session.set(undefined);
      return withCollections((_current, listed) => Promise.resolve(ok({ calendars: listed.map(({ info }) => info) })));
    },

    calendars: () => withCollections((_current, listed) => Promise.resolve(ok(listed.map(({ info }) => info)))),

    ensureKumo: () =>
      withCollections(async (current, listed) => {
        const existing = listed.find(({ info }) => info.isKumo);
        if (existing) return ok(existing.info);
        const url = new URL(`${randomUUID()}/`, current.homeUrl).href;
        const made = await makeCalendar({
          url,
          props: {
            "d:displayname": kumoName,
            "c:supported-calendar-component-set": { "c:comp": { _attributes: { name: "VEVENT" } } },
          },
          headers,
          fetch: send,
        });
        const refusal = made.find((response) => !response.ok);
        return refusal
          ? fail(`iCloud wouldn't make the Kumo calendar (${refusal.status}).`)
          : ok({ url, name: kumoName, isKumo: true, readOnly: false });
      }),

    events: (from, to) => {
      const range = toRange(from, to);
      if (!range.ok) return Promise.resolve(range);
      return withCollections(async (current, listed) => {
        const found = combined(await Promise.all(listed.map(({ info }) => query(info, range.value))));
        if (!found.ok) return found;
        return ok(
          found.value
            .flat()
            .flatMap((object) => {
              const occurrences = toOccurrences(object, current.addresses, range.value);
              return occurrences.ok ? occurrences.value : [];
            })
            .toSorted(byStart),
        );
      });
    },

    create: (calendar, event) => {
      if (calendar.readOnly) return Promise.resolve(fail(`${calendar.name} is read-only.`));
      const uid = event.uid ?? randomUUID().toUpperCase();
      const ics = toIcs(event, uid, Date.now());
      if (!ics.ok) return Promise.resolve(ics);
      const url = new URL(`${uid}.ics`, withSlash(calendar.url)).href;
      return withSession(async (current) => {
        const written = await write(url, ics.value, { "if-none-match": "*" });
        return written.ok ? readBack(current, url, calendar) : written;
      });
    },

    update: (event, changes) => rewritten(event, (ics) => withChanges(ics, changes, Date.now(), event.recurrenceId)),

    remove: (event) => {
      const { recurrenceId } = event;
      return attempt(() =>
        recurrenceId === undefined
          ? erase(event.url, event.etag)
          : rewrite(event, (ics) => withoutOccurrence(ics, recurrenceId)),
      );
    },

    respond: (event, answer) =>
      rewritten(event, (ics, current) => withResponse(ics, current.addresses, answer, event.recurrenceId)),

    changes: (token) => {
      const previous = token === undefined ? ok(undefined) : decodeToken(token);
      if (!previous.ok) return Promise.resolve(previous);
      return withCollections(async (current, listed) => {
        const progress = combined(
          await Promise.all(
            listed.map((collection) =>
              previous.value === undefined
                ? Promise.resolve(ok({ token: collection.syncToken, changed: [], removed: [] }))
                : sync(collection, previous.value[collection.info.url], current),
            ),
          ),
        );
        if (!progress.ok) return progress;
        const tokens = listed.flatMap(({ info }, index) => {
          const next = progress.value[index]?.token;
          return next === undefined ? [] : [[info.url, next] as const];
        });
        return ok({
          token: encodeToken(Object.fromEntries(tokens)),
          changed: progress.value.flatMap(({ changed }) => changed),
          removed: progress.value.flatMap(({ removed }) => removed),
        });
      });
    },
  };
};
