import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Attachments } from "#attachments/attachments.ts";
import { mediaTypeOfName } from "#attachments/formats.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { FileVersion, ShownFile } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// Files Kumo shows them in the chat to look at before they go anywhere, such as a PDF it made. Each time it shows
// a changed file, that's the file's next version: an attachment whose bytes never change, so feedback is about one
// version and the same version can go into a mail draft. A read-only copy of each version sits in the workspace,
// under shown/, for `ito mail draft --attach`.

export type ShownFilesOptions = {
  readonly database: DatabaseSync;
  readonly attachments: Pick<Attachments, "save" | "remove" | "find" | "pathOf">;
  readonly store: Pick<Store, "keepAttachment">;
  readonly newAttachment: () => string;
  readonly workspace: string;
  readonly maxBytes: number;
  readonly clock: Clock;
};

export type Shown = {
  readonly file: string;
  readonly version: FileVersion;
  readonly isNew: boolean;
  readonly mailPath: string;
};

export type ShowInput = { readonly path: string; readonly note?: string; readonly replaces?: string };

export type ShownFiles = {
  readonly show: (input: ShowInput) => Result<Shown, string>;
  readonly list: () => readonly ShownFile[];
  readonly find: (file: string) => ShownFile | undefined;
  readonly remove: (file: string) => void;
  readonly tool: Tool;
};

type Row = {
  readonly attachment: string;
  readonly file: string;
  readonly version: number;
  readonly path: string;
  readonly sha256: string;
  readonly body: string;
};

export const shownFolder = "shown";

const megabytes = (bytes: number): string => `${String(Math.round(bytes / (1024 * 1024)))} MB`;

