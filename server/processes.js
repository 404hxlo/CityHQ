// Watches and controls only the processes that live under this server's folder,
// so other FiveM servers or databases on the PC are never touched.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DB_EXE, DB_INI, DB_PORT, FXSERVER_DIR, FXSERVER_EXE, LOG_DIR, ROOT, TX_ENV, TXADMIN_PORT,
} from './paths.js';

const exec = promisify(execFile);
const HISTORY_LENGTH = 150;
const SAMPLE_SECONDS = 2;

const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $p = @(Get-CimInstance Win32_Process -Filter "Name='FXServer.exe' OR Name='mariadbd.exe'" |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, UserModeTime, KernelModeTime, WorkingSetSize)
  ConvertTo-Json -Compress -Depth 2 -InputObject $p
  Start-Sleep -Seconds ${SAMPLE_SECONDS}
}`;

const under = (p) => Boolean(p) && p.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\`);

const state = {
  monitor: null,
  game: null,
  db: null,
  updatedAt: 0,
  cpuPct: null,
  memBytes: null,
  sysCpuPct: null,
  sysMemUsed: 0,
  sysMemTotal: os.totalmem(),
};
const history = [];
let lastCpu = null;
let lastSys = null;
let probe = null;
let stopped = false;

function sysCpuSample() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [k, v] of Object.entries(cpu.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

function ingest(rows) {
  const mine = rows.filter((r) => under(r.ExecutablePath));
  const fx = mine.filter((r) => r.Name === 'FXServer.exe');
  const fxPids = new Set(fx.map((r) => r.ProcessId));
  const roles = fx.filter((r) => !/-dumpserver/i.test(r.CommandLine || ''));
  const monitor = roles.find((r) => !fxPids.has(r.ParentProcessId)) || null;
  const game = monitor ? roles.find((r) => r.ParentProcessId === monitor.ProcessId) || null : null;
  const db = mine.find((r) => r.Name === 'mariadbd.exe') || null;

  state.monitor = monitor ? { pid: monitor.ProcessId } : null;
  state.game = game ? { pid: game.ProcessId } : null;
  state.db = db ? { pid: db.ProcessId } : null;

  const now = Date.now();
  const cores = os.cpus().length || 1;
  const counted = [game, monitor, db].filter(Boolean);
  const cpuTotal = counted.reduce((sum, r) => sum + Number(r.UserModeTime || 0) + Number(r.KernelModeTime || 0), 0);
  if (lastCpu && now > lastCpu.at && cpuTotal >= lastCpu.total) {
    // CPU times are reported in 100-nanosecond units.
    const usedMs = (cpuTotal - lastCpu.total) / 10_000;
    state.cpuPct = Math.min(100, (usedMs / (now - lastCpu.at) / cores) * 100);
  }
  lastCpu = { at: now, total: cpuTotal };
  state.memBytes = counted.reduce((sum, r) => sum + Number(r.WorkingSetSize || 0), 0);

  const sys = sysCpuSample();
  if (lastSys && sys.total > lastSys.total) {
    state.sysCpuPct = 100 * (1 - (sys.idle - lastSys.idle) / (sys.total - lastSys.total));
  }
  lastSys = sys;
  state.sysMemTotal = os.totalmem();
  state.sysMemUsed = state.sysMemTotal - os.freemem();
  state.updatedAt = now;

  history.push({
    t: now,
    cpu: state.cpuPct === null ? null : Math.round(state.cpuPct * 10) / 10,
    mem: state.memBytes,
    running: Boolean(game),
  });
  if (history.length > HISTORY_LENGTH) history.shift();
}

export function startProbe() {
  stopped = false;
  if (probe) return;
  const encoded = Buffer.from(PROBE, 'utf16le').toString('base64');
  probe = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buffer = '';
  probe.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        ingest(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { /* a partial line; the next sample replaces it */ }
    }
  });
  probe.on('exit', () => {
    probe = null;
    if (!stopped) setTimeout(startProbe, 3000);
  });
}

export function stopProbe() {
  stopped = true;
  probe?.kill();
  probe = null;
}

export const getProcessState = () => state;
export const getHistory = () => history;

export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function spawnDetached(exe, args, cwd, logName, env) {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(path.join(LOG_DIR, `${logName}.log`), 'a');
  const child = spawn(exe, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

export async function ensureDatabase() {
  if (await isPortOpen(DB_PORT)) return false;
  spawnDetached(DB_EXE, [`--defaults-file=${DB_INI}`], path.dirname(DB_INI), 'mariadb-console');
  for (let i = 0; i < 30; i++) {
    if (await isPortOpen(DB_PORT)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The database did not start. See logs\\mariadb.err for details.');
}

/**
 * Starts txAdmin with a hidden console of its own. The game server inherits that console. A
 * process with no console at all would make Windows open a visible terminal for the game
 * server every time it boots, and closing that window would shut the server down.
 */
async function startWithHiddenConsole(exe, cwd, logName, env) {
  mkdirSync(LOG_DIR, { recursive: true });
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = [
    'Start-Process',
    `-FilePath ${quote(exe)}`,
    `-WorkingDirectory ${quote(cwd)}`,
    '-WindowStyle Hidden',
    `-RedirectStandardOutput ${quote(path.join(LOG_DIR, `${logName}.log`))}`,
    `-RedirectStandardError ${quote(path.join(LOG_DIR, `${logName}.err.log`))}`,
  ].join(' ');
  await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 20000,
  });
}

export async function startTxAdmin() {
  await ensureDatabase();
  if (await isPortOpen(TXADMIN_PORT)) return false;
  // Drop anything inherited that would make txAdmin bind to the wrong interface.
  const env = { ...TX_ENV, TXHOST_INTERFACE: undefined };
  await startWithHiddenConsole(FXSERVER_EXE, FXSERVER_DIR, 'txadmin-console', env);
  return true;
}

export async function killTree(pid) {
  await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
}

export async function waitFor(check, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
