#!/usr/bin/env node
// Builds assets/top-langs.svg: languages by bytes of code across ALL owned repositories,
// public and private, forks and archived repos excluded.
//
// The workflow token can only see public repositories, so this script is run by hand
// with a token that can read the private ones and the result is committed:
//   GITHUB_TOKEN="$(gh auth token)" GH_USER=<login> node scripts/langs-card.mjs
import { mkdir, writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const login = process.env.GH_USER;
if (!token || !login) {
  console.error("GITHUB_TOKEN and GH_USER are required");
  process.exit(1);
}

const query = `query ($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isArchived
        languages(first: 30, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const bytes = new Map();
const colors = new Map();
let repos = 0;
let after = null;
for (;;) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "langs-card",
    },
    body: JSON.stringify({ query, variables: { login, after } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors || !body.data?.user) {
    console.error("GraphQL error:", JSON.stringify(body.errors ?? body));
    process.exit(1);
  }
  const page = body.data.user.repositories;
  for (const repo of page.nodes) {
    if (repo.isArchived) continue;
    repos++;
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
      if (node.color) colors.set(node.name, node.color);
    }
  }
  if (!page.pageInfo.hasNextPage) break;
  after = page.pageInfo.endCursor;
}

const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0);
if (totalBytes === 0) {
  console.error("No language data");
  process.exit(1);
}
const sorted = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
const top = sorted.slice(0, 8).map(([name, size]) => ({
  name,
  pct: (size / totalBytes) * 100,
  color: colors.get(name) ?? "#8b949e",
}));

const FONT = "'Segoe UI', Ubuntu, Sans-Serif";
const W = 300;
const H = 165;
const barX = 25;
const barW = W - 50;

let offset = 0;
const barSegments = top
  .map((l) => {
    const w = (l.pct / 100) * barW;
    const seg = `<rect x="${(barX + offset).toFixed(2)}" y="46" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
    offset += w;
    return seg;
  })
  .join("\n    ");

const items = top
  .map((l, i) => {
    const colX = i % 2 === 0 ? 25 : 155;
    const y = 76 + Math.floor(i / 2) * 20;
    return `<circle cx="${colX + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
    <text x="${colX + 16}" y="${y}" class="lang">${l.name} ${l.pct.toFixed(2)}%</text>`;
  })
  .join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Most used languages</title>
  <desc id="desc">Share of code by language across ${repos} repositories, public and private: ${top.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(", ")}.</desc>
  <style>
    .header { font: 600 17px ${FONT}; fill: #58a6ff }
    .lang { font: 400 11px ${FONT}; fill: #c9d1d9 }
    .muted { font: 400 10px ${FONT}; fill: #8b949e }
  </style>
  <rect width="${W}" height="${H}" rx="4.5" fill="#0d1117"/>
  <text x="25" y="33" class="header">Most Used Languages</text>
  <mask id="bar"><rect x="${barX}" y="46" width="${barW}" height="8" rx="4" fill="#fff"/></mask>
  <g mask="url(#bar)">
    ${barSegments}
  </g>
  <g>
    ${items}
  </g>
  <text x="${W - 25}" y="${H - 10}" class="muted" text-anchor="end">${repos} repos · public + private</text>
</svg>
`;

await mkdir("assets", { recursive: true });
await writeFile("assets/top-langs.svg", svg);
console.log(`top-langs.svg: repos=${repos} ${top.map((l) => `${l.name}=${l.pct.toFixed(1)}%`).join(" ")}`);
