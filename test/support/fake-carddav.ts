import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCell } from "#cell.ts";

// A small iCloud Contacts: discovery, two address books (one shared read-only), PROPFIND listings, sync tokens,
// multiget, and writes guarded by ETags, as contacts.icloud.com answers them.

type FakeCard = { readonly vcard: string; readonly etag: string };

type FakeBook = {
  readonly name: string;
  readonly readOnly: boolean;
  readonly cards: ReadonlyMap<string, FakeCard>;
  readonly log: readonly { readonly file: string; readonly revision: number }[];
};

export type Written = { readonly method: string; readonly path: string; readonly condition?: string };

export type FakeCardDav = {
  readonly serverUrl: string;
  readonly appleId: string;
  readonly appPassword: string;
  readonly bookUrl: (name: string) => string;
  // A card already there, such as one they made on their phone; gives its URL.
  readonly seed: (bookName: string, file: string, vcard: string) => string;
  readonly stored: (url: string) => string | undefined;
  readonly files: (bookName: string) => readonly string[];
  // Every write that reached the server, with the If-Match or If-None-Match it carried.
  readonly writes: () => readonly Written[];
  // Refuses the next sync token, as iCloud does after a long while.
  readonly forgetTokens: () => void;
  readonly close: () => Promise<void>;
};

const appleId = "divy@icloud.com";
const appPassword = "abcd-efgh-ijkl-mnop";
const principal = "/1234/principal/";
const home = "/1234/carddavhome/";
const namespaces = `xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"`;

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const multistatus = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus ${namespaces}>${body}</d:multistatus>`;

const found = (href: string, properties: string): string =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const missing = (href: string): string =>
  `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

const send = (response: ServerResponse, status: number, body = "", headers: Record<string, string> = {}): void => {
  response.writeHead(status, body ? { "content-type": "application/xml; charset=utf-8", ...headers } : headers);
  response.end(body);
};

const elementText = (body: string, name: string): string | undefined =>
  new RegExp(String.raw`<(?:\w+:)?${name}>([^<]*)</(?:\w+:)?${name}>`, "u").exec(body)?.[1];

const hrefsIn = (body: string): readonly string[] =>
  body
    .matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gu)
    .map((match) => match[1] ?? "")
    .toArray();

const cardXml = (path: string, file: string, card: FakeCard, withData: boolean): string =>
  found(
    `${path}${file}`,
    `<d:getetag>${escapeXml(card.etag)}</d:getetag>${withData ? `<card:address-data>${escapeXml(card.vcard)}</card:address-data>` : ""}`,
  );

const principalXml = (path: string): string =>
  multistatus(
    found(
      path,
      `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>` +
        `<card:addressbook-home-set><d:href>${home}</d:href></card:addressbook-home-set>`,
    ),
  );

const splitUrl = (url: string): { readonly bookPath: string; readonly file: string } => {
  const { pathname } = new URL(url);
  const bookPath = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return { bookPath, file: decodeURIComponent(pathname.slice(bookPath.length)) };
};

