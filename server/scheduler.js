// Nightly backups, scheduled restarts with in-game warnings, and noticing when the server goes down.
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { agentRequest } from './agent.js';
import { backupStatus, createBackup, listBackups } from './backups.js';
import {
  isControlBusy, lastControlAt, restartServer, startAfterCrash, startServer,
} from './control.js';
import { isSecondary } from './desktop.js';
import { recordEvent } from './events.js';
import {
  FXSERVER_DIR, FXSERVER_LOG, findServerData, REMOTE,
} from './paths.js';
import {
  ensureDatabase, getProcessState,
} from './processes.js';
import { getSettings, updateSettings } from './settings.js';

const TICK_MS = 5000;
const BACKUP_RETRY_MS = 60 * 60 * 1000;
const RECOVER_LIMIT = 3;
const RECOVER_WINDOW_MS = 15 * 60 * 1000;
export const WARN_MINUTES = [15, 5, 1];

// ---------------------------------------------------------------- pure time helpers
export const isValidTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

function atTime(day, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The soonest time from the list that is still ahead of now. */
export function nextOccurrence(times, now) {
  let best = null;
  for (const time of times) {
    for (const offset of [0, 1]) {
      const day = new Date(now);
      day.setDate(day.getDate() + offset);
      const at = atTime(day, time).getTime();
      if (at > now.getTime() && (best === null || at < best)) best = at;
    }
  }
  return best;
}

/** The most recent past moment this daily time came around. */
export function lastOccurrence(time, now) {
  const today = atTime(now, time);
  if (today.getTime() <= now.getTime()) return today.getTime();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return atTime(yesterday, time).getTime();
}

/** Which warning to give, if any, given how long is left and what was already announced. */
export function warningDue(msLeft, announced, thresholds = WARN_MINUTES) {
  const minutesLeft = msLeft / 60000;
  const due = thresholds.filter((m) => minutesLeft <= m && !announced.includes(m));
  if (!due.length) return null;
  const closest = Math.min(...due);
  return { minutes: closest, marks: due };
}

const minutesText = (n) => `${n} minute${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- pending restart
let pending = null;
let skipped = new Set();
let restartRunning = false;

export const getPendingRestart = () => (pending ? { at: pending.at, reason: pending.reason } : null);

function announce(message) {
  return agentRequest('/announce', { method: 'POST', body: { message } }).catch(() => null);
}

/** Restart after a countdown, warning players along the way. */
export function scheduleRestart(minutes, reason = 'manual') {
  pending = { at: Date.now() + minutes * 60000, reason, announced: [] };
  pendingTick();
  return getPendingRestart();
}

export function cancelPendingRestart() {
  if (!pending) return { cancelled: false };
  if (pending.key) skipped.add(pending.key);
  const warned = pending.announced.length > 0;
  pending = null;
  if (warned) announce('The planned server restart was cancelled.');
  return { cancelled: true };
}

async function runPendingRestart() {
  const { reason } = pending;
  pending = null;
  restartRunning = true;
  try {
    await restartServer('The server is restarting. Please reconnect in a minute.');
    recordEvent({ title: reason === 'scheduled' ? 'Scheduled restart finished' : 'Planned restart finished' });
  } catch (err) {
    recordEvent({ level: 'alert', title: 'A planned restart failed', detail: err.message });
  } finally {
    restartRunning = false;
  }
}

function pendingTick() {
  if (!pending || restartRunning) return;
  const msLeft = pending.at - Date.now();
  if (msLeft <= 0) {
    runPendingRestart();
    return;
  }
  const warning = warningDue(msLeft, pending.announced);
  if (warning) {
    pending.announced.push(...warning.marks);
    announce(`The server will restart in ${minutesText(Math.max(1, Math.ceil(msLeft / 60000)))}.`);
  }
}

function scheduleTick(now) {
  const { restarts } = getSettings();
  if (!restarts.enabled || !restarts.times.length || pending || restartRunning) return;
  const at = nextOccurrence(restarts.times, now);
  if (at === null || at - now.getTime() > WARN_MINUTES[0] * 60000) return;
  const key = String(at);
  if (skipped.has(key)) return;
  pending = { at, reason: 'scheduled', key, announced: [] };
}

export function nextScheduledRestart() {
  const { restarts } = getSettings();
  if (!restarts.enabled || !restarts.times.length) return null;
  return nextOccurrence(restarts.times, new Date());
}

// ---------------------------------------------------------------- nightly backups
let backupRetryAfter = 0;

async function backupTick(now) {
  const { backups } = getSettings();
  if (!backups.enabled || backupStatus() || now.getTime() < backupRetryAfter) return;
  if (!findServerData()) return;
  // Also catches up after the PC was off at the usual time.
  const slot = lastOccurrence(backups.time, now);
  if (backups.lastAuto >= slot) return;
  try {
    // A full backup made since then already covers this one.
    const covered = (await listBackups()).some((b) => b.createdAt >= slot && b.parts.length === 3);
    if (covered) {
      updateSettings({ backups: { ...backups, lastAuto: Date.now() } });
      return;
    }
    const made = await createBackup('nightly');
    updateSettings({ backups: { ...getSettings().backups, lastAuto: Date.now() } });
    recordEvent({
      title: 'Automatic backup finished',
      detail: `${Math.round(made.size / 1024 / 1024)} MB${made.skipped.length ? `, ${made.skipped.length} busy file(s) skipped` : ''}`,
    });
  } catch (err) {
    backupRetryAfter = Date.now() + BACKUP_RETRY_MS;
    recordEvent({ level: 'alert', title: 'The automatic backup failed', detail: `${err.message} It will try again in an hour.` });
  }
}

export function nextBackupTime() {
  const { backups } = getSettings();
  // CityHQ doesn't back up hosted servers yet, so nothing is coming up.
  if (!backups.enabled || REMOTE) return null;
  return nextOccurrence([backups.time], new Date());
}

// ---------------------------------------------------------------- watchdog
const QUIET_AFTER_CONTROL_MS = 10000;

const sameIds = (a, b) => Boolean(a) && a.monitor === b.monitor && a.game === b.game && a.db === b.db;

/** What changed between two trusted readings of the running processes. */
export function judgeProcesses(before, now) {
  const serverDown = Boolean(before.monitor && !now.monitor);
  return {
    serverDown,
    databaseStopped: Boolean(before.db && !now.db),
    gameClosed: !serverDown && Boolean(before.game && before.game !== now.game),
  };
}

/**
 * Decides when a reading can be believed. Any single reading can be wrong, for example an empty
 * process list when Windows is short of memory, and acting on one could raise a false alarm, so
 * a change only counts once two readings in a row agree. Everything is ignored while the app
 * itself is starting or stopping the server, and briefly after, or pressing Stop would look
 * like a crash and the server would come straight back.
 */
export function createProcessWatch(quietMs = QUIET_AFTER_CONTROL_MS) {
  let trusted = null;
  let previous = null;
  let quietUntil = 0;
  return (ids, { busy = false, controlledAt = 0, now = Date.now() } = {}) => {
    // Pressing Stop with nobody online can finish between two readings, so being busy can't be
    // the only sign. When the last action ended counts too.
    quietUntil = Math.max(quietUntil, controlledAt ? controlledAt + quietMs : 0, busy ? now + quietMs : 0);
    const steady = sameIds(previous, ids);
    previous = ids;
    if (now < quietUntil) {
      trusted = ids;
      return null;
    }
    if (!steady) return null;
    const before = trusted;
    trusted = ids;
    return before ? judgeProcesses(before, ids) : null;
  };
}

const watch = createProcessWatch();
let lastSample = 0;
let recoveries = [];
let followUp = null;

function logTail(lines = 80) {
  try {
    const text = readFileSync(FXSERVER_LOG, 'utf8');
    return text.slice(-20000).split('\n').slice(-lines).join('\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  } catch { return ''; }
}

function recentCrashDump() {
  const dir = path.join(FXSERVER_DIR, 'crashes');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => Date.now() - statSync(path.join(dir, name)).mtimeMs < 120000);
  } catch { return false; }
}

/** Runs shortly after the game closed, once the log has caught up. */
function reportGameClosed() {
  const tail = logTail();
  const boots = tail.split('FXServer Starting');
  const beforeLatestBoot = boots.length > 1 ? boots.slice(0, -1).join('') : tail;
  const closing = beforeLatestBoot.slice(-3000);
  if (/-> Quitting:/.test(closing)) {
    recordEvent({ title: 'The server restarted', detail: 'It was restarted from the console or txAdmin.' });
    return;
  }
  const crashed = recentCrashDump();
  recordEvent({
    level: 'alert',
    title: crashed ? 'The game server crashed' : 'The game server stopped unexpectedly',
    detail: getProcessState().game
      ? 'txAdmin started it again, but anyone online was disconnected. Check Home for anything that may have caused it.'
      : 'It has not come back yet. Use Start or Restart on Home.',
  });
}

async function recoverServer() {
  recoveries = recoveries.filter((t) => Date.now() - t < RECOVER_WINDOW_MS);
  if (recoveries.length >= RECOVER_LIMIT) {
    recordEvent({ level: 'alert', title: 'The server keeps going down', detail: `It stopped ${RECOVER_LIMIT} times in 15 minutes, so the app stopped restarting it. Check Home, then press Start.` });
    return;
  }
  let result;
  try {
    // Runs like pressing Start, so the watchdog stays quiet meanwhile and a Start click can't overlap.
    result = await startAfterCrash();
  } catch (err) {
    // Someone pressed Start, Stop or Restart at the same moment; leave it to them.
    if (err.status === 409) return;
    result = { ok: false, reason: err.message };
  }
  if (result.alreadyRunning) return;
  recoveries.push(Date.now());
  recordEvent(result.ok
    ? { level: 'alert', title: 'The server went down and was started again', detail: 'Anyone online was disconnected.' }
    : { level: 'alert', title: 'The server went down and could not be started again', detail: result.reason });
}

async function recoverDatabase() {
  try {
    if (await ensureDatabase()) {
      recordEvent({ level: 'alert', title: 'The database stopped and was started again', detail: 'If anything in the game stops saving, restart the server.' });
    }
  } catch (err) {
    recordEvent({ level: 'alert', title: 'The database stopped and could not be restarted', detail: err.message });
  }
}

function watchTick() {
  const p = getProcessState();
  if (!p.updatedAt || p.updatedAt === lastSample) return;
  lastSample = p.updatedAt;
  const ids = { monitor: p.monitor?.pid ?? null, game: p.game?.pid ?? null, db: p.db?.pid ?? null };
  const change = watch(ids, { busy: isControlBusy(), controlledAt: lastControlAt() });
  if (!change) return;

  if (change.databaseStopped) recoverDatabase();
  if (change.serverDown) {
    if (getSettings().autoRecover) recoverServer();
    else recordEvent({ level: 'alert', title: 'The server went down', detail: 'Automatic recovery is off, so use Start on Home.' });
    return;
  }
  if (change.gameClosed && !followUp) {
    // Give txAdmin time to bring it back and the log time to catch up before judging.
    followUp = setTimeout(() => { followUp = null; if (!isControlBusy()) reportGameClosed(); }, 15000);
  }
}

// ---------------------------------------------------------------- the loop
let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    pendingTick();
    if (!isSecondary()) {
      const now = new Date();
      scheduleTick(now);
      // A hosted server is watched and backed up by its host (CityHQ's own backups of hosted
      // servers come later).
      if (!REMOTE) {
        watchTick();
        await backupTick(now);
      }
    }
  } catch (err) {
    console.error('[cityhq] scheduler:', err);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (!isSecondary() && !REMOTE && getSettings().autoStartServer && findServerData()) {
    startServer().catch((err) => recordEvent({ level: 'alert', title: 'The server could not be started automatically', detail: err.message }));
  }
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
  clearTimeout(followUp);
  followUp = null;
}
