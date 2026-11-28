import { imagesIn } from "#memory/photos.ts";
import type { MemoryMap } from "#protocol/types.ts";

// The maps a page shows in its story: Markdown images whose source is a day's route (`route:2026-11-24`) or a trip
// (`trip:2026-03-14`, its first day), which the app draws from the places API. The words are the caption.
const mapPattern = /^(?<kind>route|trip):(?<day>\d{4}-\d{2}-\d{2})$/u;

export const mapsIn = (markdown: string): readonly MemoryMap[] => {
  const maps = imagesIn(markdown).flatMap(({ source }): readonly MemoryMap[] => {
    const groups = mapPattern.exec(source)?.groups;
    const kind = groups?.kind;
    const day = groups?.day;
    return day !== undefined && (kind === "route" || kind === "trip") ? [{ source, kind, day }] : [];
  });
  return new Map(maps.map((map) => [map.source, map])).values().toArray();
};
