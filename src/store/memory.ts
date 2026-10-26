import type { DatabaseSync } from "node:sqlite";

export type ChangeRow = {
  readonly id: string;
  readonly address: string;
  readonly title: string;
  readonly file: string;
  readonly commit: string;
  readonly before?: string;
  readonly at: string;
};

export type Chunk = {
  readonly address: string;
  readonly title: string;
  readonly message?: string;
  readonly text: string;
  readonly at: string;
  readonly vector?: Float32Array;
};

export type StoredChunk = Chunk & { readonly id: number };

export type LatestChange = { readonly address: string; readonly title: string; readonly at: string };

export type ConversationMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly at: string;
};

export const unindexedMessages = (database: DatabaseSync): readonly ConversationMessage[] =>
  database
    .prepare(
      `SELECT id, role, text, at FROM messages
       WHERE text != '' AND (role = 'user' OR (kind = 'reply' AND outcome = 'completed'))
       AND id NOT IN (SELECT message FROM memory_chunks WHERE message IS NOT NULL)
       ORDER BY position`,
    )
    .all() as unknown as readonly ConversationMessage[];

export type MemoryStore = {
  readonly recordChange: (change: ChangeRow) => void;
  readonly findChange: (id: string) => ChangeRow | undefined;
  readonly latestChanges: () => readonly LatestChange[];
  readonly replaceChunks: (address: string, chunks: readonly Chunk[]) => void;
  readonly addChunks: (chunks: readonly Chunk[]) => void;
  readonly clearChunks: () => void;
  readonly chunks: () => readonly StoredChunk[];
  readonly searchText: (query: string, limit: number) => readonly number[];
  readonly unindexedMessages: () => readonly ConversationMessage[];
  readonly yourMessages: () => readonly string[];
};

type ChunkRow = {
  readonly id: number;
  readonly address: string;
  readonly title: string;
  readonly message: string | null;
  readonly text: string;
  readonly at: string;
  readonly vector: Uint8Array | null;
};

const toBlob = (vector: Float32Array | undefined): Uint8Array | null =>
  vector ? new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength) : null;

const toVector = (blob: Uint8Array | null): Float32Array | undefined =>
  blob ? new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)) : undefined;

const toChunk = ({ id, address, title, message, text, at, vector }: ChunkRow): StoredChunk => {
  const decoded = toVector(vector);
  return { id, address, title, ...(message !== null && { message }), text, at, ...(decoded && { vector: decoded }) };
};

const toMatchQuery = (query: string): string =>
  (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => `"${word}"`).join(" OR ");

export const createMemoryStore = (database: DatabaseSync): MemoryStore => {
  const insertChunk = (chunk: Chunk): void => {
    const { lastInsertRowid } = database
      .prepare("INSERT INTO memory_chunks (address, title, message, text, at, vector) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chunk.address, chunk.title, chunk.message ?? null, chunk.text, chunk.at, toBlob(chunk.vector));
    database.prepare("INSERT INTO memory_text (rowid, text) VALUES (?, ?)").run(lastInsertRowid, chunk.text);
  };

  const inTransaction = (work: () => void): void => {
    database.exec("BEGIN");
    try {
      work();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    recordChange: ({ id, address, title, file, commit, before, at }) => {
      database
        .prepare(
          "INSERT INTO memory_changes (id, address, title, file, commit_sha, before_sha, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, address, title, file, commit, before ?? null, at);
    },
    findChange: (id) => {
      const row = database
        .prepare(
          "SELECT id, address, title, file, commit_sha AS 'commit', before_sha AS before, at FROM memory_changes WHERE id = ?",
        )
        .get(id) as (Omit<ChangeRow, "before"> & { readonly before: string | null }) | undefined;
      if (!row) return;
      const { before, ...rest } = row;
      return before === null ? rest : { ...rest, before };
    },
    latestChanges: () =>
      database
        .prepare(
          `SELECT address, title, at FROM memory_changes AS outer_change
           WHERE at = (SELECT MAX(at) FROM memory_changes WHERE address = outer_change.address)
           GROUP BY address ORDER BY at DESC, address`,
        )
        .all() as unknown as readonly LatestChange[],
    replaceChunks: (address, chunks) => {
      inTransaction(() => {
        database
          .prepare("DELETE FROM memory_text WHERE rowid IN (SELECT id FROM memory_chunks WHERE address = ?)")
          .run(address);
        database.prepare("DELETE FROM memory_chunks WHERE address = ?").run(address);
        for (const chunk of chunks) insertChunk(chunk);
      });
    },
    addChunks: (chunks) => {
      inTransaction(() => {
        for (const chunk of chunks) insertChunk(chunk);
      });
    },
    clearChunks: () => {
      database.exec("DELETE FROM memory_text; DELETE FROM memory_chunks;");
    },
    chunks: () =>
      (database.prepare("SELECT * FROM memory_chunks").all() as unknown as readonly ChunkRow[]).map((row) =>
        toChunk(row),
      ),
    searchText: (query, limit) => {
      const match = toMatchQuery(query);
      if (match === "") return [];
      const rows = database
        .prepare("SELECT rowid AS id FROM memory_text WHERE memory_text MATCH ? ORDER BY bm25(memory_text) LIMIT ?")
        .all(match, limit) as unknown as readonly { readonly id: number }[];
      return rows.map(({ id }) => id);
    },
    unindexedMessages: () => unindexedMessages(database),
    yourMessages: () =>
      (
        database
          .prepare("SELECT text FROM messages WHERE role = 'user' AND text != '' ORDER BY position DESC LIMIT 2000")
          .all() as unknown as readonly { readonly text: string }[]
      ).map(({ text }) => text),
  };
};
