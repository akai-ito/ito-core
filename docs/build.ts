import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createConfig } from "@redocly/openapi-core";
import { Marked, type Token, type Tokens } from "marked";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocol = join(root, "protocol");
const site = join(root, "site");
const require = createRequire(import.meta.url);

type Json = Record<string, unknown>;

const MARK = `<svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M8 52 C15 52 18 44 24 39 C30 34 40 36 41 27 C42 19 33 17 31 23 C29 30 38 33 45 28 C51 24 54 18 57 11" stroke="#D7263D" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function page(title: string, depth: number, body: string): string {
  const up = depth ? "../".repeat(depth) : "./";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="${up}assets/site.css">
</head>
<body>
<header class="bar"><a class="home" href="${up}">${MARK}<span>Ito client API</span></a>
<nav><a href="${up}api/">API reference</a><a href="${up}guarantees/">Guarantees</a><a href="${up}transcripts/">Transcripts</a></nav></header>
<main>${body}</main>
<footer>Source-available under the PolyForm Noncommercial or PolyForm Small Business licence. <a href="https://github.com/akai-ito/ito-core">akai-ito/ito-core</a></footer>
</body>
</html>
`;
}

function markdown(
  source: string,
  rewrite: (href: string) => string,
  drop: (token: Token) => boolean = () => false,
): string {
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type !== "link") return;
      const link = token as Tokens.Link;
      link.href = rewrite(link.href);
    },
    renderer: {
      heading(this: { parser: { parseInline(tokens: Token[]): string } }, { tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(text)}">${text}</h${depth}>\n`;
      },
    },
  });
  const tokens = marked.lexer(source).filter((token) => !drop(token));
  return marked.parser(tokens);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Spec files, at the paths the schema ids name.
