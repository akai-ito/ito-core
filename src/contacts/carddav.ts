import { addressBookMultiGet, createAccount, propfind, syncCollection, type DAVResponse } from "tsdav";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";

// iCloud Contacts over CardDAV, with the Apple ID and app-specific password of the iCloud connection: every
// address book, read in full once and then by sync token, and written with ETags so a change made meanwhile on
// a phone is never overwritten.

export type AddressBook = { readonly url: string; readonly name: string; readonly readOnly: boolean };

export type StoredCard = {
  readonly url: string;
  readonly etag?: string;
  readonly vcard: string;
  readonly book: AddressBook;
};

export type CardChanges = {
  readonly token: string;
  readonly changed: readonly StoredCard[];
  readonly removed: readonly string[];
  // Books read in full this time, whose cards replace everything known of them.
  readonly full: readonly string[];
};

export type ContactsSource = {
  readonly check: () => Promise<Result<{ readonly books: readonly AddressBook[] }, string>>;
  readonly books: () => Promise<Result<readonly AddressBook[], string>>;
  // What changed since the token; with no token, or one a book no longer accepts, that book in full.
  readonly changes: (token?: string) => Promise<Result<CardChanges, string>>;
  readonly read: (url: string, book: AddressBook) => Promise<Result<StoredCard, string>>;
  readonly create: (book: AddressBook, file: string, vcard: string) => Promise<Result<StoredCard, string>>;
  // Writes over a card only if it's still as read, by its ETag.
  readonly update: (card: StoredCard, vcard: string) => Promise<Result<StoredCard, string>>;
  // Puts a card back as it was: over the one there if it still has that ETag, or anew if it's gone.
  readonly restore: (
    url: string,
    book: AddressBook,
    vcard: string,
    etag?: string,
  ) => Promise<Result<StoredCard, string>>;
  readonly remove: (url: string, etag?: string) => Promise<Result<undefined, string>>;
};

export type CardDavOptions = {
  readonly appleId: string;
  readonly appPassword: string;
  readonly serverUrl?: string;
  readonly fetch?: typeof fetch;
};

type Session = { readonly homeUrl: string };

type Book = { readonly info: AddressBook; readonly syncToken?: string };

type Condition = Readonly<Record<string, never>> | { readonly "if-match": string } | { readonly "if-none-match": "*" };

const rejected = "iCloud rejected that email address or app-specific password.";

export const changedSince = "That contact changed in iCloud since it was read; read it again first.";

export const isRejected = (failure: string): boolean => failure === rejected;

export const isConflict = (failure: string): boolean => failure === changedSince;

const answerMs = 30_000;
const chunkSize = 50;
const writePrivileges = new Set(["all", "write", "writeContent", "bind"]);
const cardProperties = { "d:getetag": {}, "card:address-data": {} };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

const textOf = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value : (field(value, "_cdata") ?? field(value, "_text"));
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
};

const withSlash = (url: string): string => (url.endsWith("/") ? url : `${url}/`);

const sameUrl = (left: string, right: string): boolean => withSlash(left) === withSlash(right);

const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return `iCloud Contacts failed: ${String(error)}`;
  if (error.message === rejected) return rejected;
  if (error.name === "TimeoutError") return "iCloud Contacts didn't answer in time.";
  if (error instanceof TypeError && error.cause instanceof Error) {
    return `iCloud Contacts couldn't be reached: ${error.cause.message}`;
  }
  return `iCloud Contacts failed: ${error.message.split(/(?<=\.)\s/u, 1)[0] ?? error.message}`;
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
      return "iCloud doesn't allow changes to that address book.";
    }
    case 404: {
      return "That contact isn't in iCloud any more.";
    }
    case 409:
    case 412: {
      return changedSince;
    }
    default: {
      return `iCloud Contacts answered ${String(status)}.`;
    }
  }
};

const isRefusal = (response: DAVResponse): boolean => !response.ok && response.propStats === undefined;

