export const sub20Id = "sub-20-5k";

export const sub20Training: Readonly<Record<string, unknown>> = {
  goal: { title: "Sub-20 5K", target: "19:59", by: "2026-11-30" },
  weeks: [
    {
      id: "week-6",
      start: "2026-10-26",
      focus: "Speed",
      note: "Two hard days, so keep the easy runs easy.",
      sessions: [
        {
          id: "mon-easy",
          date: "2026-10-26",
          kind: "easy",
          title: "Easy run",
          detail: "6 km, conversational",
          done: true,
        },
        {
          id: "wed-intervals",
          date: "2026-10-28",
          kind: "intervals",
          title: "Intervals",
          detail: "6 × 800 m at 3:50/km · 90 s jog · 2 km warm-up",
          done: false,
        },
        { id: "fri-tempo", date: "2026-10-30", kind: "tempo", title: "Tempo", detail: "4 km at 4:05/km", done: false },
        { id: "sun-long", date: "2026-11-01", kind: "long", title: "Long run", detail: "12 km easy", done: false },
      ],
    },
  ],
  results: [
    { id: "parkrun-oct-3", date: "2026-10-03", result: "21:02" },
    { id: "parkrun-oct-24", date: "2026-10-24", result: "20:41", note: "Windy" },
  ],
};
