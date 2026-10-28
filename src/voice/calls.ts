import { createCell } from "#cell.ts";
import { createCallStream, type CallOptions, type CallStream } from "#voice/call.ts";

export type Calls = {
  readonly streamFor: (call: string) => CallStream;
  readonly end: (call: string) => Promise<boolean>;
  readonly endAllBut: (call: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export const createCalls = (options: Omit<CallOptions, "call" | "onEnded">): Calls => {
  const streams = createCell<ReadonlyMap<string, CallStream>>(new Map());

  const forget = (call: string): void => {
    streams.update((current) => new Map([...current].filter(([name]) => name !== call)));
  };

  const endAll = async (keep?: string): Promise<void> => {
    await Promise.all(
      [...streams.get()].filter(([call]) => call !== keep).map(async ([, stream]) => stream.end()),
    );
  };

  return {
    streamFor: (call) => {
      const existing = streams.get().get(call);
      if (existing) return existing;
      const stream = createCallStream({
        ...options,
        call,
        onEnded: () => {
          forget(call);
        },
      });
      streams.update((current) => new Map([...current, [call, stream]]));
      return stream;
    },
    end: async (call) => {
      const stream = streams.get().get(call);
      if (!stream) return false;
      await stream.end();
      return true;
    },
    endAllBut: async (call) => endAll(call),
    close: async () => endAll(),
  };
};
