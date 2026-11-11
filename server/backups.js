// Whole-server backups: the database, server.cfg, and every resource's scripts and settings.
// Large game assets (stream folders) are left out: they never change, and including them would
// make each backup about 7 times bigger and 5 times slower.
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { agentRequest } from './agent.js';
import {
  connectionStringOf, parseConnection, readCfg, writeCfg,
} from './cfg.js';
import {
  clientArgs, clientEnv, dbClient, dbDump,
} from './dbtools.js';
import { findServerData, HttpError, STATE_DIR } from './paths.js';
import { ensureDatabase } from './processes.js';
import { retry } from './retry.js';
import { getSettings } from './settings.js';

const exec = promisify(execFile);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
export const BACKUP_DIR_ROOT = path.join(STATE_DIR, 'server-backups');
const SAFE_DB = /^[\w$-]+$/;
const SAFETY_REASONS_KEEP = 10;
const PARTS = ['database', 'settings', 'scripts'];

let working = null;

export const backupStatus = () => working;

function requireServer() {
  const server = findServerData();
  if (!server) throw new HttpError(409, 'The server has not been deployed yet.');
  return server;
}

async function connection(cfgPath) {
  const conn = parseConnection(connectionStringOf(await readCfg(cfgPath)));
  if (!conn?.database || !SAFE_DB.test(conn.database)) throw new HttpError(400, 'Could not read the database settings from server.cfg.');
  return conn;
}

const lastLine = (err) => String(err.stderr || err.message || err).trim().split('\n').pop();

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Backups run while people play, so they must never take CPU time away from the game. */
function gently(run) {
  try {
    if (run.child?.pid) setPriority(run.child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch { /* it can finish first, and the backup works either way */ }
  return run;
}

/**
 * Errors the database itself says to retry. 1412 happens when a table is created or changed
 * while the backup reads it, for example by a script setting up its tables, or by a database
 * file that was run a moment before.
 */
export const isRetryableDumpError = (err) => /\b(1412|1205|1213)\b|Table definition has changed|Lock wait timeout|Deadlock found/i
  .test(`${err?.stderr || ''} ${err?.message || ''}`);

async function dumpDatabase(conn, file, { run = exec, wait } = {}) {
  try {
    const dump = dbDump();
    await retry(() => gently(run(dump, [
      ...clientArgs(conn), '--single-transaction', '--quick', '--routines', '--events', '--triggers',
      `--result-file=${file}`, conn.database,
    ], { env: clientEnv(conn), windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })), {
      attempts: 4, firstDelayMs: 1500, retryable: isRetryableDumpError, wait,
    });
  } catch (err) {
    throw new HttpError(500, `The database could not be backed up: ${lastLine(err)}`);
  }
  // A dump that was cut short looks fine until you need it, so confirm it finished.
  const { size } = await stat(file);
  const handle = await open(file, 'r');
  try {
    const tail = Buffer.alloc(Math.min(200, size));
    await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    if (!tail.toString().includes('Dump completed')) throw new HttpError(500, 'The database backup did not finish properly.');
  } finally {
    await handle.close();
  }
}

async function runSql(conn, sql, database) {
  const args = [...clientArgs(conn), '--batch', '--skip-column-names', `--execute=${sql}`];
  if (database) args.push(database);
  const { stdout } = await exec(dbClient(), args, { env: clientEnv(conn), windowsHide: true, timeout: 120_000 });
  return stdout.trim();
}

const countTables = async (conn, database) => Number(await runSql(conn, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${database}';`));

function importFile(conn, database, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(dbClient(), [...clientArgs(conn), database], { env: clientEnv(conn), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').pop() || `exit ${code}`))));
    createReadStream(file).on('error', reject).pipe(child.stdin);
  });
}

/**
 * Restores a database dump. It is first loaded into a scratch database, so a damaged backup is
 * caught while the real data is still untouched. Exported so it can be tested on a scratch name.
 */
export async function restoreDatabaseFrom(conn, database, file, expectedTables) {
  if (!SAFE_DB.test(database)) throw new HttpError(400, 'Invalid database name');
  const check = `${database}_qbc_check`.slice(0, 64);
  try {
    await runSql(conn, `DROP DATABASE IF EXISTS \`${check}\`; CREATE DATABASE \`${check}\` CHARACTER SET utf8mb4;`);
    await importFile(conn, check, file);
    const found = await countTables(conn, check);
    if (expectedTables !== undefined && found !== expectedTables) {
      throw new Error(`the backup has ${found} tables but should have ${expectedTables}`);
    }
  } catch (err) {
    throw new HttpError(500, `This backup's database could not be read, so nothing was changed: ${err.message}`);
  } finally {
    await runSql(conn, `DROP DATABASE IF EXISTS \`${check}\`;`).catch(() => {});
  }
  await runSql(conn, `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4;`);
  await importFile(conn, database, file);
}

const describe = (manifest, size) => ({
  id: manifest.id,
  createdAt: manifest.createdAt,
  reason: manifest.reason,
  parts: manifest.parts,
  size,
  tables: manifest.tables,
  skipped: manifest.skipped || [],
});

const ZIP_ARGS = (zip, folder) => ['-a', '-cf', zip, '--exclude=stream', '--exclude=node_modules', '--exclude=.git', '-C', folder, '.'];
const TAR_OPTIONS = { windowsHide: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 };
const MAX_SKIPPED_LISTED = 20;

/**
 * Zips the scripts. The server is live, so a file can be busy or a folder can be moved while
 * this reads them; tar then finishes everything else but reports failure. One busy file mustn't
 * cost the whole backup, so try once more, then keep what was saved and say what was skipped.
 */
export async function archiveScripts(zip, folder) {
  let complaints = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await rm(zip, { force: true });
    try {
      await gently(exec(TAR, ZIP_ARGS(zip, folder), TAR_OPTIONS));
      return [];
    } catch (err) {
      complaints = String(err.stderr || err.message).split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !/Error exit delayed/.test(l));
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 3000));
  }
  // Only keep it if what was written can actually be read back.
  try {
    await exec(TAR, ['-tf', zip], TAR_OPTIONS);
  } catch {
    throw new HttpError(500, `Scripts could not be backed up: ${complaints[0] || 'the zip could not be created'}`);
  }
  return complaints.slice(0, MAX_SKIPPED_LISTED).map((l) => l.replace(/^tar(\.exe)?:\s*/, ''));
}

async function folderSize(dir) {
  let total = 0;
  for (const name of await readdir(dir)) total += (await stat(path.join(dir, name))).size;
  return total;
}

async function prune() {
  const all = await listBackups();
  const keep = getSettings().backups.keep;
  const nightly = all.filter((b) => b.reason === 'nightly');
  const safety = all.filter((b) => b.reason.startsWith('before-'));
  const remove = [...nightly.slice(keep), ...safety.slice(SAFETY_REASONS_KEEP)];
  for (const b of remove) await rm(path.join(BACKUP_DIR_ROOT, b.id), { recursive: true, force: true });
}

/** reason: manual, nightly, or before-something. Manual backups are never deleted automatically. */
export async function createBackup(reason = 'manual', { parts = PARTS } = {}) {
  if (working) throw new HttpError(409, 'A backup is already running. Please wait for it to finish.');
  const { cfgPath, dataPath } = requireServer();
  const now = new Date();
  const id = `${stamp(now)}-${reason}`;
  const partial = path.join(BACKUP_DIR_ROOT, `${id}.partial`);
  const final = path.join(BACKUP_DIR_ROOT, id);
  working = { id, reason, step: 'Saving players' };
  try {
    await mkdir(partial, { recursive: true });
    // Players' latest progress is only in memory until it is saved.
    await agentRequest('/save-players', { method: 'POST', timeoutMs: 8000 }).catch(() => null);

    const manifest = { id, createdAt: now.getTime(), reason, parts, dataPath };
    if (parts.includes('database')) {
      working.step = 'Backing up the database';
      await ensureDatabase();
      const conn = await connection(cfgPath);
      await dumpDatabase(conn, path.join(partial, 'database.sql'));
      manifest.database = conn.database;
      manifest.tables = await countTables(conn, conn.database);
    }
    if (parts.includes('settings')) {
      working.step = 'Backing up server settings';
      await copyFile(cfgPath, path.join(partial, 'server.cfg'));
    }
    if (parts.includes('scripts')) {
      working.step = 'Backing up scripts and resource settings';
      manifest.skipped = await archiveScripts(path.join(partial, 'resources.zip'), path.join(dataPath, 'resources'));
    }
    await writeFile(path.join(partial, 'backup.json'), JSON.stringify(manifest, null, 2));
    await rename(partial, final);
    await prune();
    return describe(manifest, await folderSize(final));
  } catch (err) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    working = null;
  }
}

