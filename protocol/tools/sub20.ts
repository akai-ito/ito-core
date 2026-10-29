export const sub20Id = "sub-20-5k";

type Session = {
  readonly id: string;
  readonly date: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly done: boolean;
};

const session = (week: number, date: string, kind: string, title: string, detail: string, done = false): Session => {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`))
    .toLowerCase();
  return { id: `w${String(week)}-${day}`, date, kind, title, detail, done };
};

export const sub20Training: Readonly<Record<string, unknown>> = {
  goal: { title: "Sub-20 5K", target: "19:59", by: "2026-11-30" },
  weeks: [
    {
      id: "week-1",
      start: "2026-09-21",
      focus: "Base",
      note: "Easy miles to build on; nothing fast yet.",
      sessions: [
        session(1, "2026-09-21", "easy", "Easy run", "5 km, conversational", true),
        session(1, "2026-09-23", "easy", "Easy run", "6 km, with 6 × 20 s strides", true),
        session(1, "2026-09-27", "long", "Long run", "9 km easy", true),
      ],
    },
    {
      id: "week-2",
      start: "2026-09-28",
      focus: "Base",
      note: "A first taste of pace on Wednesday.",
      sessions: [
        session(2, "2026-09-28", "easy", "Easy run", "6 km, conversational", true),
        session(2, "2026-09-30", "tempo", "Tempo", "3 km at 4:15/km", true),
        session(2, "2026-10-04", "long", "Long run", "10 km easy", true),
      ],
    },
    {
      id: "week-3",
      start: "2026-10-05",
      focus: "Strength",
      note: "Hills on Wednesday; the parkrun last Saturday is your starting point.",
      sessions: [
        session(3, "2026-10-05", "easy", "Easy run", "6 km, conversational", true),
        session(3, "2026-10-07", "intervals", "Hills", "8 × 60 s uphill · jog down", true),
        session(3, "2026-10-09", "strength", "Strength", "Squats, lunges, calf raises", true),
        session(3, "2026-10-11", "long", "Long run", "10 km easy", true),
      ],
    },
    {
      id: "week-4",
      start: "2026-10-12",
      focus: "Strength",
      note: "More hills, and a longer tempo.",
      sessions: [
        session(4, "2026-10-12", "easy", "Easy run", "6 km, conversational", true),
        session(4, "2026-10-14", "intervals", "Hills", "10 × 60 s uphill · jog down", true),
        session(4, "2026-10-16", "tempo", "Tempo", "3.5 km at 4:10/km", true),
        session(4, "2026-10-18", "long", "Long run", "11 km easy", true),
      ],
    },
    {
      id: "week-5",
      start: "2026-10-19",
      focus: "Easier",
      note: "A lighter week to absorb the work, then a parkrun.",
      sessions: [
        session(5, "2026-10-19", "easy", "Easy run", "5 km, conversational", true),
        session(5, "2026-10-21", "easy", "Easy run", "5 km, with 6 × 20 s strides", true),
        session(5, "2026-10-24", "race", "Parkrun", "Run it hard", true),
      ],
    },
    {
      id: "week-6",
      start: "2026-10-26",
      focus: "Speed",
      note: "Two hard days, so keep the easy runs easy.",
      sessions: [
        session(6, "2026-10-26", "easy", "Easy run", "6 km, conversational", true),
        session(6, "2026-10-28", "intervals", "Intervals", "6 × 800 m at 3:50/km · 90 s jog · 2 km warm-up"),
        session(6, "2026-10-30", "tempo", "Tempo", "4 km at 4:05/km"),
        session(6, "2026-11-01", "long", "Long run", "12 km easy"),
      ],
    },
    {
      id: "week-7",
      start: "2026-11-02",
      focus: "Speed",
      note: "Longer reps at goal pace.",
      sessions: [
        session(7, "2026-11-02", "easy", "Easy run", "6 km, conversational"),
        session(7, "2026-11-04", "intervals", "Intervals", "5 × 1 km at 3:58/km · 2 min jog"),
        session(7, "2026-11-06", "tempo", "Tempo", "4.5 km at 4:05/km"),
        session(7, "2026-11-08", "long", "Long run", "12 km easy"),
      ],
    },
    {
      id: "week-8",
      start: "2026-11-09",
      focus: "Speed",
      note: "The hardest week of the block; sleep counts as training.",
      sessions: [
        session(8, "2026-11-09", "easy", "Easy run", "6 km, conversational"),
        session(8, "2026-11-11", "intervals", "Intervals", "3 × 1.6 km at 3:58/km · 3 min jog"),
        session(8, "2026-11-13", "tempo", "Tempo", "5 km at 4:05/km"),
        session(8, "2026-11-15", "long", "Long run", "13 km easy"),
      ],
    },
    {
      id: "week-9",
      start: "2026-11-16",
      focus: "Sharpen",
      note: "Less volume, same speed, and a parkrun to check where you are.",
      sessions: [
        session(9, "2026-11-16", "easy", "Easy run", "5 km, conversational"),
        session(9, "2026-11-18", "intervals", "Intervals", "6 × 400 m at 3:45/km · 90 s jog"),
        session(9, "2026-11-21", "race", "Parkrun", "Goal pace, 3:59/km, then hold on"),
      ],
    },
    {
      id: "week-10",
      start: "2026-11-23",
      focus: "Race",
      note: "Fresh legs: short and sharp, then the attempt on Saturday.",
      sessions: [
        session(10, "2026-11-23", "easy", "Easy run", "4 km, conversational"),
        session(10, "2026-11-25", "intervals", "Openers", "4 × 200 m quick · full recovery"),
        session(10, "2026-11-28", "race", "Sub-20 attempt", "Parkrun, 3:59/km from the start"),
      ],
    },
  ],
  results: [
    { id: "parkrun-oct-3", date: "2026-10-03", result: "21:02" },
    { id: "parkrun-oct-24", date: "2026-10-24", result: "20:41", note: "Windy" },
  ],
};
