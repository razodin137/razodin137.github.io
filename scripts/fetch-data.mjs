#!/usr/bin/env node
/*
 * Fetches the public repo list for every owner in OWNERS and writes data.json
 * — the static file index.html renders from, so a page visit never touches
 * api.github.com (no 60/hr-per-IP unauthenticated limit for anyone, bots
 * included). Runs inside .github/workflows/refresh-data.yml, where the
 * workflow's GITHUB_TOKEN authenticates the calls (15,000 req/hr).
 *
 * Requires Node >= 18 (global fetch) and a GITHUB_TOKEN env var.
 *
 * data.json is only rewritten when the repo list actually changed, OR when the
 * fetchedAt stamp is older than KEEPALIVE_MS (~1/day). The periodic stamp bump
 * keeps commits flowing to the repo, which keeps GitHub from auto-disabling
 * the scheduled workflow after 60 days of repository "inactivity".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// keep in sync with the OWNERS array in index.html
const OWNERS = ["razodin137", "mvvk-space"];
const KEEPALIVE_MS = 20 * 60 * 60 * 1000; // bump fetchedAt at least once a day
const DATA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data.json");
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("GITHUB_TOKEN env var is required (the workflow provides it automatically).");
  process.exit(1);
}

const headers = {
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${TOKEN}`,
  "User-Agent": "razodin137.github.io-data-refresh",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function gh(pathname, attempt = 0) {
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  // transient failures (rate-limit-style 403/429, 5xx) — retry with backoff
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const wait = retryAfter * 1000 + 5000 * (attempt + 1);
    console.warn(`GET ${pathname} -> ${res.status}; retry ${attempt + 1}/3 in ${Math.round(wait / 1000)}s`);
    await new Promise(r => setTimeout(r, wait));
    return gh(pathname, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function listRepos(owner) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/users/${owner}/repos?per_page=100&sort=pushed&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// flatten to the exact shape index.html's toRepo() expects
function toEntry(owner, r) {
  return {
    owner,
    name: r.name,
    description: r.description ?? null,
    homepage: r.homepage && r.homepage.trim() ? r.homepage.trim() : null,
    has_pages: r.has_pages,
    html_url: r.html_url,
    language: r.language ?? null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    pushed_at: r.pushed_at,
    created_at: r.created_at,
    fork: r.fork === true,
  };
}

const repos = [];
for (const owner of OWNERS) {
  const raw = await listRepos(owner);
  console.log(`${owner}: ${raw.length} public repos`);
  for (const r of raw) repos.push(toEntry(owner, r));
}
if (!repos.length) {
  console.error("no repos returned at all — refusing to wipe data.json");
  process.exit(1);
}

// deterministic order: index.html section order, then most-recent push, then name
const rank = o => OWNERS.indexOf(o);
repos.sort((a, b) =>
  rank(a.owner) - rank(b.owner) ||
  new Date(b.pushed_at) - new Date(a.pushed_at) ||
  a.name.localeCompare(b.name)
);

let skip = false;
try {
  const prev = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const sameData = JSON.stringify(prev.repos) === JSON.stringify(repos);
  const stampAge = Date.now() - new Date(prev.fetchedAt).getTime();
  if (sameData && stampAge < KEEPALIVE_MS) skip = true; // nothing new, stamp fresh
} catch { /* no previous file (or unreadable) — write */ }

if (skip) {
  console.log("data.json already current and stamp fresh — nothing to do");
  process.exit(0);
}

fs.writeFileSync(DATA_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), repos }, null, 2) + "\n");
console.log(`wrote data.json — ${repos.length} repos total (${repos.filter(r => r.has_pages).length} with pages)`);