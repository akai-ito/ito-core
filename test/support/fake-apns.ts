import { once } from "node:events";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import { createCell } from "#cell.ts";

export type Pushed = { readonly path: string; readonly headers: IncomingHttpHeaders; readonly payload: unknown };

export type FakeApns = {
  readonly origin: string;
  readonly pushed: () => readonly Pushed[];
  readonly next: (waitMs: number) => Promise<Pushed | undefined>;
  readonly answerWith: (status: number) => void;
  readonly holdAnswers: (isHeld: boolean) => void;
  readonly close: () => Promise<void>;
};

export const startFakeApns = async (): Promise<FakeApns> => {
  const pushed = createCell<readonly Pushed[]>([]);
  const taken = createCell(0);
  const status = createCell(200);
  const isHolding = createCell(false);
  const waiters = createCell<readonly (() => void)[]>([]);

  const server: Http2Server = createServer((request, response) => {
    const body = createCell("");
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body.update((text) => text + chunk);
    });
    request.on("end", () => {
      pushed.set([...pushed.get(), { path: request.url, headers: request.headers, payload: JSON.parse(body.get()) }]);
      if (isHolding.get()) return;
      const answer = status.get();
      response.writeHead(answer, { "content-type": "application/json" });
      response.end(
        answer === 200 ? "" : JSON.stringify({ reason: answer === 410 ? "Unregistered" : "BadDeviceToken" }),
      );
      for (const wake of waiters.get()) wake();
      waiters.set([]);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake APNs has no port.");

  const next = async (waitMs: number): Promise<Pushed | undefined> => {
    const ready = pushed.get()[taken.get()];
    if (ready) {
      taken.update((count) => count + 1);
      return ready;
    }
    const hasArrived = await Promise.race([
      new Promise<boolean>((resolve) => {
        waiters.set([
          ...waiters.get(),
          () => {
            resolve(true);
          },
        ]);
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, waitMs);
      }),
    ]);
    return hasArrived ? next(waitMs) : undefined;
  };

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    pushed: () => pushed.get(),
    next,
    answerWith: (answer) => {
      status.set(answer);
    },
    holdAnswers: (isHeld) => {
      isHolding.set(isHeld);
    },
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};
