// Moving the server on this PC to a host: pack the resources, upload them (continuing where a
// cut connection left off), unpack them on the host, then, once you say so, stop the server
// here, copy the database and server.cfg, put CityHQ's helper there and switch CityHQ over.
// The server on this PC is never changed or deleted; it stays as a fallback.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir, readdir, rm, stat, statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { agentRequest } from '../agent.js';
import { holdAwake, releaseAwake } from '../awake.js';
import {
  connection as localConnection, countTables, dumpDatabase, importFile, runSql,
} from '../backups.js';
import { readCfg } from '../cfg.js';
import { stopServer } from '../control.js';
import { recordEvent } from '../events.js';
import {
  findServerData, HttpError, REMOTE, STATE_DIR, TX_PROFILE,
} from '../paths.js';
import { ensureDatabase, getProcessState, isPortOpen } from '../processes.js';
import { replaceFileSync } from '../retry.js';
import { makeConnection } from '../remote/connection.js';
import { findHostedServer } from '../remote/find.js';
import { databaseAddress, panelClient } from '../remote/panel.js';
import { forgetSecret, loadSecret, saveSecret } from '../remote/secret.js';
import { sftpClient } from '../remote/sftp.js';
import { remoteFrom, useHosted } from '../remote/welcome.js';
import {
  databaseNameFor, execFiles, mergeCfgForHost, preflight,
} from './plan.js';

const exec = promisify(execFile);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const MOVE_DIR = path.join(STATE_DIR, 'move');
const STATE_FILE = path.join(STATE_DIR, 'move.json');
const SECRET_FILE = 'move-secret.bin';
const ZIP_NAME = 'resources.zip';

// ---------------------------------------------------------------- saved state
let state = null;
let running = null;
let abort = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = null; }
  return state;
}
function save() {
  try { replaceFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* shown from memory */ }
}
const secrets = () => {
  try { return JSON.parse(loadSecret(STATE_DIR, SECRET_FILE) || '{}'); } catch { return {}; }
};

/** What the Move screen shows. */
export function moveStatus() {
  const s = load();
  if (!s) return { phase: null };
  const { target, ...rest } = s;
  return { ...rest, target: target ? { type: target.type, name: target.serverName, panelUrl: target.panelUrl || null, host: target.host || null } : null, running: Boolean(running) };
}

// ---------------------------------------------------------------- helpers
async function folderBytes(dir) {
  let total = 0;
  let files = 0;
  const walk = async (d) => {
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') await walk(full); } else if (e.isFile()) {
        try { total += (await stat(full)).size; files += 1; } catch { /* busy */ }
      }
    }
  };
  await walk(dir);
  return { bytes: total, files };
}

const sizeIfThere = async (p) => { try { return (await stat(p)).size; } catch { return null; } };

/** A zip of the resources already on this PC (CityHQ's own, or one made by hand next to them). */
async function localZip(local) {
  for (const p of [path.join(MOVE_DIR, ZIP_NAME), path.join(local.dataPath, ZIP_NAME)]) {
    const size = await sizeIfThere(p);
    if (size) return { path: p, size };
  }
  return null;
}

/** SFTP to the host: the SFTP login itself, or the panel's SFTP details with the panel password. */
async function sftpFor(target, secret) {
  if (target.type === 'sftp') {
    return sftpClient({ host: target.host, port: target.port, username: target.username, password: secret.key, hostKey: target.hostKey || null });
  }
  if (!secret.sftpPassword) throw new HttpError(400, 'Enter your panel password: big uploads go over SFTP, which uses it.');
  return sftpClient({ host: target.sftp.host, port: target.sftp.port, username: target.sftp.username, password: secret.sftpPassword, hostKey: target.hostKey || null });
}

