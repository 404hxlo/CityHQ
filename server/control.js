// The server's overall state, and start / stop / restart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { agentRequest, installAgent, installedAgentVersion } from './agent.js';
import { applyBackupParts, createBackup, readBackup } from './backups.js';
import { ensureCfgBlock } from './resources.js';
import {
  DB_PORT, FXSERVER_LOG, GAME_PORT, HttpError, findServerData, MANAGED_DB, STATE_DIR, TX_PROFILE, TXADMIN_PORT,
} from './paths.js';
import {
  getHistory, getProcessState, isPortOpen, killTree, startTxAdmin, waitFor,
} from './processes.js';
import { fatalErrorBox, whyStartFailed } from './startup.js';

// A boot is given as long as it keeps making progress (the server log keeps growing), up to a hard
// limit. Big servers take well over 3 minutes, and a fixed clock cut healthy boots short.
export const BOOT_STALL_MS = 5 * 60 * 1000;
export const BOOT_MAX_MS = 25 * 60 * 1000;
// A gap this long between two checks a second or two apart means the PC was asleep.
const SLEPT_GAP_MS = 30000;
const CLOSED_FOR_MS = 6000;

/**
 * Whether to keep waiting for a boot: 'wait', 'stalled' (nothing new in the log for too long) or
 * 'timeout' (over the hard limit). Time the PC spent asleep doesn't count, since the server can't
 * make progress then either.
 */
export function bootVerdict({ now, startedAt, lastProgress, stallMs = BOOT_STALL_MS, maxMs = BOOT_MAX_MS, asleepMs = 0 }) {
  if (now - startedAt - asleepMs > maxMs) return 'timeout';
  if (now - lastProgress > stallMs) return 'stalled';
  return 'wait';
}

const logSize = async () => { try { return (await stat(FXSERVER_LOG)).size; } catch { return 0; } };

const STATUS_MS = 2000;
let liveStatus = null;
let liveAt = 0;
let action = null;
let controlledAt = 0;
let pollTimer = null;

async function pollStatus() {
  if (!getProcessState().game) {
    liveStatus = null;
    return;
  }
  try {
    liveStatus = await agentRequest('/status', { timeoutMs: 1800 });
    liveAt = Date.now();
  } catch {
    liveStatus = null;
  }
}

export function startStatusPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollStatus, STATUS_MS);
  pollStatus();
}

export function stopStatusPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function currentState() {
  const p = getProcessState();
  if (action) return action.state;
  if (!p.monitor) return 'stopped';
  if (!p.game) return 'panel-only';
  return liveStatus ? 'online' : 'starting';
}

function serverName() {
  try {
    const name = JSON.parse(readFileSync(path.join(TX_PROFILE, 'config.json'), 'utf8'))?.general?.serverName;
    if (name) return name;
  } catch { /* use the default below */ }
  return 'QBCore Server';
}

export function getOverview() {
  const p = getProcessState();
  const server = findServerData();
  return {
    state: currentState(),
    message: action?.message || null,
    deployed: Boolean(server),
    serverName: serverName(),
    gamePort: GAME_PORT,
    txAdminPort: TXADMIN_PORT,
    helperOutdated: Boolean(liveStatus && liveStatus.agentVersion !== installedAgentVersion()),
    processes: {
      txAdmin: Boolean(p.monitor),
      game: Boolean(p.game),
      database: MANAGED_DB ? Boolean(p.db) : p.externalDbUp !== false,
    },
    // False when the database is the owner's own (XAMPP, MySQL...), which CityHQ doesn't start.
    databaseManaged: MANAGED_DB,
    databasePort: MANAGED_DB ? DB_PORT : null,
    status: liveStatus,
    statusAgeMs: liveAt ? Date.now() - liveAt : null,
    stats: {
      cpuPct: p.cpuPct,
      memBytes: p.memBytes,
      sysCpuPct: p.sysCpuPct,
      sysMemUsed: p.sysMemUsed,
      sysMemTotal: p.sysMemTotal,
    },
    history: getHistory(),
    logPath: FXSERVER_LOG,
  };
}

