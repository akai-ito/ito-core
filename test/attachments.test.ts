import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toTurnId } from "#conversation/ids.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";
import { wordEmbedder } from "#memory/embedder.ts";

const token = "ito_attachments_test_not_a_real_token_000000000000000000";
const authorization = `Bearer ${token}`;
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-attachments-"));
const clock = createVirtualClock(Date.parse("2026-10-15T18:30:00.000Z"));
const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  createEngine: () =>
    createScriptEngine(clock, () => ({ events: [], steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at })),
  name: "studio",
  clock,
});
server.store.setSetting(tokenSetting, hashToken(token));

const upload = async (id: string, body: Buffer, contentType?: string) =>
  server.app.inject({
    method: "PUT",
    url: `/v0/attachments/${id}?name=photo.png`,
    headers: { authorization, ...(contentType && { "content-type": contentType }) },
    payload: body,
  });

const send = async (body: Readonly<Record<string, unknown>>) =>
  server.app.inject({ method: "POST", url: "/v0/messages", headers: { authorization }, payload: body });

const pngOfSize = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
};

describe("attachments", () => {
  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("leave out sizes an image header doesn't really give", async () => {
    const answer = await upload(randomUUID(), pngOfSize(0, 0), "image/png");
    expect(answer.statusCode).toBe(201);
    expect(answer.json()).toMatchObject({ attachment: { kind: "image", size: 33 } });
    expect(answer.json<{ attachment: object }>().attachment).not.toHaveProperty("width");
  });

  it("accept an empty file with no type", async () => {
    const answer = await upload(randomUUID(), Buffer.alloc(0));
    expect(answer.statusCode).toBe(201);
    expect(answer.json()).toMatchObject({ attachment: { size: 0, media_type: "application/octet-stream" } });
  });

  it("refuse an id in capitals, and the same attachment twice in one message", async () => {
    const capitals = await upload(randomUUID().toUpperCase(), pngOfSize(4, 3), "image/png");
    expect(capitals.statusCode).toBe(400);
    const id = randomUUID();
    await upload(id, pngOfSize(4, 3), "image/png");
    const twice = await send({ id: randomUUID(), text: "", attachments: [id, id] });
    expect(twice.statusCode).toBe(400);
  });

  it("make a message id with different attachments a conflict, not the first message again", async () => {
    const first = randomUUID();
    const second = randomUUID();
    await upload(first, pngOfSize(4, 3), "image/png");
    await upload(second, pngOfSize(8, 6), "image/png");
    const message = randomUUID();
    const accepted = await send({ id: message, text: "Look", attachments: [first] });
    expect(accepted.statusCode).toBe(201);
    const repeated = await send({ id: message, text: "Look", attachments: [first] });
    expect(repeated.statusCode).toBe(200);
    const conflict = await send({ id: message, text: "Look", attachments: [second] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "id_conflict" } });
  });

  it("refuse attachments on a secret answer", async () => {
    const ask = server.store.startAsk(toTurnId("t_earlier"), {
      kind: "question",
      question: "Juno texted you a 6-digit code. What is it?",
      options: [],
      allows_text: true,
      secret: true,
    });
    const id = randomUUID();
    await upload(id, pngOfSize(4, 3), "image/png");
    const refused = await send({ id: randomUUID(), text: "481516", answers: ask.id, attachments: [id] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(JSON.stringify(server.store.snapshot("no_cursor"))).not.toContain("481516");
  });
});
