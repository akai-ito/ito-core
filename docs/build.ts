import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { bundle, createConfig } from "@redocly/openapi-core";
import { getDefaults, Marked, Parser, type Token, type Tokens } from "marked";
import { protocolDirectory } from "#protocol/schemas.ts";
import { listTranscriptFiles, transcriptDirectory } from "#protocol/tools/transcript-files.ts";

type JsonObject = Readonly<Record<string, unknown>>;

type Summary = { readonly who: string; readonly what: string };

type AppRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonObject;
};

type ServerResponse = { readonly status: number; readonly body?: JsonObject };

type TranscriptFile = { readonly raw: string; readonly header: JsonObject; readonly lines: readonly JsonObject[] };

const root = path.join(import.meta.dirname, "..");
const site = path.join(root, "site");
const require = createRequire(import.meta.url);

const mark = `<svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M8 52 C15 52 18 44 24 39 C30 34 40 36 41 27 C42 19 33 17 31 23 C29 30 38 33 45 28 C51 24 54 18 57 11" stroke="#D7263D" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const apiReferencePage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ito client API reference</title>
</head>
<body>
<div id="app"></div>
<script src="../assets/scalar.js"></script>
<script>
Scalar.createApiReference("#app", {
  url: "../protocol/v0/openapi.json",
  darkMode: true,
  withDefaultFonts: false,
  hideClientButton: true,
  hideTestRequestButton: true,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true },
  telemetry: false,
  defaultOpenAllTags: true,
});
</script>
</body>
</html>
`;

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const toSlug = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

const toPage = (title: string, depth: number, body: string): string => {
  const up = depth ? "../".repeat(depth) : "./";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${up}assets/site.css">
</head>
<body>
<header class="bar"><a class="home" href="${up}">${mark}<span>Ito client API</span></a>
<nav><a href="${up}api/">API reference</a><a href="${up}guarantees/">Guarantees</a><a href="${up}transcripts/">Transcripts</a></nav></header>
<main>${body}</main>
<footer>Source-available under the PolyForm Noncommercial or PolyForm Small Business licence. <a href="https://github.com/akai-ito/ito-core">akai-ito/ito-core</a></footer>
</body>
</html>
`;
};

const toHeading = ({ tokens, depth }: Tokens.Heading): string => {
  const text = Parser.parseInline(tokens, getDefaults());
  return `<h${depth} id="${toSlug(text)}">${text}</h${depth}>\n`;
};

const markdown = new Marked({ gfm: true, renderer: { heading: toHeading } });

const toSiteLink = (prefix: string, href: string): string => {
  if (/^https?:/u.test(href) || href.startsWith("#")) return href;
  if (href === "transcripts") return `${prefix}transcripts/`;
  if (href === "guarantees.md") return `${prefix}guarantees/`;
  const transcript = /^transcripts\/(?<name>\d\d-[\da-z-]+)\.jsonl$/u.exec(href)?.groups?.name;
  if (transcript) return `${prefix}transcripts/${transcript}/`;
  const isSpecFile = [
    "openapi.yaml",
    "events.schema.json",
    "push.schema.json",
    "blocks.schema.json",
    "motion.schema.json",
    "capability.schema.json",
  ].includes(href);
  return isSpecFile
    ? `${prefix}protocol/v0/${href}`
    : `https://github.com/akai-ito/ito-core/blob/main/protocol/${href}`;
};

const withSiteLinks = (value: unknown, prefix: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => withSiteLinks(item, prefix));
  if (!value || typeof value !== "object") return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withSiteLinks(item, prefix)]));
  return copy.type === "link" && typeof copy.href === "string"
    ? { ...copy, href: toSiteLink(prefix, copy.href) }
    : copy;
};

const toHtml = (source: string, prefix: string, shouldDrop: (token: Token) => boolean = () => false): string => {
  const tokens = withSiteLinks(markdown.lexer(source), prefix) as readonly Token[];
  return markdown.parser(tokens.filter((token) => !shouldDrop(token)));
};

const write = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const summariseRequest = (app: AppRequest): Summary => {
  const cursor = app.headers?.["Last-Event-ID"];
  const text = app.body && typeof app.body.text === "string" ? ` “${app.body.text}”` : "";
  const cut = app.body?.cut as { readonly offset?: number } | undefined;
  const detail = cursor ? ` · Last-Event-ID ${cursor}` : cut ? ` · cut at ${String(cut.offset)}` : text;
  return { who: "app", what: `<code>${app.method} ${escapeHtml(app.path)}</code>${escapeHtml(detail)}` };
};

