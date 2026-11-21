import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { looksLike } from "#attachments/formats.ts";
import { limitsFrom } from "#attachments/uploads.ts";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Upload } from "#protocol/types.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const token = "ito_uploads_test_not_a_real_token_00000000000000000000";
const authorization = `Bearer ${token}`;
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-uploads-"));
const clock = createVirtualClock(Date.parse("2026-11-21T09:00:00.000Z"));
const free = createCell(64 * 1024 * 1024 * 1024);
const chunkBytes = 64 * 1024;
const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  createEngine: () =>
    createScriptEngine(clock, () => ({ events: [], steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at })),
  name: "studio",
  clock,
  uploadLimits: { audioBytes: 1024 * 1024, fileBytes: 256 * 1024, chunkBytes },
  freeBytes: () => free.get(),
});
server.store.setSetting(tokenSetting, hashToken(token));

// A made-up recording: an M4A's first bytes, then noise standing in for the audio.
const recording = (size: number): Buffer => {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypM4A ", 4, "latin1");
  for (const [index] of bytes.entries()) if (index >= 12) bytes.writeUInt8((index * 31) % 251, index);
  return bytes;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  server.app.inject({ method, url, headers: { authorization }, ...(payload && { payload }) });

const start = async (id: string, size: number, mediaType = "audio/mp4", name = "Interview.m4a") =>
  call("POST", "/v0/uploads", { id, name, media_type: mediaType, size });

const sendChunk = async (id: string, offset: number, bytes: Buffer) =>
  server.app.inject({
    method: "PUT",
    url: `/v0/uploads/${id}?offset=${String(offset)}`,
    headers: { authorization, "content-type": "application/octet-stream" },
    payload: bytes,
  });

const sendAll = async (id: string, bytes: Buffer, from = 0): Promise<void> => {
  if (from >= bytes.length) return;
  const answer = await sendChunk(id, from, bytes.subarray(from, from + chunkBytes));
  expect(answer.statusCode).toBe(200);
  await sendAll(id, bytes, answer.json<{ upload: Upload }>().upload.received);
};

describe("big uploads", () => {
  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("say what they take before anything is uploaded", async () => {
    const answer = await call("GET", "/v0/uploads");

    expect(answer.statusCode).toBe(200);
    const { limits } = answer.json<{
      limits: { kinds: { kind: string; max_bytes: number; media_types: string[] }[] };
    }>();
    expect(answer.json()).toMatchObject({ limits: { simple_bytes: 20 * 1024 * 1024, chunk_bytes: chunkBytes } });
    expect(limits.kinds.map(({ kind, max_bytes }) => [kind, max_bytes])).toEqual([
      ["audio", 1024 * 1024],
      ["image", 50 * 1024 * 1024],
      ["file", 256 * 1024],
    ]);
    expect(limits.kinds[0]?.media_types).toContain("audio/x-m4a");
  });

  it("take a recording in chunks, become an attachment a message names, and fetch it back whole or in part", async () => {
    const id = randomUUID();
    const bytes = recording(200_000);
    const started = await start(id, bytes.length);
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({
      upload: { id, kind: "audio", size: 200_000, received: 0, state: "receiving" },
    });

    await sendAll(id, bytes);
    const finished = await call("POST", `/v0/uploads/${id}/finish`, { sha256: sha256(bytes) });

    expect(finished.statusCode).toBe(201);
    expect(finished.json()).toEqual({
      attachment: { id, kind: "audio", name: "Interview.m4a", media_type: "audio/mp4", size: 200_000 },
    });
    const again = await call("POST", `/v0/uploads/${id}/finish`);
    expect(again.statusCode).toBe(200);
    const looked = await call("GET", `/v0/uploads/${id}`);
    expect(looked.json()).toMatchObject({ upload: { state: "finished" } });
    const sent = await call("POST", "/v0/messages", { id: randomUUID(), text: "How did it go?", attachments: [id] });
    expect(sent.statusCode).toBe(201);

    const whole = await call("GET", `/v0/attachments/${id}`);
    expect(whole.rawPayload.equals(bytes)).toBe(true);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-disposition"]).toBe(
      `inline; filename="Interview.m4a"; filename*=UTF-8''Interview.m4a`,
    );
    const part = await server.app.inject({
      method: "GET",
      url: `/v0/attachments/${id}`,
      headers: { authorization, range: "bytes=100-199" },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 100-199/200000");
    expect(part.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);
    const tail = await server.app.inject({
      method: "GET",
      url: `/v0/attachments/${id}`,
      headers: { authorization, range: "bytes=-10" },
    });
    expect(tail.rawPayload.equals(bytes.subarray(-10))).toBe(true);
    const past = await server.app.inject({
      method: "GET",
      url: `/v0/attachments/${id}`,
      headers: { authorization, range: "bytes=300000-" },
    });
    expect([past.statusCode, past.headers["content-range"]]).toEqual([416, "bytes */200000"]);
  });

  it("carry on after a drop: a repeated chunk is skipped, and one from too far ahead says where to resume", async () => {
    const id = randomUUID();
    const bytes = recording(150_000);
    await start(id, bytes.length);
    await sendChunk(id, 0, bytes.subarray(0, 50_000));

    const again = await start(id, bytes.length);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ upload: { received: 50_000 } });
    const ahead = await sendChunk(id, 100_000, bytes.subarray(100_000));
    expect(ahead.statusCode).toBe(409);
    expect(ahead.json()).toMatchObject({ error: { code: "offset_mismatch" }, upload: { received: 50_000 } });
    const overlapping = await sendChunk(id, 25_000, bytes.subarray(25_000, 75_000));
    expect(overlapping.json()).toMatchObject({ upload: { received: 75_000 } });
    const listed = await call("GET", "/v0/uploads");
    expect(listed.json<{ uploads: Upload[] }>().uploads.map((upload) => [upload.id, upload.received])).toContainEqual([
      id,
      75_000,
    ]);
    const early = await call("POST", `/v0/uploads/${id}/finish`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: { code: "upload_incomplete" }, upload: { received: 75_000 } });

    await sendAll(id, bytes, 75_000);
    const tooMuch = await sendChunk(id, 150_000, Buffer.from("more"));
    expect(tooMuch.statusCode).toBe(400);
    const finished = await call("POST", `/v0/uploads/${id}/finish`);
    expect(finished.statusCode).toBe(201);
    const fetched = await call("GET", `/v0/attachments/${id}`);
    expect(fetched.rawPayload.equals(bytes)).toBe(true);
  });

  it("start over when the bytes that arrived don't have the checksum the app gave", async () => {
    const id = randomUUID();
    const bytes = recording(80_000);
    await start(id, bytes.length);
    await sendAll(id, bytes);

    const damaged = await call("POST", `/v0/uploads/${id}/finish`, { sha256: sha256(Buffer.from("other")) });

    expect(damaged.statusCode).toBe(422);
    expect(damaged.json()).toMatchObject({ error: { code: "checksum_mismatch" }, upload: { received: 0 } });
  });

  it("refuse what they don't take, with the limits in words", async () => {
    const video = await start(randomUUID(), 5000, "video/quicktime", "Harbour.mov");
    expect(video.statusCode).toBe(415);
    expect(video.json()).toMatchObject({ error: { code: "unsupported_type" } });

    const long = await start(randomUUID(), 2 * 1024 * 1024);
    expect(long.statusCode).toBe(413);
    expect(long.json()).toMatchObject({ error: { code: "too_large", message: "A recording can be up to 1 MB." } });

    const big = await start(randomUUID(), 300 * 1024, "application/pdf", "Report.pdf");
    expect(big.json()).toMatchObject({ error: { message: "A file can be up to 256 KB." } });

    const id = randomUUID();
    await start(id, 300_000);
    const chunk = await sendChunk(id, 0, Buffer.alloc(chunkBytes + 1));
    expect(chunk.statusCode).toBe(413);
    expect(chunk.json()).toMatchObject({
      error: { code: "too_large", message: "That piece of the upload is too big." },
    });

    const conflict = await start(id, 300_001);
    expect(conflict.statusCode).toBe(409);
  });

  it("refuse a file whose first bytes aren't the recording it says it is, and keep nothing of it", async () => {
    const id = randomUUID();
    const notAudio = Buffer.from("<html>this is a web page, not a recording</html>");
    await start(id, notAudio.length, "audio/mpeg", "Talk.mp3");
    await sendChunk(id, 0, notAudio);

    const finished = await call("POST", `/v0/uploads/${id}/finish`);

    expect(finished.statusCode).toBe(415);
    expect(finished.json()).toMatchObject({ error: { code: "unsupported_type" } });
    const looked = await call("GET", `/v0/uploads/${id}`);
    expect(looked.statusCode).toBe(404);
  });

  it("say when the server's disk hasn't room", async () => {
    free.set(100 * 1024 * 1024);
    const answer = await start(randomUUID(), 500_000);
    free.set(64 * 1024 * 1024 * 1024);

    expect(answer.statusCode).toBe(507);
    expect(answer.json()).toMatchObject({ error: { code: "server_disk_full" } });
  });

  it("delete an upload that's given up, or that nothing reaches for two days", async () => {
    const cancelled = randomUUID();
    await start(cancelled, 10_000);
    const deleted = await call("DELETE", `/v0/uploads/${cancelled}`);
    expect(deleted.statusCode).toBe(204);
    const looked = await call("GET", `/v0/uploads/${cancelled}`);
    expect(looked.statusCode).toBe(404);

    const forgotten = randomUUID();
    await start(forgotten, 10_000);
    clock.moveTo(clock.now() + 2 * 24 * 60 * 60 * 1000 + 1000);
    const runDue = (): void => {
      if (clock.runNext(clock.now())) runDue();
    };
    runDue();

    expect(readdirSync(path.join(directory, "uploads"))).not.toContain(forgotten);
  });

  it("tell a recording or a PDF by its first bytes, whatever near-miss type it came with", () => {
    const starts = {
      wav: Buffer.from("RIFF\0\0\0\0WAVEfmt "),
      mp3: Buffer.from("ID3\u{4}\0\0"),
      adts: Buffer.from([255, 241, 80, 128]),
      ogg: Buffer.from("OggS\0\u{2}"),
      coreAudio: Buffer.from("caff\0\u{1}"),
      webm: Buffer.from([26, 69, 223, 163, 1]),
    };
    for (const start of Object.values(starts)) expect(looksLike("audio", "audio/mp4", start)).toBe(true);
    expect(looksLike("audio", "audio/mpeg", Buffer.from("<html>"))).toBe(false);
    expect(looksLike("file", "application/pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(looksLike("file", "application/pdf", Buffer.from("PK\u{3}\u{4}"))).toBe(false);
    expect(looksLike("file", "text/csv", Buffer.from("date,km"))).toBe(true);
  });

  it("read a box's own limits in megabytes, and refuse ones that aren't", () => {
    expect(limitsFrom({ ITO_MAX_RECORDING_MB: "2048", ITO_MAX_FILE_MB: " 50 " })).toEqual({
      ok: true,
      value: { audioBytes: 2048 * 1024 * 1024, fileBytes: 50 * 1024 * 1024 },
    });
    expect(limitsFrom({})).toEqual({ ok: true, value: {} });
    expect(limitsFrom({ ITO_MAX_RECORDING_MB: "1.5GB" })).toEqual({
      ok: false,
      failure: "ITO_MAX_RECORDING_MB is 1.5GB: give a whole number of megabytes, such as 1024.",
    });
  });
});