const toBook = (response: DAVResponse, homeUrl: string): readonly Book[] => {
  const properties: unknown = response.props;
  const resourceType = field(properties, "resourcetype");
  const isAddressBook = isRecord(resourceType) && "addressbook" in resourceType;
  if (!isAddressBook || response.href === undefined) return [];
  const privileges = listOf(field(field(properties, "currentUserPrivilegeSet"), "privilege")).flatMap((privilege) =>
    isRecord(privilege) ? Object.keys(privilege) : [],
  );
  const syncToken = textOf(field(properties, "syncToken"));
  return [
    {
      info: {
        url: new URL(response.href, homeUrl).href,
        name: textOf(field(properties, "displayname")) ?? "Contacts",
        readOnly: privileges.length > 0 && privileges.every((privilege) => !writePrivileges.has(privilege)),
      },
      ...(syncToken !== undefined && { syncToken }),
    },
  ];
};

const toCard = (response: DAVResponse, book: AddressBook): readonly StoredCard[] => {
  const properties: unknown = response.props;
  const vcard = textOf(field(properties, "addressData"));
  const etag = textOf(field(properties, "getetag"));
  return vcard === undefined || response.href === undefined
    ? []
    : [{ url: new URL(response.href, book.url).href, ...(etag !== undefined && { etag }), vcard, book }];
};

const encodeToken = (tokens: Readonly<Record<string, string>>): string =>
  Buffer.from(JSON.stringify(tokens)).toString("base64url");

const decodeToken = (token: string): Readonly<Record<string, string>> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return isRecord(value)
      ? (Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string")) as Record<
          string,
          string
        >)
      : {};
  } catch {
    return {};
  }
};

const chunks = <Item>(items: readonly Item[]): readonly (readonly Item[])[] =>
  Array.from({ length: Math.ceil(items.length / chunkSize) }, (_, index) =>
    items.slice(index * chunkSize, (index + 1) * chunkSize),
  );

type Progress = {
  readonly token?: string;
  readonly changed: readonly StoredCard[];
  readonly removed: readonly string[];
  readonly isFull: boolean;
};

