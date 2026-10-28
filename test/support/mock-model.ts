import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";

export type MockModel = {
  readonly baseUrl: string;
  readonly developerTexts: () => readonly string[];
  readonly userTexts: () => readonly string[];
  readonly images: () => number;
  readonly toolOutputs: () => readonly string[];
  readonly lastRun: () => { readonly model?: string; readonly effort?: string };
  readonly lastFormat: () => string | undefined;
  readonly close: () => Promise<void>;
};

type InputItem = {
  readonly type?: string;
  readonly role?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly output?: string | readonly { readonly type?: string; readonly text?: string }[];
};

type Send = (type: string, payload: Readonly<Record<string, unknown>>, delayMs?: number) => Promise<void>;

const markerPattern = /\[\[(?<scenario>[a-z]+)\]\]/u;
const usage = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 150,
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: readonly Buffer[] = await request.toArray();
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
};

const textsOf = (body: unknown, role: string): readonly string[] => {
  const input = (body as { readonly input?: readonly InputItem[] } | undefined)?.input ?? [];
  return input
    .filter((item) => item.type === "message" && item.role === role)
    .map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""));
};

const imagesIn = (body: unknown): number =>
  ((body as { readonly input?: readonly InputItem[] } | undefined)?.input ?? [])
    .filter((item) => item.type === "message" && item.role === "user")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "input_image").length;

const toolOutputsOf = (body: unknown): readonly string[] =>
  ((body as { readonly input?: readonly InputItem[] } | undefined)?.input ?? [])
    .filter((item) => item.type === "custom_tool_call_output")
    .map(({ output = "" }) => (typeof output === "string" ? output : output.map((part) => part.text ?? "").join("")));

const codeMarker = "[[code]]";

