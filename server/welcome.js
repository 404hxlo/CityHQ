// The Welcome screen: connects a downloaded CityHQ to a server someone already has, or builds them a
// new one. Nothing here is reachable from a phone; choosing a server happens on the PC itself.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  connectionStringOf, gamePortOf, parseConnection, parseBoot,
} from './cfg.js';
import { isSecondary } from './desktop.js';
import {
  APP_DIR, APP_PORT, CONFIG_NAME, findServerData, HOME_DIR, HttpError, POINTER_FILE, portOr, readConfig,
} from './paths.js';
import { isPortOpen } from './processes.js';
import { replaceFile } from './retry.js';

const fs = {
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  dirs: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  files: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
};
const tryOr = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => path.resolve(child).toLowerCase().startsWith(`${path.resolve(parent).toLowerCase()}\\`);
const problem = (level, text) => ({ level, text });

/**
 * txAdmin's data folders keep one folder per profile, each with its own config.json. (txAdmin 8
 * keeps admins.json at the top of txData itself, so admins.json alone doesn't make a profile.)
 */
function profilesIn(txData, io) {
  return tryOr(() => io.dirs(txData), []).filter((d) => io.exists(path.join(txData, d, 'config.json')));
}

/** The txAdmin port a start script sets (TXHOST_TXA_PORT=40120, or the older +set txAdminPort 40120). */
export function txAdminPortIn(text) {
  const m = String(text).match(/TXHOST_TXA_PORT\s*=\s*(\d+)/i) || String(text).match(/txAdminPort\s+"?(\d+)/i);
  return m ? portOr(m[1], null) : null;
}

/**
 * Works out a server's layout from a folder someone picked: the server's main folder, FiveM's
 * server folder (FXServer.exe) or txAdmin's txData folder. Reads only; `io` is swappable for tests.
 * Returns where everything is, the ports, the database, and plain-English problems.
 */
export function inspectServerFolder(picked, io = fs) {
  const dir = path.resolve(picked);
  const problems = [];
  const hasFx = (d) => io.exists(path.join(d, 'FXServer.exe'));

  // FiveM's server folder: the one picked, a usual name inside it, or any folder one level down.
  const fxCandidates = [dir, ...['server', 'artifacts', 'fxserver', 'FXServer', 'server-files'].map((n) => path.join(dir, n)),
    ...tryOr(() => io.dirs(dir), []).map((n) => path.join(dir, n))];
  let fxserverDir = fxCandidates.find(hasFx) || null;
  const pickedTxData = profilesIn(dir, io).length ? dir : null;
  if (!fxserverDir && pickedTxData) {
    const up = path.dirname(dir);
    fxserverDir = [up, ...['server', 'artifacts'].map((n) => path.join(up, n))].find(hasFx) || null;
  }

  // Start scripts can say where txData is (TXHOST_DATA_PATH, or the older +set txDataPath).
  const scriptDirs = [dir, path.dirname(dir), fxserverDir].filter(Boolean);
  const scripts = [...new Set(scriptDirs.flatMap((d) => tryOr(() => io.files(d), []).filter((f) => /\.(bat|cmd)$/i.test(f)).map((f) => path.join(d, f))))];
  const scriptText = scripts.map((f) => tryOr(() => io.read(f), '')).join('\n');
  const fromScriptData = scriptText.match(/TXHOST_DATA_PATH\s*=\s*"?([^"\r\n]+?)"?\s*$/im)?.[1] || scriptText.match(/txDataPath\s+"?([^"\r\n]+?)"?(\s|$)/im)?.[1];
  // txData: the folder picked, a start script's choice, next to FiveM's folder (txAdmin's usual
  // place), inside it (older txAdmin), or inside the folder picked or one folder below it.
  const txCandidates = [
    pickedTxData,
    fromScriptData && path.resolve(fxserverDir || dir, fromScriptData.trim()),
    fxserverDir && path.resolve(fxserverDir, '..', 'txData'),
    fxserverDir && path.join(fxserverDir, 'txData'),
    path.join(dir, 'txData'),
    ...tryOr(() => io.dirs(dir), []).map((n) => path.join(dir, n, 'txData')),
  ].filter(Boolean);
  const txDataDir = txCandidates.find((d) => profilesIn(d, io).length) || null;
  const profiles = txDataDir ? profilesIn(txDataDir, io) : [];
  const profile = profiles.includes('default') ? 'default' : profiles[0] || 'default';

  if (!fxserverDir) {
    problems.push(problem('bad', 'There\'s no FXServer.exe in this folder. Choose the folder that holds your server: the one with FXServer.exe in it, or the folder above it.'));
  }
  // The server's main folder holds both parts when it can; otherwise the folder picked.
  let root = dir;
  if (txDataDir && fxserverDir && inside(fxserverDir, path.dirname(txDataDir))) root = path.dirname(txDataDir);
  else if (fxserverDir && same(fxserverDir, dir)) root = path.dirname(dir);
  else if (pickedTxData) root = path.dirname(dir);
  const cityhqMade = io.exists(path.join(root, 'db', 'mariadb', 'bin', 'mariadbd.exe'));
  const saved = tryOr(() => JSON.parse(io.read(path.join(root, CONFIG_NAME))), {});

  // txAdmin's settings: where the server's own folder (resources, server.cfg) is.
  let dataPath = null;
  let cfgPath = null;
  if (!txDataDir) {
    if (fxserverDir) problems.push(problem('warn', 'txAdmin hasn\'t been set up for this server yet. CityHQ can start txAdmin for you, then you finish its setup in the browser.'));
  } else {
    const tx = tryOr(() => JSON.parse(io.read(path.join(txDataDir, profile, 'config.json'))), null);
    dataPath = tx?.server?.dataPath || tx?.fxRunner?.serverDataPath || null;
    const cfgName = tx?.server?.cfgPath || tx?.fxRunner?.cfgPath || 'server.cfg';
    if (dataPath && io.exists(path.resolve(dataPath, cfgName))) {
      cfgPath = path.resolve(dataPath, cfgName);
      dataPath = path.resolve(dataPath);
    }
    else {
      dataPath = null;
      problems.push(problem('warn', 'txAdmin is there, but no server has been deployed with it yet. Finish txAdmin\'s setup (choose the QBCore recipe), then CityHQ can manage it.'));
    }
  }

  const cfg = cfgPath ? tryOr(() => io.read(cfgPath), '') : '';
  const gamePort = cityhqMade ? portOr(saved.gamePort, 30121) : gamePortOf(cfg) || portOr(saved.gamePort, 30120);
  if (cfgPath && !cityhqMade && !gamePortOf(cfg)) {
    problems.push(problem('warn', `server.cfg has no endpoint_add_tcp line, so CityHQ assumes the game port is ${gamePort}.`));
  }

  // The txAdmin port: CityHQ's own setting, a start script's, or txAdmin's usual 40120.
  const fromScript = txAdminPortIn(scriptText);
  const txAdminPort = portOr(saved.txAdminPort, null) || fromScript || 40120;

  // The database scripts use, from server.cfg. The password is never sent back to the screen.
  const conn = cfgPath ? parseConnection(connectionStringOf(cfg)) : null;
  const database = conn ? {
    host: conn.host, port: Number(conn.port), user: conn.user, name: conn.database, hasPassword: Boolean(conn.password), managed: cityhqMade,
  } : null;
  if (cfgPath && !database) problems.push(problem('bad', 'server.cfg has no mysql_connection_string line, so scripts (and CityHQ) can\'t reach the database. Add the one your database setup gave you.'));
  else if (database && !database.name) problems.push(problem('bad', 'The mysql_connection_string in server.cfg doesn\'t name a database.'));

  // CityHQ is made for QBCore; other frameworks mostly work for starting and stopping only.
  const boot = cfg ? parseBoot(cfg) : null;
  const qbcore = Boolean(boot && (boot.names.has('qb-core') || (dataPath && io.exists(path.join(dataPath, 'resources', '[qb]', 'qb-core')))));
  if (cfgPath && !qbcore) problems.push(problem('warn', 'This doesn\'t look like a QBCore server. Starting, stopping, files and backups work, but the player tools are made for QBCore.'));

  return {
    folder: dir,
    found: Boolean(fxserverDir),
    root,
    fxserverDir,
    txDataDir: txDataDir || (fxserverDir ? path.resolve(fxserverDir, '..', 'txData') : null),
    profile,
    dataPath,
    cfgPath,
    gamePort,
    txAdminPort,
    database,
    qbcore,
    cityhqMade,
    problems,
  };
}

/** The checks that need the network: is txAdmin already running, does the database answer. */
export async function checkServerFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder)) throw new HttpError(400, 'Choose a folder on this PC.');
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new HttpError(404, 'That folder doesn\'t exist.');
  const result = inspectServerFolder(folder);
  if (result.found) {
    result.txAdminRunning = await isPortOpen(result.txAdminPort);
    if (result.database) {
      const host = result.database.host === 'localhost' ? '127.0.0.1' : result.database.host;
      result.databaseUp = await isPortOpen(result.database.port, host);
      if (!result.databaseUp && !result.cityhqMade) {
        result.problems.push(problem('warn', `The database at ${result.database.host}:${result.database.port} isn't answering right now. Start it before starting the server, for example MySQL in XAMPP's control panel.`));
      }
    }
  }
  return result;
}

