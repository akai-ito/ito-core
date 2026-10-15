import { createCell } from "#cell.ts";
import type { DeviceId } from "#conversation/ids.ts";

export type Presence = {
  readonly setLooking: (device: DeviceId, isLooking: boolean) => void;
  readonly forget: (device: DeviceId) => void;
  readonly openStream: () => () => void;
  readonly isWatched: () => boolean;
};

export const createPresence = (): Presence => {
  const looking = createCell<ReadonlySet<DeviceId>>(new Set());
  const streams = createCell(0);

  return {
    setLooking: (device, isLooking) => {
      looking.update(
        (current) => new Set(isLooking ? [...current, device] : [...current].filter((other) => other !== device)),
      );
    },
    forget: (device) => {
      looking.update((current) => new Set([...current].filter((other) => other !== device)));
    },
    openStream: () => {
      streams.update((count) => count + 1);
      const isOpen = createCell(true);
      return () => {
        if (!isOpen.get()) return;
        isOpen.set(false);
        streams.update((count) => count - 1);
      };
    },
    isWatched: () => looking.get().size > 0 && streams.get() > 0,
  };
};