const ACTIONS_FILE = path.join(STATE_DIR, 'control-actions.json');

/** CityHQ's own starts, stops and restarts, so the startup doctor doesn't mistake them for crashes. */
export function controlActions() {
  try { return JSON.parse(readFileSync(ACTIONS_FILE, 'utf8')); } catch { return []; }
}
function rememberAction(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(ACTIONS_FILE, JSON.stringify([{ state, at: Date.now() }, ...controlActions()].slice(0, 50)));
  } catch { /* only used for explanations */ }
}

async function exclusive(state, message, run) {
  if (action) throw new HttpError(409, `Please wait: ${action.message}`);
  action = { state, message };
  rememberAction(state);
  try {
    return await run();
  } finally {
    action = null;
    controlledAt = Date.now();
    pollStatus();
  }
}

/** When the app last finished starting, stopping or restarting the server. */
export const lastControlAt = () => controlledAt;

const prepareShutdown = (reason) => agentRequest('/prepare-shutdown', {
  method: 'POST', body: { reason }, timeoutMs: 8000,
}).catch(() => null);

const gameOnline = async () => {
  try { await agentRequest('/status', { timeoutMs: 1500 }); return true; } catch { return false; }
};

/**
 * Waits for the game to come online after txAdmin was launched. If txAdmin closes during
 * startup, it stops waiting straight away and says why, instead of making people wait out the
 * whole time for something that already failed.
 */
