// A short history of what the app did and noticed on its own, shown on the Overview page.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { replaceFileSync } from './retry.js';

const FILE = path.join(STATE_DIR, 'events.json');
const MAX_EVENTS = 100;
const listeners = new Set();
let events = null;

function load() {
  if (events) return events;
  events = [];
  if (existsSync(FILE)) {
    try { events = JSON.parse(readFileSync(FILE, 'utf8')); } catch { events = []; }
  }
  return events;
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true });
  replaceFileSync(FILE, JSON.stringify(events, null, 1));
}

/** level: "alert" needs attention and notifies the desktop; "info" is only history. */
export function recordEvent({ level = 'info', title, detail = '' }) {
  load();
  const event = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`, at: Date.now(), level, title, detail, seen: level !== 'alert',
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  try { save(); } catch (err) { console.error('[cityhq] events:', err); }
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error('[cityhq] event listener:', err); }
  }
  return event;
}

export const listEvents = (limit = 30) => [...load()].reverse().slice(0, limit);
export const unseenAlerts = () => load().filter((e) => e.level === 'alert' && !e.seen).reverse();

export function markSeen(id) {
  load();
  for (const e of events) if (!id || e.id === id) e.seen = true;
  try { save(); } catch (err) { console.error('[cityhq] events:', err); }
}

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