async function reachable(db) {
  if (!db?.host) return false;
  if (!(await isPortOpen(db.port || 3306, db.host, 5000).catch(() => false))) return false;
  try {
    await runSql({ host: db.host, port: db.port, user: db.username, password: db.password }, 'SELECT 1');
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- checking
/**
 * Looks at both sides and says what the move would do, without changing anything (on the host,
 * not even a database). body: the hosted login, plus sftpPassword (panel), and for SFTP-only
 * hosts the database details.
 */
export async function checkMove(body) {
  if (REMOTE) throw new HttpError(409, 'This CityHQ manages a hosted server already. Moving works from a server on this PC.');
  const local = findServerData();
  if (!local) throw new HttpError(409, 'Finish setting up your server on this PC first.');
  const { remote, secret } = remoteFrom(body);
  let hostKey = null;
  const conn = makeConnection(remote, secret, { onHostKey: (f) => { hostKey ||= f; } });
  try {
    const localCfg = await readCfg(local.cfgPath).catch(() => null);
    const found = await findHostedServer(conn.files);
    const [resources, zip, free] = await Promise.all([
      folderBytes(path.join(local.dataPath, 'resources')),
      localZip(local),
      statfs(local.dataPath).then((s) => s.bavail * s.bsize).catch(() => null),
    ]);
    const facts = {
      localCfg, hostFound: Boolean(found), resourcesBytes: resources.bytes, localFreeBytes: free, localZipReady: Boolean(zip),
      localMemoryBytes: getProcessState().memBytes || null,
    };
    const target = { ...remote, hostKey };
    let databases = [];
    let panel = null;
    if (remote.type === 'panel') {
      panel = panelClient({ url: remote.panelUrl, key: secret, serverId: remote.serverId });
      const [details, limits, usage, account, dbs] = await Promise.all([
        panel.details(), panel.limits(), panel.resources().catch(() => null), panel.account(), panel.databases.list().catch(() => []),
      ]);
      target.serverName = details.name;
      target.address = details.address;
      target.sftp = details.sftp ? { ...details.sftp, username: `${account.username}.${remote.serverId}` } : null;
      facts.hostDiskLimitBytes = limits.diskMb ? limits.diskMb * 1024 * 1024 : null;
      facts.hostDiskUsedBytes = usage?.diskBytes ?? null;
      facts.hostMemoryLimitBytes = limits.memoryMb ? limits.memoryMb * 1024 * 1024 : null;
      databases = dbs;
      facts.databaseLimit = limits.databases;
    }
    // What's on the host already: its resources folder, and a zip uploaded earlier.
    if (found) {
      const entries = await conn.files.list(found.dataPath).catch(() => []);
      facts.hostHasResources = entries.some((e) => e.dir && e.name === 'resources');
      const hostZip = entries.find((e) => !e.dir && e.name === ZIP_NAME);
      if (hostZip && zip && hostZip.size === zip.size) facts.alreadyUploaded = true;
      else if (hostZip && zip && hostZip.size < zip.size) facts.partlyUploaded = hostZip.size;
    }
    // The database: one the host already has (the panel shows its password), a new one the panel
    // makes at the start, or (SFTP only) the details typed in.
    let database = null;
    const localName = localCfg ? (await localConnection(local.cfgPath).catch(() => null))?.database : null;
    if (remote.type === 'panel') {
      // Some panels don't share a database's address; then it's typed in (their Databases tab).
      const typed = databaseAddress(body.databaseHost);
      const withAddress = (d) => (d.host ? d : { ...d, host: typed?.host || null, port: typed?.port || d.port });
      const wanted = databaseNameFor(localName);
      // The one chosen, or the one CityHQ made for this move before (panels add a prefix: s1_name).
      const existing = databases.find((d) => d.id === body.databaseId)
        || databases.find((d) => d.name === wanted || String(d.name || '').endsWith(`_${wanted}`));
      if (existing) {
        database = withAddress(existing);
        database.reachable = database.host ? await reachable(database) : null;
        if (database.reachable) database.tables = await countTables({ host: database.host, port: database.port, user: database.username, password: database.password }, database.name).catch(() => 0);
      } else {
        // A new one, made when the move starts. Until then, only the database server can be
        // tried: the host's other databases may only allow the game server to sign in.
        const sample = withAddress(databases[0] || { port: 3306 });
        database = { create: wanted, name: wanted, host: sample.host, port: sample.port || 3306 };
        database.reachable = database.host ? await isPortOpen(database.port, database.host, 5000).catch(() => false) : null;
        if (facts.databaseLimit !== null && databases.length >= facts.databaseLimit) {
          database = { ...database, limitReached: true };
        }
      }
      if (!database.host) database.needsAddress = true;
    } else if (body.database?.host) {
      const d = body.database;
      database = { host: String(d.host).trim(), port: Number(d.port) || 3306, name: String(d.name || '').trim(), username: String(d.username || '').trim(), password: String(d.password || '') };
      database.reachable = await reachable(database);
      if (database.reachable) database.tables = await countTables({ host: database.host, port: database.port, user: database.username, password: database.password }, database.name).catch(() => 0);
    }
    facts.database = database;
    const report = preflight(facts);
    if (database?.limitReached) report.items.push({ level: 'bad', text: 'Your plan\'s database limit is reached, so CityHQ can\'t make a new one. Pick an existing database, or delete one in your host\'s panel.' }), report.ok = false;
    return {
      ...report,
      target: { type: target.type, name: target.serverName || target.host, address: target.address || null, dataPath: found?.dataPath || null },
      resources: resources,
      databases: databases.map(({ password, ...d }) => d),
      database: database ? {
        name: database.name, host: database.host, port: database.port, create: Boolean(database.create), reachable: database.reachable,
        tables: database.tables ?? null, needsAddress: Boolean(database.needsAddress),
      } : null,
      alreadyUploaded: Boolean(facts.alreadyUploaded),
      _internal: { target, found, database, zip, localName },
    };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------- moving
/** Starts (or continues) the long part: pack, upload, unpack. The server here keeps running. */
export async function startMove(body) {
  if (running) throw new HttpError(409, 'The move is already running.');
  let s = load();
  if (!s || body?.restart) {
    const check = await checkMove(body);
    if (!check.ok) throw new HttpError(409, check.items.find((i) => i.level === 'bad')?.text || 'Fix the problems shown first.');
    const { target, found, zip } = check._internal;
    let { database } = check._internal;
    const login = remoteFrom(body);
    // A new database is made now, not at the end: if this PC can't sign in to it, that's found
    // out before your server here is stopped.
    if (database?.create && target.type === 'panel') {
      const panel = panelClient({ url: target.panelUrl, key: login.secret, serverId: target.serverId });
      const made = await panel.databases.create(database.create, '%');
      database = { ...made, host: made.host || database.host, port: made.host ? made.port : database.port, create: null };
      if (!(await reachable(database))) {
        const from = made.connectionsFrom && made.connectionsFrom !== '%' ? ` It only allows connections from ${made.connectionsFrom}.` : '';
        throw new HttpError(409, `Your host made the database "${made.name}", but this PC can't sign in to it.${from} Ask your host to let it accept connections from anywhere ("%"), then check again: CityHQ uses that database instead of making another.`);
      }
    }
    saveSecret(STATE_DIR, JSON.stringify({ key: login.secret, sftpPassword: body.sftpPassword || null, dbPassword: database?.password || null }), SECRET_FILE);
    state = s = {
      phase: 'moving',
      startedAt: Date.now(),
      target: { ...target, dataPath: found.dataPath, cfgPath: found.cfgPath, txProfile: found.txProfile || null },
      database: database ? { ...database, password: undefined } : null,
      steps: {
        pack: { done: Boolean(zip), zip: zip?.path || null, size: zip?.size || null },
        upload: { done: Boolean(check.alreadyUploaded), sent: check.alreadyUploaded ? zip?.size : 0, total: zip?.size || null, safe: null },
        unpack: { done: false },
        files: { done: false },
      },
      error: null,
      copyPlayersDb: body?.copyPlayersDb !== false,
    };
    save();
  }
  s.phase = 'moving';
  s.error = null;
  save();
  abort = new AbortController();
  holdAwake('move');
  running = runMoving(abort.signal)
    .catch((err) => {
      state.error = err.status === 499 ? null : err.message;
      state.phase = err.status === 499 ? 'paused' : 'stopped';
      save();
      if (err.status !== 499) recordEvent({ level: 'alert', title: 'Moving to your host stopped', detail: `${err.message} Open Settings, Move to a host, to continue.` });
    })
    .finally(() => { running = null; abort = null; releaseAwake('move'); });
  return moveStatus();
}

export function pauseMove() {
  abort?.abort();
  return moveStatus();
}

async function runMoving(signal) {
  const s = state;
  const local = findServerData();
  const secret = secrets();
  const t = s.target;
  const conn = makeConnection(t, secret.key);
  if (t.type === 'panel' && !t.sftp) throw new HttpError(409, 'Your panel doesn\'t show SFTP details for this server, which the upload needs. Ask your host to turn SFTP on.');
  const sftp = await sftpFor(t, secret);
  const panel = t.type === 'panel' ? panelClient({ url: t.panelUrl, key: secret.key, serverId: t.serverId }) : null;
  try {
    // 1. Pack everything in resources, maps and cars included, into CityHQ's own folder.
    if (panel && !s.steps.pack.done) {
      s.step = 'pack';
      save();
      await mkdir(MOVE_DIR, { recursive: true });
      const zip = path.join(MOVE_DIR, ZIP_NAME);
      await rm(zip, { force: true });
      const ticker = setInterval(async () => { s.steps.pack.packed = await sizeIfThere(zip); save(); }, 3000);
      try {
        await exec(TAR, ['-a', '-cf', zip, '--exclude=.git', '--exclude=node_modules', '-C', local.dataPath, 'resources'], { windowsHide: true, timeout: 12 * 3600_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        // tar finishes but complains about a file in use; the zip is kept if it can be read.
        await exec(TAR, ['-tf', zip], { windowsHide: true, timeout: 3600_000, maxBuffer: 256 * 1024 * 1024 }).catch(() => { throw new HttpError(500, `Packing your resources failed: ${String(err.stderr || err.message).trim().split('\n').pop()}`); });
      } finally { clearInterval(ticker); }
      s.steps.pack = { done: true, zip, size: await sizeIfThere(zip) };
      s.steps.upload = { done: false, sent: 0, total: s.steps.pack.size, safe: null };
      save();
    }
    if (signal.aborted) throw new HttpError(499, 'Paused');

    // 2. Upload, continuing from the last point known to be complete.
    if (panel && !s.steps.upload.done) {
      s.step = 'upload';
      save();
      const startedAt = Date.now();
      let lastSave = 0;
      const remoteZip = path.posix.join(t.dataPath, ZIP_NAME);
      try {
        await sftp.uploadFile(s.steps.pack.zip, remoteZip, {
          from: s.steps.upload.safe,
          signal,
          onProgress: (sent, total, safe) => {
            s.steps.upload.sent = sent;
            s.steps.upload.total = total;
            s.steps.upload.safe = safe;
            s.steps.upload.rate = Math.round((sent - (s.steps.upload.from ?? sent)) / Math.max(1, (Date.now() - startedAt) / 1000));
            if (s.steps.upload.from === undefined) s.steps.upload.from = sent;
            if (Date.now() - lastSave > 3000) { lastSave = Date.now(); save(); }
          },
        });
      } catch (err) {
        if (Number.isInteger(err.safe)) s.steps.upload.safe = err.safe;
        delete s.steps.upload.from;
        save();
        throw err;
      }
      delete s.steps.upload.from;
      s.steps.upload.done = true;
      save();
    }
    if (signal.aborted) throw new HttpError(499, 'Paused');

    // 3. Unpack on the host (panel), or upload file by file (SFTP only).
    if (!s.steps.unpack.done) {
      s.step = 'unpack';
      save();
      const entries = await conn.files.list(t.dataPath);
      const names = new Set(entries.map((e) => e.name));
      if (names.has('resources') && !s.steps.unpack.setAside) {
        let spare = 'resources-before-move';
        for (let i = 2; names.has(spare); i++) spare = `resources-before-move-${i}`;
        await conn.files.rename(t.dataPath, 'resources', spare);
        s.steps.unpack.setAside = spare;
        save();
      }
      if (panel) {
        try {
          await panel.files.decompress(t.dataPath, ZIP_NAME);
        } catch (err) {
          // Big archives can outlast the panel's own time limit while the host keeps unpacking.
          if (![502, 504].includes(err.status)) throw err;
          await waitUntilSettled(conn, t.dataPath);
        }
      } else {
        await uploadTree(sftp, path.join(local.dataPath, 'resources'), path.posix.join(t.dataPath, 'resources'), s, signal);
      }
      const unpacked = await conn.files.list(path.posix.join(t.dataPath, 'resources')).catch(() => []);
      const localTop = (await readdir(path.join(local.dataPath, 'resources'))).filter((n) => !n.startsWith('.'));
      if (unpacked.length < Math.min(localTop.length, 1)) throw new HttpError(500, 'The resources didn\'t appear on your host after unpacking. Check your host\'s file manager, then continue.');
      s.steps.unpack = { ...s.steps.unpack, done: true, folders: unpacked.length, localFolders: localTop.length };
      save();
    }

    // 4. Files server.cfg runs that live next to it (permissions.cfg and the like).
    if (!s.steps.files.done) {
      s.step = 'files';
      const cfg = await readCfg(local.cfgPath);
      const sent = [];
      for (const rel of execFiles(cfg)) {
        const from = path.join(path.dirname(local.cfgPath), ...rel.split('/'));
        if (!existsSync(from)) continue;
        await conn.files.write(path.posix.join(path.posix.dirname(t.cfgPath), rel), readFileSync(from, 'utf8'));
        sent.push(rel);
      }
      s.steps.files = { done: true, sent };
      save();
    }
    s.step = null;
    s.phase = 'ready';
    save();
    recordEvent({ title: 'Your server is ready to move', detail: 'Your resources are on your host. Open Settings, Move to a host, to finish: CityHQ then copies the database and settings and switches over.' });
  } finally {
    conn.close();
    sftp?.close();
  }
}

/** Waits for an unpack the panel stopped waiting for: done once the folder stops changing. */
async function waitUntilSettled(conn, dataPath) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 20000));
    const n = (await conn.files.list(path.posix.join(dataPath, 'resources')).catch(() => [])).length;
    if (n > 0 && n === last) same += 1; else same = 0;
    last = n;
    if (same >= 6) return;
  }
  throw new HttpError(504, 'Your host is still unpacking after 2 hours. Check its file manager, then continue.');
}

/** SFTP-only hosts: every file, skipping any already there at the same size. */
async function uploadTree(sftp, localDir, remoteDir, s, signal) {
  s.steps.unpack.files = s.steps.unpack.files || 0;
  const walk = async (from, to) => {
    await sftp.mkdirs(to);
    const there = new Map((await sftp.files.list(to).catch(() => [])).map((e) => [e.name, e]));
    for (const e of await readdir(from, { withFileTypes: true })) {
      if (signal.aborted) throw new HttpError(499, 'Paused');
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const a = path.join(from, e.name);
      const b = path.posix.join(to, e.name);
      if (e.isDirectory()) await walk(a, b);
      else if (e.isFile()) {
        const size = (await stat(a)).size;
        if (there.get(e.name)?.size !== size) await sftp.uploadFile(a, b, { resume: false });
        s.steps.unpack.files += 1;
        if (s.steps.unpack.files % 50 === 0) save();
      }
    }
  };
  await walk(localDir, remoteDir);
}

// ---------------------------------------------------------------- finishing
/**
 * The last part, once the resources are there: stop the server here (if asked), copy the
 * database and server.cfg, put the helper on the host, start it there, and switch CityHQ over.
 */
export async function finishMove(body = {}) {
  const s = load();
  if (!s || s.phase !== 'ready') throw new HttpError(409, 'The resources aren\'t on your host yet.');
  if (running) throw new HttpError(409, 'The move is already running.');
  const players = await agentRequest('/players', { timeoutMs: 4000 }).catch(() => []);
  if (body.stopLocal !== false && players.length && !body.playersOk) {
    throw new HttpError(409, `${players.length} player${players.length === 1 ? ' is' : 's are'} on your server. Finishing stops it here; try again when nobody is on.`, { players: players.length });
  }
  holdAwake('move');
  running = (async () => {
    const local = findServerData();
    const secret = secrets();
    const t = s.target;
    const conn = makeConnection(t, secret.key);
    const panel = t.type === 'panel' ? panelClient({ url: t.panelUrl, key: secret.key, serverId: t.serverId }) : null;
    try {
      s.phase = 'finishing';
      // Stop the server here first, so nothing changes in the database after it is copied.
      s.step = 'stop-local';
      save();
      if (body.stopLocal !== false) await stopServer('The server is moving to its new home. See you there in a few minutes!').catch(() => {});
      // The host's server stays off while its files change.
      if (panel) {
        s.step = 'stop-host';
        save();
        await panel.power('stop').catch(() => {});
        for (let i = 0; i < 30 && (await panel.resources().catch(() => ({ state: 'offline' }))).state !== 'offline'; i++) await new Promise((r) => setTimeout(r, 2000));
      }

      // The database: a fresh copy, into the host's.
      s.step = 'database';
      save();
      let db = s.database ? { ...s.database, password: secret.dbPassword } : null;
      if (db?.create) {
        const made = await panel.databases.create(db.create);
        db = { ...made, host: made.host || db.host, port: made.host ? made.port : db.port };
        s.database = { ...db, password: undefined, create: null };
        saveSecret(STATE_DIR, JSON.stringify({ ...secret, dbPassword: made.password }), SECRET_FILE);
        save();
      }
      if (!db?.host) throw new HttpError(409, 'No database on your host was chosen.');
      await ensureDatabase();
      const from = await localConnection(local.cfgPath);
      await mkdir(MOVE_DIR, { recursive: true });
      const dump = path.join(MOVE_DIR, 'database.sql');
      await dumpDatabase(from, dump);
      const to = { host: db.host, port: db.port, user: db.username, password: db.password };
      await importFile(to, db.name, dump);
      const want = await countTables(from, from.database);
      const got = await countTables(to, db.name);
      if (got < want) throw new HttpError(500, `Only ${got} of your ${want} database tables arrived on your host. Nothing else was changed; try finishing again.`);

      // server.cfg: yours, with the host's own lines and its database.
      s.step = 'settings';
      save();
      const hostCfg = await conn.files.read(t.cfgPath).catch(() => '');
      if (hostCfg && !s.cfgSetAside) {
        await conn.files.write(`${t.cfgPath}.before-move`, hostCfg);
        s.cfgSetAside = true;
        save();
      }
      const localCfg = await readCfg(local.cfgPath);
      await conn.files.write(t.cfgPath, mergeCfgForHost(localCfg, hostCfg, db));

      // txAdmin's records of players (bans, warnings, playtime), if wanted and there's a txAdmin.
      if (s.copyPlayersDb && t.txProfile) {
        const file = path.join(TX_PROFILE, 'data', 'playersDB.json');
        if (existsSync(file)) {
          s.step = 'txadmin';
          save();
          const sftp = await sftpFor(t, secret).catch(() => null);
          if (sftp) {
            try {
              await sftp.mkdirs(path.posix.join(t.txProfile, 'data'));
              await sftp.uploadFile(file, path.posix.join(t.txProfile, 'data', 'playersDB.json'), { resume: false });
            } finally { sftp.close(); }
          } else {
            await conn.files.write(path.posix.join(t.txProfile, 'data', 'playersDB.json'), readFileSync(file, 'utf8'));
          }
        }
      }

      // Switch CityHQ over: this saves the hosted server, puts the helper there, then restarts.
      s.step = 'switch';
      save();
      const login = t.type === 'panel'
        ? { type: 'panel', url: t.panelUrl, key: secret.key, serverId: t.serverId }
        : { type: 'sftp', host: t.host, port: t.port, username: t.username, password: secret.key };
      const saved = await useHosted(login);
      if (panel) await panel.power('start').catch(() => {});
      s.phase = 'done';
      s.step = null;
      s.doneAt = Date.now();
      save();
      forgetSecret(STATE_DIR, SECRET_FILE);
      recordEvent({ title: 'Your server moved to your host', detail: `Your server on this PC is stopped and kept as it was. CityHQ now runs the one on your host (${t.serverName || t.host}).` });
      return saved;
    } catch (err) {
      s.phase = 'ready';
      s.error = err.message;
      save();
      throw err;
    } finally {
      conn.close();
    }
  })();
  try {
    const saved = await running;
    return { ...moveStatus(), switched: saved };
  } finally {
    running = null;
    releaseAwake('move');
  }
}

/** Forgets a move that hasn't finished (nothing on either side is undone). */
export async function cancelMove() {
  if (running) throw new HttpError(409, 'Pause the move first.');
  state = null;
  await rm(STATE_FILE, { force: true });
  forgetSecret(STATE_DIR, SECRET_FILE);
  return { phase: null };
}
