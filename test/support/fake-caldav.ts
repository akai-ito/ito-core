import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCell } from "#cell.ts";

type FakeObject = { readonly ics: string; readonly etag: string };

type FakeCalendar = {
  readonly name: string;
  readonly components: readonly string[];
  readonly readOnly: boolean;
  readonly objects: ReadonlyMap<string, FakeObject>;
  readonly log: readonly { readonly file: string; readonly revision: number }[];
};

export type FakeCalDav = {
  readonly serverUrl: string;
  readonly appleId: string;
  readonly appPassword: string;
  readonly alias: string;
  readonly calendarUrl: (name: string) => string;
  readonly seed: (calendarName: string, file: string, ics: string) => string;
  readonly stored: (url: string) => string | undefined;
  readonly calendarNames: () => readonly string[];
  readonly close: () => Promise<void>;
};

const appleId = "divy@icloud.com";
const appPassword = "abcd-efgh-ijkl-mnop";
const alias = "divy@me.com";
const principal = "/1234/principal/";
const home = "/1234/calendars/";
const namespaces = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"`;

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

const objectXml = (path: string, file: string, object: FakeObject, withData: boolean): string =>
  found(
    `${path}${file}`,
    `<d:getetag>${escapeXml(object.etag)}</d:getetag>${withData ? `<c:calendar-data>${escapeXml(object.ics)}</c:calendar-data>` : ""}`,
  );

const principalXml = (path: string): string =>
  multistatus(
    found(
      path,
      `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>` +
        `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>` +
        `<c:calendar-user-address-set><d:href>mailto:${appleId}</d:href><d:href>mailto:${alias}</d:href><d:href>${principal}</d:href></c:calendar-user-address-set>`,
    ),
  );

