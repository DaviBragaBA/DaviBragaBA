#!/usr/bin/env node
// Builds dist/contrib-stats.svg from the GitHub contribution calendar.
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

const query = `query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const res = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "contrib-card",
  },
  body: JSON.stringify({ query, variables: { login } }),
});
const body = await res.json();
if (!res.ok || body.errors || !body.data?.user) {
  console.error("GraphQL error:", JSON.stringify(body.errors ?? body));
  process.exit(1);
}

const calendar = body.data.user.contributionsCollection.contributionCalendar;
const days = calendar.weeks.flatMap((w) => w.contributionDays);
if (days.length === 0) {
  console.error("Empty contribution calendar");
  process.exit(1);
}

const total = calendar.totalContributions;
const activeDays = days.filter((d) => d.contributionCount > 0).length;
const best = days.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), days[0]);

let longest = 0;
let run = 0;
for (const d of days) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  if (run > longest) longest = run;
}

// Current streak counts back from the last day. A zero on the last day (today, UTC)
// does not break the streak yet, the same rule the streak cards use.
let current = 0;
let i = days.length - 1;
if (days[i].contributionCount === 0) i--;
for (; i >= 0 && days[i].contributionCount > 0; i--) current++;

const weekly = calendar.weeks.map((w) =>
  w.contributionDays.reduce((s, d) => s + d.contributionCount, 0),
);
const maxWeek = Math.max(1, ...weekly);

const fmt = (n) => n.toLocaleString("en-US");
const dayLabel = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const rows = [
  ["Total contributions", fmt(total)],
  ["Active days", fmt(activeDays)],
  ["Longest streak", plural(longest, "day")],
  ["Current streak", plural(current, "day")],
  ["Best day", `${fmt(best.contributionCount)} on ${dayLabel(best.date)}`],
];

// Layout: 420x165, same height as the other cards in the README.
const W = 420;
const H = 165;
const chart = { x: 252, y: 58, w: 143, h: 78 };
const slot = chart.w / weekly.length;
const barW = Math.max(1, slot * 0.72);

const bars = weekly
  .map((v, idx) => {
    const h = v === 0 ? 1 : Math.max(2, (v / maxWeek) * chart.h);
    const x = (chart.x + idx * slot).toFixed(2);
    const y = (chart.y + chart.h - h).toFixed(2);
    const opacity = v === 0 ? 0.25 : 0.55 + 0.45 * (v / maxWeek);
    return `<rect x="${x}" y="${y}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="#58a6ff" fill-opacity="${opacity.toFixed(2)}"/>`;
  })
  .join("\n    ");

const rowSvg = rows
  .map(([label, value], idx) => {
    const y = 64 + idx * 19;
    return `<text x="25" y="${y}" class="label">${label}</text>
    <text x="228" y="${y}" class="value" text-anchor="end">${value}</text>`;
  })
  .join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Contributions in the last 12 months</title>
  <desc id="desc">${fmt(total)} contributions, ${fmt(activeDays)} active days, longest streak ${plural(longest, "day")}, current streak ${plural(current, "day")}.</desc>
  <style>
    .header { font: 600 17px 'Segoe UI', Ubuntu, Sans-Serif; fill: #58a6ff }
    .label { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #c9d1d9 }
    .value { font: 700 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #c9d1d9 }
    .muted { font: 400 10px 'Segoe UI', Ubuntu, Sans-Serif; fill: #8b949e }
  </style>
  <rect width="${W}" height="${H}" rx="4.5" fill="#0d1117"/>
  <text x="25" y="33" class="header">Contributions · last 12 months</text>
  <g>
    ${rowSvg}
  </g>
  <g>
    <line x1="${chart.x}" y1="${chart.y + chart.h + 0.5}" x2="${chart.x + chart.w}" y2="${chart.y + chart.h + 0.5}" stroke="#30363d" stroke-width="1"/>
    ${bars}
    <text x="${chart.x + chart.w}" y="${chart.y + chart.h + 14}" class="muted" text-anchor="end">per week · public + private</text>
  </g>
</svg>
`;

await mkdir("dist", { recursive: true });
await writeFile("dist/contrib-stats.svg", svg);
console.log(
  `contrib-stats.svg: total=${total} activeDays=${activeDays} longest=${longest} current=${current} best=${best.contributionCount}@${best.date}`,
);