const toResponseNote = (body: JsonObject): string => {
  const error = body.error as { readonly code?: string } | undefined;
  if (error?.code) return ` ${error.code}`;
  if (typeof body.state === "string") {
    return ` ${body.state}${typeof body.outcome === "string" ? ` · ${body.outcome}` : ""}`;
  }
  if (typeof body.retry_of === "string") return ` new attempt ${String(body.turn)}`;
  if (Array.isArray(body.messages)) {
    return ` ${body.messages.length} messages${body.has_more ? " · more before" : " · nothing older"}`;
  }
  const message = body.message as { readonly id?: string } | undefined;
  if (message?.id) return ` message ${message.id.slice(0, 8)}…`;
  if (typeof body.name === "string") {
    return ` ${body.name} · Ito ${String(body.version)} · agent ${String((body.agent as JsonObject | undefined)?.name)}`;
  }
  return Array.isArray(body.protocol) ? ` speaks ${body.protocol.join(", ")}` : "";
};

const summariseResponse = (server: ServerResponse, isLost: boolean): Summary => {
  const lost = isLost ? ` <span class="lost">lost on the way</span>` : "";
  return {
    who: "server",
    what: `<code>${server.status}</code>${escapeHtml(toResponseNote(server.body ?? {}))}${lost}`,
  };
};

const summariseWorld = (line: JsonObject): Summary => {
  const fields = Object.entries(line)
    .filter(([key]) => key !== "at" && key !== "world")
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return {
    who: "world",
    what: `<strong>${escapeHtml(line.world as string)}</strong>${fields ? ` · ${escapeHtml(fields)}` : ""}`,
  };
};

const summariseEvent = (event: JsonObject): Summary => {
  const type = `<code>${escapeHtml(String(event.type))}</code>`;
  switch (event.type) {
    case "message.delta": {
      return {
        who: "event",
        what: `${type} @${String(event.offset)} <span class="text">${escapeHtml(String(event.text))}</span>`,
      };
    }
    case "turn.status": {
      return {
        who: "event",
        what: `${type} ${escapeHtml(String(event.kind))} · “${escapeHtml(String(event.label))}”${event.detail ? ` · ${escapeHtml(event.detail as string)}` : ""}`,
      };
    }
    case "message.ended":
    case "turn.ended": {
      return {
        who: "event",
        what: `${type} ${escapeHtml(String(event.outcome))}${typeof event.length === "number" ? ` · length ${event.length}` : ""}`,
      };
    }
    case "snapshot": {
      const steps = (event.steps as readonly unknown[]).length;
      return {
        who: "event",
        what: `${type} ${escapeHtml(String(event.reason))} · ${(event.messages as readonly unknown[]).length} messages · ${steps} step${steps === 1 ? "" : "s"}${event.turn ? " · a turn running" : ""}`,
      };
    }
    case "step.started":
    case "step.updated":
    case "step.ended": {
      const step = event.step as { readonly kind: string; readonly title: string; readonly outcome?: string };
      const outcome = step.outcome ? ` · ${step.outcome}` : "";
      return { who: "event", what: `${type} ${escapeHtml(step.kind)} · “${escapeHtml(step.title)}”${outcome}` };
    }
    case "message.accepted":
    case "message.started": {
      const message = event.message as {
        readonly role: string;
        readonly kind?: string;
        readonly text: string;
        readonly secret?: boolean;
      };
      const text = message.secret ? " (secret)" : message.text ? ` “${message.text}”` : "";
      return { who: "event", what: `${type} ${escapeHtml(message.kind ?? message.role)}${escapeHtml(text)}` };
    }
    case "turn.started": {
      const inputs = (event.inputs as readonly string[]).length;
      const retry = typeof event.retry_of === "string" ? ` · retry of ${event.retry_of}` : "";
      return {
        who: "event",
        what: `${type} ${String(event.turn)} · answers ${inputs} message${inputs === 1 ? "" : "s"}${retry}`,
      };
    }
    case "message.queued": {
      return { who: "event", what: `${type} waits as Next behind ${String(event.turn)}` };
    }
    case "ask.started":
    case "ask.ended": {
      const ask = event.ask as { readonly kind: string; readonly question: string; readonly outcome?: string };
      const outcome = ask.outcome ? ` · ${ask.outcome}` : "";
      return { who: "event", what: `${type} ${escapeHtml(ask.kind)} · “${escapeHtml(ask.question)}”${outcome}` };
    }
    case "message.read": {
      return { who: "event", what: `${type} taken into ${String(event.turn)}` };
    }
    default: {
      return { who: "event", what: type };
    }
  }
};

