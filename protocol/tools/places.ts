import { createTranscript, type Transcript } from "./transcript.ts";
import { dayBatch, evening, fiveASide, homeWeek, jitter, lisbonPhotos } from "./places-data.ts";

// Places (101–104): a day uploaded and threaded, an arrival Kumo handles quietly, naming a place Kumo can't name,
// and the heat and trips of a year with photos from a trip seeding the spring.

const edinburgh = { locality: "Edinburgh", country: "United Kingdom", country_code: "GB" } as const;
const flatWhere = { street: "4 Marchmont Crescent", ...edinburgh } as const;
const northwindWhere = { apple_name: "Northwind", street: "12 Forth Street", ...edinburgh } as const;

const aDay = (): Transcript => {
  const transcript = createTranscript({
    name: "101-a-day-of-places",
    scenario: 101,
    title: "A day of places",
    summary:
      "On Tuesday evening the phone uploads what it collected since Sunday: two nights at the flat, two days at the " +
      "office and the walks between, as live points and visits. The response is lost, so the phone sends the same " +
      "batch again, and the box answers as it did, taking nothing twice. Home is the place you slept at both nights. " +
      "The day's thread runs from the night at home through the walk to work and back, each move with its minutes " +
      "and metres along the points, and ends at home, where you are now; the trail is the same day as a simplified " +
      "line. Settings shows what the box keeps.",
    guarantees: ["G67", "G69"],
  });
  transcript.begin("2026-11-24T20:00:00.000Z");
  transcript.connect();
  transcript.time("2026-11-24T20:00:01.000Z");
  const flat = transcript.placeId();
  const office = transcript.placeId();
  const taken = {
    batch: dayBatch.batch,
    repeated: false,
    samples: { taken: 44, already: 0 },
    visits: { taken: 5, updated: 0, already: 0 },
  };
  transcript.request("POST", "/v0/location/batches", { body: dayBatch });
  transcript.wait(40);
  transcript.response(200, taken, { isLost: true });
  transcript.time("2026-11-24T20:00:06.000Z");
  transcript.request("POST", "/v0/location/batches", { body: dayBatch });
  transcript.wait(20);
  transcript.response(200, { ...taken, repeated: true });

  transcript.time("2026-11-24T20:01:00.000Z");
  transcript.request("GET", "/v0/places");
  transcript.wait(20);
  transcript.response(200, {
    places: [
      {
        id: flat,
        kind: "home",
        latitude: 55.9415,
        longitude: -3.2058,
        radius: 0,
        hours: 30.2,
        visits: 3,
        first_visit: "2026-11-22T19:10:00.000Z",
        last_visit: "2026-11-24T17:52:00.000Z",
        ...flatWhere,
        here: true,
      },
      {
        id: office,
        kind: "unknown",
        latitude: 55.9524,
        longitude: -3.1965,
        radius: 0,
        hours: 17.3,
        visits: 2,
        first_visit: "2026-11-23T08:55:00.000Z",
        last_visit: "2026-11-24T09:00:00.000Z",
        ...northwindWhere,
      },
    ],
  });

  transcript.time("2026-11-24T20:01:10.000Z");
  transcript.request("GET", "/v0/location/days/2026-11-24");
  transcript.wait(20);
  const home = { place: flat, place_kind: "home", latitude: 55.9415, longitude: -3.2058 };
  const work = { place: office, apple_name: "Northwind", place_kind: "unknown", latitude: 55.9524, longitude: -3.1965 };
  transcript.response(200, {
    day: "2026-11-24",
    items: [
      {
        kind: "stop",
        ...home,
        arrived_at: "2026-11-23T18:00:00.000Z",
        departed_at: "2026-11-24T08:40:00.000Z",
        minutes: 520,
      },
      {
        kind: "move",
        started_at: "2026-11-24T08:40:00.000Z",
        ended_at: "2026-11-24T09:00:00.000Z",
        minutes: 20,
        metres: 1350,
        traced: true,
        mode: "walk",
      },
      {
        kind: "stop",
        ...work,
        arrived_at: "2026-11-24T09:00:00.000Z",
        departed_at: "2026-11-24T17:30:00.000Z",
        minutes: 510,
      },
      {
        kind: "move",
        started_at: "2026-11-24T17:30:00.000Z",
        ended_at: "2026-11-24T17:52:00.000Z",
        minutes: 22,
        metres: 1350,
        traced: true,
        mode: "walk",
      },
      { kind: "stop", ...home, arrived_at: "2026-11-24T17:52:00.000Z", minutes: 129, here: true },
    ],
  });

  transcript.time("2026-11-24T20:01:20.000Z");
  transcript.request("GET", "/v0/location/days/2026-11-24/trail");
  transcript.wait(20);
  transcript.response(200, {
    day: "2026-11-24",
    points: [
      { at: "2026-11-24T00:00:00.000Z", latitude: 55.9415, longitude: -3.2058 },
      { at: "2026-11-24T08:50:00.000Z", latitude: 55.94815, longitude: -3.20115 },
      { at: "2026-11-24T09:00:00.000Z", latitude: 55.9524, longitude: -3.1965 },
      { at: "2026-11-24T17:41:00.000Z", latitude: 55.94815, longitude: -3.20115 },
      { at: "2026-11-24T20:01:20.000Z", latitude: 55.9415, longitude: -3.2058 },
    ],
  });

  transcript.time("2026-11-24T20:02:00.000Z");
  transcript.request("GET", "/v0/location");
  transcript.wait(20);
  transcript.response(200, {
    samples: 44,
    visits: 5,
    photos: 0,
    places: 2,
    first_day: "2026-11-22",
    last_day: "2026-11-24",
    uploaded_at: "2026-11-24T20:00:01.000Z",
    home: flat,
  });
  return transcript;
};