const specOut = join(site, "protocol", "v0");
rmSync(site, { recursive: true, force: true });
mkdirSync(specOut, { recursive: true });
copyFileSync(join(protocol, "openapi.yaml"), join(specOut, "openapi.yaml"));
copyFileSync(join(protocol, "events.schema.json"), join(specOut, "events.schema.json"));
const bundled = await bundle({ ref: join(protocol, "openapi.yaml"), config: await createConfig({}) });
const openapi = bundled.bundle.parsed as { info: { version: string } };
write(join(specOut, "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");

// Assets.
mkdirSync(join(site, "assets"), { recursive: true });
copyFileSync(join(root, "docs", "site.css"), join(site, "assets", "site.css"));
copyFileSync(
  join(dirname(require.resolve("@scalar/api-reference")), "browser", "standalone.js"),
  join(site, "assets", "scalar.js"),
);
write(join(site, ".nojekyll"), "");

// API reference.
write(
  join(site, "api", "index.html"),
  `<!doctype html>
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
`,
);

// Landing page, from the protocol README.
const siteLink = (prefix: string) => (href: string) => {
  if (/^https?:/.test(href) || href.startsWith("#")) return href;
  if (href === "transcripts") return `${prefix}transcripts/`;
  if (href === "guarantees.md") return `${prefix}guarantees/`;
  const transcript = /^transcripts\/(\d\d-[a-z0-9-]+)\.jsonl$/.exec(href);
  if (transcript) return `${prefix}transcripts/${transcript[1]}/`;
  if (href === "openapi.yaml" || href === "events.schema.json") return `${prefix}protocol/v0/${href}`;
  return `https://github.com/akai-ito/ito-core/blob/main/protocol/${href}`;
};
const readme = readFileSync(join(protocol, "README.md"), "utf8");
const landing = markdown(
  readme.slice(readme.indexOf("## How it fits together"), readme.indexOf("## Working on it")),
  siteLink(""),
  (token) => token.type === "code" && (token as Tokens.Code).lang === "mermaid",
);
write(
  join(site, "index.html"),
  page(
    "Ito client API",
    0,
    `<section class="hero"><p class="eyebrow">Protocol ${escape(openapi.info.version)}</p>
<h1>Ito client API</h1>
<p class="lead">Commands in, one resumable event stream out. Ari speaks it, and so can any other client.</p>
<p class="links"><a class="button" href="api/">API reference</a><a href="guarantees/">Guarantees</a><a href="transcripts/">Golden transcripts</a></p>
<p class="files">Spec: <a href="protocol/v0/openapi.yaml">openapi.yaml</a> · <a href="protocol/v0/events.schema.json">events.schema.json</a> · <a href="protocol/v0/openapi.json">bundled openapi.json</a></p></section>
<article class="prose">${landing}</article>`,
  ),
);

// Guarantees.
write(
  join(site, "guarantees", "index.html"),
  page(
    "Guarantees · Ito client API",
    1,
    `<article class="prose">${markdown(readFileSync(join(protocol, "guarantees.md"), "utf8"), siteLink("../"))}</article>`,
  ),
);

// Transcripts.
function summarise(line: Json): { who: string; what: string } {
  if (line.app) {
    const app = line.app as { method: string; path: string; headers?: Record<string, string>; body?: Json };
    const cursor = app.headers?.["Last-Event-ID"];
    const text = app.body && typeof app.body.text === "string" ? ` “${app.body.text}”` : "";
    const cut = app.body?.cut as { offset?: number } | undefined;
    const detail = cursor ? ` · Last-Event-ID ${cursor}` : cut ? ` · cut at ${String(cut.offset)}` : text;
    return { who: "app", what: `<code>${app.method} ${escape(app.path)}</code>${escape(detail)}` };
  }
  if (line.server) {
    const server = line.server as { status: number; body?: Json };
    const body = server.body ?? {};
    const error = body.error as { code?: string } | undefined;
    const message = body.message as { id?: string } | undefined;
    const note = error?.code
      ? ` ${error.code}`
      : typeof body.state === "string"
        ? ` ${body.state}${typeof body.outcome === "string" ? ` · ${body.outcome}` : ""}`
        : typeof body.retry_of === "string"
          ? ` new attempt ${String(body.turn)}`
          : Array.isArray(body.messages)
            ? ` ${body.messages.length} messages${body.has_more ? " · more before" : " · nothing older"}`
            : message?.id
              ? ` message ${message.id.slice(0, 8)}…`
              : typeof body.name === "string"
                ? ` ${body.name} · Ito ${String(body.version)} · agent ${String((body.agent as Json | undefined)?.name)}`
                : Array.isArray(body.protocol)
                  ? ` speaks ${body.protocol.join(", ")}`
                  : "";
    const lost = line.lost ? ` <span class="lost">lost on the way</span>` : "";
    return { who: "server", what: `<code>${server.status}</code>${escape(note)}${lost}` };
  }
  if (line.world) {
    const fields = Object.entries(line)
      .filter(([key]) => key !== "at" && key !== "world")
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(", ");
    return {
      who: "world",
      what: `<strong>${escape(line.world as string)}</strong>${fields ? ` · ${escape(fields)}` : ""}`,
    };
  }
  const event = line.event as Json;
  const type = `<code>${escape(String(event.type))}</code>`;
  switch (event.type) {
    case "message.delta":
      return {
        who: "event",
        what: `${type} @${String(event.offset)} <span class="text">${escape(String(event.text))}</span>`,
      };
    case "turn.status":
      return {
        who: "event",
        what: `${type} ${escape(String(event.kind))} · “${escape(String(event.label))}”${event.detail ? ` · ${escape(event.detail as string)}` : ""}`,
      };
    case "message.ended":
    case "turn.ended":
      return {
        who: "event",
        what: `${type} ${escape(String(event.outcome))}${typeof event.length === "number" ? ` · length ${event.length}` : ""}`,
      };
    case "snapshot":
      return {
        who: "event",
        what: `${type} ${escape(String(event.reason))} · ${(event.messages as unknown[]).length} messages${event.turn ? " · a turn running" : ""}`,
      };
    case "message.accepted":
    case "message.started": {
      const message = event.message as { role: string; kind?: string; text: string };
      const text = message.text ? ` “${message.text}”` : "";
      return { who: "event", what: `${type} ${escape(message.kind ?? message.role)}${escape(text)}` };
    }
    case "turn.started": {
      const inputs = (event.inputs as string[]).length;
      const retry = typeof event.retry_of === "string" ? ` · retry of ${event.retry_of}` : "";
      return {
        who: "event",
        what: `${type} ${String(event.turn)} · answers ${inputs} message${inputs === 1 ? "" : "s"}${retry}`,
      };
    }
    case "message.queued":
      return { who: "event", what: `${type} waits as Next behind ${String(event.turn)}` };
    case "message.read":
      return { who: "event", what: `${type} taken into ${String(event.turn)}` };
    default:
      return { who: "event", what: type };
  }
}

const transcriptDir = join(protocol, "transcripts");
const files = readdirSync(transcriptDir)
  .filter((file) => file.endsWith(".jsonl"))
  .sort();
const index: string[] = [];
for (const file of files) {
  const raw = readFileSync(join(transcriptDir, file), "utf8");
  const [header, ...lines] = raw
    .trimEnd()
    .split("\n")
    .map((text) => JSON.parse(text) as Json);
  if (!header) continue;
  const name = String(header.transcript);
  const given = lines.filter((line) => line.given);
  const steps = lines.filter((line) => !line.given);
  const rows = steps
    .map((line) => {
      const { who, what } = summarise(line);
      const seconds = (Number(line.at) / 1000).toFixed(3);
      return `<tr class="${who}"><td class="at">${seconds}</td><td><span class="who">${who}</span></td><td>${what}<details><summary>JSON</summary><pre>${escape(JSON.stringify(line, null, 2))}</pre></details></td></tr>`;
    })
    .join("\n");
  const givenList = given.map((line) => `<li>${summarise({ event: line.given }).what}</li>`).join("");
  const chips = (header.guarantees as string[])
    .map((g) => `<a class="chip" href="../../guarantees/">${g}</a>`)
    .join("");
  write(join(site, "transcripts", `${name}.jsonl`), raw);
  write(
    join(site, "transcripts", name, "index.html"),
    page(
      `${String(header.title)} · Golden transcripts`,
      2,
      `<p class="eyebrow">Scenario ${String(header.scenario)} of ${files.length}</p>
<h1>${escape(String(header.title))}</h1>
<p class="lead">${escape(String(header.summary))}</p>
<p class="chips">${chips}<a class="raw" href="../${name}.jsonl">Raw JSON Lines</a></p>
${given.length ? `<details class="given"><summary>${given.length} events already in the server's log</summary><ul>${givenList}</ul></details>` : ""}
<table class="steps"><thead><tr><th>Seconds</th><th>Who</th><th>What</th></tr></thead><tbody>
${rows}
</tbody></table>`,
    ),
  );
  index.push(
    `<li><a href="${name}/"><span class="n">${String(header.scenario)}</span><span><strong>${escape(String(header.title))}</strong><br>${escape(String(header.summary))}</span></a></li>`,
  );
}
write(
  join(site, "transcripts", "index.html"),
  page(
    "Golden transcripts · Ito client API",
    1,
    `<h1>Golden transcripts</h1>
<p class="lead">What crosses the API in each scenario, step by step. The server's tests replay them through the real API, and apps check their own state against them. The format is described in <a href="https://github.com/akai-ito/ito-core/blob/main/protocol/transcripts/README.md">the transcripts README</a>.</p>
<ol class="scenarios">${index.join("\n")}</ol>`,
  ),
);

console.log(`built site/ with ${files.length} transcripts`);
