#!/usr/bin/env node
// Builds dist/contrib-stats.svg and dist/streak.svg from the GitHub contribution calendar.
// Runs in GitHub Actions with the default GITHUB_TOKEN. Private contributions are
// counted because "Include private contributions on my profile" is enabled, so the
// numbers match the contribution graph on the profile page (public + private).
import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const login = process.env.GH_USER;
if (!token || !login) {
  console.error("GITHUB_TOKEN and GH_USER are required");
  process.exit(1);
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "contrib-card",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors || !body.data?.user) {
    throw new Error(`GraphQL error: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data.user;
}

const CALENDAR = `contributionCalendar {
  totalContributions
  weeks { contributionDays { date contributionCount } }
}`;

// Last 12 months (GitHub's default window, the same one the profile graph shows).
const lastYear = await graphql(
  `query ($login: String!) {
    user(login: $login) {
      contributionsCollection { contributionYears ${CALENDAR} }
    }
  }`,
  { login },
);
const yearCalendar = lastYear.contributionsCollection.contributionCalendar;
const yearDays = yearCalendar.weeks.flatMap((w) => w.contributionDays);
if (yearDays.length === 0) {
  console.error("Empty contribution calendar");
  process.exit(1);
}

// Whole history, one calendar per contribution year, for the streak card.
const byDate = new Map();
for (const year of lastYear.contributionsCollection.contributionYears) {
  const u = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) { ${CALENDAR} }
      }
    }`,
    { login, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
  );
  for (const w of u.contributionsCollection.contributionCalendar.weeks) {
    for (const d of w.contributionDays) byDate.set(d.date, d.contributionCount);
  }
}
const today = yearDays[yearDays.length - 1].date;
const allDays = [...byDate.entries()]
  .filter(([date]) => date <= today)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([date, contributionCount]) => ({ date, contributionCount }));

// ---- numbers -------------------------------------------------------------

const total12m = yearCalendar.totalContributions;
const activeDays = yearDays.filter((d) => d.contributionCount > 0).length;
const best = yearDays.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), yearDays[0]);
const weekly = yearCalendar.weeks.map((w) =>
  w.contributionDays.reduce((s, d) => s + d.contributionCount, 0),
);
const maxWeek = Math.max(1, ...weekly);

const totalAll = allDays.reduce((s, d) => s + d.contributionCount, 0);
const firstDay = allDays.find((d) => d.contributionCount > 0)?.date ?? today;

let longest = { length: 0, start: null, end: null };
let run = { length: 0, start: null };
for (const d of allDays) {
  if (d.contributionCount > 0) {
    if (run.length === 0) run.start = d.date;
    run.length++;
    if (run.length > longest.length) longest = { length: run.length, start: run.start, end: d.date };
  } else {
    run = { length: 0, start: null };
  }
}

// Current streak counts back from the last day. A zero on the last day (today, UTC)
// does not break the streak yet, the same rule the streak cards use.
let current = { length: 0, start: null, end: null };
{
  let i = allDays.length - 1;
  if (allDays[i].contributionCount === 0) i--;
  if (i >= 0 && allDays[i].contributionCount > 0) {
    current.end = allDays[i].date;
    for (; i >= 0 && allDays[i].contributionCount > 0; i--) {
      current.length++;
      current.start = allDays[i].date;
    }
  }
}

// ---- formatting ----------------------------------------------------------

const fmt = (n) => n.toLocaleString("en-US");
const thisYear = today.slice(0, 4);
const dayLabel = (iso, withYear = iso.slice(0, 4) !== thisYear) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const range = (s) => (s.length === 0 ? "No streak yet" : `${dayLabel(s.start)} - ${dayLabel(s.end)}`);

const FONT = "'Segoe UI', Ubuntu, Sans-Serif";
const BG = "#0d1117";
const ACCENT = "#58a6ff";
const TEXT = "#c9d1d9";
const MUTED = "#8b949e";
const LINE = "#30363d";

// ---- card 1: contributions in the last 12 months -------------------------

const rows = [
  ["Total contributions", fmt(total12m)],
  ["Active days", fmt(activeDays)],
  ["Longest streak", plural(longest.length, "day")],
  ["Current streak", plural(current.length, "day")],
  ["Best day", `${fmt(best.contributionCount)} on ${dayLabel(best.date)}`],
];

const W1 = 420;
const H1 = 165;
const chart = { x: 252, y: 58, w: 143, h: 78 };
const slot = chart.w / weekly.length;
const barW = Math.max(1, slot * 0.72);

const bars = weekly
  .map((v, idx) => {
    const h = v === 0 ? 1 : Math.max(2, (v / maxWeek) * chart.h);
    const x = (chart.x + idx * slot).toFixed(2);
    const y = (chart.y + chart.h - h).toFixed(2);
    const opacity = v === 0 ? 0.25 : 0.55 + 0.45 * (v / maxWeek);
    return `<rect x="${x}" y="${y}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${ACCENT}" fill-opacity="${opacity.toFixed(2)}"/>`;
  })
  .join("\n    ");

const rowSvg = rows
  .map(([label, value], idx) => {
    const y = 64 + idx * 19;
    return `<text x="25" y="${y}" class="label">${label}</text>
    <text x="228" y="${y}" class="value" text-anchor="end">${value}</text>`;
  })
  .join("\n    ");

const statsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W1}" height="${H1}" viewBox="0 0 ${W1} ${H1}" role="img" aria-labelledby="title desc">
  <title id="title">Contributions in the last 12 months</title>
  <desc id="desc">${fmt(total12m)} contributions, ${fmt(activeDays)} active days, longest streak ${plural(longest.length, "day")}, current streak ${plural(current.length, "day")}.</desc>
  <style>
    .header { font: 600 17px ${FONT}; fill: ${ACCENT} }
    .label { font: 400 13px ${FONT}; fill: ${TEXT} }
    .value { font: 700 13px ${FONT}; fill: ${TEXT} }
    .muted { font: 400 10px ${FONT}; fill: ${MUTED} }
  </style>
  <rect width="${W1}" height="${H1}" rx="4.5" fill="${BG}"/>
  <text x="25" y="33" class="header">Contributions · last 12 months</text>
  <g>
    ${rowSvg}
  </g>
  <g>
    <line x1="${chart.x}" y1="${chart.y + chart.h + 0.5}" x2="${chart.x + chart.w}" y2="${chart.y + chart.h + 0.5}" stroke="${LINE}" stroke-width="1"/>
    ${bars}
    <text x="${chart.x + chart.w}" y="${chart.y + chart.h + 14}" class="muted" text-anchor="end">per week · public + private</text>
  </g>
</svg>
`;

// ---- card 2: streak (total, current streak, longest streak) --------------

const W2 = 495;
const H2 = 195;
const col = [W2 / 6, W2 / 2, (5 * W2) / 6];
const ringY = 88;
const ringR = 40;
const circumference = (2 * Math.PI * ringR).toFixed(2);

const streakSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}" role="img" aria-labelledby="title2 desc2">
  <title id="title2">Contribution streak</title>
  <desc id="desc2">${fmt(totalAll)} total contributions since ${dayLabel(firstDay, true)}, current streak ${plural(current.length, "day")}, longest streak ${plural(longest.length, "day")}.</desc>
  <style>
    .big { font: 700 28px ${FONT}; fill: ${ACCENT} }
    .ring-num { font: 700 28px ${FONT}; fill: ${TEXT} }
    .side { font: 400 14px ${FONT}; fill: ${TEXT} }
    .side-bold { font: 700 14px ${FONT}; fill: ${TEXT} }
    .date { font: 400 12px ${FONT}; fill: ${MUTED} }
    .ring { stroke-dasharray: ${circumference}; stroke-dashoffset: ${circumference}; animation: ring 1.2s ease-out forwards }
    @keyframes ring { to { stroke-dashoffset: 0 } }
  </style>
  <rect width="${W2}" height="${H2}" rx="4.5" fill="${BG}"/>
  <line x1="${W2 / 3}" y1="30" x2="${W2 / 3}" y2="${H2 - 30}" stroke="${LINE}" stroke-width="1"/>
  <line x1="${(2 * W2) / 3}" y1="30" x2="${(2 * W2) / 3}" y2="${H2 - 30}" stroke="${LINE}" stroke-width="1"/>

  <text x="${col[0]}" y="84" class="big" text-anchor="middle">${fmt(totalAll)}</text>
  <text x="${col[0]}" y="118" class="side" text-anchor="middle">Total Contributions</text>
  <text x="${col[0]}" y="142" class="date" text-anchor="middle">${dayLabel(firstDay, true)} - Present</text>

  <circle cx="${col[1]}" cy="${ringY}" r="${ringR}" fill="none" stroke="${ACCENT}" stroke-opacity="0.2" stroke-width="5"/>
  <circle class="ring" cx="${col[1]}" cy="${ringY}" r="${ringR}" fill="none" stroke="${ACCENT}" stroke-width="5" stroke-linecap="round" transform="rotate(-90 ${col[1]} ${ringY})"/>
  <g transform="translate(${col[1] - 9} ${ringY - ringR - 22}) scale(0.75)">
    <path d="M12 2c1.2 4.6 6 6 6 11.5A6 6 0 0 1 6 13.5c0-1.9.7-3.4 1.7-4.6.3 1.5 1.2 2.6 2.4 3.1C9.6 9 10.6 5.4 12 2z" fill="${ACCENT}"/>
  </g>
  <text x="${col[1]}" y="${ringY + 10}" class="ring-num" text-anchor="middle">${current.length}</text>
  <text x="${col[1]}" y="152" class="side-bold" text-anchor="middle">Current Streak</text>
  <text x="${col[1]}" y="172" class="date" text-anchor="middle">${range(current)}</text>

  <text x="${col[2]}" y="84" class="big" text-anchor="middle">${longest.length}</text>
  <text x="${col[2]}" y="118" class="side" text-anchor="middle">Longest Streak</text>
  <text x="${col[2]}" y="142" class="date" text-anchor="middle">${range(longest)}</text>
</svg>
`;

await mkdir("dist", { recursive: true });
await writeFile("dist/contrib-stats.svg", statsSvg);
await writeFile("dist/streak.svg", streakSvg);
console.log(
  `contrib-stats.svg: total12m=${total12m} activeDays=${activeDays} best=${best.contributionCount}@${best.date}`,
);
console.log(
  `streak.svg: totalAll=${totalAll} since=${firstDay} current=${current.length} (${current.start}..${current.end}) longest=${longest.length} (${longest.start}..${longest.end})`,
);
