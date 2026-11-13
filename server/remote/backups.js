// Backups for a hosted server. With a panel: the host's own backups of the whole server (made,
// downloaded and restored through the panel). With any host: CityHQ's copy of the database and
// server.cfg, kept on this PC, when the database answers this PC.
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countTables, dumpDatabase } from '../backups.js';
import { connectionStringOf, parseConnection, readCfg } from '../cfg.js';
import { dbToolsReady, installDbTools } from '../dbtools.js';
import { desktop } from '../desktop.js';
import { recordEvent } from '../events.js';
import {
  findServerData, HttpError, REMOTE, STATE_DIR,
} from '../paths.js';
import { isPortOpen } from '../processes.js';
import { panelClient } from './panel.js';
import { loadSecret } from './secret.js';

const DB_BACKUPS = path.join(STATE_DIR, 'hosted-backups');
const VALID_ID = /^[\w-]{6,80}$/;

const panel = () => {
  if (REMOTE?.type !== 'panel') return null;
  const key = loadSecret(STATE_DIR);
  return key ? panelClient({ url: REMOTE.panelUrl, key, serverId: REMOTE.serverId }) : null;
};

/**
 * The database as this PC can reach it. server.cfg often names the host's internal address, so
 * with a panel the database's public address (and login) comes from the panel's database list.
 */
async function databaseLogin() {
  const server = findServerData();
  const conn = parseConnection(connectionStringOf(await readCfg(server.cfgPath)));
  if (!conn?.database) throw new HttpError(409, 'server.cfg has no database line CityHQ can read.');
  const p = panel();
  if (p) {
    const match = (await p.databases.list().catch(() => [])).find((d) => d.name === conn.database);
    if (match?.host) return { host: match.host, port: match.port, user: match.username, password: match.password, database: match.name };
  }
  return { ...conn, port: Number(conn.port) || 3306 };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

async function localBackups() {
  if (!existsSync(DB_BACKUPS)) return [];
  const out = [];
  for (const id of await readdir(DB_BACKUPS)) {
    const dir = path.join(DB_BACKUPS, id);
    try {
      const files = await readdir(dir);
      let size = 0;
      for (const f of files) size += (await stat(path.join(dir, f))).size;
      out.push({ id, createdAt: (await stat(dir)).mtimeMs, size, parts: files.map((f) => f.replace(/\..*$/, '')) });
    } catch { /* half-made */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** What the Backups page shows for a hosted server. */
export async function hostedBackups() {
  const p = panel();
  let host = null;
  let limit = null;
  let hostError = null;
  if (p) {
    try {
      [host, limit] = await Promise.all([p.backups.list(), p.limits().then((l) => l.backups)]);
    } catch (err) { hostError = err.message; }
  }
  return {
    kind: REMOTE.type,
    host, limit, hostError,
    local: await localBackups(),
    canOpenFolder: Boolean(desktop()?.openFolder),
  };
}

export async function createHostBackup() {
  const p = panel();
  if (!p) throw new HttpError(409, 'Your host\'s backups need the panel API key connection.');
  await p.backups.create(`CityHQ ${new Date().toLocaleString()}`);
  return { started: true };
}

export async function hostBackupLink(id) {
  if (!VALID_ID.test(String(id))) throw new HttpError(400, 'Invalid backup');
  const url = await panel()?.backups.downloadUrl(id);
  if (!url) throw new HttpError(409, 'Your host doesn\'t offer a download for this backup.');
  return { url };
}

/** Puts a host backup back: the server is stopped first, then the host restores its files. */
export async function restoreHostBackup(id) {
  if (!VALID_ID.test(String(id))) throw new HttpError(400, 'Invalid backup');
  const p = panel();
  if (!p) throw new HttpError(409, 'Your host\'s backups need the panel API key connection.');
  await p.power('stop').catch(() => {});
  for (let i = 0; i < 30 && (await p.resources().catch(() => ({ state: 'offline' }))).state !== 'offline'; i++) await new Promise((r) => setTimeout(r, 2000));
  await p.backups.restore(id);
  recordEvent({ title: 'Your host is restoring a backup', detail: 'The server stays off while the host puts the files back. Start it from Home when it\'s done.' });
  return { restoring: true };
}

export async function deleteHostBackup(id) {
  if (!VALID_ID.test(String(id))) throw new HttpError(400, 'Invalid backup');
  const p = panel();
  if (!p) throw new HttpError(409, 'Your host\'s backups need the panel API key connection.');
  await p.backups.remove(id);
  return { deleted: id };
}

/** CityHQ's own copy of the database and server.cfg, kept on this PC. */
export async function createDatabaseBackup() {
  const conn = await databaseLogin();
  if (!(await isPortOpen(conn.port, conn.host, 5000))) {
    throw new HttpError(409, `This PC can't reach your host's database (${conn.host}:${conn.port}). Use your host's own backups, or allow connections to the database from anywhere in your host's panel.`);
  }
  // The database programs come once from MariaDB's official download, as for anyone's own database.
  if (!dbToolsReady()) await installDbTools();
  const id = `${stamp()}-database`;
  const dir = path.join(DB_BACKUPS, id);
  await mkdir(dir, { recursive: true });
  try {
    await dumpDatabase(conn, path.join(dir, 'database.sql'));
    await writeFile(path.join(dir, 'server.cfg'), await readCfg(findServerData().cfgPath));
    const tables = await countTables(conn, conn.database).catch(() => null);
    return { id, tables };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function deleteDatabaseBackup(id) {
  if (!VALID_ID.test(String(id))) throw new HttpError(400, 'Invalid backup');
  await rm(path.join(DB_BACKUPS, id), { recursive: true, force: true });
  return { deleted: id };
}

export async function openDatabaseBackups() {
  await mkdir(DB_BACKUPS, { recursive: true });
  await desktop()?.openFolder?.(DB_BACKUPS);
  return { opened: true };
}