const hasToolOutput = (body: unknown): boolean => {
  const input = (body as { readonly input?: readonly InputItem[] } | undefined)?.input ?? [];
  const lastUser = input.findLastIndex((item) => item.type === "message" && item.role === "user");
  return input
    .slice(lastUser + 1)
    .some((item) => item.type === "custom_tool_call_output" || item.type === "function_call_output");
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const createSend =
  (response: ServerResponse): Send =>
  async (type, payload, delayMs = 10) => {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    await delay(delayMs);
  };

export const startMockModel = async (): Promise<MockModel> => {
  const counter = createCell(0);
  const latestDeveloperTexts = createCell<readonly string[]>([]);
  const latestUserTexts = createCell<readonly string[]>([]);
  const latestImages = createCell(0);
  const latestToolOutputs = createCell<readonly string[]>([]);
  const latestRun = createCell<{ readonly model?: string; readonly effort?: string }>({});
  const latestFormat = createCell<string | undefined>(undefined);
  const nextId = (prefix: string): string => `${prefix}_${String(counter.update((count) => count + 1))}`;

  const reason = async (send: Send, text: string): Promise<void> => {
    const id = nextId("rs");
    await send("response.output_item.added", { item: { type: "reasoning", id, summary: [] } });
    await send("response.reasoning_summary_part.added", { item_id: id, summary_index: 0 });
    for (const word of text.split(" ")) {
      await send("response.reasoning_summary_text.delta", { item_id: id, delta: `${word} `, summary_index: 0 });
    }
    await send("response.output_item.done", {
      item: { type: "reasoning", id, summary: [{ type: "summary_text", text }] },
    });
  };

  const say = async (send: Send, text: string, phase: string, delayMs = 10): Promise<void> => {
    const item = { type: "message", id: nextId("msg"), role: "assistant", phase };
    await send("response.output_item.added", { item: { ...item, content: [] } });
    const pieces = text.match(/.{1,6}/gsu) ?? [];
    for (const piece of pieces) {
      await send(
        "response.output_text.delta",
        { item_id: item.id, output_index: 0, content_index: 0, delta: piece },
        delayMs,
      );
    }
    await send("response.output_item.done", { item: { ...item, content: [{ type: "output_text", text }] } });
  };

  const search = async (send: Send, query: string): Promise<void> => {
    const id = nextId("ws");
    await send("response.output_item.added", { item: { type: "web_search_call", id, status: "in_progress" } });
    await send("response.output_item.done", {
      item: { type: "web_search_call", id, status: "completed", action: { type: "search", query } },
    });
  };

  const reportThroughExec = async (send: Send): Promise<void> => {
    const gap = {
      capability: "web search",
      operation: "open a page",
      tried: "Opened the parkrun event page to read the start time",
      failed: "The page answered 403",
      would_help: "A browser that can load pages behind bot protection",
    };
    const item = { type: "custom_tool_call", id: nextId("ctc"), call_id: nextId("call"), name: "exec" };
    const input = `const result = await tools.mcp__ito__report_gap(${JSON.stringify(gap)});\ntext(JSON.stringify(result));`;
    await send("response.output_item.added", { item: { ...item, input: "" } });
    await send("response.output_item.done", { item: { ...item, input } });
  };

  const askThroughExec = async (send: Send): Promise<void> => {
    const ask = { question: "Which Juno did you mean?", options: [{ label: "Clapham" }, { label: "Soho" }] };
    const item = { type: "custom_tool_call", id: nextId("ctc"), call_id: nextId("call"), name: "exec" };
    const input = `const result = await tools.mcp__ito__ask(${JSON.stringify(ask)});\ntext(JSON.stringify(result));`;
    await send("response.output_item.added", { item: { ...item, input: "" } });
    await send("response.output_item.done", { item: { ...item, input } });
  };

  const runCode = async (send: Send, input: string): Promise<void> => {
    const item = { type: "custom_tool_call", id: nextId("ctc"), call_id: nextId("call"), name: "exec" };
    await send("response.output_item.added", { item: { ...item, input: "" } });
    await send("response.output_item.done", { item: { ...item, input } });
  };

  const stream = async (
    response: ServerResponse,
    scenario: string,
    isSteered: boolean,
    hasToolOutput: boolean,
    code: string,
  ): Promise<void> => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = createSend(response);
    await send("response.created", { response: { id: nextId("resp") } });
    if (scenario === "failure") {
      await send("response.failed", {
        response: { id: nextId("resp"), status: "failed", error: { code: "server_error", message: "Mock failure" } },
      });
      response.end();
      return;
    }
    if (scenario === "json") {
      await say(
        send,
        JSON.stringify({ gists: [{ address: "memory:people/sam", gist: "Runs with you" }] }),
        "final_answer",
      );
      await send("response.completed", { response: { id: nextId("resp"), usage } });
      response.end();
      return;
    }
    if (scenario === "slow" && isSteered) {
      await say(send, "Got it, wrapping up.", "final_answer");
    } else if (scenario === "slow") {
      await reason(send, "Working slowly");
      await say(send, "This note streams slowly so that it can be steered or stopped.", "commentary", 300);
      await say(send, "Slow answer.", "final_answer");
    } else if (scenario === "ask" && hasToolOutput) {
      await say(send, "This should never be read: asking ends the turn.", "final_answer", 300);
    } else if (scenario === "ask") {
      await askThroughExec(send);
    } else if (scenario === "report" && hasToolOutput) {
      await say(send, "Most parkruns start at 9:00, and I've reported that.", "final_answer");
    } else if (scenario === "report") {
      await reportThroughExec(send);
    } else if (scenario === "code" && hasToolOutput) {
      await say(send, "Done.", "final_answer");
    } else if (scenario === "code") {
      await runCode(send, code);
    } else if (scenario === "search") {
      await search(send, "breakfast by the river");
      await say(send, "Found a place.", "final_answer");
    } else {
      await reason(send, "**Planning the answer** Thinking it through.");
      await say(send, "Let me think about that.", "commentary");
      await say(send, "Here is the answer.", "final_answer");
    }
    await send("response.completed", { response: { id: nextId("resp"), usage } });
    response.end();
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      sendJson(response, 200, { models: [] });
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/v1/responses")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    latestDeveloperTexts.set(textsOf(body, "developer"));
    const texts = textsOf(body, "user");
    latestUserTexts.set(texts);
    latestImages.set(imagesIn(body));
    latestToolOutputs.set(toolOutputsOf(body));
    const run = body as
      | {
          readonly model?: string;
          readonly reasoning?: { readonly effort?: string };
          readonly text?: { readonly format?: { readonly type?: string } };
        }
      | undefined;
    latestFormat.set(run?.text?.format?.type);
    latestRun.set({
      ...(run?.model !== undefined && { model: run.model }),
      ...(run?.reasoning?.effort !== undefined && { effort: run.reasoning.effort }),
    });
    const scenario = markerPattern.exec(texts.findLast((text) => markerPattern.test(text)) ?? "")?.groups?.scenario;
    if (scenario === "signedout") {
      sendJson(response, 401, { error: { message: "Missing bearer or basic authentication in header" } });
      return;
    }
    if (scenario === "usage") {
      sendJson(response, 429, {
        error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus" },
      });
      return;
    }
    const code =
      texts
        .findLast((text) => text.includes(codeMarker))
        ?.split(codeMarker)[1]
        ?.trim() ?? "";
    await stream(response, scenario ?? "reply", texts.at(-1)?.includes("STEER") ?? false, hasToolOutput(body), code);
  };

  const server = createServer((request, response) => {
    void respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The mock model has no port.");

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    developerTexts: () => latestDeveloperTexts.get(),
    userTexts: () => latestUserTexts.get(),
    images: () => latestImages.get(),
    toolOutputs: () => latestToolOutputs.get(),
    lastRun: () => latestRun.get(),
    lastFormat: () => latestFormat.get(),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
