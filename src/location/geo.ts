// Geometry for places: distances on the Earth, geohash cells and simplifying a route.
//
// The heat is binned in geohash cells. A geohash names a rectangle by interleaving the bits of its longitude and
// latitude, five bits to a character, so every prefix of a cell's name is the cell that contains it. That lets the box
// store one fine precision per day (7 characters, about 150 m) and sum any coarser one with `SUBSTR` in SQL, with no
// library: 6 is about a kilometre, 5 about 5 km, 4 about 40 km, 3 about 150 km and 2 a continent. Cells narrow toward
// the poles, which a glow doesn't mind. H3's hexagons look rounder, but their parents don't contain their children
// exactly and they need a native library.

export type Point = { readonly latitude: number; readonly longitude: number };

export type Bounds = { readonly south: number; readonly west: number; readonly north: number; readonly east: number };

const earthMetres = 6_371_000;
const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export const finestPrecision = 7;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

// The great-circle distance in metres.
export const metresBetween = (from: Point, to: Point): number => {
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthMetres * Math.asin(Math.min(1, Math.sqrt(a)));
};

type Range = { readonly low: number; readonly high: number };

type Encoding = {
  readonly hash: string;
  readonly bits: number;
  readonly value: number;
  readonly lon: Range;
  readonly lat: Range;
};

// The geohash of a point, `precision` characters long.
export const geohash = ({ latitude, longitude }: Point, precision = finestPrecision): string => {
  const steps = Array.from({ length: precision * 5 }, (_, index) => index);
  const done = steps.reduce<Encoding>(
    (state, index) => {
      const isLongitude = index % 2 === 0;
      const range = isLongitude ? state.lon : state.lat;
      const middle = (range.low + range.high) / 2;
      const coordinate = isLongitude ? longitude : latitude;
      const isHigh = coordinate >= middle;
      const narrowed = isHigh ? { low: middle, high: range.high } : { low: range.low, high: middle };
      const value = state.value * 2 + (isHigh ? 1 : 0);
      const bits = state.bits + 1;
      const next = {
        ...state,
        ...(isLongitude ? { lon: narrowed } : { lat: narrowed }),
      };
      return bits === 5
        ? { ...next, hash: state.hash + base32.charAt(value), bits: 0, value: 0 }
        : { ...next, bits, value };
    },
    { hash: "", bits: 0, value: 0, lon: { low: -180, high: 180 }, lat: { low: -90, high: 90 } },
  );
  return done.hash;
};

// The rectangle a geohash names.
export const cellBounds = (hash: string): Bounds => {
  const bits = Array.from({ length: hash.length }, (_, index) => hash.charAt(index)).flatMap((character) => {
    const value = base32.indexOf(character);
    return [4, 3, 2, 1, 0].map((shift) => (value >> shift) & 1);
  });
  const { lon, lat } = bits.reduce<{ readonly lon: Range; readonly lat: Range }>(
    (state, bit, index) => {
      const isLongitude = index % 2 === 0;
      const range = isLongitude ? state.lon : state.lat;
      const middle = (range.low + range.high) / 2;
      const narrowed = bit === 1 ? { low: middle, high: range.high } : { low: range.low, high: middle };
      return isLongitude ? { ...state, lon: narrowed } : { ...state, lat: narrowed };
    },
    { lon: { low: -180, high: 180 }, lat: { low: -90, high: 90 } },
  );
  return { south: lat.low, west: lon.low, north: lat.high, east: lon.high };
};

export const centreOf = ({ south, west, north, east }: Bounds): Point => ({
  latitude: (south + north) / 2,
  longitude: (west + east) / 2,
});

// Coordinates as the API gives them: about a metre.
export const rounded = (value: number, places = 5): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

// A weighted mean of points: fine at the scale of a place or a city.
export const meanOf = (points: readonly (Point & { readonly weight: number })[]): Point | undefined => {
  const total = points.reduce((sum, { weight }) => sum + weight, 0);
  if (points.length === 0) return undefined;
  if (total <= 0) return meanOf(points.map((point) => ({ ...point, weight: 1 })));
  return {
    latitude: points.reduce((sum, point) => sum + point.latitude * point.weight, 0) / total,
    longitude: points.reduce((sum, point) => sum + point.longitude * point.weight, 0) / total,
  };
};

// How far a point is from the line through two others, in metres, on a local flat projection.
const offLine = (point: Point, start: Point, end: Point): number => {
  const scale = Math.cos(radians(start.latitude));
  const toXy = ({ latitude, longitude }: Point): readonly [number, number] => [
    radians(longitude - start.longitude) * scale * earthMetres,
    radians(latitude - start.latitude) * earthMetres,
  ];
  const [px, py] = toXy(point);
  const [ex, ey] = toXy(end);
  const length = Math.hypot(ex, ey);
  if (length === 0) return Math.hypot(px, py);
  const along = Math.max(0, Math.min(1, (px * ex + py * ey) / (length * length)));
  return Math.hypot(px - along * ex, py - along * ey);
};

// Douglas–Peucker: drops the points closer than `tolerance` metres to the line the rest make.
export const simplify = <Kept extends Point>(points: readonly Kept[], tolerance: number): readonly Kept[] => {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return points;
  const farthest = points.slice(1, -1).reduce<{ readonly index: number; readonly distance: number }>(
    (best, point, index) => {
      const distance = offLine(point, first, last);
      return distance > best.distance ? { index: index + 1, distance } : best;
    },
    { index: 0, distance: 0 },
  );
  if (farthest.distance <= tolerance) return [first, last];
  const before = simplify(points.slice(0, farthest.index + 1), tolerance);
  const after = simplify(points.slice(farthest.index), tolerance);
  return [...before.slice(0, -1), ...after];
};

// The length of a path through points, in metres.
export const pathMetres = (points: readonly Point[]): number =>
  points.slice(1).reduce((sum, point, index) => sum + metresBetween(points[index] ?? point, point), 0);
