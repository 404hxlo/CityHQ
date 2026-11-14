// Nightly backups, scheduled restarts with in-game warnings, and noticing when the server goes down.
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { agentRequest } from './agent.js';
import { backupStatus, createBackup, listBackups } from './backups.js';
import { readConsole } from './console.js';
import {
  getOverview, isControlBusy, lastControlAt, restartServer, startAfterCrash, startServer,
} from './control.js';
import {
  explainCrash, isCrashReason, isHostCrashLine, reportCrash, reportRecovery, restartReasonOf, sinceBoot,
} from './crashes.js';
import { isSecondary } from './desktop.js';
import { adminLogTail, serverLogTail } from './doctor.js';
import { recordEvent } from './events.js';
import {
  FXSERVER_DIR, findServerData, REMOTE,
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
/** A planned restart this late means the PC slept through it (or CityHQ couldn't run). */
export const MISSED_AFTER_MS = 2 * 60 * 1000;

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

/**
 * What a planned restart needs now: 'wait', 'now', or 'missed' when its time passed long ago, which
 * means the PC was asleep. Restarting the moment it wakes, hours late and without the last
 * warnings, would throw off players who joined since.
 */
export function restartDue(msLeft, missedAfterMs = MISSED_AFTER_MS) {
  if (msLeft > 0) return 'wait';
  return -msLeft > missedAfterMs ? 'missed' : 'now';
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

function skipMissedRestart() {
  const { at, reason, key, announced } = pending;
  const scheduled = reason === 'scheduled';
  if (key) skipped.add(key);
  pending = null;
  if (announced.length) announce('The planned server restart was cancelled.');
  const when = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  recordEvent({
    // A restart someone asked for is worth a notice; the daily one just comes round again.
    level: scheduled ? 'info' : 'alert',
    title: scheduled ? 'A scheduled restart was skipped' : 'A planned restart was skipped',
    detail: `It was due at ${when}, while the PC was asleep or CityHQ couldn't run. Restarting this late, without warning players first, would catch out anyone who joined since. ${scheduled ? 'The next one happens at its usual time.' : 'Plan it again from Home if it\'s still needed.'}`,
  });
}

function pendingTick() {
  if (!pending || restartRunning) return;
  const msLeft = pending.at - Date.now();
  const due = restartDue(msLeft);
  if (due === 'missed') {
    skipMissedRestart();
    return;
  }
  if (due === 'now') {
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

function recentCrashDump() {
  const dir = path.join(FXSERVER_DIR, 'crashes');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => Date.now() - statSync(path.join(dir, name)).mtimeMs < 120000);
  } catch { return false; }
}

const nameOfServer = () => {
  try { return getOverview().serverName || ''; } catch { return ''; }
};

/** txAdmin's reason for the restart it just made (its own log), or null if it didn't make one. */
async function recentAdminReason() {
  const line = (await adminLogTail().catch(() => [])).findLast((l) => /Restarting server:/i.test(l));
  if (!line) return null;
  const t = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (t) {
    const at = new Date();
    at.setHours(Number(t[1]), Number(t[2]), Number(t[3]), 0);
    if (Math.abs(Date.now() - at.getTime()) > 5 * 60000) return null;
  }
  return restartReasonOf(line);
}

/** Runs shortly after the game closed, once the log has caught up: what happened, and why. */
async function reportGameClosed() {
  const lines = await serverLogTail(512 * 1024).catch(() => []);
  // When txAdmin has started it again, the crashed run is the one before its new start.
  const restarted = Boolean(getProcessState().game);
  const latest = lines.findLastIndex((l) => /FXServer Starting/.test(l));
  const before = restarted && latest > 0 ? lines.slice(0, latest) : lines;
  if (/-> Quitting:/.test(before.slice(-60).join('\n'))) {
    recordEvent({ title: 'The server restarted', detail: 'It was restarted from the console or txAdmin.' });
    return;
  }
  const reason = await recentAdminReason();
  if (reason && !isCrashReason(reason)) {
    recordEvent({ title: 'The server restarted', detail: `txAdmin restarted it: ${reason}.` });
    return;
  }
  const segment = sinceBoot(before);
  reportCrash(explainCrash({ reason, lines: segment, dumpSaved: recentCrashDump() }), {
    reason,
    raw: segment.slice(-15).join('\n'),
    serverName: nameOfServer(),
    after: restarted ? 'txAdmin started it again, but anyone online was disconnected.' : 'It hasn\'t come back yet. Use Start or Restart on Home.',
  });
}

/** txAdmin itself stopped: explained, before CityHQ starts it again (when it may). */
async function reportServerDown(autoRecover) {
  const segment = sinceBoot(await serverLogTail(512 * 1024).catch(() => []));
  reportCrash(explainCrash({ wentDown: true, lines: segment, dumpSaved: recentCrashDump() }), {
    raw: segment.slice(-15).join('\n'),
    serverName: nameOfServer(),
    after: autoRecover ? 'CityHQ is starting it again.' : 'Automatic recovery is off, so use Start on Home.',
  });
}

async function recoverServer() {
  recoveries = recoveries.filter((t) => Date.now() - t < RECOVER_WINDOW_MS);
  if (recoveries.length >= RECOVER_LIMIT) {
    reportRecovery({ ok: false, detail: `It went down ${RECOVER_LIMIT} times in 15 minutes, so CityHQ stopped starting it. Check Things to fix on Home, then press Start.`, serverName: nameOfServer() });
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
  reportRecovery({ ok: result.ok, detail: result.reason || '', serverName: nameOfServer() });
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
    const { autoRecover } = getSettings();
    reportServerDown(autoRecover).catch(() => {});
    if (autoRecover) recoverServer();
    return;
  }
  if (change.gameClosed && !followUp) {
    // Give txAdmin time to bring it back and the log time to catch up before judging.
    followUp = setTimeout(() => { followUp = null; if (!isControlBusy()) reportGameClosed().catch(() => {}); }, 15000);
  }
}

// ---------------------------------------------------------------- hosted servers
// The host and txAdmin bring a crashed server back themselves; CityHQ follows the console to say
// what happened and why. txAdmin says "Restarting server: <reason>" when the game server crashed
// or froze; the host (Wings) says "Detected server process in a crashed state" when everything
// did, then whether memory ran out and whether it's restarting it.
const HOSTED_QUIET_MS = 60000;
let hostedAt;
let hostedLines = [];
let hostCrash = null;
let hostedRecoveries = [];
let sftpTicks = 0;

const recentlyControlled = () => isControlBusy() || Date.now() - lastControlAt() < HOSTED_QUIET_MS;

async function recoverHosted() {
  hostedRecoveries = hostedRecoveries.filter((t) => Date.now() - t < RECOVER_WINDOW_MS);
  if (hostedRecoveries.length >= RECOVER_LIMIT) {
    reportRecovery({ ok: false, detail: `It went down ${RECOVER_LIMIT} times in 15 minutes, so CityHQ stopped starting it. Check Things to fix on Home, then press Start.`, serverName: nameOfServer() });
    return;
  }
  hostedRecoveries.push(Date.now());
  try {
    await startServer();
    reportRecovery({ ok: true, serverName: nameOfServer() });
  } catch (err) {
    // Someone pressed Start, Stop or Restart at the same moment; leave it to them.
    if (err.status !== 409) reportRecovery({ ok: false, detail: err.message, serverName: nameOfServer() });
  }
}

async function hostedWatchTick() {
  const chunk = await readConsole(hostedAt).catch(() => null);
  if (!chunk) return;
  const texts = chunk.lines.map((l) => l.text);
  // The first read is what happened before CityHQ was watching: only kept, to explain later ones.
  const watching = hostedAt !== undefined && !chunk.reset;
  hostedAt = chunk.offset;
  if (watching) {
    texts.forEach((line, i) => {
      const reason = restartReasonOf(line);
      if (reason && isCrashReason(reason) && !recentlyControlled()) {
        const lines = sinceBoot([...hostedLines, ...texts.slice(0, i)]);
        reportCrash(explainCrash({ reason, lines, hosted: true }), {
          reason, raw: lines.slice(-15).join('\n'), serverName: nameOfServer(), after: 'txAdmin is starting it again. Anyone online was disconnected.',
        });
      }
      if (hostCrash) hostCrash.follow.push(line);
      else if (isHostCrashLine(line) && !recentlyControlled()) hostCrash = { at: Date.now(), lines: sinceBoot([...hostedLines, ...texts.slice(0, i)]), follow: [] };
    });
  }
  hostedLines = [...hostedLines, ...texts].slice(-500);
  // Reported once the host's own follow-up lines (memory, restarting or not) are in.
  if (hostCrash && Date.now() - hostCrash.at >= 4000) {
    const { lines, follow } = hostCrash;
    hostCrash = null;
    const gaveUp = follow.some((l) => /Aborting automatic restart/i.test(l));
    const { autoRecover } = getSettings();
    let after = 'Your host is starting it again.';
    if (gaveUp) after = `Your host stopped restarting it, because it crashed twice within a minute.${autoRecover ? ' CityHQ will try once more in 30 seconds.' : ' Start it from Home when you\'re ready.'}`;
    reportCrash(explainCrash({ wentDown: true, lines: [...lines, ...follow], hosted: true }), {
      raw: [...lines.slice(-10), ...follow.slice(0, 6)].join('\n'), serverName: nameOfServer(), after,
    });
    if (gaveUp && autoRecover) setTimeout(() => { recoverHosted().catch(() => {}); }, 30000);
  }
}

// ---------------------------------------------------------------- the loop
/**
 * One turn of the scheduler: the quick checks every time, and the slow job (the nightly backup)
 * started beside them, never waited for and never run twice at once. A backup can take an hour on
 * a big server, and crash watching, restart warnings and scheduled restarts keep going meanwhile.
 */
export function createTicker({ quick, slow, onError = (err) => console.error('[cityhq] scheduler:', err) }) {
  let ticking = false;
  let slowRun = null;
  return async () => {
    if (ticking) return;
    ticking = true;
    try {
      await quick();
    } catch (err) {
      onError(err);
    } finally {
      ticking = false;
    }
    if (!slowRun) {
      slowRun = Promise.resolve().then(slow).catch(onError).finally(() => { slowRun = null; });
    }
  };
}

const tick = createTicker({
  async quick() {
    pendingTick();
    if (isSecondary()) return;
    scheduleTick(new Date());
    // A hosted server is backed up by its host, and its crashes are followed in its console:
    // the panel's live one each time, a log file over SFTP every third time.
    if (!REMOTE) watchTick();
    else if (REMOTE.type !== 'sftp' || (sftpTicks = (sftpTicks + 1) % 3) === 0) await hostedWatchTick();
  },
  slow: () => (!isSecondary() && !REMOTE ? backupTick(new Date()) : null),
});

let timer = null;

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
