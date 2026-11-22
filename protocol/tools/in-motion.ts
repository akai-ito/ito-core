// Samples of 0.19's kinds, fictional, dated around a given day: a role in the career pipeline, a hybrid
// training block in its first week, a project, and a running goal that ended unmet. The demo engine fills In
// motion with them, so the app shows every shape.

type Fields = Readonly<Record<string, unknown>>;

const dayMs = 24 * 60 * 60 * 1000;

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

// The Monday of the week a moment falls in, as a day.
const mondayOf = (at: number): number => {
  const day = new Date(at).getUTCDay();
  const midnight = Date.parse(`${dayOf(at)}T00:00:00.000Z`);
  return midnight - ((day + 6) % 7) * dayMs;
};

export const roleId = "northwind";

export const roleContent = (now: number): Fields => ({
  org: "Northwind",
  role: "Software Engineer, Agents",
  where: "London",
  stage: "interviewing",
  stages: { lead: dayOf(now - 19 * dayMs), talking: dayOf(now - 9 * dayMs), interviewing: dayOf(now - 2 * dayMs) },
  next: {
    text: "Virtual 1 · Python PR review",
    at: `${dayOf(now + 16 * dayMs)}T14:00`,
    end: `${dayOf(now + 16 * dayMs)}T15:15`,
    detail: "Video, with an engineer from the agents team",
    link: { label: "The invite", url: "https://northwind.example/careers/invite" },
  },
  rounds: [
    { id: "recruiter", title: "Recruiter", status: "done" },
    { id: "virtual-1", title: "Virtual 1", status: "next", at: `${dayOf(now + 16 * dayMs)}T14:00` },
    { id: "virtual-2", title: "Virtual 2", status: "planned" },
    { id: "on-site", title: "On site", status: "planned" },
  ],
  facts: [
    { id: "through", label: "Through", value: "Applied on their site · recruiter Tess Harlow" },
    { id: "where", label: "Where", value: "London, three days in the office" },
    { id: "pay", label: "Pay", value: "£120–150k and equity, said on the call" },
  ],
  notes: [
    {
      id: "invite",
      tag: "source",
      text: "The invite from their recruiting team: 60 minutes, video.",
      at: dayOf(now - 2 * dayMs),
    },
    { id: "length", tag: "unsure", text: "The invite says 60 minutes; Tess said about an hour and a quarter." },
    { id: "format", tag: "guess", text: "Likely a shared repo with a planted bug, reviewed out loud." },
    {
      id: "pay-source",
      tag: "source",
      text: "The pay range is from your notes on Tess's call. Nothing in writing yet.",
    },
    { id: "ids", tag: "ids", text: "calendar 7c1e9b2a@northwind.example · motion northwind" },
  ],
});

export const quietRoles: readonly { readonly id: string; readonly content: Fields; readonly summary: string }[] = [
  {
    id: "quillmoor",
    summary: "On the recruiter since last week",
    content: {
      org: "Quillmoor",
      role: "ML Engineer",
      stage: "talking",
      stages: {},
      waiting_on: { who: "the recruiter", since: "2026-11-14" },
    },
  },
  {
    id: "halcyon-labs",
    summary: "A lead from a friend; nothing sent yet",
    content: { org: "Halcyon Labs", role: "Applied AI Engineer", stage: "lead", stages: {} },
  },
];

export const hybridId = "hybrid-restart";

