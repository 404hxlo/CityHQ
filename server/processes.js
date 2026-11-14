// Watches and controls only the processes that live under this server's folder,
// so other FiveM servers or databases on the PC are never touched.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { connectionStringOf, parseConnection, readCfg } from './cfg.js';
import {
  DB_EXE, DB_HOME, DB_INI, DB_PORT, findServerData, FXSERVER_DIR, FXSERVER_EXE, HttpError, LOG_DIR, MANAGED_DB, TX_ENV, TXADMIN_PORT,
} from './paths.js';

const exec = promisify(execFile);
const HISTORY_LENGTH = 150;
const SAMPLE_SECONDS = 2;

// Each sample also says which TCP ports each of those programs listens on, so this server's txAdmin
// can be told apart from another server's started from the same FiveM folder.
const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $p = @(Get-CimInstance Win32_Process -Filter "Name='FXServer.exe' OR Name='mariadbd.exe'" |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, UserModeTime, KernelModeTime, WorkingSetSize)
  if ($p.Count) {
    $listen = @(Get-NetTCPConnection -State Listen -OwningProcess @($p.ProcessId))
    foreach ($row in $p) { $row | Add-Member -NotePropertyName Ports -NotePropertyValue @($listen | Where-Object { $_.OwningProcess -eq $row.ProcessId } | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique) }
  }
  ConvertTo-Json -Compress -Depth 3 -InputObject $p
  Start-Sleep -Seconds ${SAMPLE_SECONDS}
}`;

/** True when a program runs from inside folder (FiveM's server folder, or CityHQ's own database). */
export const runsFrom = (exe, folder) => Boolean(exe) && exe.toLowerCase().startsWith(`${path.resolve(folder).toLowerCase()}\\`);

/** The TCP ports a process listens on, from the probe; null when the probe couldn't tell. */
const portsOf = (row) => (row.Ports === undefined || row.Ports === null ? null : [row.Ports].flat().map(Number));

/**
 * txAdmin for this server among those started from its FiveM folder. Usually there's one. Two
 * servers can share one FiveM folder (each with its own txData), and then this server's txAdmin is
 * the one listening on this server's txAdmin port; with none on it, this server is off.
 */
export function pickMonitor(monitors, txAdminPort) {
  if (monitors.length <= 1) return monitors[0] || null;
  const known = monitors.filter((r) => portsOf(r) !== null);
  // Without port details nothing tells them apart, so keep to the first, as before.
  if (!known.length) return monitors[0];
  return known.find((r) => portsOf(r).includes(Number(txAdminPort))) || null;
}

/**
 * Picks this server's processes out of every FXServer and database on the PC: FXServer only from
 * this server's FiveM folder, and a database only when CityHQ runs it. Other servers are ignored.
 */
export function ownProcesses(rows, {
  fxserverDir = FXSERVER_DIR, dbHome = DB_HOME, managedDb = MANAGED_DB, txAdminPort = TXADMIN_PORT,
} = {}) {
  const fx = rows.filter((r) => r.Name === 'FXServer.exe' && runsFrom(r.ExecutablePath, fxserverDir));
  const fxPids = new Set(fx.map((r) => r.ProcessId));
  const roles = fx.filter((r) => !/-dumpserver/i.test(r.CommandLine || ''));
  const monitor = pickMonitor(roles.filter((r) => !fxPids.has(r.ParentProcessId)), txAdminPort);
  const game = monitor ? roles.find((r) => r.ParentProcessId === monitor.ProcessId) || null : null;
  const db = managedDb ? rows.find((r) => r.Name === 'mariadbd.exe' && runsFrom(r.ExecutablePath, dbHome)) || null : null;
  return { monitor, game, db };
}

const state = {
  monitor: null,
  game: null,
  db: null,
  // For someone's own database: true or false once checked, null when it can't be told.
  externalDbUp: null,
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
  const { monitor, game, db } = ownProcesses(rows);
  if (!MANAGED_DB) checkExternalDatabase();

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

/** Who is listening on a TCP port on this PC: { pid, name, path }, or null (nobody, or it can't be told). */
export async function portOwner(port) {
  const script = `$c = Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; `
    + 'if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; '
    + 'ConvertTo-Json -Compress -InputObject @{ pid = [int]$c.OwningProcess; name = [string]$p.Name; path = [string]$p.ExecutablePath } }';
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
    const owner = JSON.parse(stdout.trim() || 'null');
    return owner?.pid ? owner : null;
  } catch { return null; }
}

/** A program on a port, in words: "FXServer.exe (D:\Other-Server\server)", or Windows itself. */
export function describeOwner(owner) {
  if (!owner) return 'another program';
  if (!owner.path) return owner.pid === 4 ? 'Windows itself' : owner.name || `the program with id ${owner.pid}`;
  return `${owner.name || path.win32.basename(owner.path)} (${path.win32.dirname(owner.path)})`;
}

/**
 * Throws a plain explanation when a port this server needs is taken by a program that isn't the
 * one expected (folder: where the expected program runs from). Ports CityHQ can't check pass.
 */
export async function assertPortIsOurs(port, folder, what) {
  const owner = await portOwner(port);
  if (!owner || (owner.path && runsFrom(owner.path, folder))) return;
  throw new HttpError(409, `Port ${port}, which ${what} uses, is taken by ${describeOwner(owner)}. Close that program (or stop that server), then try again.`);
}

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
  // Someone's own database (XAMPP, MySQL...) is theirs to run; CityHQ only checks it answers.
  if (!MANAGED_DB) {
    const conn = await externalDatabase();
    if (!conn || await isPortOpen(Number(conn.port), conn.host)) return false;
    throw new HttpError(503, `Your database at ${conn.host}:${conn.port} (from server.cfg) isn't answering. Start it first, for example MySQL in XAMPP's control panel, then try again.`);
  }
  if (await isPortOpen(DB_PORT)) {
    // Something answers on the database's port: CityHQ's own database, or another one in the way
    // (which the server would then try to use).
    await assertPortIsOurs(DB_PORT, DB_HOME, 'CityHQ\'s database for this server');
    return false;
  }
  spawnDetached(DB_EXE, [`--defaults-file=${DB_INI}`], path.dirname(DB_INI), 'mariadb-console');
  for (let i = 0; i < 30; i++) {
    if (await isPortOpen(DB_PORT)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The database did not start. See logs\\mariadb.err for details.');
}

// Someone's own database isn't one of our processes, so whether it answers is checked now and then.
let externalCheckAt = 0;
function checkExternalDatabase() {
  if (Date.now() - externalCheckAt < 10000) return;
  externalCheckAt = Date.now();
  externalDatabase()
    .then(async (conn) => { state.externalDbUp = conn ? await isPortOpen(Number(conn.port), conn.host) : null; })
    .catch(() => { state.externalDbUp = null; });
}

/** The database server.cfg points at, for a server whose database CityHQ doesn't run. */
export async function externalDatabase() {
  const server = findServerData();
  if (!server) return null;
  try {
    const conn = parseConnection(connectionStringOf(await readCfg(server.cfgPath)));
    if (!conn) return null;
    return { ...conn, host: conn.host === 'localhost' ? '127.0.0.1' : conn.host };
  } catch { return null; }
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
  if (await isPortOpen(TXADMIN_PORT)) {
    // Something answers on txAdmin's port: this server's txAdmin, already running, or another
    // program in the way, which used to look like "already running" and then a stuck start.
    await assertPortIsOurs(TXADMIN_PORT, FXSERVER_DIR, 'this server\'s txAdmin');
    return false;
  }
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
