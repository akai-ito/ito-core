import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createFindPart } from "#mail/compose.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { ShownFile } from "#protocol/types.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const token = "ito_files_test_not_a_real_token_00000000000000000000000";
const authorization = `Bearer ${token}`;
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-files-"));
const workspace = path.join(directory, "workspace");
const clock = createVirtualClock(Date.parse("2026-11-21T09:00:00.000Z"));
const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  createEngine: () =>
    createScriptEngine(clock, () => ({ events: [], steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at })),
  name: "studio",
  clock,
});
server.store.setSetting(tokenSetting, hashToken(token));

const pdf = (words: string): Buffer => Buffer.from(`%PDF-1.7\n% ${words}\n%%EOF\n`);

const writeWorkspace = (file: string, bytes: Buffer): void => {
  mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
  writeFileSync(path.join(workspace, file), bytes);
};

type Shown = {
  readonly file: string;
  readonly version: number;
  readonly attachment: string;
  readonly mail_path: string;
};

const show = async (input: Readonly<Record<string, string>>) => {
  const result = await server.callTool("show_file", input);
  return { ...result, shown: result.structured as Shown | undefined };
};

const get = async (url: string) => server.app.inject({ method: "GET", url, headers: { authorization } });

describe("files Kumo shows for review", () => {
  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("come into the chat as one version each, with their bytes exactly as made, until the file changes", async () => {
    writeWorkspace("cv/cv.pdf", pdf("first draft"));

    const first = await show({ path: "cv/cv.pdf" });

    expect(first.isError).toBeUndefined();
    const shown = first.shown;
    if (!shown) throw new Error("Nothing was shown.");
    expect(shown.version).toBe(1);
    expect(first.text).toContain("Shown cv.pdf, version 1 of");
    expect(first.text).toContain(`\`\`\`ari:file\n{"file":"${shown.file}","version":1}\n\`\`\``);
    const fetched = await get(`/v0/attachments/${shown.attachment}`);
    expect(fetched.headers["content-type"]).toBe("application/pdf");
    expect(fetched.rawPayload.equals(pdf("first draft"))).toBe(true);

    const again = await show({ path: "cv/cv.pdf" });
    expect(again.text).toContain("Already shown, unchanged: cv.pdf, version 1");
    expect(again.shown?.attachment).toBe(shown.attachment);

    writeWorkspace("cv/cv.pdf", pdf("second draft"));
    const second = await show({ path: "cv/cv.pdf", note: "Tighter header" });
    expect(second.shown).toMatchObject({ file: shown.file, version: 2 });
    const described = await get(`/v0/files/${shown.file}`);
    const { file } = described.json<{ file: ShownFile }>();
    expect(file.versions.map(({ version, note }) => [version, note])).toEqual([
      [1, undefined],
      [2, "Tighter header"],
    ]);
    expect(file.versions[1]?.attachment).toMatchObject({ name: "cv.pdf", media_type: "application/pdf", kind: "file" });
    const firstAgain = await get(`/v0/attachments/${shown.attachment}`);
    expect(firstAgain.rawPayload.equals(pdf("first draft"))).toBe(true);
  });

  it("keep each version where a mail draft can attach exactly it, read-only", async () => {
    writeWorkspace("letters/cover.pdf", pdf("cover letter"));
    const { shown } = await show({ path: "letters/cover.pdf" });
    if (!shown) throw new Error("Nothing was shown.");
    writeWorkspace("letters/cover.pdf", pdf("cover letter, changed after review"));

    expect(shown.mail_path).toBe(`shown/${shown.file}/v1/cover.pdf`);
    const copy = path.join(workspace, shown.mail_path);
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    const found = await createFindPart({ workspace, fetch })(shown.mail_path, "file");
    expect(found).toMatchObject({ ok: true, value: { filename: "cover.pdf", contentType: "application/pdf" } });
    expect(found.ok && found.value.content.equals(pdf("cover letter"))).toBe(true);
  });

  it("follow a file to a new name when Kumo says which it replaces, and refuse what isn't its own", async () => {
    writeWorkspace("plan/trip.pdf", pdf("trip v1"));
    const { shown } = await show({ path: "plan/trip.pdf" });
    if (!shown) throw new Error("Nothing was shown.");
    writeWorkspace("plan/trip-final.pdf", pdf("trip v2"));

    const renamed = await show({ path: "plan/trip-final.pdf", replaces: shown.file });

    expect(renamed.shown).toMatchObject({ file: shown.file, version: 2 });
    writeWorkspace("empty.pdf", Buffer.alloc(0));
    const outside = await show({ path: "../ito.db" });
    expect(outside).toMatchObject({ isError: true, text: "../ito.db isn't in your workspace, so it can't be shown." });
    expect(await show({ path: "missing.pdf" })).toMatchObject({ isError: true });
    expect(await show({ path: "empty.pdf" })).toMatchObject({ isError: true, text: "empty.pdf is empty." });
    expect(await show({ path: "plan/trip.pdf", replaces: "sf_nothing" })).toMatchObject({ isError: true });
  });

  it("outlast the day an attachment no message names is kept, and go when deleted", async () => {
    writeWorkspace("notes/menu.pdf", pdf("menu picks"));
    const { shown } = await show({ path: "notes/menu.pdf" });
    if (!shown) throw new Error("Nothing was shown.");
    clock.moveTo(clock.now() + 3 * 24 * 60 * 60 * 1000);
    const runDue = (): void => {
      if (clock.runNext(clock.now())) runDue();
    };
    runDue();
    const kept = await get(`/v0/attachments/${shown.attachment}`);
    expect(kept.statusCode).toBe(200);
    const listed = await get("/v0/files");
    expect(listed.json<{ files: ShownFile[] }>().files[0]?.id).toBe(shown.file);

    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/v0/files/${shown.file}`,
      headers: { authorization },
    });

    expect(deleted.statusCode).toBe(204);
    const gone = await get(`/v0/files/${shown.file}`);
    expect(gone.statusCode).toBe(404);
    const bytesGone = await get(`/v0/attachments/${shown.attachment}`);
    expect(bytesGone.statusCode).toBe(404);
    expect(existsSync(path.join(workspace, "shown", shown.file))).toBe(false);
    expect(readFileSync(path.join(workspace, "notes/menu.pdf")).equals(pdf("menu picks"))).toBe(true);
  });
});
