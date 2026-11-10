// Remembers how busy the server is over time, and who joined and left, for the dashboard.
// It checks every 15 seconds while the game server is running and keeps 8 days of history.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAdmins } from './admins.js';
import { agentRequest } from './agent.js';
import { readCfg } from './cfg.js';
import { isSecondary } from './desktop.js';
import { findServerData, STATE_DIR } from './paths.js';
import { rememberIdentifiers } from './people.js';
import { getProcessState } from './processes.js';
import { replaceFileSync } from './retry.js';
import { getSettings } from './settings.js';

const STATS_FILE = path.join(STATE_DIR, 'stats.json');
const ACTIVITY_FILE = path.join(STATE_DIR, 'activity.json');
const POLL_MS = 15000;
export const BUCKET_MS = 5 * 60000;
const KEEP_SAMPLES = 8 * 24 * 12;
const KEEP_DAYS = 40;
const KEEP_ACTIVITY = 300;

export const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA');

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

let stats = null;
let activity = null;
let current = null;
let bucket = null;
let timer = null;
let polling = false;
let saveTimer = null;
let whitelistSyncedFor = null;

function loadAll() {
  if (stats) return;
  stats = readJson(STATS_FILE, {});
  stats.samples = Array.isArray(stats.samples) ? stats.samples : [];
  stats.days = stats.days && typeof stats.days === 'object' ? stats.days : {};
  stats.today = stats.today && typeof stats.today === 'object' ? stats.today : { day: dayKey(Date.now()), ids: [] };
  activity = readJson(ACTIVITY_FILE, []);
  if (!Array.isArray(activity)) activity = [];
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      replaceFileSync(STATS_FILE, JSON.stringify(stats));
      replaceFileSync(ACTIVITY_FILE, JSON.stringify(activity));
    } catch (err) { console.error('[cityhq] could not save stats:', err.message); }
  }, 2000);
}

/** Folds one reading into the running 5-minute bucket, closing buckets that have finished. */
export function addReading(state, now, players) {
  const start = now - (now % BUCKET_MS);
  if (state.bucket && state.bucket.start !== start) {
    state.samples.push([state.bucket.start, state.bucket.max]);
    if (state.samples.length > KEEP_SAMPLES) state.samples.splice(0, state.samples.length - KEEP_SAMPLES);
    state.bucket = null;
  }
  if (!state.bucket) state.bucket = { start, max: players };
  else state.bucket.max = Math.max(state.bucket.max, players);
}

/** Who joined and who left between two readings, keyed by license. */
export function diffPlayers(before, after) {
  const joined = [];
  const left = [];
  for (const [key, p] of after) if (!before.has(key)) joined.push(p);
  for (const [key, p] of before) if (!after.has(key)) left.push(p);
  return { joined, left };
}

/** Counts a player once per day, and keeps the day's peak. */
export function countDay(store, now, keys, online) {
  const day = dayKey(now);
  if (store.today.day !== day) store.today = { day, ids: [] };
  const entry = store.days[day] || (store.days[day] = { unique: 0, peak: 0 });
  for (const key of keys) {
    if (!store.today.ids.includes(key)) {
      store.today.ids.push(key);
      entry.unique = store.today.ids.length;
    }
  }
  entry.peak = Math.max(entry.peak, online);
  const days = Object.keys(store.days).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete store.days[old];
}

function record(kind, player) {
  activity.push({ t: Date.now(), kind, name: player.name, character: player.character || null });
  if (activity.length > KEEP_ACTIVITY) activity.splice(0, activity.length - KEEP_ACTIVITY);
}

/** Sends the whitelist to the server. Admins can always join, so their IDs go along too. */
export async function pushWhitelist() {
  const { whitelist } = getSettings();
  const ids = new Set((whitelist.entries || []).map((e) => e.id));
  const server = findServerData();
  if (server) {
    try { for (const admin of parseAdmins(await readCfg(server.cfgPath))) ids.add(admin.identifier); } catch { /* no cfg yet */ }
  }
  return agentRequest('/whitelist', { method: 'POST', body: { enabled: whitelist.enabled, ids: [...ids] } });
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    loadAll();
    const game = getProcessState().game;
    let players = null;
    if (game) {
      try { players = await agentRequest('/players', { timeoutMs: 3000 }); } catch { players = null; }
    }
    const now = Date.now();
    const state = { samples: stats.samples, bucket };
    addReading(state, now, players ? players.length : 0);
    bucket = state.bucket;

    if (players) {
      const next = new Map(players.map((p) => [p.license || `id:${p.id}`, { name: p.name, character: p.character?.trim() || null }]));
      if (current) {
        const { joined, left } = diffPlayers(current, next);
        joined.forEach((p) => record('join', p));
        left.forEach((p) => record('leave', p));
        if (joined.length) {
          agentRequest('/identifiers', { timeoutMs: 3000 }).then(rememberIdentifiers).catch(() => {});
        }
      } else if (players.length) {
        agentRequest('/identifiers', { timeoutMs: 3000 }).then(rememberIdentifiers).catch(() => {});
      }
      current = next;
      countDay(stats, now, [...next.keys()], players.length);
      if (whitelistSyncedFor !== game.pid) {
        whitelistSyncedFor = game.pid;
        pushWhitelist().catch(() => { whitelistSyncedFor = null; });
      }
    } else if (!game) {
      current = null;
    }
    saveSoon();
  } catch (err) {
    console.error('[cityhq] stats:', err.message);
  } finally {
    polling = false;
  }
}

export function startStats() {
  if (timer || isSecondary()) return;
  timer = setInterval(poll, POLL_MS);
  poll();
}

export function stopStats() {
  clearInterval(timer);
  timer = null;
}

/** Turns stored samples into an evenly spaced series, with gaps where nothing was recorded. */
export function series(samples, now, count, stepMs) {
  const end = now - (now % stepMs);
  const start = end - (count - 1) * stepMs;
  const out = Array.from({ length: count }, (_, i) => ({ t: start + i * stepMs, v: null }));
  for (const [t, v] of samples) {
    if (t < start || t > end + stepMs) continue;
    const i = Math.min(count - 1, Math.floor((t - start) / stepMs));
    out[i].v = out[i].v === null ? v : Math.max(out[i].v, v);
  }
  return out;
}

export function statsView() {
  loadAll();
  const now = Date.now();
  const samples = bucket ? [...stats.samples, [bucket.start, bucket.max]] : stats.samples;
  const yesterday = dayKey(now - 86400000);
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = dayKey(now - i * 86400000);
    week.push({ day, ...(stats.days[day] || { unique: 0, peak: 0 }) });
  }
  return {
    day: series(samples, now, 288, BUCKET_MS),
    week: series(samples, now, 168, 3600000),
    today: stats.days[dayKey(now)] || { unique: 0, peak: 0 },
    yesterday: stats.days[yesterday] || { unique: 0, peak: 0 },
    days: week,
    activity: activity.slice(-30).reverse(),
  };
}