// ---- finding servers on this PC ----
const SKIP = /^(\$recycle\.bin|system volume information|windows|program files|program files \(x86\)|programdata|appdata|node_modules|\.git|resources|cache|stream|txdata|recovery|perflogs|msocache)$/i;

/** Folders worth searching: each drive's top folders and the user's Desktop, Documents and Downloads. */
function searchStarts() {
  const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => tryOr(() => existsSync(d), false));
  const home = os.homedir();
  return [...drives, ...['Desktop', 'Documents', 'Downloads', path.join('OneDrive', 'Desktop'), path.join('OneDrive', 'Documents')].map((d) => path.join(home, d))].filter((d) => tryOr(() => existsSync(d), false));
}

/** Every FiveM server folder found within three levels of the usual places, within a time limit. */
export function findServerFolders({ starts = searchStarts(), maxDepth = 3, timeLimitMs = 8000, io = fs } = {}) {
  const deadline = Date.now() + timeLimitMs;
  const found = new Map();
  const visit = (dir, depth) => {
    if (Date.now() > deadline || depth > maxDepth) return;
    if (io.exists(path.join(dir, 'FXServer.exe'))) {
      found.set(dir.toLowerCase(), dir);
      return;
    }
    for (const name of tryOr(() => io.dirs(dir), [])) {
      if (!SKIP.test(name)) visit(path.join(dir, name), depth + 1);
    }
  };
  for (const start of starts) visit(start, 0);
  return [...found.values()];
}