const isInside = (folder: string, file: string): boolean => {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// The file Kumo named, inside its workspace and nowhere else.
const resolve = (
  workspace: string,
  given: string,
): Result<{ readonly file: string; readonly relative: string }, string> => {
  try {
    const folder = realpathSync(workspace);
    const file = realpathSync(path.resolve(folder, given));
    if (!isInside(folder, file)) return fail(`${given} isn't in your workspace, so it can't be shown.`);
    return statSync(file).isFile()
      ? ok({ file, relative: path.relative(folder, file).split(path.sep).join("/") })
      : fail(`${given} isn't a file.`);
  } catch {
    return fail(`There's no ${given} in your workspace.`);
  }
};

const toShownFile = (rows: readonly Row[]): ShownFile | undefined => {
  const versions = rows.map((row) => JSON.parse(row.body) as FileVersion);
  const [first] = rows;
  const latest = versions.at(-1);
  return first && latest ? { id: first.file, name: latest.attachment.name, versions } : undefined;
};

const failed = (text: string): ToolResult => ({ text, isError: true });

// Where a version's read-only copy sits in the workspace, such as shown/sf_…/v2/cv.pdf.
const mailPathOf = (file: string, version: number, name: string): string =>
  `${shownFolder}/${file}/v${String(version)}/${name}`;

const shownAs = (row: Row, isNew: boolean): Shown => {
  const version = JSON.parse(row.body) as FileVersion;
  return { file: row.file, version, isNew, mailPath: mailPathOf(row.file, row.version, version.attachment.name) };
};

export const createShownFiles = ({
  database,
  attachments,
  store,
  newAttachment,
  workspace,
  maxBytes,
  clock,
}: ShownFilesOptions): ShownFiles => {
  const rowsOf = (file: string): readonly Row[] =>
    database
      .prepare("SELECT * FROM shown_files WHERE file = ? ORDER BY version")
      .all(file) as unknown as readonly Row[];

  const latestAt = (relative: string): Row | undefined =>
    database.prepare("SELECT * FROM shown_files WHERE path = ? ORDER BY rowid DESC LIMIT 1").get(relative) as
      Row | undefined;

  const sameBytes = (sha256: string): Row | undefined =>
    database.prepare("SELECT * FROM shown_files WHERE sha256 = ? ORDER BY rowid DESC LIMIT 1").get(sha256) as
      Row | undefined;

  const fileOf = (given: string): string | undefined => {
    const row = database
      .prepare("SELECT file FROM shown_files WHERE file = ? OR attachment = ? LIMIT 1")
      .get(given, given) as { readonly file: string } | undefined;
    return row?.file;
  };

  // A read-only copy of a version where mail drafts can attach it: the same bytes, linked where the disk allows.
  const placeCopy = (attachment: string, target: string): void => {
    mkdirSync(path.dirname(target), { recursive: true });
    rmSync(target, { force: true });
    try {
      linkSync(attachments.pathOf(attachment), target);
    } catch {
      copyFileSync(attachments.pathOf(attachment), target);
    }
    chmodSync(target, 0o444);
  };

  const show = ({ path: given, note, replaces }: ShowInput): Result<Shown, string> => {
    const resolved = resolve(workspace, given);
    if (!resolved.ok) return resolved;
    const { file, relative } = resolved.value;
    const size = statSync(file).size;
    if (size === 0) return fail(`${given} is empty.`);
    if (size > maxBytes) return fail(`${given} is over ${megabytes(maxBytes)}, too big to show.`);
    const bytes = readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const named = replaces?.trim() ?? "";
    const existing = named === "" ? latestAt(relative)?.file : fileOf(named);
    if (named !== "" && existing === undefined) return fail(`There's no file ${named} you've shown before.`);
    const same = sameBytes(sha256);
    if (same && attachments.find(same.attachment)) return ok(shownAs(same, false));
    const attachment = newAttachment();
    const fileId = existing ?? `sf_${attachment.replace(/^f_/u, "")}`;
    const versionNumber = existing === undefined ? 1 : (rowsOf(existing).at(-1)?.version ?? 0) + 1;
    const name = path.basename(file);
    const saved = attachments.save(attachment, name, mediaTypeOfName(name), bytes);
    if (!saved.ok) return fail("It couldn't be kept.");
    store.keepAttachment(attachment);
    const version: FileVersion = {
      version: versionNumber,
      attachment: saved.value.attachment,
      ...(note !== undefined && note.trim() !== "" && { note: note.trim() }),
      made_at: toTimestamp(clock.now()),
    };
    database
      .prepare("INSERT INTO shown_files (attachment, file, version, path, sha256, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(attachment, fileId, versionNumber, relative, sha256, JSON.stringify(version));
    placeCopy(attachment, path.join(workspace, mailPathOf(fileId, versionNumber, name)));
    const row = rowsOf(fileId).find((each) => each.version === versionNumber);
    return row ? ok(shownAs(row, true)) : fail("It couldn't be kept.");
  };

  const tool: Tool = {
    name: "show_file",
    title: "Show them a file",
    description:
      "Put a file you made or changed in the chat for them to look at before it goes anywhere, such as a PDF or a " +
      "document: give its path in your workspace. Each time you show a changed file it's the file's next version, " +
      "so their feedback is about one version, and that version is kept exactly as it is. Then put the ari:file " +
      "block it gives you in your reply, or in your post, where the file belongs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file in your workspace, such as cv/cv.pdf." },
        note: { type: "string", description: "What changed since the version before, in a few words." },
        replaces: {
          type: "string",
          description: "The id of a file you showed before, when this is its next version under a new name or path.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    call: (input) => {
      const note = textOf(input, "note");
      const replaces = textOf(input, "replaces");
      const shown = show({
        path: textOf(input, "path").trim(),
        ...(note !== "" && { note }),
        ...(replaces !== "" && { replaces }),
      });
      if (!shown.ok) return Promise.resolve(failed(shown.failure));
      const { file, version, isNew, mailPath } = shown.value;
      const number = String(version.version);
      const block = ["```ari:file", JSON.stringify({ file, version: version.version }), "```"].join("\n");
      return Promise.resolve({
        text: [
          `${isNew ? "Shown" : "Already shown, unchanged:"} ${version.attachment.name}, version ${number} of ${file}.`,
          "Put this where it belongs in your reply or post:",
          block,
          `Their feedback on it is about version ${number} unless they say otherwise. To attach exactly this version to ` +
            `a mail draft, attach ${mailPath}.`,
        ].join("\n"),
        structured: { file, version: version.version, attachment: version.attachment.id, mail_path: mailPath },
      });
    },
  };

  return {
    show,
    list: () =>
      (
        database
          .prepare("SELECT file FROM shown_files GROUP BY file ORDER BY MAX(rowid) DESC")
          .all() as unknown as readonly { readonly file: string }[]
      ).flatMap(({ file }) => toShownFile(rowsOf(file)) ?? []),
    find: (file) => toShownFile(rowsOf(file)),
    remove: (file) => {
      for (const row of rowsOf(file)) attachments.remove(row.attachment);
      rmSync(path.join(workspace, shownFolder, path.basename(file)), { recursive: true, force: true });
      database.prepare("DELETE FROM shown_files WHERE file = ?").run(file);
    },
    tool,
  };
};
