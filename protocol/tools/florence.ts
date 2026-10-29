export const florenceId = "florence-with-janki";

export const florenceCover = {
  alt: "The Duomo above Florence's rooftops at dusk",
  source_url: "https://commons.wikimedia.org/wiki/File:Florence_Duomo_at_dusk.jpg",
  credit: "Wikimedia Commons, CC BY-SA 4.0",
};

export const florenceTrip = (cover: string): Readonly<Record<string, unknown>> => ({
  destination: "Florence",
  dates: { start: "2026-11-06", end: "2026-11-09" },
  timezone: "Europe/Rome",
  who: ["Janki"],
  cover: { attachment: cover, ...florenceCover },
  days: [
    {
      id: "fri",
      date: "2026-11-06",
      stops: [
        { id: "land", title: "Land at Florence airport", time: "14:20", next: { mode: "tram", minutes: 25 } },
        {
          id: "duomo",
          title: "The Duomo",
          time: "16:30",
          place: "duomo-place",
          booking: { status: "to_book" },
          next: { mode: "walk", minutes: 6 },
        },
        { id: "dinner-fri", title: "Dinner at Trattoria Mario", time: "20:00", place: "mario" },
      ],
    },
    {
      id: "sat",
      date: "2026-11-07",
      stops: [
        {
          id: "uffizi",
          title: "Uffizi Gallery",
          time: "08:15",
          place: "uffizi-place",
          booking: { status: "to_book" },
          next: { mode: "walk", minutes: 9 },
        },
        {
          id: "pitti",
          title: "Pitti Palace",
          time: "13:00",
          place: "pitti-place",
          booking: { status: "to_book" },
        },
      ],
    },
    {
      id: "sun",
      date: "2026-11-08",
      title: "Pisa",
      stops: [
        {
          id: "pisa-train",
          title: "Train to Pisa",
          time: "09:12",
          booking: { status: "to_book" },
          next: { mode: "train", minutes: 60, detail: "Firenze SMN → Pisa Centrale" },
        },
        { id: "tower", title: "The Leaning Tower", time: "10:30" },
      ],
    },
  ],
  places: [
    {
      id: "mario",
      name: "Trattoria Mario",
      category: "restaurant",
      why: "Family-run since 1953: bistecca and ribollita at shared tables.",
      status: "shortlisted",
      hours: "Dinner from 19:30",
      price: "€€",
      location: { lat: 43.7765, lon: 11.2535 },
    },
    {
      id: "uffizi-place",
      name: "Uffizi Gallery",
      category: "museum",
      why: "Botticelli and Caravaggio; go at 8:15, before the groups.",
      status: "shortlisted",
      hours: "8:15–18:30",
      price: "€25",
      location: { lat: 43.7678, lon: 11.2553 },
      booking: { status: "to_book", url: "https://www.uffizi.it/en/tickets" },
    },
    {
      id: "pitti-place",
      name: "Pitti Palace",
      category: "museum",
      why: "Raphael and Titian, then the Boboli Gardens behind.",
      status: "shortlisted",
      hours: "8:15–18:50",
      price: "€16",
      location: { lat: 43.7768, lon: 11.2586 },
    },
    {
      id: "duomo-place",
      name: "The Duomo",
      category: "sight",
      why: "Climb Brunelleschi's dome for the city at your feet.",
      status: "shortlisted",
      location: { lat: 43.7731, lon: 11.256 },
    },
  ],
  travel: [
    {
      id: "pisa-day",
      mode: "train",
      title: "Train to Pisa",
      from: "Firenze SMN",
      to: "Pisa Centrale",
      depart: "2026-11-08T09:12",
      arrive: "2026-11-08T10:12",
      booking: { status: "to_book" },
    },
  ],
  stays: [
    {
      id: "guelfo",
      name: "Il Guelfo Bianco",
      address: "Via Cavour 29, Florence",
      location: { lat: 43.7768, lon: 11.2563 },
      check_in: "2026-11-06T15:00",
      check_out: "2026-11-09T11:00",
      booking: { status: "booked", ref: "GB-48213" },
    },
  ],
  todo: [
    { id: "book-uffizi", text: "Book the Uffizi, 8:15 Saturday", done: false },
    { id: "book-duomo", text: "Book the Duomo climb", done: false },
    { id: "book-pisa", text: "Pisa train tickets", done: false },
    { id: "book-pitti", text: "Book the Pitti Palace", done: false },
  ],
});