const arriving = (): Transcript => {
  const transcript = createTranscript({
    name: "102-arriving-somewhere",
    scenario: 102,
    title: "Arriving somewhere",
    summary:
      "After the final you leave the office and walk to dinner at Orrin's. The phone uploads the departure and the " +
      "arrival a few minutes later. They're fresh, so they're events, as a mail is: once the moment settles, Kumo " +
      "looks at both together, keeps a note for tonight's journal and says nothing. Then GPS jitter at the table: " +
      "iOS ends the visit and starts it again three minutes later. Leaving and coming back so soon is no event, so " +
      "Kumo isn't woken again, and the day's thread shows dinner as one stay, still going.",
    guarantees: ["G68"],
  });
  transcript.begin("2026-11-24T18:30:00.000Z");
  transcript.connect();
  transcript.time("2026-11-24T18:30:01.000Z");
  const office = transcript.placeId();
  const orrins = transcript.placeId();
  transcript.request("POST", "/v0/location/batches", { body: evening });
  transcript.wait(30);
  transcript.response(200, {
    batch: evening.batch,
    repeated: false,
    samples: { taken: 19, already: 0 },
    visits: { taken: 2, updated: 0, already: 0 },
  });
  transcript.time("2026-11-24T18:31:00.000Z");
  transcript.world("kumo_works", {
    calls: [{ tool: "note_day", input: { text: "Walked from the office to dinner at Orrin's after the final." } }],
    answer: "Kept a note for tonight: dinner at Orrin's after the final. Nothing to tell them.",
  });

  transcript.time("2026-11-24T18:45:00.000Z");
  transcript.request("POST", "/v0/location/batches", { body: jitter });
  transcript.wait(30);
  transcript.response(200, {
    batch: jitter.batch,
    repeated: false,
    samples: { taken: 0, already: 0 },
    visits: { taken: 1, updated: 1, already: 0 },
  });

  transcript.time("2026-11-24T18:46:00.000Z");
  transcript.request("GET", "/v0/location/days/2026-11-24");
  transcript.wait(20);
  transcript.response(200, {
    day: "2026-11-24",
    items: [
      {
        kind: "stop",
        place: office,
        apple_name: "Northwind",
        place_kind: "unknown",
        latitude: 55.9524,
        longitude: -3.1965,
        arrived_at: "2026-11-24T09:00:00.000Z",
        departed_at: "2026-11-24T18:10:00.000Z",
        minutes: 550,
      },
      {
        kind: "move",
        started_at: "2026-11-24T18:10:00.000Z",
        ended_at: "2026-11-24T18:28:00.000Z",
        minutes: 18,
        metres: 699,
        traced: true,
        mode: "walk",
      },
      {
        kind: "stop",
        place: orrins,
        apple_name: "Orrin's",
        place_kind: "unknown",
        latitude: 55.94971,
        longitude: -3.1873,
        arrived_at: "2026-11-24T18:28:00.000Z",
        minutes: 18,
        here: true,
      },
    ],
  });
  return transcript;
};

