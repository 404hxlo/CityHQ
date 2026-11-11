// Finds a script's own documentation, so problem tips link to the author's instructions rather than
// to searches. Sources, best first: a docs link inside the error itself, links in the script's own
// files (fxmanifest, readme, config comments), the author's docs site learned from their other
// scripts, and QBCore's page for qb- scripts (checked once to exist, then remembered).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

const URL_RE = /https?:\/\/[^\s'"`<>)\]},]+/g;
// Links that are never documentation for the script itself.
const NOT_DOCS = /discord\.(gg|com)|tebex\.io|youtube\.com|youtu\.be|keymaster|portal\.cfx\.re|forum\.cfx\.re|fontawesome|toptal\.com|docs\.fivem\.net|imgur|\bcdn\.|workers\.dev|gist\.github|shields\.io|badge|\/issues\b|\/releases\b|\/download\/|\.zip$|\.(png|jpe?g|gif|webp|svg|mp3|ogg)$/i;
// A documentation site: docs.example.com, *.gitbook.io, readme.io, or a /docs or /wiki path.
const DOCS_HOST = /^https?:\/\/(docs?|wiki)\.|gitbook\.io|readme\.io|\/docs?(\/|$|#)|\/wiki(\/|$)|documentation/i;
// Well-known docs pages, used when they exist (checked once, like the QBCore ones).
const KNOWN_PAGES = {
  oxmysql: 'https://overextended.dev/docs/oxmysql',
  ox_lib: 'https://overextended.dev/docs/ox_lib',
  ox_target: 'https://overextended.dev/docs/ox_target',
  ox_inventory: 'https://overextended.dev/docs/ox_inventory',
};
const FILES = ['fxmanifest.lua', '__resource.lua', 'config.lua', 'shared/config.lua', 'config/config.lua', 'configs/config.lua', 'shared/sh_config.lua'];
const QB_PAGE = (name) => `https://qbcore.org/docs/qbcore-resources/${name}`;
export const QB_HOME = 'https://qbcore.org/docs/';
const CHECKED_FILE = path.join(STATE_DIR, 'doc-links.json');
const RECHECK_MS = 30 * 24 * 3600 * 1000;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const prefixOf = (name) => name.match(/^([a-z0-9]+)[-_]/i)?.[1]?.toLowerCase() || null;
const stripPrefix = (name) => name.replace(/^[a-z0-9]+[-_]/i, '');
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const clean = (url) => url.replace(/[.;:,]+$/, '').replace(/#$/, '');

/** Links in some text that could be documentation (never chat, store, video or image links). */
export function docLinksIn(text) {
  return [...new Set((String(text).match(URL_RE) || []).map(clean))].filter((u) => !NOT_DOCS.test(u));
}

/**
 * How likely a link is to be this script's own documentation. Links about another installed
 * script (a readme listing what it needs) score low; links naming this script on a docs site win.
 */
export function scoreLink(url, name, { otherNames = [], file = '', siteCount = 1 } = {}) {
  const u = norm(url);
  const full = norm(name);
  const bare = norm(stripPrefix(name));
  const github = url.match(/github\.com\/[^/]+\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i);
  if (github && norm(github[1]) !== full && norm(github[1]) !== bare) return -10;
  // A short leftover like "voice" (pma-voice) is too common a word to count as naming the script.
  const named = u.includes(full) || (bare.length >= 6 && u.includes(bare));
  const docsFile = /^(documentation|docs?)\b/i.test(path.basename(file));
  // A docs site that doesn't name the script only counts from a documentation file, or when the
  // readme links to it more than once (a passing mention of another product doesn't count).
  if (!named && !github && !(DOCS_HOST.test(url) && (docsFile || siteCount >= 2))) return -5;
  let score = 0;
  if (u.includes(full)) score += 5;
  else if (bare.length >= 6 && u.includes(bare)) score += 4;
  if (DOCS_HOST.test(url)) score += 3;
  if (github) score += 2;
  if (docsFile || /^(readme|install)/i.test(path.basename(file))) score += 1;
  const mentionsOther = otherNames.some((o) => o !== name && norm(o).length >= 5 && u.includes(norm(o)) && !u.includes(full));
  if (mentionsOther) score -= 6;
  return score;
}

/** The best documentation link among the ones found in a script's files, or null. */
export function bestLink(found, name, otherNames = []) {
  const perSite = new Map();
  for (const { url } of found) perSite.set(siteOf(url), (perSite.get(siteOf(url)) || 0) + 1);
  let best = null;
  for (const { url, file } of found) {
    const score = scoreLink(url, name, { otherNames, file, siteCount: perSite.get(siteOf(url)) });
    if (score >= 3 && (!best || score > best.score)) best = { url, score };
  }
  return best ? best.url : null;
}

/** The first word of a docs site's name: energy-fivem.gitbook.io -> "energy", docs.jgscripts.com -> "jgscripts". */
const siteWord = (site) => {
  const host = hostOf(site).replace(/^(docs?|wiki)\./, '');
  return host.split(/[.-]/)[0].toLowerCase();
};

/** An author's docs site from one of their links: the site, plus the space name on GitBook. */
export function siteOf(url) {
  try {
    const u = new URL(url);
    const first = u.pathname.split('/').filter(Boolean)[0];
    return u.host.endsWith('gitbook.io') && first ? `${u.origin}/${first}` : `${u.origin}/`;
  } catch { return null; }
}

async function readText(full) {
  try {
    const buf = await readFile(full);
    // Escrowed files are encrypted and hold nothing readable.
    return buf.subarray(0, 4).toString() === 'FXAP' ? '' : buf.toString('utf8');
  } catch { return ''; }
}

/** Every documentation-looking link in a script's own files, with the file it came from. */
export async function linksInResource(dir) {
  const files = [...FILES];
  try {
    for (const n of await readdir(dir)) if (/\.(md|txt)$/i.test(n)) files.push(n);
  } catch { /* unreadable folder */ }
  const found = [];
  const seen = new Set();
  for (const file of files) {
    for (const url of docLinksIn(await readText(path.join(dir, file)))) {
      if (!seen.has(url)) { seen.add(url); found.push({ url, file }); }
    }
  }
  return found;
}

// ---- remembering which synthesized links really exist (a file in the app's state folder) ----
let saved = null;
export const fileLinkCache = {
  async get(url) {
    if (!saved) { try { saved = JSON.parse(await readFile(CHECKED_FILE, 'utf8')); } catch { saved = {}; } }
    return saved[url];
  },
  async set(url, value) {
    saved[url] = value;
    try {
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(CHECKED_FILE, JSON.stringify(saved, null, 1));
    } catch { /* only a cache */ }
  },
};

/** True or false, or null when it couldn't be checked (offline). Each link is checked once a month. */
async function pageExists(url, fetcher, cache) {
  const hit = await cache.get(url);
  if (hit && Date.now() - hit.at < RECHECK_MS) return hit.ok;
  try {
    const r = await fetcher(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'CityHQ link check' } });
    const value = { ok: r.status < 400, at: Date.now() };
    await cache.set(url, value);
    return value.ok;
  } catch {
    return null;
  }
}

/**
 * Documentation for every installed script: { name -> { url, label, source } }.
 * `source` is 'own' (its files), 'author' (the author's site, from their other scripts) or 'qbcore'.
 */
export async function buildDocIndex(disk, { fetcher = fetch, cache = fileLinkCache } = {}) {
  const names = disk.map((r) => r.name);
  // Once one check fails (offline), the rest use what's remembered instead of each waiting 6 s.
  let offline = false;
  const exists = async (url) => {
    if (offline) return (await cache.get(url))?.ok ?? null;
    const ok = await pageExists(url, fetcher, cache);
    if (ok === null) offline = true;
    return ok;
  };
  const own = new Map();
  const links = new Map();
  for (const r of disk) {
    const found = await linksInResource(r.dir);
    links.set(r.name, found);
    const url = bestLink(found, r.name, names);
    if (url) own.set(r.name, url);
  }
  // An author's docs site, learned from their scripts that link to one: by the scripts' shared
  // name prefix (prompt_*), or by the site's own name (energy-fivem.gitbook.io for energy_*).
  const sites = new Map();
  const allSites = new Map();
  const note = (key, site) => {
    if (!sites.has(key)) sites.set(key, new Map());
    sites.get(key).set(site, (sites.get(key).get(site) || 0) + 1);
  };
  for (const r of disk) {
    const prefix = prefixOf(r.name);
    for (const { url } of links.get(r.name)) {
      if (!DOCS_HOST.test(url) || /github\.com/i.test(url)) continue;
      const site = siteOf(url);
      if (!site) continue;
      if (prefix) note(prefix, site);
      allSites.set(site, (allSites.get(site) || 0) + 1);
    }
  }
  const index = new Map();
  for (const r of disk) {
    const known = KNOWN_PAGES[r.name];
    if (known && await exists(known)) {
      index.set(r.name, { url: known, label: `${r.name} documentation`, source: 'own' });
      continue;
    }
    const mine = own.get(r.name);
    if (mine) {
      index.set(r.name, { url: mine, label: /github\.com/i.test(mine) ? `${r.name} on GitHub` : `${r.name} documentation`, source: 'own' });
      continue;
    }
    const prefix = prefixOf(r.name);
    if (prefix && prefix !== 'qb' && prefix.length >= 2 && !sites.has(prefix)) {
      for (const [site, count] of allSites) if (siteWord(site).startsWith(prefix)) note(prefix, site, count);
    }
    if (prefix === 'qb') {
      const ok = await exists(QB_PAGE(r.name));
      index.set(r.name, ok
        ? { url: QB_PAGE(r.name), label: `${r.name} documentation (QBCore)`, source: 'qbcore' }
        : { url: QB_HOME, label: 'QBCore documentation', source: 'qbcore' });
      continue;
    }
    const candidates = prefix && sites.get(prefix);
    if (candidates?.size) {
      const site = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0][0];
      index.set(r.name, { url: site, label: `Docs from the author of ${r.name} (${hostOf(site)})`, source: 'author' });
    }
  }
  return { index, links };
}

