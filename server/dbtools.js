// The mariadb client programs CityHQ uses for backups, SQL files, table checks and the player list.
// A server made by setup has its own copy. For anyone else's database (XAMPP, MySQL, MariaDB...),
// CityHQ downloads the official MariaDB package once, checks it against its published checksum,
// and keeps only the two client programs and their login plugins (about 18 MB).
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir, readFile, rename, rm, stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DB_HOME, HttpError, MANAGED_DB, TOOLS_DIR,
} from './paths.js';

const exec = promisify(execFile);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
/** The same version setup\Install-Server.ps1 installs. */
export const MARIADB_VERSION = '12.3.3';
const PACKAGE = `mariadb-${MARIADB_VERSION}-winx64`;
const ZIP = `${PACKAGE}.zip`;
const BASE = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages`;
export const TOOLS_HOME = path.join(TOOLS_DIR, 'mariadb');

const home = () => (MANAGED_DB ? DB_HOME : TOOLS_HOME);
const binary = (name) => path.join(home(), 'bin', name);

/** True when the client programs are there to use. */
export const dbToolsReady = () => existsSync(binary('mariadb.exe')) && existsSync(binary('mariadb-dump.exe'));

function tool(name) {
  if (!dbToolsReady()) {
    throw new HttpError(409, MANAGED_DB
      ? 'The database programs are missing from the server folder. Run setup again to repair it.'
      : 'CityHQ is still getting its database tools (a one-time download). Try again in a minute; if it keeps saying this, check the internet connection and open the Health page.');
  }
  return binary(name);
}
export const dbClient = () => tool('mariadb.exe');
export const dbDump = () => tool('mariadb-dump.exe');

/**
 * How the client programs reach the database. The password goes in the environment (clientEnv),
 * never on the command line, where other programs could read it.
 */
export function clientArgs(conn) {
  const args = [`--host=${conn.host}`, `--port=${conn.port}`, `--user=${conn.user}`, '--skip-ssl', '--default-character-set=utf8mb4'];
  // Logins such as MySQL 8's caching_sha2_password come from the plugins kept beside the programs.
  if (!MANAGED_DB) args.push(`--plugin-dir=${path.join(TOOLS_HOME, 'lib', 'plugin')}`);
  return args;
}
export const clientEnv = (conn) => ({ ...process.env, MYSQL_PWD: conn.password });

/** The expected checksum for a file, from a sha256sums.txt list. */
export function checksumFor(list, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = String(list).split(/\r?\n/).find((l) => new RegExp(`\\s\\*?(\\./)?${esc}\\s*$`).test(l));
  return line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Downloads with Windows' own curl, which retries through the timeouts some networks give. */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const part = `${dest}.part`;
    const child = spawn(CURL, [
      '--location', '--fail', '--silent', '--show-error', '--retry', '6', '--retry-delay', '3', '--retry-all-errors',
      '--connect-timeout', '30', '--output', part, url,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = onProgress ? setInterval(() => { stat(part).then((s) => onProgress(s.size)).catch(() => {}); }, 1000) : null;
    child.on('error', (err) => { clearInterval(timer); reject(err); });
    child.on('close', async (code) => {
      clearInterval(timer);
      if (code !== 0) {
        await rm(part, { force: true }).catch(() => {});
        reject(new HttpError(502, `Could not download the database tools: ${stderr.trim().split('\n').pop() || `curl stopped (${code})`}. Check the internet connection and try again.`));
        return;
      }
      try { await rename(part, dest); resolve(); } catch (err) { reject(err); }
    });
  });
}

let installing = null;
let progress = null;
let lastError = null;

/** Where a download in progress is, for the Welcome screen: { step, mb } or null. */
export const dbToolsProgress = () => progress;

/** Everything the Welcome screen polls for: ready, the step in progress, or why it failed. */
export const dbToolsState = () => ({
  ready: MANAGED_DB || dbToolsReady(), running: Boolean(installing), progress, error: lastError,
});

/** Gets the client programs if they aren't there yet. Calls made meanwhile share one download. */
export function installDbTools() {
  if (MANAGED_DB || dbToolsReady()) return Promise.resolve({ ready: true, changed: false });
  if (!installing) {
    lastError = null;
    installing = fetchTools()
      .catch((err) => { lastError = err.message; throw err; })
      .finally(() => { installing = null; progress = null; });
  }
  return installing;
}

async function fetchTools() {
  const work = path.join(TOOLS_DIR, 'download');
  await mkdir(work, { recursive: true });
  const zip = path.join(work, ZIP);
  const sumsFile = path.join(work, 'sha256sums.txt');
  progress = { step: 'Downloading the database tools', mb: 0 };
  await download(`${BASE}/sha256sums.txt`, sumsFile);
  const expected = checksumFor(await readFile(sumsFile, 'utf8'), ZIP);
  if (!expected) throw new HttpError(502, 'MariaDB\'s checksum list did not include the download, so nothing was installed.');
  if (!existsSync(zip) || await sha256(zip) !== expected) {
    await download(`${BASE}/${ZIP}`, zip, (bytes) => { progress = { step: 'Downloading the database tools', mb: Math.round(bytes / 1048576) }; });
  }
  progress = { step: 'Checking the download', mb: null };
  if (await sha256(zip) !== expected) {
    await rm(zip, { force: true });
    throw new HttpError(502, 'The database tools download did not match its published checksum, so nothing was installed. Try again.');
  }
  progress = { step: 'Unpacking', mb: null };
  const unpack = path.join(work, 'unpack');
  await rm(unpack, { recursive: true, force: true });
  await mkdir(unpack, { recursive: true });
  await exec(TAR, ['-xf', zip, '-C', unpack, `${PACKAGE}/bin/mariadb.exe`, `${PACKAGE}/bin/mariadb-dump.exe`, `${PACKAGE}/lib/plugin`], { windowsHide: true, timeout: 300_000 });
  await rm(TOOLS_HOME, { recursive: true, force: true });
  await rename(path.join(unpack, PACKAGE), TOOLS_HOME);
  const { stdout } = await exec(path.join(TOOLS_HOME, 'bin', 'mariadb.exe'), ['--version'], { windowsHide: true, timeout: 15000 });
  if (!/MariaDB/i.test(stdout)) throw new HttpError(500, 'The database tools were unpacked but did not run.');
  await rm(work, { recursive: true, force: true });
  return { ready: true, changed: true };
}