const summarisePush = (line: JsonObject): Summary => {
  const push = line.push as {
    readonly level: string;
    readonly notification: { readonly kind: string; readonly text: string };
  };
  return {
    who: "push",
    what: `<strong>${escapeHtml(push.notification.kind)}</strong> · ${escapeHtml(push.level)} · “${escapeHtml(push.notification.text)}”`,
  };
};

const summariseSocket = (line: JsonObject): Summary => {
  const socket = line.socket as {
    readonly from: string;
    readonly frame?: JsonObject;
    readonly audio?: string;
    readonly audio_ms?: number;
    readonly closed?: number;
    readonly reason?: string;
  };
  const who = `${socket.from} →`;
  if (socket.frame) {
    const fields = Object.entries(socket.frame)
      .filter(([key]) => key !== "type")
      .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
      .join(", ");
    return {
      who: "socket",
      what: `${who} <code>${escapeHtml(String(socket.frame.type))}</code>${fields ? ` · ${escapeHtml(fields)}` : ""}`,
    };
  }
  if (socket.audio !== undefined)
    return { who: "socket", what: `${who} audio <code>${escapeHtml(socket.audio)}</code>` };
  if (socket.audio_ms !== undefined)
    return { who: "socket", what: `${who} ${String(socket.audio_ms)} ms of Ari's voice` };
  return { who: "socket", what: `${who} closes ${String(socket.closed)} · ${escapeHtml(socket.reason ?? "")}` };
};

const summarise = (line: JsonObject): Summary => {
  if (line.push) return summarisePush(line);
  if (line.socket) return summariseSocket(line);
  if (line.app) return summariseRequest(line.app as AppRequest);
  if (line.server) return summariseResponse(line.server as ServerResponse, Boolean(line.lost));
  return line.world ? summariseWorld(line) : summariseEvent(line.event as JsonObject);
};