/** A GitHub repository for a missing script, when another script's files link to it. */
export function repoFor(dependency, found = []) {
  for (const { url } of found) {
    const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (m && norm(m[2]) === norm(dependency)) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}

/**
 * The links a problem shows: a docs page named in the error, then the script's own docs, then
 * reference docs for that kind of error. YouTube searches are gone; a forum search stays only
 * when the script has no documentation of its own.
 */
export function withDocLinks(problem, docs) {
  const reference = problem.links.filter((l) => l.kind === 'doc');
  const search = problem.links.find((l) => l.kind === 'forum');
  const out = [];
  const errorPage = docLinksIn(problem.raw).find((u) => DOCS_HOST.test(u) && !/\.\.\.$/.test(u));
  if (errorPage) out.push({ kind: 'doc', label: `${problem.resource || 'Its'} docs about this error`, url: errorPage });
  const mine = problem.resource ? docs.get(problem.resource) : null;
  if (mine && mine.url !== errorPage) out.push({ kind: 'doc', label: mine.label, url: mine.url });
  const own = out.length > 0;
  out.push(...reference.slice(0, own ? 1 : reference.length));
  if (!own && search) {
    out.push(problem.resource
      ? { kind: 'forum', label: `Search the FiveM forum for ${problem.resource}`, url: `https://forum.cfx.re/search?q=${encodeURIComponent(problem.resource)}` }
      : search);
  }
  const seen = new Set();
  return out.filter((l) => !seen.has(l.url) && seen.add(l.url));
}