export async function waitForBoot(startedAt, { stallMs = BOOT_STALL_MS, maxMs = BOOT_MAX_MS } = {}) {
  let seen = false;
  let goneSince = 0;
  let lastBoxCheck = 0;
  let lastSize = await logSize();
  let lastProgress = Date.now();
  let lastTick = Date.now();
  let asleepMs = 0;
  for (;;) {
    if (await gameOnline()) return { ok: true };
    const now = Date.now();
    if (now - lastTick > SLEPT_GAP_MS) {
      // The PC slept: the server couldn't progress either, so start the stall clock again.
      asleepMs += now - lastTick;
      lastProgress = now;
    }
    lastTick = now;
    const size = await logSize();
    if (size !== lastSize) { lastSize = size; lastProgress = now; }
    const verdict = bootVerdict({ now, startedAt, lastProgress, stallMs, maxMs, asleepMs });
    if (verdict !== 'wait') {
      return { ok: false, stalled: true, reason: await whyStartFailed(startedAt, { closed: false, stalledMs: verdict === 'stalled' ? now - lastProgress : 0 }) };
    }
    const p = getProcessState();
    if (p.monitor) {
      seen = true;
      goneSince = 0;
      // A fatal error leaves a box on screen and the process waiting forever, so look for one.
      if (Date.now() - lastBoxCheck > 4000) {
        lastBoxCheck = Date.now();
        const boxText = await fatalErrorBox(p.monitor.pid);
        if (boxText) {
          await killTree(p.monitor.pid);
          return { ok: false, reason: await whyStartFailed(startedAt, { closed: true, boxText }) };
        }
      }
    } else if (p.updatedAt > startedAt && (seen || Date.now() - startedAt > 30000)) {
      goneSince ||= Date.now();
      if (Date.now() - goneSince >= CLOSED_FOR_MS && !(await isPortOpen(TXADMIN_PORT))) {
        return { ok: false, reason: await whyStartFailed(startedAt, { closed: true }) };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Keeps qb-control and its server.cfg lines in place before each boot. */
async function prepareBoot() {
  await installAgent();
  await ensureCfgBlock();
}

export function startServer() {
  return exclusive('starting', 'Starting the server...', async () => {
    if (!findServerData()) throw new HttpError(409, 'Finish the txAdmin setup first.');
    await prepareBoot();
    const p = getProcessState();
    if (p.game) return { alreadyRunning: true };
    // If the panel is up but the game process is not, txAdmin was told to stop it.
    // Restarting the panel starts the game again because auto-start is on.
    if (p.monitor) {
      await killTree(p.monitor.pid);
      await waitFor(async () => !(await isPortOpen(TXADMIN_PORT)), 10000);
    }
    const startedAt = Date.now();
    await startTxAdmin();
    const boot = await waitForBoot(startedAt);
    if (!boot.ok) throw new HttpError(503, boot.reason);
    return { started: true };
  });
}

/** Crash recovery: starts the server again, and only reports success once it is really online. */
export function startAfterCrash() {
  return exclusive('starting', 'Starting the server again after it went down...', async () => {
    await prepareBoot();
    const startedAt = Date.now();
    // Nothing is started if txAdmin is still answering, which means it never went down.
    if (!(await startTxAdmin())) return { ok: true, alreadyRunning: true };
    return waitForBoot(startedAt);
  });
}

export const isControlBusy = () => Boolean(action);

/**
 * Puts a backup back: makes a safety copy of the current state, stops the server, restores,
 * then starts it again if it was running. Any failure still tries to bring the server back.
 */
export function restoreServer(id, parts) {
  return exclusive('restoring', 'Restoring from a backup...', async () => {
    if (!findServerData()) throw new HttpError(409, 'Finish the txAdmin setup first.');
    await readBackup(id);
    const safety = await createBackup('before-restore');
    const before = getProcessState();
    const wasRunning = Boolean(before.monitor);
    if (before.monitor) {
      await prepareShutdown('The server is being restored from a backup. Please reconnect in a few minutes.');
      await killTree(before.monitor.pid);
      await waitFor(async () => !(await isPortOpen(GAME_PORT)) && !(await isPortOpen(TXADMIN_PORT)), 15000);
    }
    let failure = null;
    try {
      await applyBackupParts(id, parts);
      await installAgent();
      await ensureCfgBlock();
    } catch (err) {
      failure = err;
    }
    if (wasRunning) {
      const startedAt = Date.now();
      await startTxAdmin();
      const boot = await waitForBoot(startedAt);
      if (!boot.ok && !failure) throw new HttpError(503, `The restore finished, but the server did not come back. ${boot.reason}`);
    }
    if (failure) {
      throw new HttpError(failure.status || 500, `${failure.message} Your state from just before this is saved as a backup (${safety.id}).`);
    }
    return { restored: id, safetyBackup: safety.id, serverStarted: wasRunning };
  });
}

export function stopServer(reason) {
  return exclusive('stopping', 'Stopping the server...', async () => {
    const p = getProcessState();
    if (!p.monitor) return { alreadyStopped: true };
    await prepareShutdown(reason || 'The server is shutting down.');
    await killTree(p.monitor.pid);
    await waitFor(async () => !(await isPortOpen(GAME_PORT)) && !(await isPortOpen(TXADMIN_PORT)), 10000);
    return { stopped: true };
  });
}

export function restartServer(reason) {
  return exclusive('restarting', 'Restarting the server...', async () => {
    if (!findServerData()) throw new HttpError(409, 'Finish the txAdmin setup first.');
    await prepareBoot();
    const before = getProcessState();

    if (before.monitor && before.game) {
      await prepareShutdown(reason || 'The server is restarting. Please reconnect in a minute.');
      const oldGame = before.game.pid;
      // Ending only the game process lets txAdmin bring it back up by itself.
      await agentRequest('/quit', { method: 'POST', timeoutMs: 3000 }).catch(() => killTree(oldGame));
      await waitFor(() => getProcessState().game?.pid !== oldGame, 20000);
      const relaunched = await waitFor(() => {
        const g = getProcessState().game;
        return g && g.pid !== oldGame;
      }, 45000);
      if (relaunched) {
        // Give txAdmin's relaunch as long as it keeps making progress; only a stuck boot is redone.
        const boot = await waitForBoot(Date.now());
        if (boot.ok) return { restarted: true };
      }
    }

    // Nothing running, or txAdmin did not bring it back: restart from the top.
    const now = getProcessState();
    if (now.monitor) {
      await killTree(now.monitor.pid);
      await waitFor(async () => !(await isPortOpen(TXADMIN_PORT)), 10000);
    }
    const startedAt = Date.now();
    await startTxAdmin();
    const boot = await waitForBoot(startedAt);
    if (boot.ok) return { restarted: true };
    throw new HttpError(503, boot.reason);
  });
}