const naming = (): Transcript => {
  const transcript = createTranscript({
    name: "103-naming-a-place",
    scenario: 103,
    title: "Naming a place",
    summary:
      "You spend two hours off Dalry Road on Tuesday evening, somewhere Kumo can't name. When the phone says you " +
      "left, Kumo looks and asks about it in Understanding you, on its Your places track: a place question with the " +
      "spot, when you were there and for how long, and its guesses at the name from Apple's map data and your " +
      "calendar. It's quiet, like every question: no Desk card, no notification. You tap Five-a-side with Omar, " +
      "the place takes that name, with a kind from it, and Kumo files what it learned in the background.",
    guarantees: ["G69"],
  });
  transcript.begin("2026-11-24T21:20:00.000Z");
  transcript.connect();
  transcript.time("2026-11-24T21:20:01.000Z");
  const pitch = transcript.placeId();
  transcript.request("POST", "/v0/location/batches", { body: fiveASide });
  transcript.wait(30);
  transcript.response(200, {
    batch: fiveASide.batch,
    repeated: false,
    samples: { taken: 0, already: 0 },
    visits: { taken: 1, updated: 0, already: 0 },
  });
  const unnamed = {
    id: pitch,
    kind: "unknown",
    latitude: 55.9402,
    longitude: -3.2235,
    radius: 0,
    hours: 2,
    visits: 1,
    first_visit: "2026-11-24T19:05:00.000Z",
    last_visit: "2026-11-24T19:05:00.000Z",
    apple_name: "Dalry Park",
    street: "Dalry Road",
    ...edinburgh,
  };
  transcript.time("2026-11-24T21:20:30.000Z");
  transcript.request("GET", "/v0/places");
  transcript.wait(20);
  transcript.response(200, { places: [unnamed] });

  transcript.time("2026-11-24T21:21:00.000Z");
  const asked = {
    understood: "You spent two hours off Dalry Road on Tuesday evening, from 19:05.",
    missing: "What was this place?",
    why: "So your map and your days can say where you were.",
    options: ["Five-a-side with Omar", "Dalry Park", "A friend's"],
  };
  transcript.world("kumo_works", {
    calls: [{ tool: "add_question", input: { place: pitch, ...asked } }],
    answer: "Asked what the spot off Dalry Road is.",
  });
  const askedAt = "2026-11-24T21:23:01.000Z";
  transcript.time(askedAt);
  const track = {
    id: transcript.track(),
    name: "Your places",
    stage: "learning",
    since: askedAt,
    note: "The places in your days, and what each one is.",
    confirmed: 0,
    corrected: 0,
    evidence: [] as readonly Readonly<Record<string, unknown>>[],
  };
  const question = {
    id: transcript.questionId(),
    track: track.id,
    state: "open",
    ...asked,
    asked_at: askedAt,
    changed_at: askedAt,
    kind: "place",
    place: {
      place: pitch,
      latitude: 55.9402,
      longitude: -3.2235,
      arrived_at: "2026-11-24T19:05:00.000Z",
      departed_at: "2026-11-24T21:02:00.000Z",
      minutes: 117,
      visits: 1,
      hours: 2,
      apple_name: "Dalry Park",
      street: "Dalry Road",
      locality: "Edinburgh",
    },
  };
  transcript.question(question);

  transcript.time("2026-11-24T21:30:00.000Z");
  transcript.getUnderstanding({ tracks: [track], questions: [question], recent: [] });

  transcript.time("2026-11-24T21:31:00.000Z");
  const filed = "Dalry Park on Tuesday evenings is your five-a-side with Omar.";
  transcript.world("kumo_works", { calls: [], answer: filed });
  const answer = { picked: ["Five-a-side with Omar"] };
  transcript.request("POST", `/v0/understanding/questions/${question.id}/answer`, { body: answer });
  const answeredAt = "2026-11-24T21:31:00.000Z";
  const answered = { ...question, state: "answered", changed_at: answeredAt, answer: { at: answeredAt, ...answer } };
  transcript.question(answered);
  transcript.question({ ...answered, filed });
  transcript.wait(60);
  transcript.response(202, { question: answered });

  transcript.time("2026-11-24T21:32:00.000Z");
  transcript.request("GET", `/v0/places/${pitch}`);
  transcript.wait(20);
  transcript.response(200, {
    place: { ...unnamed, name: "Five-a-side with Omar", kind: "outdoors" },
    visits: [{ arrived_at: "2026-11-24T19:05:00.000Z", departed_at: "2026-11-24T21:02:00.000Z", minutes: 117 }],
  });
  return transcript;
};