export const startFakeCardDav = async (): Promise<FakeCardDav> => {
  const revision = createCell(0);
  const written = createCell<readonly Written[]>([]);
  const isForgetful = createCell(false);
  const books = createCell<ReadonlyMap<string, FakeBook>>(
    new Map([
      [`${home}card/`, { name: "Contacts", readOnly: false, cards: new Map(), log: [] }],
      [`${home}team/`, { name: "Team", readOnly: true, cards: new Map(), log: [] }],
    ]),
  );

  const syncToken = (book: FakeBook): string => `https://example.com/ns/sync/${String(book.log.at(-1)?.revision ?? 0)}`;

  const change = (path: string, file: string, card: FakeCard | undefined): FakeCard | undefined => {
    const book = books.get().get(path);
    if (!book) return undefined;
    const next = revision.update((current) => current + 1);
    const stored = card && { vcard: card.vcard, etag: `"c${String(next)}"` };
    const cards = new Map(stored ? [...book.cards, [file, stored]] : [...book.cards].filter(([name]) => name !== file));
    books.set(new Map([...books.get(), [path, { ...book, cards, log: [...book.log, { file, revision: next }] }]]));
    return stored;
  };

  const homeXml = (): string =>
    multistatus(
      found(home, "<d:resourcetype><d:collection/></d:resourcetype>") +
        [...books.get()]
          .map(([path, book]) =>
            found(
              path,
              `<d:displayname>${escapeXml(book.name)}</d:displayname>` +
                "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>" +
                `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${book.readOnly ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set>` +
                `<d:sync-token>${syncToken(book)}</d:sync-token>`,
            ),
          )
          .join(""),
    );

  const bookXml = (path: string, book: FakeBook): string =>
    multistatus(
      found(path, "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>") +
        [...book.cards].map(([file, card]) => cardXml(path, file, card, false)).join(""),
    );

  const report = (response: ServerResponse, path: string, book: FakeBook, body: string): void => {
    if (body.includes("sync-collection")) {
      const since = /\/(?<revision>\d+)$/u.exec(elementText(body, "sync-token") ?? "")?.groups?.revision;
      if (since === undefined || isForgetful.get()) {
        isForgetful.set(false);
        send(response, 403, `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`);
        return;
      }
      const files = new Set(book.log.filter((entry) => entry.revision > Number(since)).map(({ file }) => file));
      const entries = [...files].map((file) => {
        const card = book.cards.get(file);
        return card ? cardXml(path, file, card, false) : missing(`${path}${file}`);
      });
      send(response, 207, multistatus(`${entries.join("")}<d:sync-token>${syncToken(book)}</d:sync-token>`));
      return;
    }
    if (!body.includes("addressbook-multiget")) {
      send(response, 501);
      return;
    }
    const entries = hrefsIn(body).map((href) => {
      const file = href.slice(path.length);
      const card = book.cards.get(file);
      return card ? cardXml(path, file, card, true) : missing(href);
    });
    send(response, 207, multistatus(entries.join("")));
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: readonly Buffer[] = await request.toArray();
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path === "/.well-known/carddav") {
      send(response, 301, "", { location: "/" });
      return;
    }
    const expected = `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
    if (request.headers.authorization !== expected) {
      send(response, 401, "", { "www-authenticate": 'Basic realm="fake iCloud"' });
      return;
    }
    const method = request.method ?? "GET";
    const exactBook = books.get().get(path);
    if (method === "PROPFIND") {
      if (path === home) send(response, 207, homeXml());
      else if (exactBook) send(response, 207, bookXml(path, exactBook));
      else send(response, 207, principalXml(path));
      return;
    }
    const bookPath = path.slice(0, path.lastIndexOf("/") + 1);
    const file = path.slice(bookPath.length);
    const book = books.get().get(bookPath);
    if (!book) {
      send(response, 404);
      return;
    }
    if (method === "REPORT") {
      report(response, bookPath, book, body);
      return;
    }
    const existing = book.cards.get(file);
    const ifMatch = request.headers["if-match"];
    const ifNoneMatch = request.headers["if-none-match"];
    const conflicts =
      (ifNoneMatch === "*" && existing !== undefined) || (ifMatch !== undefined && ifMatch !== existing?.etag);
    if (method === "PUT" || method === "DELETE") {
      const condition =
        ifMatch === undefined
          ? ifNoneMatch === undefined
            ? undefined
            : `if-none-match ${ifNoneMatch}`
          : `if-match ${ifMatch}`;
      written.update((all) => [...all, { method, path, ...(condition !== undefined && { condition }) }]);
    }
    switch (method) {
      case "GET": {
        if (existing) {
          response.writeHead(200, { "content-type": "text/vcard; charset=utf-8", etag: existing.etag });
          response.end(existing.vcard);
        } else send(response, 404);
        return;
      }
      case "PUT": {
        if (book.readOnly) send(response, 403);
        else if (conflicts) send(response, 412);
        else {
          const stored = change(bookPath, file, { vcard: body, etag: "" });
          send(response, existing ? 204 : 201, "", { etag: stored?.etag ?? "" });
        }
        return;
      }
      case "DELETE": {
        if (!existing) send(response, 404);
        else if (book.readOnly) send(response, 403);
        else if (conflicts) send(response, 412);
        else {
          change(bookPath, file, undefined);
          send(response, 204);
        }
        return;
      }
      default: {
        send(response, 405);
      }
    }
  };

  const server = createServer((request, response) => {
    void respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake CardDAV server has no port.");
  const serverUrl = `http://127.0.0.1:${String(address.port)}`;
  const pathOf = (name: string): string => {
    const entry = [...books.get()].find(([, book]) => book.name === name);
    if (!entry) throw new Error(`The fake has no address book called ${name}.`);
    return entry[0];
  };

  return {
    serverUrl,
    appleId,
    appPassword,
    bookUrl: (name) => `${serverUrl}${pathOf(name)}`,
    seed: (bookName, file, vcard) => {
      change(pathOf(bookName), file, { vcard, etag: "" });
      return `${serverUrl}${pathOf(bookName)}${file}`;
    },
    stored: (url) => {
      const { bookPath, file } = splitUrl(url);
      return books.get().get(bookPath)?.cards.get(file)?.vcard;
    },
    files: (bookName) => [...(books.get().get(pathOf(bookName))?.cards.keys() ?? [])],
    writes: () => written.get(),
    forgetTokens: () => {
      isForgetful.set(true);
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