// A hybrid block's first week, around now: Monday's lift and Tuesday's run done, Wednesday's lift, Thursday's run
// moved to Saturday after a short night, and a second week planned.
export const hybridContent = (now: number): Fields => {
  const monday = mondayOf(now);
  const day = (offset: number): string => dayOf(monday + offset * dayMs);
  return {
    plan: "2 lifts and 2 easy runs a week",
    hours_a_week: 7,
    weeks: [
      {
        id: "week-1",
        start: day(0),
        focus: "Restart",
        sessions: [
          {
            id: "w1-mon",
            date: day(0),
            kind: "lift",
            title: "Lift A",
            plan: "Squat 3×5 at 80 · bench 3×5 at 60 · row 3×8 at 50",
            planned: { minutes: 60 },
            done: true,
            result: {
              source: "you",
              minutes: 60,
              effort: 7,
              sets: [
                { exercise: "Squat", sets: 3, reps: 5, load_kg: 80 },
                { exercise: "Bench", sets: 3, reps: 5, load_kg: 60, note: "last set stopped at 4" },
              ],
            },
          },
          {
            id: "w1-tue",
            date: day(1),
            kind: "run",
            title: "Easy run",
            plan: "30 min easy · heart under 150",
            planned: {
              minutes: 30,
              distance_km: 5,
              pace: { from: "6:00", to: "6:20" },
              heart_under: 150,
              effort: "easy",
            },
            done: true,
            result: {
              source: "watch",
              at: "07:12",
              minutes: 31.2,
              distance_km: 5.2,
              pace: "5:59",
              heart_avg: 146,
              heart_max: 158,
              zones: [
                { zone: 1, minutes: 4 },
                { zone: 2, minutes: 21 },
                { zone: 3, minutes: 5 },
                { zone: 4, minutes: 1 },
              ],
              splits: ["6:08", "6:01", "5:57", "5:55", "5:54"],
              felt: "easy, heavy legs at first",
            },
            line: "Thirty easy minutes, on plan, and a touch quick.",
            changes_next: "Next week's runs 35 → 40 min",
            notes: [{ id: "w1-tue-watch", tag: "source", text: "Workout record from the Watch, 07:12 to 07:43." }],
          },
          {
            id: "w1-wed",
            date: day(2),
            kind: "lift",
            title: "Lift B",
            plan: "Squat 3×5 at 82.5 · press 3×5 at 40",
            planned: { minutes: 60 },
            done: true,
            result: { source: "you", effort: 6, sets: [{ exercise: "Squat", sets: 3, reps: 5, load_kg: 82.5 }] },
          },
          {
            id: "w1-sat",
            date: day(5),
            kind: "run",
            title: "Easy run",
            plan: "35 min easy · heart under 150",
            planned: { minutes: 35, heart_under: 150, effort: "easy" },
            moved_from: day(3),
            done: false,
          },
        ],
      },
      {
        id: "week-2",
        start: day(7),
        sessions: [
          { id: "w2-mon", date: day(7), kind: "lift", title: "Lift A", planned: { minutes: 60 }, done: false },
          { id: "w2-tue", date: day(8), kind: "run", title: "Easy run", planned: { minutes: 40 }, done: false },
          { id: "w2-thu", date: day(10), kind: "lift", title: "Lift B", planned: { minutes: 60 }, done: false },
          { id: "w2-sat", date: day(12), kind: "run", title: "Easy run", planned: { minutes: 40 }, done: false },
        ],
      },
    ],
    reasons: [
      { id: "moved-thu", date: day(3), change: "Moved Thursday's run to Saturday", because: "5h sleep on Wednesday" },
      { id: "bench-down", date: day(0), change: "Lift A bench down 2.5 kg", because: "last set stopped at 4" },
    ],
  };
};

export const projectId = "ito-lived-in";

export const projectContent: Fields = {
  aim: "Chat threads, a better In motion, and honest freshness",
  parts: [
    { id: "design-1", title: "Design round 1 · chat", status: "done" },
    { id: "design-2", title: "Design round 2 · In motion", status: "doing" },
    { id: "design-3", title: "Design round 3 · files", status: "planned" },
    { id: "design-4", title: "Design round 4 · Library", status: "planned" },
  ],
};

export const springId = "spring-5k";

// A goal towards a 5K time that ended unmet, with the results that happened.
export const springContent: Fields = {
  goal: { title: "Sub-20 5K", target: "20:00", by: "2026-11-09" },
  weeks: [{ id: "week-1", start: "2026-09-14", sessions: [] }],
  results: [
    { id: "trial-1", date: "2026-09-15", result: "23:40" },
    { id: "trial-2", date: "2026-10-06", result: "22:48" },
    { id: "trial-3", date: "2026-10-27", result: "22:10" },
  ],
};

export const springStory: Fields = {
  happened:
    "You trained five of the eight weeks. Interviews took October's evenings, and the race was never booked, so " +
    "nothing held the date.",
  learnt: [
    "Four runs a week didn't survive a month of interviews. Two did.",
    "A booked race is what makes the date real.",
  ],
  followed: "A fresh hybrid plan",
  followed_by: hybridId,
};
