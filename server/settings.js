import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
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

export function getSettings() {
  if (cache) return cache;
  let loaded = {};
  if (existsSync(FILE)) {
    try { loaded = JSON.parse(readFileSync(FILE, 'utf8')); } catch { loaded = {}; }
  }
  cache = {
    agentToken: loaded.agentToken || randomBytes(32).toString('hex'),
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