const heatAndTrips = (): Transcript => {
  const transcript = createTranscript({
    name: "104-heat-and-trips",
    scenario: 104,
    title: "Heat and trips",
    summary:
      "The phone has two nights at home and a day at the office, and seeds the spring from photo locations: four days " +
      "in Lisbon in March, with a day out to Sintra. Photos are seeded, never live: sending them again under another " +
      "batch takes none twice, and they wake no one. Days mostly far from home are days away, so March holds a " +
      "four-day trip with its country and cities. The year's heat, in coarse cells, counts each day away as 14 " +
      "hours, so Lisbon glows by the trip's length on the saturating curve, full at 500 hours; the week's, in fine " +
      "cells, has home full at 10. Forgetting March takes the photos, the places they made and the trip.",
    guarantees: ["G67", "G69"],
  });
  transcript.begin("2026-11-25T08:00:00.000Z");
  transcript.connect();
  transcript.time("2026-11-25T08:00:01.000Z");
  const flat = transcript.placeId();
  transcript.placeId();
  transcript.request("POST", "/v0/location/batches", { body: homeWeek });
  transcript.wait(30);
  transcript.response(200, {
    batch: homeWeek.batch,
    repeated: false,
    samples: { taken: 0, already: 0 },
    visits: { taken: 3, updated: 0, already: 0 },
  });

  transcript.time("2026-11-25T08:00:10.000Z");
  transcript.request("POST", "/v0/location/photos", { body: lisbonPhotos });
  transcript.wait(30);
  transcript.response(200, { batch: lisbonPhotos.batch, repeated: false, taken: 9, already: 0 });
  transcript.time("2026-11-25T08:00:20.000Z");
  const again = { ...lisbonPhotos, batch: "photos-2026-0002" };
  transcript.request("POST", "/v0/location/photos", { body: again });
  transcript.wait(30);
  transcript.response(200, { batch: again.batch, repeated: false, taken: 0, already: 9 });

  transcript.time("2026-11-25T08:01:00.000Z");
  transcript.request("GET", "/v0/location/trips?from=2026-01-01&to=2026-12-31");
  transcript.wait(20);
  transcript.response(200, {
    trips: [
      {
        id: "2026-03-14",
        from: "2026-03-14",
        to: "2026-03-17",
        days: 4,
        countries: [{ name: "Portugal", code: "PT" }],
        cities: ["Lisbon", "Sintra"],
        latitude: 38.72589,
        longitude: -9.17514,
        kilometres: 1965,
        from_photos: true,
      },
    ],
  });

  transcript.time("2026-11-25T08:01:10.000Z");
  transcript.request("GET", "/v0/location/heat?from=2026-01-01&to=2026-12-31&precision=3");
  transcript.wait(20);
  transcript.response(200, {
    from: "2026-01-01",
    to: "2026-12-31",
    precision: 3,
    full: 500,
    cells: [
      {
        cell: "eyc",
        latitude: 38.67188,
        longitude: -9.14062,
        south: 37.96875,
        west: -9.84375,
        north: 39.375,
        east: -8.4375,
        hours: 56,
        glow: 0.3,
      },
      {
        cell: "gcv",
        latitude: 55.54688,
        longitude: -3.51562,
        south: 54.84375,
        west: -4.21875,
        north: 56.25,
        east: -2.8125,
        hours: 36.8,
        glow: 0.21,
      },
    ],
  });

  transcript.time("2026-11-25T08:01:20.000Z");
  transcript.request("GET", "/v0/location/heat?from=2026-11-23&to=2026-11-29&precision=6");
  transcript.wait(20);
  transcript.response(200, {
    from: "2026-11-23",
    to: "2026-11-29",
    precision: 6,
    full: 10,
    cells: [
      {
        cell: "gcvwpp",
        latitude: 55.93964,
        longitude: -3.20251,
        south: 55.93689,
        west: -3.20801,
        north: 55.94238,
        east: -3.19702,
        hours: 23,
        glow: 1,
      },
      {
        cell: "gcvwr3",
        latitude: 55.95062,
        longitude: -3.19153,
        south: 55.94788,
        west: -3.19702,
        north: 55.95337,
        east: -3.18604,
        hours: 8.8,
        glow: 0.98,
      },
    ],
  });

  transcript.time("2026-11-25T08:02:00.000Z");
  transcript.request("POST", "/v0/location/forget", { body: { from: "2026-03-01", to: "2026-03-31" } });
  transcript.wait(30);
  transcript.response(200, { samples: 0, visits: 0, photos: 9, places: 2 });
  transcript.time("2026-11-25T08:02:10.000Z");
  transcript.request("GET", "/v0/location/trips");
  transcript.wait(20);
  transcript.response(200, { trips: [] });
  transcript.time("2026-11-25T08:02:20.000Z");
  transcript.request("GET", "/v0/location");
  transcript.wait(20);
  transcript.response(200, {
    samples: 0,
    visits: 3,
    photos: 0,
    places: 2,
    first_day: "2026-11-22",
    last_day: "2026-11-24",
    uploaded_at: "2026-11-25T08:00:20.000Z",
    home: flat,
  });
  return transcript;
};

export const placesScenarios: readonly (() => Transcript)[] = [aDay, arriving, naming, heatAndTrips];