const toTranscriptPage = ({ header, lines }: TranscriptFile, scenarioCount: number): string => {
  const name = String(header.transcript);
  const given = lines.filter((line) => line.given);
  const steps = lines.filter((line) => !line.given);
  const rows = steps
    .map((line) => {
      const { who, what } = summarise(line);
      const seconds = (Number(line.at) / 1000).toFixed(3);
      return `<tr class="${who}"><td class="at">${seconds}</td><td><span class="who">${who}</span></td><td>${what}<details><summary>JSON</summary><pre>${escapeHtml(JSON.stringify(line, null, 2))}</pre></details></td></tr>`;
    })
    .join("\n");
  const givenList = given.map((line) => `<li>${summarise({ event: line.given }).what}</li>`).join("");
  const chips = (header.guarantees as readonly string[])
    .map((guarantee) => `<a class="chip" href="../../guarantees/">${guarantee}</a>`)
    .join("");
  const title = escapeHtml(String(header.title));
  const summary = escapeHtml(String(header.summary));
  return toPage(
    `${String(header.title)} · Golden transcripts`,
    2,
    `<p class="eyebrow">Scenario ${String(header.scenario)} of ${scenarioCount}</p>
<h1>${title}</h1>
<p class="lead">${summary}</p>
<p class="chips">${chips}<a class="raw" href="../${name}.jsonl">Raw JSON Lines</a></p>
${given.length > 0 ? `<details class="given"><summary>${given.length} events already in the server's log</summary><ul>${givenList}</ul></details>` : ""}
<table class="steps"><thead><tr><th>Seconds</th><th>Who</th><th>What</th></tr></thead><tbody>
${rows}
</tbody></table>`,
  );
};

const toIndexItem = ({ header }: TranscriptFile): string =>
  `<li><a href="${String(header.transcript)}/"><span class="n">${String(header.scenario)}</span><span><strong>${escapeHtml(String(header.title))}</strong><br>${escapeHtml(String(header.summary))}</span></a></li>`;

// Spec files, at the paths the schema ids name.
const specDirectory = path.join(site, "protocol", "v0");
rmSync(site, { recursive: true, force: true });
mkdirSync(specDirectory, { recursive: true });
copyFileSync(path.join(protocolDirectory, "openapi.yaml"), path.join(specDirectory, "openapi.yaml"));
copyFileSync(path.join(protocolDirectory, "events.schema.json"), path.join(specDirectory, "events.schema.json"));
copyFileSync(path.join(protocolDirectory, "push.schema.json"), path.join(specDirectory, "push.schema.json"));
copyFileSync(path.join(protocolDirectory, "blocks.schema.json"), path.join(specDirectory, "blocks.schema.json"));
copyFileSync(path.join(protocolDirectory, "motion.schema.json"), path.join(specDirectory, "motion.schema.json"));
copyFileSync(
  path.join(protocolDirectory, "capability.schema.json"),
  path.join(specDirectory, "capability.schema.json"),
);
const bundled = await bundle({ ref: path.join(protocolDirectory, "openapi.yaml"), config: await createConfig({}) });
const openapi = bundled.bundle.parsed as { readonly info: { readonly version: string } };
write(path.join(specDirectory, "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");

mkdirSync(path.join(site, "assets"), { recursive: true });
copyFileSync(path.join(root, "docs", "site.css"), path.join(site, "assets", "site.css"));
const scalarDirectory = path.dirname(require.resolve("@scalar/api-reference"));
copyFileSync(path.join(scalarDirectory, "browser", "standalone.js"), path.join(site, "assets", "scalar.js"));
write(path.join(site, ".nojekyll"), "");

write(path.join(site, "api", "index.html"), apiReferencePage);

const readme = readFileSync(path.join(protocolDirectory, "README.md"), "utf8");
const landing = toHtml(
  readme.slice(readme.indexOf("## How it fits together"), readme.indexOf("## Working on it")),
  "",
  (token) => token.type === "code" && (token as Tokens.Code).lang === "mermaid",
);
write(
  path.join(site, "index.html"),
  toPage(
    "Ito client API",
    0,
    `<section class="hero"><p class="eyebrow">Protocol ${escapeHtml(openapi.info.version)}</p>
<h1>Ito client API</h1>
<p class="lead">Commands in, one resumable event stream out. Ari speaks it, and so can any other client.</p>
<p class="links"><a class="button" href="api/">API reference</a><a href="guarantees/">Guarantees</a><a href="transcripts/">Golden transcripts</a></p>
<p class="files">Spec: <a href="protocol/v0/openapi.yaml">openapi.yaml</a> · <a href="protocol/v0/events.schema.json">events.schema.json</a> · <a href="protocol/v0/push.schema.json">push.schema.json</a> · <a href="protocol/v0/openapi.json">bundled openapi.json</a></p></section>
<article class="prose">${landing}</article>`,
  ),
);

const guarantees = toHtml(readFileSync(path.join(protocolDirectory, "guarantees.md"), "utf8"), "../");
write(
  path.join(site, "guarantees", "index.html"),
  toPage("Guarantees · Ito client API", 1, `<article class="prose">${guarantees}</article>`),
);

const files = listTranscriptFiles();
const transcripts = files.flatMap((file): readonly TranscriptFile[] => {
  const raw = readFileSync(path.join(transcriptDirectory, file), "utf8");
  const [header, ...lines] = raw
    .trimEnd()
    .split("\n")
    .map((text) => JSON.parse(text) as JsonObject);
  return header ? [{ raw, header, lines }] : [];
});
for (const transcript of transcripts) {
  const name = String(transcript.header.transcript);
  const page = toTranscriptPage(transcript, files.length);
  write(path.join(site, "transcripts", `${name}.jsonl`), transcript.raw);
  write(path.join(site, "transcripts", name, "index.html"), page);
}
write(
  path.join(site, "transcripts", "index.html"),
  toPage(
    "Golden transcripts · Ito client API",
    1,
    `<h1>Golden transcripts</h1>
<p class="lead">What crosses the API in each scenario, step by step. The server's tests replay them through the real API, and apps check their own state against them. The format is described in <a href="https://github.com/akai-ito/ito-core/blob/main/protocol/transcripts/README.md">the transcripts README</a>.</p>
<ol class="scenarios">${transcripts.map((transcript) => toIndexItem(transcript)).join("\n")}</ol>`,
  ),
);

console.log(`built site/ with ${files.length} transcripts`);