export const createContactsSource = (options: CardDavOptions): ContactsSource => {
  const serverUrl = options.serverUrl ?? "https://contacts.icloud.com";
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

  const login = (): Promise<Result<Session, string>> =>
    attempt(async () => {
      const account = await createAccount({ account: { serverUrl, accountType: "carddav" }, headers, fetch: send });
      if (account.homeUrl === undefined) return fail("iCloud didn't say where the contacts are.");
      const current = { homeUrl: withSlash(account.homeUrl) };
      session.set(current);
      return ok(current);
    });

  const withSession = <Value>(
    work: (current: Session) => Promise<Result<Value, string>>,
  ): Promise<Result<Value, string>> =>
    attempt(async () => {
      const known = session.get();
      const current = known ? ok(known) : await login();
      return current.ok ? work(current.value) : current;
    });

  const listBooks = async (current: Session): Promise<Result<readonly Book[], string>> => {
    const responses = await propfind({
      url: current.homeUrl,
      depth: "1",
      props: { "d:displayname": {}, "d:resourcetype": {}, "d:current-user-privilege-set": {}, "d:sync-token": {} },
      headers,
      fetch: send,
    });
    const refusal = responses.find(isRefusal);
    return refusal
      ? fail(`iCloud wouldn't list the address books (${String(refusal.status)}).`)
      : ok(responses.flatMap((response) => toBook(response, current.homeUrl)));
  };

  const withBooks = <Value>(
    work: (current: Session, books: readonly Book[]) => Promise<Result<Value, string>>,
  ): Promise<Result<Value, string>> =>
    withSession(async (current) => {
      const listed = await listBooks(current);
      return listed.ok ? work(current, listed.value) : listed;
    });

  const multiGet = async (book: AddressBook, hrefs: readonly string[]): Promise<readonly StoredCard[]> => {
    const fetched = await Promise.all(
      chunks(hrefs).map((part) =>
        addressBookMultiGet({
          url: book.url,
          props: cardProperties,
          objectUrls: [...part],
          depth: "1",
          headers,
          fetch: send,
        }),
      ),
    );
    return fetched.flat().flatMap((response) => toCard(response, book));
  };

  // Every card in a book: its members by PROPFIND, which every server answers, then their vCards.
  const everything = async ({ info, syncToken }: Book): Promise<Result<Progress, string>> => {
    const responses = await propfind({
      url: info.url,
      depth: "1",
      props: { "d:getetag": {}, "d:resourcetype": {} },
      headers,
      fetch: send,
    });
    const refusal = responses.find(isRefusal);
    if (refusal) return fail(`iCloud wouldn't list ${info.name} (${String(refusal.status)}).`);
    const members = responses
      .filter((response) => response.href !== undefined && !sameUrl(new URL(response.href, info.url).href, info.url))
      .filter((response) => !isRecord(field(field(response.props, "resourcetype"), "collection")))
      .map((response) => response.href ?? "");
    return ok({
      ...(syncToken !== undefined && { token: syncToken }),
      changed: await multiGet(info, members),
      removed: [],
      isFull: true,
    });
  };

  const sync = async (book: Book, since: string | undefined): Promise<Result<Progress, string>> => {
    if (since === undefined || book.syncToken === undefined) return everything(book);
    if (since === book.syncToken) return ok({ token: since, changed: [], removed: [], isFull: false });
    const responses = await syncCollection({
      url: book.info.url,
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
      return isStale ? everything(book) : fail(refusalOf(refusal.status));
    }
    const members = responses.filter((response) => response.href !== undefined && !response.href.endsWith("/"));
    const removed = members
      .filter((member) => member.status === 404)
      .map((member) => new URL(member.href ?? "", book.info.url).href);
    const changed = members.filter((member) => member.status !== 404).map((member) => member.href ?? "");
    const token = textOf(field(field(responses[0]?.raw, "multistatus"), "syncToken")) ?? book.syncToken;
    return ok({ token, changed: await multiGet(book.info, changed), removed, isFull: false });
  };

  const read = async (url: string, book: AddressBook): Promise<Result<StoredCard, string>> => {
    const response = await send(url, { headers: { ...headers, accept: "text/vcard" } });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(refusalOf(response.status));
    }
    const etag = response.headers.get("etag");
    return ok({ url, ...(etag !== null && { etag }), vcard: await response.text(), book });
  };

  const write = async (
    url: string,
    book: AddressBook,
    vcard: string,
    condition: Condition,
  ): Promise<Result<StoredCard, string>> => {
    if (book.readOnly) return fail(`${book.name} is read-only.`);
    const response = await send(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/vcard; charset=utf-8", ...condition },
      body: vcard,
    });
    await response.body?.cancel();
    return response.ok ? read(url, book) : fail(refusalOf(response.status));
  };

  return {
    check: () => {
      session.set(undefined);
      return withBooks((_current, books) => Promise.resolve(ok({ books: books.map(({ info }) => info) })));
    },

    books: () => withBooks((_current, books) => Promise.resolve(ok(books.map(({ info }) => info)))),

    changes: (token) => {
      const previous = token === undefined ? {} : decodeToken(token);
      return withBooks(async (_current, books) => {
        const progress = await Promise.all(books.map((book) => sync(book, previous[book.info.url])));
        const [failure] = progress.flatMap((result) => (result.ok ? [] : result.failure));
        if (failure !== undefined) return fail(failure);
        const done = progress.flatMap((result) => (result.ok ? result.value : []));
        const tokens = books.flatMap(({ info }, index) => {
          const next = done[index]?.token;
          return next === undefined ? [] : [[info.url, next] as const];
        });
        return ok({
          token: encodeToken(Object.fromEntries(tokens)),
          changed: done.flatMap(({ changed }) => changed),
          removed: done.flatMap(({ removed }) => removed),
          full: books.filter((_book, index) => done[index]?.isFull === true).map(({ info }) => info.url),
        });
      });
    },

    read: (url, book) => withSession(() => read(url, book)),

    create: (book, file, vcard) =>
      withSession(() => write(new URL(file, withSlash(book.url)).href, book, vcard, { "if-none-match": "*" })),

    update: (card, vcard) =>
      withSession(() => write(card.url, card.book, vcard, card.etag === undefined ? {} : { "if-match": card.etag })),

    restore: (url, book, vcard, etag) =>
      withSession(() => write(url, book, vcard, etag === undefined ? { "if-none-match": "*" } : { "if-match": etag })),

    remove: (url, etag) =>
      withSession(async () => {
        const response = await send(url, {
          method: "DELETE",
          headers: { ...headers, ...(etag !== undefined && { "if-match": etag }) },
        });
        await response.body?.cancel();
        return response.ok || response.status === 404 ? ok(undefined) : fail(refusalOf(response.status));
      }),
  };
};
