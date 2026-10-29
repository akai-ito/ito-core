import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fail, ok, type Result } from "#result.ts";

const run = promisify(execFile);

export type FileChange = { readonly file: string; readonly isDeleted: boolean };

export type FileCommit = {
  readonly commit: string;
  readonly at: string;
  readonly subject: string;
  readonly body: string;
  readonly isDeleted: boolean;
};

export type Thread = {
  readonly directory: string;
  readonly read: (file: string) => string | undefined;
  readonly write: (file: string, text: string | undefined, message: string) => Promise<Result<string, string>>;
  readonly writeFiles: (
    files: readonly { readonly file: string; readonly text: string | Uint8Array }[],
    message: string,
    removed?: readonly string[],
  ) => Promise<Result<string, string>>;
  readonly readAt: (commit: string, file: string) => Promise<string | undefined>;
  readonly history: (file: string, limit?: number) => Promise<readonly FileCommit[]>;
  readonly files: () => readonly string[];
  readonly head: () => Promise<string>;
  readonly changedFiles: (from: string, to: string) => Promise<readonly FileChange[]>;
  readonly pull: () => Promise<Result<"pulled" | "current", string>>;
  readonly hasRemote: () => Promise<boolean>;
  readonly setRemote: (url: string) => Promise<Result<undefined, string>>;
  readonly push: () => Promise<Result<undefined, string>>;
};

const describe = (error: unknown): string => {
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.trim() !== ""
    ? stderr.trim()
    : error instanceof Error
      ? error.message
      : String(error);
};

const listFiles = (directory: string, relative = ""): readonly string[] => {
  const entries = readdirSync(path.join(directory, relative), { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith("."),
  );
  const named = (name: string): string => (relative ? `${relative}/${name}` : name);
  return [
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => named(entry.name)),
    ...entries.filter((entry) => entry.isDirectory()).flatMap((entry) => listFiles(directory, named(entry.name))),
  ];
};

export const openThread = async (directory: string): Promise<Thread> => {
  const git = async (...arguments_: readonly string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", directory, ...arguments_], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };
  mkdirSync(directory, { recursive: true });
  if (!existsSync(path.join(directory, ".git"))) {
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.name", "Ari");
    await git("config", "user.email", "ari@ito.invalid");
    await git("commit", "--quiet", "--allow-empty", "--message", "Start the Thread");
  }

  return {
    directory,
    read: (file) => {
      const full = path.join(directory, file);
      return existsSync(full) ? readFileSync(full, "utf8") : undefined;
    },
    write: async (file, text, message) => {
      const full = path.join(directory, file);
      try {
        if (text === undefined) {
          rmSync(full, { force: true });
        } else {
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, text);
        }
        await git("add", "--all", "--", file);
        await git("commit", "--quiet", "--allow-empty", "--message", message);
        const head = await git("rev-parse", "HEAD");
        return ok(head.trim());
      } catch (error) {
        return fail(describe(error));
      }
    },
    writeFiles: async (files, message, removed = []) => {
      try {
        for (const { file, text } of files) {
          mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
          writeFileSync(path.join(directory, file), text);
        }
        for (const file of removed) rmSync(path.join(directory, file), { force: true, recursive: true });
        await git("add", "--all", "--", ...files.map(({ file }) => file), ...removed);
        await git("commit", "--quiet", "--message", message);
        const head = await git("rev-parse", "HEAD");
        return ok(head.trim());
      } catch (error) {
        return fail(describe(error));
      }
    },
    readAt: async (commit, file) => {
      try {
        return await git("show", `${commit}:${file}`);
      } catch {
        return;
      }
    },
    history: async (file, limit) => {
      const listed = await git(
        "log",
        "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f",
        "--name-status",
        "--no-renames",
        ...(limit === undefined ? [] : [`--max-count=${String(limit)}`]),
        "--",
        file,
      );
      return listed
        .split("\u{1E}")
        .filter((entry) => entry.trim() !== "")
        .map((entry) => {
          const [commit = "", at = "", subject = "", body = "", status = ""] = entry.split("\u{1F}", 5);
          const statuses = status
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const isDeleted = statuses.length > 0 && statuses.every((line) => line.startsWith("D"));
          return { commit, at, subject, body: body.trim(), isDeleted };
        });
    },
    files: () => listFiles(directory),
    head: async () => {
      const head = await git("rev-parse", "HEAD");
      return head.trim();
    },
    changedFiles: async (from, to) => {
      const listed = await git("diff", "--name-status", "--no-renames", from, to, "--", "*.md");
      return listed
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const [status = "", file = ""] = line.split("\t", 2);
          return { file, isDeleted: status === "D" };
        });
    },
    pull: async () => {
      try {
        await git("fetch", "--quiet", "origin");
        const isBehind = async (): Promise<boolean> => {
          try {
            await git("merge-base", "--is-ancestor", "origin/main", "HEAD");
            return false;
          } catch {
            return true;
          }
        };
        if (!(await isBehind())) return ok("current");
        try {
          await git("merge", "--ff-only", "--quiet", "origin/main");
        } catch {
          return fail(
            "Memory has changed both here and on the remote since they last matched, so nothing was pulled. " +
              `Merge them by hand with git -C ${directory} pull.`,
          );
        }
        return ok("pulled");
      } catch (error) {
        return fail(describe(error));
      }
    },
    hasRemote: async () => {
      const remotes = await git("remote");
      return remotes.split("\n").includes("origin");
    },
    setRemote: async (url) => {
      try {
        const remotes = await git("remote");
        await (remotes.split("\n").includes("origin")
          ? git("remote", "set-url", "origin", url)
          : git("remote", "add", "origin", url));
        return ok(undefined);
      } catch (error) {
        return fail(describe(error));
      }
    },
    push: async () => {
      try {
        await git("push", "--quiet", "origin", "HEAD:main");
        return ok(undefined);
      } catch (error) {
        return fail(describe(error));
      }
    },
  };
};
