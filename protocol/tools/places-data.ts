// Made-up comings and goings for the places transcripts (101–104): a flat in Edinburgh, an office, an evening's
// five-a-side and a spring trip to Lisbon. Every name and spot here is invented for the samples; the streets are only
// there so the numbers look like a real city.

type Spot = { readonly latitude: number; readonly longitude: number };

export const flat: Spot = { latitude: 55.9415, longitude: -3.2058 };
export const office: Spot = { latitude: 55.9524, longitude: -3.1965 };
export const orrins: Spot = { latitude: 55.9497, longitude: -3.1873 };
export const pitch: Spot = { latitude: 55.9402, longitude: -3.2235 };
export const hotel: Spot = { latitude: 38.7139, longitude: -9.1394 };
export const sintra: Spot = { latitude: 38.7976, longitude: -9.3904 };

const toIso = (ms: number): string => new Date(ms).toISOString();

// Live points every minute along a gentle bend between two spots.
export const walk = (from: Spot, to: Spot, start: string, minutes: number) => {
  const startMs = Date.parse(start);
  return Array.from({ length: minutes + 1 }, (_, index) => {
    const share = index / minutes;
    const bend = Math.sin(share * Math.PI) * 0.0012;
    return {
      at: toIso(startMs + index * 60_000),
      latitude: Math.round((from.latitude + (to.latitude - from.latitude) * share + bend) * 1e6) / 1e6,
      longitude: Math.round((from.longitude + (to.longitude - from.longitude) * share) * 1e6) / 1e6,
      accuracy: 6,
      speed: 1.3,
    };
  });
};

const northwind = {
  name: "Northwind",
  street: "12 Forth Street",
  locality: "Edinburgh",
  country: "United Kingdom",
  country_code: "GB",
};
const home = { street: "4 Marchmont Crescent", locality: "Edinburgh", country: "United Kingdom", country_code: "GB" };

// 101: two nights at the flat and two days at the office, uploaded on Tuesday evening.
export const dayBatch = {
  batch: "6f1c2a90-0001",
  time_zone: "Europe/London",
  visits: [
    {
      arrived_at: "2026-11-22T19:10:00.000Z",
      departed_at: "2026-11-23T08:35:00.000Z",
      ...flat,
      accuracy: 15,
      placemark: home,
    },
    {
      arrived_at: "2026-11-23T08:55:00.000Z",
      departed_at: "2026-11-23T17:40:00.000Z",
      ...office,
      accuracy: 18,
      placemark: northwind,
    },
    {
      arrived_at: "2026-11-23T18:00:00.000Z",
      departed_at: "2026-11-24T08:40:00.000Z",
      ...flat,
      accuracy: 12,
      placemark: home,
    },
    {
      arrived_at: "2026-11-24T09:00:00.000Z",
      departed_at: "2026-11-24T17:30:00.000Z",
      ...office,
      accuracy: 16,
      placemark: northwind,
    },
    { arrived_at: "2026-11-24T17:52:00.000Z", ...flat, accuracy: 14, placemark: home },
  ],
  samples: [
    ...walk(flat, office, "2026-11-24T08:40:00.000Z", 20),
    ...walk(office, flat, "2026-11-24T17:30:00.000Z", 22),
  ],
};

// 102: leaving the office after the final, and dinner at Orrin's.
export const evening = {
  batch: "6f1c2a90-0102",
  time_zone: "Europe/London",
  visits: [
    {
      arrived_at: "2026-11-24T09:00:00.000Z",
      departed_at: "2026-11-24T18:10:00.000Z",
      ...office,
      accuracy: 16,
      placemark: northwind,
    },
    {
      arrived_at: "2026-11-24T18:28:00.000Z",
      ...orrins,
      accuracy: 20,
      placemark: {
        name: "Orrin's",
        category: "Restaurant",
        street: "31 Broughton Street",
        locality: "Edinburgh",
        country: "United Kingdom",
        country_code: "GB",
      },
    },
  ],
  samples: walk(office, orrins, "2026-11-24T18:10:00.000Z", 18),
};

// 102: GPS jitter at dinner: iOS ends the visit and starts it again three minutes later.
export const jitter = {
  batch: "6f1c2a90-0103",
  time_zone: "Europe/London",
  visits: [
    { arrived_at: "2026-11-24T18:28:00.000Z", departed_at: "2026-11-24T18:41:00.000Z", ...orrins, accuracy: 20 },
    {
      arrived_at: "2026-11-24T18:44:00.000Z",
      latitude: orrins.latitude + 0.0002,
      longitude: orrins.longitude,
      accuracy: 35,
    },
  ],
};

// 103: two hours off Dalry Road on Tuesday evening, at a spot Kumo doesn't know.
export const fiveASide = {
  batch: "6f1c2a90-0201",
  time_zone: "Europe/London",
  visits: [
    {
      arrived_at: "2026-11-24T19:05:00.000Z",
      departed_at: "2026-11-24T21:02:00.000Z",
      ...pitch,
      accuracy: 25,
      placemark: {
        name: "Dalry Park",
        category: "Park",
        street: "Dalry Road",
        locality: "Edinburgh",
        country: "United Kingdom",
        country_code: "GB",
      },
    },
  ],
};

// 104: a week of nights at home, then photos from four days in Lisbon in March, with a day out to Sintra.
export const homeWeek = {
  batch: "6f1c2a90-0301",
  time_zone: "Europe/London",
  visits: [
    {
      arrived_at: "2026-11-22T19:00:00.000Z",
      departed_at: "2026-11-23T08:30:00.000Z",
      ...flat,
      accuracy: 15,
      placemark: home,
    },
    {
      arrived_at: "2026-11-23T08:50:00.000Z",
      departed_at: "2026-11-23T17:40:00.000Z",
      ...office,
      accuracy: 18,
      placemark: northwind,
    },
    {
      arrived_at: "2026-11-23T18:00:00.000Z",
      departed_at: "2026-11-24T08:30:00.000Z",
      ...flat,
      accuracy: 12,
      placemark: home,
    },
  ],
};

const lisbon = { locality: "Lisbon", country: "Portugal", country_code: "PT" };

export const lisbonPhotos = {
  batch: "photos-2026-0001",
  time_zone: "Europe/Lisbon",
  photos: [
    { taken_at: "2026-03-14T12:10:00.000Z", ...hotel, placemark: { name: "Casa Kestrel", ...lisbon } },
    { taken_at: "2026-03-14T18:40:00.000Z", latitude: 38.7142, longitude: -9.1391 },
    {
      taken_at: "2026-03-15T09:30:00.000Z",
      latitude: 38.714,
      longitude: -9.1396,
      placemark: { name: "Casa Kestrel", ...lisbon },
    },
    { taken_at: "2026-03-15T13:05:00.000Z", latitude: 38.7136, longitude: -9.1389 },
    {
      taken_at: "2026-03-16T11:20:00.000Z",
      ...sintra,
      placemark: { name: "Quinta dos Halcyon", locality: "Sintra", country: "Portugal", country_code: "PT" },
    },
    { taken_at: "2026-03-16T13:45:00.000Z", latitude: 38.7979, longitude: -9.3901 },
    { taken_at: "2026-03-16T20:15:00.000Z", latitude: 38.7141, longitude: -9.1393 },
    { taken_at: "2026-03-17T10:00:00.000Z", latitude: 38.7138, longitude: -9.1395 },
    { taken_at: "2026-03-17T14:30:00.000Z", latitude: 38.7137, longitude: -9.1392 },
  ],
};