export async function listBackups() {
  if (!existsSync(BACKUP_DIR_ROOT)) return [];
  const out = [];
  for (const entry of await readdir(BACKUP_DIR_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith('.partial')) continue;
    const dir = path.join(BACKUP_DIR_ROOT, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'backup.json'), 'utf8'));
      out.push(describe(manifest, await folderSize(dir)));
    } catch { /* an unreadable folder isn't a usable backup */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const isValidBackupId = (id) => typeof id === 'string' && /^\d{8}-\d{6}-[\w-]+$/.test(id);

export async function deleteBackup(id) {
  if (!isValidBackupId(id)) throw new HttpError(400, 'Invalid backup');
  const dir = path.join(BACKUP_DIR_ROOT, id);
  if (!existsSync(dir)) throw new HttpError(404, 'That backup no longer exists');
  await rm(dir, { recursive: true, force: true });
  return { deleted: id };
}

export async function readBackup(id) {
  if (!isValidBackupId(id)) throw new HttpError(400, 'Invalid backup');
  const dir = path.join(BACKUP_DIR_ROOT, id);
  if (!existsSync(path.join(dir, 'backup.json'))) throw new HttpError(404, 'That backup no longer exists');
  return { dir, manifest: JSON.parse(await readFile(path.join(dir, 'backup.json'), 'utf8')) };
}

/** Puts the chosen parts back. The caller has already stopped the server and made a safety copy. */
export async function applyBackupParts(id, parts) {
  const { dir, manifest } = await readBackup(id);
  const { cfgPath, dataPath } = requireServer();
  for (const part of parts) {
    if (!manifest.parts.includes(part)) throw new HttpError(400, `This backup does not include ${part}.`);
  }
  if (parts.includes('database')) {
    working = { id, reason: 'restore', step: 'Restoring the database' };
    try {
      await ensureDatabase();
      const conn = await connection(cfgPath);
      await restoreDatabaseFrom(conn, manifest.database || conn.database, path.join(dir, 'database.sql'), manifest.tables);
    } finally { working = null; }
  }
  if (parts.includes('settings')) {
    await writeCfg(cfgPath, await readFile(path.join(dir, 'server.cfg'), 'utf8'));
  }
  if (parts.includes('scripts')) {
    working = { id, reason: 'restore', step: 'Restoring scripts and resource settings' };
    try {
      await exec(TAR, ['-xf', path.join(dir, 'resources.zip'), '-C', path.join(dataPath, 'resources')], { windowsHide: true, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 }).catch((err) => {
        throw new HttpError(500, `Scripts could not be restored: ${lastLine(err)}`);
      });
    } finally { working = null; }
  }
}

export const VALID_PARTS = PARTS;
