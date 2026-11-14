import { randomBytes, randomInt } from 'node:crypto';
import {
  copyFileSync, mkdirSync, readFileSync,
} from 'node:fs';
import path from 'node:path';
import { recordEvent } from './events.js';
import { findServerData, STATE_DIR } from './paths.js';
import { replaceFileSync } from './retry.js';

const FILE = path.join(STATE_DIR, 'settings.json');

const newPasscode = () => String(randomInt(0, 100_000_000)).padStart(8, '0');

const AUTOMATION_DEFAULTS = {
  backups: { enabled: true, time: '05:00', keep: 14, lastAuto: 0 },
  restarts: { enabled: false, times: ['06:00'] },
  autoStartServer: false,
  autoRecover: true,
  // Ask Windows not to sleep while the server runs. On battery, Modern Standby laptops only stay
  // awake with the screen on, which drains the battery, so that part is a separate choice.
  keepAwake: { enabled: true, screenOnBattery: false },
};

let cache = null;

function save() {
  mkdirSync(STATE_DIR, { recursive: true });
  replaceFileSync(FILE, JSON.stringify(cache, null, 2));
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A file's text, waiting out a passing lock (a virus scan, say). Null when there is no file. */
function readText(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (attempt >= 6) throw err;
      pause(100 * attempt);
    }
  }
}

const parsed = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
};

/**
 * settings.json as saved. When it's damaged (a power cut in the middle of saving, say), the copy kept
 * the last time CityHQ started (settings.json.bak) is used instead, and the damaged file is copied
 * aside first, so nothing is overwritten unseen. source says which: 'file', 'backup', 'new' (there
 * is no file yet) or 'damaged' (no good copy either).
 */
export function readSettingsFile(file = FILE) {
  const text = readText(file);
  if (text === null) return { loaded: {}, source: 'new' };
  const main = parsed(text);
  if (main) {
    try { copyFileSync(file, `${file}.bak`); } catch { /* only a spare */ }
    return { loaded: main, source: 'file' };
  }
  const aside = `${file}.damaged-${Date.now()}`;
  try { copyFileSync(file, aside); } catch { /* kept when it can be */ }
  let spare = null;
  try { spare = parsed(readText(`${file}.bak`) ?? ''); } catch { /* no spare */ }
  return spare ? { loaded: spare, source: 'backup', aside } : { loaded: {}, source: 'damaged', aside };
}

/**
 * The key CityHQ's helper already has on this PC's server, so settings started afresh keep working
 * with the helper the server is running now (it only reads its key when the server starts).
 */
function helperToken() {
  try {
    const server = findServerData();
    if (!server || server.remote) return null;
    const token = readFileSync(path.join(server.dataPath, 'resources', '[local]', 'qb-control', 'token.txt'), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch { return null; }
}

export function getSettings() {
  if (cache) return cache;
  const { loaded, source, aside } = readSettingsFile(FILE);
  const keptToken = loaded.agentToken || helperToken();
  cache = {
    agentToken: keptToken || randomBytes(32).toString('hex'),
    passcode: loaded.passcode || newPasscode(),
    lanEnabled: Boolean(loaded.lanEnabled),
    sessions: loaded.sessions || {},
    backups: { ...AUTOMATION_DEFAULTS.backups, ...loaded.backups },
    restarts: { ...AUTOMATION_DEFAULTS.restarts, ...loaded.restarts },
    autoStartServer: loaded.autoStartServer ?? AUTOMATION_DEFAULTS.autoStartServer,
    autoRecover: loaded.autoRecover ?? AUTOMATION_DEFAULTS.autoRecover,
    keepAwake: {
      enabled: loaded.keepAwake?.enabled ?? AUTOMATION_DEFAULTS.keepAwake.enabled,
      screenOnBattery: loaded.keepAwake?.screenOnBattery ?? AUTOMATION_DEFAULTS.keepAwake.screenOnBattery,
    },
    // Who may join while the whitelist is on: [{ id: 'license:...', name }]. Admins always may.
    whitelist: {
      enabled: Boolean(loaded.whitelist?.enabled),
      entries: Array.isArray(loaded.whitelist?.entries) ? loaded.whitelist.entries : [],
    },
    greetingName: typeof loaded.greetingName === 'string' ? loaded.greetingName.slice(0, 40) : '',
    // Look for a new CityHQ version now and then (installing always waits for a click).
    autoUpdateCheck: loaded.autoUpdateCheck ?? true,
    updateAnnounced: typeof loaded.updateAnnounced === 'string' ? loaded.updateAnnounced : null,
  };
  save();
  const keptAs = aside ? ` The damaged file was kept as ${path.basename(aside)}.` : '';
  if (source === 'backup') {
    recordEvent({
      level: 'alert',
      title: 'CityHQ\'s settings file was damaged',
      detail: `CityHQ used the copy it kept when it last started, so a change made since then (a new passcode, a phone that signed in, a whitelist edit) may need doing again.${keptAs}`,
    });
  } else if (source === 'damaged') {
    recordEvent({
      level: 'alert',
      title: 'CityHQ\'s settings were reset',
      detail: `Its settings file was damaged and there was no good copy, so CityHQ started afresh: a new passcode (phones sign in again), and the schedules and whitelist are back to how they start.${keptToken ? '' : ' Restart the server when nobody is on, so CityHQ\'s helper gets its new key.'}${keptAs}`,
    });
  }
  return cache;
}

export function updateSettings(patch) {
  Object.assign(getSettings(), patch);
  save();
  return cache;
}

export function regeneratePasscode() {
  return updateSettings({ passcode: newPasscode(), sessions: {} }).passcode;
}