export const startFakeCalDav = async (): Promise<FakeCalDav> => {
  const revision = createCell(0);
  const calendars = createCell<ReadonlyMap<string, FakeCalendar>>(
    new Map([
      [`${home}home/`, { name: "Home", components: ["VEVENT"], readOnly: false, objects: new Map(), log: [] }],
      [`${home}family/`, { name: "Family", components: ["VEVENT"], readOnly: true, objects: new Map(), log: [] }],
      [`${home}tasks/`, { name: "Reminders", components: ["VTODO"], readOnly: false, objects: new Map(), log: [] }],
    ]),
  );

  const syncToken = (calendar: FakeCalendar): string => `rev-${String(calendar.log.at(-1)?.revision ?? 0)}`;

  const change = (path: string, file: string, object: FakeObject | undefined): FakeObject | undefined => {
    const calendar = calendars.get().get(path);
    if (!calendar) return undefined;
    const next = revision.update((current) => current + 1);
    const stored = object && { ics: object.ics, etag: `"${String(next)}"` };
    const objects = new Map(
      stored ? [...calendar.objects, [file, stored]] : [...calendar.objects].filter(([name]) => name !== file),
    );
    calendars.set(
      new Map([...calendars.get(), [path, { ...calendar, objects, log: [...calendar.log, { file, revision: next }] }]]),
    );
    return stored;
  };

  const homeXml = (): string =>
    multistatus(
      found(home, "<d:resourcetype><d:collection/></d:resourcetype><d:displayname>Calendars</d:displayname>") +
        [...calendars.get()]
          .map(([path, calendar]) =>
            found(
              path,
              `<d:displayname>${escapeXml(calendar.name)}</d:displayname>` +
                "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>" +
                `<c:supported-calendar-component-set>${calendar.components.map((component) => `<c:comp name="${component}"/>`).join("")}</c:supported-calendar-component-set>` +
                `<d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${calendar.readOnly ? "" : "<d:privilege><d:write/></d:privilege>"}</d:current-user-privilege-set>` +
                `<d:sync-token>${syncToken(calendar)}</d:sync-token>`,
            ),
          )
          .join(""),
    );

  const report = (response: ServerResponse, path: string, calendar: FakeCalendar, body: string): void => {
    if (body.includes("sync-collection")) {
      const since = /^rev-(?<revision>\d+)$/u.exec(elementText(body, "sync-token") ?? "")?.groups?.revision;
      if (since === undefined) {
        send(response, 403, `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`);
        return;
      }
      const files = new Set(calendar.log.filter((entry) => entry.revision > Number(since)).map(({ file }) => file));
      const entries = [...files].map((file) => {
        const object = calendar.objects.get(file);
        return object ? objectXml(path, file, object, false) : missing(`${path}${file}`);
      });
      send(response, 207, multistatus(`${entries.join("")}<d:sync-token>${syncToken(calendar)}</d:sync-token>`));
      return;
    }
    const wanted = body.includes("calendar-multiget")
      ? hrefsIn(body).map((href) => href.slice(path.length))
      : calendar.objects.keys().toArray();
    const entries = wanted.map((file) => {
      const object = calendar.objects.get(file);
      return object ? objectXml(path, file, object, true) : missing(`${path}${file}`);
    });
    send(response, 207, multistatus(entries.join("")));
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: readonly Buffer[] = await request.toArray();
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path === "/.well-known/caldav") {
      send(response, 301, "", { location: "/" });
      return;
    }
    const expected = `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
    if (request.headers.authorization !== expected) {
      send(response, 401, "", { "www-authenticate": 'Basic realm="fake iCloud"' });
      return;
    }
    const method = request.method ?? "GET";
    if (method === "PROPFIND") {
      send(response, 207, path === home ? homeXml() : principalXml(path));
      return;
    }
    if (method === "MKCALENDAR") {
      if (calendars.get().has(path)) {
        send(response, 405);
        return;
      }
      const name = elementText(body, "displayname") ?? "Untitled";
      const calendar = { name, components: ["VEVENT"], readOnly: false, objects: new Map(), log: [] };
      calendars.set(new Map([...calendars.get(), [path, calendar]]));
      send(response, 201);
      return;
    }
    const calendarPath = path.slice(0, path.lastIndexOf("/") + 1);
    const file = path.slice(calendarPath.length);
    const calendar = calendars.get().get(calendarPath);
    if (!calendar) {
      send(response, 404);
      return;
    }
    if (method === "REPORT") {
      report(response, calendarPath, calendar, body);
      return;
    }
    const existing = calendar.objects.get(file);
    const ifMatch = request.headers["if-match"];
    const conflicts =
      (request.headers["if-none-match"] === "*" && existing !== undefined) ||
      (ifMatch !== undefined && ifMatch !== existing?.etag);
    switch (method) {
      case "GET": {
        if (existing) {
          response.writeHead(200, { "content-type": "text/calendar; charset=utf-8", etag: existing.etag });
          response.end(existing.ics);
        } else send(response, 404);
        return;
      }
      case "PUT": {
        if (calendar.readOnly) send(response, 403);
        else if (conflicts) send(response, 412);
        else {
          const stored = change(calendarPath, file, { ics: body, etag: "" });
          send(response, existing ? 204 : 201, "", { etag: stored?.etag ?? "" });
        }
        return;
      }
      case "DELETE": {
        if (!existing) send(response, 404);
        else if (conflicts) send(response, 412);
        else {
          change(calendarPath, file, undefined);
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
  if (!address || typeof address === "string") throw new Error("The fake CalDAV server has no port.");
  const serverUrl = `http://127.0.0.1:${String(address.port)}`;
  const pathOf = (name: string): string => {
    const entry = [...calendars.get()].find(([, calendar]) => calendar.name === name);
    if (!entry) throw new Error(`The fake has no calendar called ${name}.`);
    return entry[0];
  };

  return {
    serverUrl,
    appleId,
    appPassword,
    alias,
    calendarUrl: (name) => `${serverUrl}${pathOf(name)}`,
    seed: (calendarName, file, ics) => {
      change(pathOf(calendarName), file, { ics, etag: "" });
      return `${serverUrl}${pathOf(calendarName)}${file}`;
    },
    stored: (url) => {
      const { pathname } = new URL(url);
      const calendarPath = pathname.slice(0, pathname.lastIndexOf("/") + 1);
      return calendars.get().get(calendarPath)?.objects.get(pathname.slice(calendarPath.length))?.ics;
    },
    calendarNames: () =>
      calendars
        .get()
        .values()
        .map(({ name }) => name)
        .toArray(),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