/** Servers found on this PC, each inspected, without duplicates. */
export async function scanForServers() {
  const seen = new Set();
  const out = [];
  for (const fx of findServerFolders()) {
    const result = inspectServerFolder(fx);
    const key = result.root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

// ---- saving the choice ----
/**
 * Saves which server this CityHQ manages: the server folder's qbcontrol.json gets where its parts
 * are (only what differs from setup's layout, and never replacing what's already there), and
 * CityHQ's own folder remembers the server folder. A test copy never changes an existing file.
 */
export async function useServer(folder, { txAdminPort } = {}) {
  const found = await checkServerFolder(folder);
  if (!found.found) throw new HttpError(400, found.problems[0]?.text || 'That isn\'t a server folder.');
  const file = path.join(found.root, CONFIG_NAME);
  const existing = readConfig(found.root);
  const hadFile = existsSync(file);
  if (!(hadFile && isSecondary())) {
    const rel = (p) => (inside(p, found.root) ? path.relative(found.root, p) : p);
    const layout = {};
    if (!same(found.fxserverDir, path.join(found.root, 'server'))) layout.fxserverDir = rel(found.fxserverDir);
    if (!same(found.txDataDir, path.join(found.root, 'txData'))) layout.txDataDir = rel(found.txDataDir);
    if (found.profile !== 'default') layout.profile = found.profile;
    layout.database = found.cityhqMade ? 'managed' : 'external';
    layout.txAdminPort = portOr(txAdminPort, null) || found.txAdminPort;
    if (!found.cityhqMade) layout.gamePort = found.gamePort;
    const merged = { ...layout, ...existing };
    // A txAdmin port typed on the Welcome screen is a deliberate choice, so it wins.
    if (portOr(txAdminPort, null)) merged.txAdminPort = portOr(txAdminPort, null);
    if (!hadFile || JSON.stringify(merged) !== JSON.stringify(existing)) {
      await (hadFile ? replaceFile(file, JSON.stringify(merged, null, 2)) : writeFile(file, JSON.stringify(merged, null, 2)));
    }
  }
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(POINTER_FILE, JSON.stringify({ serverRoot: found.root, chosenAt: new Date().toISOString() }, null, 2));
  return { root: found.root, external: !found.cityhqMade };
}

/** Forgets the chosen server, so the Welcome screen shows at the next start. */
export async function forgetServer() {
  await rm(POINTER_FILE, { force: true });
}

// ---- building a new server ----
let job = null;

/** A free place for a new server: C:\QBCore-Server, or the first numbered one that is free. */
export function suggestNewFolder(exists = existsSync) {
  const drive = exists('D:\\') && tryOr(() => statSync('D:\\').isDirectory(), false) ? 'D:' : 'C:';
  for (let i = 1; i < 50; i++) {
    const candidate = `${drive}\\QBCore-Server${i === 1 ? '' : `-${i}`}`;
    if (!exists(candidate)) return candidate;
  }
  return `${drive}\\QBCore-Server-new`;
}

export const newServerJob = () => job && { ...job, lines: job.lines.slice(-200) };

/**
 * Runs setup into a new folder (FiveM's server, a private database and free ports), streaming its
 * steps for the screen. Setup itself refuses folders that aren't new or empty.
 */
export function startNewServer(folder) {
  if (job?.running) throw new HttpError(409, 'A new server is already being set up.');
  if (typeof folder !== 'string' || !/^[A-Za-z]:\\[^\s"]+$/.test(folder.trim())) {
    throw new HttpError(400, 'Choose a folder on this PC with no spaces in its path, such as C:\\QBCore-Server.');
  }
  const root = path.resolve(folder.trim());
  const script = path.join(APP_DIR, 'setup', 'Install-Server.ps1');
  if (!existsSync(script)) throw new HttpError(500, 'The setup script is missing from this copy of CityHQ. Download it again.');
  job = { running: true, root, lines: [], ok: null, error: null, startedAt: Date.now() };
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, '-Yes', '-NoApp', '-NoShortcuts', '-NoStart', '-AppPort', String(APP_PORT)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (chunk) => {
    for (const raw of String(chunk).split(/\r?\n|\r/)) {
      // curl's progress bar is noise on screen; setup's own lines are what matter.
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (line.trim() && !/^[#\s.0-9%]+$/.test(line)) job.lines.push(line);
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('error', (err) => { job.running = false; job.ok = false; job.error = err.message; });
  child.on('close', async (code) => {
    job.running = false;
    job.ok = code === 0 && existsSync(path.join(root, CONFIG_NAME));
    if (!job.ok) {
      job.error = [...job.lines].reverse().find((l) => /^Setup stopped:/.test(l))?.replace(/^Setup stopped:\s*/, '') || `Setup stopped (code ${code}).`;
      return;
    }
    try {
      await mkdir(HOME_DIR, { recursive: true });
      await writeFile(POINTER_FILE, JSON.stringify({ serverRoot: root, chosenAt: new Date().toISOString() }, null, 2));
    } catch (err) { job.ok = false; job.error = err.message; }
  });
  return newServerJob();
}

// ---- after a new server: txAdmin's PIN ----
/** The PIN txAdmin prints for its first sign-in, from its console log, or null. */
export function txAdminPinIn(text) {
  // txAdmin prints the PIN in a box on the line after "Use the PIN below"; times in the line
  // prefixes have only two digits, and ports five, so the first four-digit number is the PIN.
  const matches = [...String(text).matchAll(/\bPIN\b[\s\S]{0,240}?(?<![\d:])(\d{4})(?![\d:])/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

export function readTxAdminPin(logDir) {
  return txAdminPinIn(tryOr(() => {
    const text = readFileSync(path.join(logDir, 'txadmin-console.log'), 'utf8');
    return text.slice(-20000);
  }, ''));
}

/** Whether txAdmin has a deployed server yet, for the "not set up" screen. */
export const deployed = () => Boolean(findServerData());
