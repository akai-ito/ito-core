import { createCell } from "#cell.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { toThreadId, type MessageId } from "#conversation/ids.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { QuickChoice } from "#engine/quick-model.ts";
import type { Message, Share, Shared, Thread } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { lineOf } from "#notifications/text.ts";
import { ok, type Result } from "#result.ts";
import { previewLink } from "#shares/link.ts";
import { toSaid } from "#shares/said.ts";
import type { ShareFailure, SharePlace, ShareRequest, Store, StoredShare } from "#store/store.ts";
import { toTitle } from "#threads/naming.ts";
import { textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// What they share from their phone's share sheet: a link, a screenshot or photo, some text or a quick thought. It's on
// disk as soon as it's accepted. Then the server reads the link's page, and Kumo, on the quick model, decides where it
// belongs: one of their open side threads when it clearly belongs to that thread's subject, or else a new thread it
// names. There it becomes their message, under the share's id, and that thread's own turn answers it, as any message
// there would be answered. Shares are sorted one at a time, in the order they came, and a restart sorts what's left.
export type Shares = {
  readonly accept: (
    id: MessageId,
    request: ShareRequest,
  ) => Result<{ readonly share: Share; readonly isNew: boolean }, ShareFailure>;
  // Sorts every share a restart cut off.
  readonly recover: () => void;
  readonly idle: () => Promise<void>;
  readonly close: () => void;
};

export type SharesOptions = {
  readonly store: Pick<
    Store,
    "acceptShare" | "findShare" | "unplacedShares" | "placeShare" | "openThreads" | "threadMessages" | "findAttachment"
  >;
  readonly fetch: Fetch;
  readonly complete: Complete;
  readonly quickChoice: QuickChoice;
  // Where an attachment's bytes are, for the model to see a screenshot.
  readonly attachmentPath: (attachment: string) => string;
  // When something happened, in their time zone and plain words.
  readonly spoken: (at: string) => string;
  // The share is their message in its thread now: that thread's conversation answers it.
  readonly route: (message: MessageId, text: string) => void;
  readonly info: Info;
};

const mostThreads = 25;
const threadMessages = 2;
const messageLength = 160;

export const sortSchema: JsonSchema = {
  type: "object",
  properties: { thread: { type: "string" }, title: { type: "string" } },
  required: ["thread", "title"],
  additionalProperties: false,
};

export const toShare = (stored: StoredShare): Share => ({
  id: stored.id,
  state: stored.placed ? "placed" : "sorting",
  at: stored.at,
  ...(stored.placed?.thread !== undefined && { thread: stored.placed.thread }),
});

const squeeze = (text: string): string => {
  const plain = withoutBlocks(text).replaceAll(/\s+/gu, " ").trim();
  return plain.length > messageLength ? `${plain.slice(0, messageLength)}…` : plain;
};

export const toSortingPrompt = (
  threads: readonly { readonly thread: Thread; readonly last: string; readonly lately: readonly string[] }[],
  said: string,
  extras: { readonly images: number; readonly files: readonly string[] },
): string =>
  [
    "You sort what they share with Kumo, their assistant, from their phone's share sheet: a link, a screenshot or",
    "photo, some text or a quick thought. Kumo answers each share in a side thread, a conversation of its own beside",
    "the main chat.",
    "- When it clearly belongs to one of their open threads, answer with that thread's id as `thread`, and an empty",
    "  `title`. Clearly means it's about that thread's subject, such as a screenshot of the job ad for the role a",
    "  thread is about, or the menu for the restaurant a thread is planning, not merely the same area of life.",
    "- Otherwise answer an empty `thread`, and a `title` for a new thread of its own: one to five plain words naming",
    '  what it\'s about, such as "Kiln menu", "Halcyon offer" or "Trail shoes". Name the thing, not the request: no',
    "  verbs like asking or planning, no quotes, no full stop.",
    "",
    ...(threads.length === 0
      ? ["They have no open threads."]
      : [
          "Their open threads, latest first:",
          ...threads.flatMap(({ thread, last, lately }) => [
            `- ${thread.id}, ${thread.title === undefined ? "not yet named" : `“${thread.title}”`}, last ${last}` +
              (thread.result === undefined ? "" : `: ${thread.result}`),
            ...lately.map((line) => `  ${line}`),
          ]),
        ]),
    "",
    "What they shared:",
    said,
    ...(extras.images === 0
      ? []
      : [`(${extras.images === 1 ? "A photo" : `${String(extras.images)} photos`}, shown to you.)`]),
    ...(extras.files.length === 0 ? [] : [`(Files: ${extras.files.join(", ")})`]),
  ].join("\n");

const whoSaid = (message: Message): string => (message.role === "user" ? "they" : "Kumo");

export const createShares = ({
  store,
  fetch,
  complete,
  quickChoice,
  attachmentPath,
  spoken,
  route,
  info,
}: SharesOptions): Shares => {
  const queue = createCell<Promise<void>>(Promise.resolve());
  const isClosed = createCell(false);

  const enqueue = (work: () => Promise<void>): void => {
    void queue.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await work();
      } catch (error) {
        info("Kumo couldn't sort a share", { error: String(error) });
      }
    });
  };

  const openThreads = (): readonly {
    readonly thread: Thread;
    readonly last: string;
    readonly lately: readonly string[];
  }[] =>
    store
      .openThreads()
      .slice(0, mostThreads)
      .map((thread) => ({
        thread,
        last: spoken(thread.last_at),
        lately: store
          .threadMessages(toThreadId(thread.id), threadMessages)
          .map(
            (message) =>
              `${whoSaid(message)}: ${squeeze(toSaid(message.text, message.share)) || lineOf("", message.attachments)}`,
          ),
      }));

  // Kumo's call on where the share goes. When it can't make one, the share starts a thread of its own, which Kumo
  // names once it has answered there, as a thread they start is named.
  const decide = async (share: StoredShare, said: string): Promise<SharePlace> => {
    const attached = share.request.attachments.flatMap((id) => store.findAttachment(id)?.attachment ?? []);
    const images = attached.filter(({ kind }) => kind === "image");
    const threads = openThreads();
    const prompt = toSortingPrompt(threads, said, {
      images: images.length,
      files: attached.filter(({ kind }) => kind !== "image").map(({ name }) => name),
    });
    const answered = await complete(
      prompt,
      sortSchema,
      await quickChoice({ images: images.length > 0 }),
      images.map(({ id }) => attachmentPath(id)),
    );
    if (!answered.ok) {
      info("Kumo couldn't sort a share, so it starts a thread of its own", {
        share: share.id,
        error: answered.failure,
      });
      return { title: undefined };
    }
    const thread = textOf(answered.value, "thread").trim();
    return threads.some((open) => open.thread.id === thread)
      ? { thread: toThreadId(thread) }
      : { title: toTitle(textOf(answered.value, "title")) };
  };

  const sort = async (share: StoredShare): Promise<void> => {
    const { url, text, note = "" } = share.request;
    const link = url === undefined ? undefined : await previewLink(url, fetch);
    if (isClosed.get()) return;
    const shared: Shared = { ...(link && { link }), ...(text !== undefined && { text }) };
    const said = toSaid(note, shared);
    const place = await decide(share, said);
    if (isClosed.get()) return;
    const placed = store.placeShare(share.id, shared, place);
    if (!placed.ok || !placed.value.isNew) return;
    info("Kumo placed a share", {
      share: share.id,
      thread: placed.value.message.thread,
      joined: "thread" in place && placed.value.message.thread === place.thread,
    });
    route(share.id, said);
  };

  return {
    accept: (id, request) => {
      const accepted = store.acceptShare(id, request);
      if (!accepted.ok) return accepted;
      const { share, isNew } = accepted.value;
      if (isNew) enqueue(() => sort(share));
      return ok({ share: toShare(share), isNew });
    },

    recover: () => {
      for (const share of store.unplacedShares()) enqueue(() => sort(share));
    },

    idle: () => queue.get(),

    close: () => {
      isClosed.set(true);
    },
  };
};
