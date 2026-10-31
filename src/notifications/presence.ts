import { createCell } from "#cell.ts";
import type { DeviceId } from "#conversation/ids.ts";

export type Presence = {
  readonly setLooking: (device: DeviceId, isLooking: boolean) => void;
  readonly forget: (device: DeviceId) => void;
  readonly openStream: () => () => void;
  readonly isWatched: () => boolean;
  readonly onWatched: (listener: () => void) => () => void;
};

export const createPresence = (): Presence => {
  const looking = createCell<ReadonlySet<DeviceId>>(new Set());
  const streams = createCell(0);
  const listeners = createCell<ReadonlySet<() => void>>(new Set());
  const isWatched = (): boolean => looking.get().size > 0 && streams.get() > 0;
  const tell = (wasWatched: boolean): void => {
    if (wasWatched || !isWatched()) return;
    for (const listener of listeners.get()) listener();
  };

  return {
    setLooking: (device, isLooking) => {
      const wasWatched = isWatched();
      looking.update(
        (current) => new Set(isLooking ? [...current, device] : [...current].filter((other) => other !== device)),
      );
      tell(wasWatched);
    },
    forget: (device) => {
      looking.update((current) => new Set([...current].filter((other) => other !== device)));
    },
    openStream: () => {
      const wasWatched = isWatched();
      streams.update((count) => count + 1);
      tell(wasWatched);
      const isOpen = createCell(true);
      return () => {
        if (!isOpen.get()) return;
        isOpen.set(false);
        streams.update((count) => count - 1);
      };
    },
    isWatched,
    onWatched: (listener) => {
      listeners.update((current) => new Set([...current, listener]));
      return () => {
        listeners.update((current) => new Set([...current].filter((other) => other !== listener)));
      };
    },
  };
};
