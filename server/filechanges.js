// Changing files from the Files page: replacing one, adding new ones, making a folder, renaming
// and deleting, anywhere in the server's folder. Nothing is lost: whatever a change replaces or
// deletes is kept for 30 days, and History (or the Undo shown right after the change) puts it
// back. Files ending in .cfg, which hold passwords and keys, are only changed in the editor, and
// CityHQ's own helper is never changed here.
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import {
  copyFile, cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, statfs, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  fileLock, parseBoot, readCfg, withFileLock,
} from './cfg.js';
import { assertSafeRel, isSecretFile, tokenPath } from './files.js';
import { recordChange } from './history.js';
import {
  HttpError, REMOTE, resolveInside, STATE_DIR,
} from './paths.js';
import {
  liveStates, NEVER_STOP, refreshResources, removeResource, scanDisk, serverData,
} from './resources.js';
import { isBusy, retry, tempNameFor } from './retry.js';

export const KEPT_DIR = path.join(STATE_DIR, 'kept-files');
export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
// Room left over after a file is added, so neither Windows nor the server runs out of disk.
const SPARE_BYTES = 256 * 1024 ** 2;
const HELPER = 'qb-control';
const KEPT_ID = /^\d{13}-[0-9a-f]{6}$/;
const STOPPED = 'The upload stopped before the whole file arrived. Try again.';
const NOT_HOSTED = 'Adding and changing files on a hosted server isn\'t available yet. Use your host\'s file manager for now.';

const toPosix = (p) => p.replaceAll('\\', '/');
const formatSize = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
const where = (rel) => `In ${path.posix.dirname(rel) === '.' ? 'the server folder' : path.posix.dirname(rel)}`;
const listNames = (names) => (names.length <= 3
  ? names.join(', ').replace(/, ([^,]*)$/, ' and $1')
  : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);

/** The real, long path (links and short 8.3 names seen through), lower-cased, even for a new name. */
function realOf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realOf(parent), path.basename(p));
  }
}
const norm = (p) => realOf(path.resolve(p)).toLowerCase();
/** The key lockFor compares: a path's real form, lower-cased. */
export const realKey = norm;
const within =(child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

// ---------------------------------------------------------------- what may be changed
const WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why a name can't be used for a new file or folder, or null when it can. */
export function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Type a name first.';
  if (name !== name.trim()) return 'A name can\'t start or end with a space.';
  if (name.length > 180) return 'That name is too long. Keep it under 180 characters.';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return 'A name can\'t have any of these in it: < > : " / \\ | ? *';
  if (name.endsWith('.')) return 'A name can\'t end with a dot.';
  if (WINDOWS_NAMES.test(name)) return `Windows keeps the name ${name.split('.')[0].toUpperCase()} for itself, so pick another one.`;
  if (/\.qbctmp$/i.test(name)) return 'Names ending in .qbctmp are used by CityHQ while it saves, so pick another one.';
  return null;
}

export const LOCKS = {
  root: 'This is the server folder itself, so it can\'t be renamed or deleted here.',
  helper: 'This is part of CityHQ\'s helper (qb-control). CityHQ keeps it up to date itself, so it can\'t be changed here.',
  'holds-helper': 'This folder holds CityHQ\'s helper (qb-control), so it can\'t be renamed or deleted. You can still add files to it.',
  'holds-cfg': 'This folder holds server.cfg, so it can\'t be renamed or deleted. You can still add files to it.',
  cfg: 'Files ending in .cfg hold passwords and keys, so CityHQ only changes them in its editor, where those stay hidden.',
};

/** Where the server folder, its server.cfg and CityHQ's helper really are, for lockFor. */
export function placeOf(dataPath, cfgPath, moreHelpers = []) {
  const token = tokenPath();
  return {
    root: norm(dataPath),
    cfg: norm(cfgPath),
    helpers: [...new Set([...(token ? [path.dirname(token)] : []), ...moreHelpers].map(norm))],
  };
}

/**
 * Why something can't be changed from the Files page, as a key of LOCKS, or null when it can.
 * `real` is its real path, lower-cased. A 'root', 'holds-helper' or 'holds-cfg' folder can still
 * have files added to it; a 'helper' one can't.
 */
export function lockFor(real, isDir, place) {
  if (real === place.root) return 'root';
  if (place.helpers.some((h) => within(real, h))) return 'helper';
  if (isDir && place.helpers.some((h) => within(h, real))) return 'holds-helper';
  if (isDir && within(place.cfg, real)) return 'holds-cfg';
  if (!isDir && /\.cfg(\.|$)/i.test(path.basename(real))) return 'cfg';
  return null;
}

async function context() {
  if (REMOTE) throw new HttpError(409, NOT_HOSTED);
  const { dataPath, cfgPath } = serverData();
  const disk = await scanDisk();
  return { dataPath, cfgPath, disk, place: placeOf(dataPath, cfgPath, disk.filter((r) => r.name === HELPER).map((r) => r.dir)) };
}

function assertInside(full, ctx) {
  if (!within(norm(full), ctx.place.root)) throw new HttpError(400, 'That path is outside the allowed folder');
}

/** A file or folder that is there now. */
async function existing(rel, ctx) {
  assertSafeRel(rel);
  if (!rel.replace(/[\\/.]+/g, '')) throw new HttpError(403, LOCKS.root);
  const full = resolveInside(ctx.dataPath, rel);
  const info = await stat(full).catch(() => null);
  if (!info) throw new HttpError(404, 'That file or folder no longer exists.');
  if (isSecretFile(full)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');
  return {
    full, real: norm(full), rel: toPosix(path.relative(ctx.dataPath, full)), name: path.basename(full), isDir: info.isDirectory(), size: info.size,
  };
}

function refuseLocked(item, ctx) {
  const lock = lockFor(item.real, item.isDir, ctx.place);
  if (lock) throw new HttpError(403, LOCKS[lock]);
}

/** A folder new files may go into. */
async function folderFor(rel, ctx) {
  const wanted = rel ?? '';
  assertSafeRel(wanted);
  const full = resolveInside(ctx.dataPath, wanted);
  const info = await stat(full).catch(() => null);
  if (!info) throw new HttpError(404, 'That folder no longer exists.');
  if (!info.isDirectory()) throw new HttpError(400, 'That is not a folder.');
  if (lockFor(norm(full), true, ctx.place) === 'helper') throw new HttpError(403, LOCKS.helper);
  return { full, rel: toPosix(path.relative(ctx.dataPath, full)) };
}

function checkedName(name) {
  const problem = nameProblem(name);
  if (problem) throw new HttpError(400, problem);
  return name;
}

async function assertRoom(dir, bytes) {
  let free;
  try {
    const s = await statfs(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch { return; }
  if (free < bytes + SPARE_BYTES) {
    throw new HttpError(507, `There isn't enough disk space. This needs about ${formatSize(bytes + SPARE_BYTES)}, and only ${formatSize(free)} is free.`);
  }
}

/** Plain words for what Windows said, once passing locks have been waited out. */
function friendly(err, name) {
  if (err instanceof HttpError) return err;
  if (isBusy(err)) {
    return new HttpError(423, `Windows won't let CityHQ change ${name}. It may be open in another program or set to read-only. Close it there (or wait a moment if a virus scan is running), then try again.`);
  }
  if (err?.code === 'ENOSPC') return new HttpError(507, 'The disk is full. Free up some space, then try again.');
  if (err?.code === 'ENAMETOOLONG') return new HttpError(400, 'That makes the path too long for Windows. Pick a shorter name.');
  if (err?.code === 'EEXIST') return new HttpError(409, `Something named ${name} is already there.`);
  if (err?.code === 'ENOENT') return new HttpError(404, `${name} is no longer there.`);
  return err;
}

// ---------------------------------------------------------------- scripts a change touches
const manifestOf = async (dir) => {
  for (const f of ['fxmanifest.lua', '__resource.lua']) {
    const p = path.join(dir, f);
    if (existsSync(p)) return readFile(p, 'utf8').catch(() => '');
  }
  return '';
};

/**
 * The script a file belongs to, for the "restart it" note after a change: whether it runs, and
 * whether it's a loading screen (players only see one while joining) or the file is streamed
 * game art (players who are on keep the old one until they reconnect).
 */
async function scriptAt(full, ctx) {
  const real = norm(full);
  const owner = ctx.disk
    .filter((r) => within(real, norm(r.dir)))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!owner) return null;
  const live = await liveStates();
  return {
    name: owner.name,
    state: live ? (live.get(owner.name)?.state || 'stopped') : 'offline',
    loadscreen: /^\s*loadscreen\s*[('"]/m.test(await manifestOf(owner.dir)),
    stream: path.relative(owner.dir, full).split(path.sep).some((p) => p.toLowerCase() === 'stream'),
    canRestart: !NEVER_STOP.has(owner.name),
  };
}

/** The scripts in a folder, and which of them are running now. */
async function scriptsIn(item, ctx) {
  const inside = ctx.disk.filter((r) => within(norm(r.dir), item.real));
  if (!inside.length) return { inside, running: [] };
  const live = await liveStates();
  const running = live ? inside.filter((r) => ['started', 'starting', 'stopping'].includes(live.get(r.name)?.state)).map((r) => r.name) : [];
  return { inside, running };
}

function refuseRunning(running, doing) {
  if (!running.length) return;
  const one = running.length === 1;
  throw new HttpError(409, `${listNames(running)} ${one ? 'is' : 'are'} running from this folder. Stop ${one ? 'it' : 'them'} on the Resources page first, then ${doing} it.`);
}

// ---------------------------------------------------------------- kept copies, for Undo
let prunedAt = 0;

/** Removes kept copies older than 30 days, at most once an hour. */
export async function pruneKept(now = Date.now(), { force = false } = {}) {
  if (!force && now - prunedAt < 60 * 60 * 1000) return;
  prunedAt = now;
  for (const name of await readdir(KEPT_DIR).catch(() => [])) {
    const at = Number(name.split('-')[0]);
    if (Number.isFinite(at) && now - at > KEEP_DAYS * DAY_MS) {
      await rm(path.join(KEPT_DIR, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Moves a file or folder, waiting out passing locks. To another drive it copies, then removes. */
async function move(from, to) {
  try {
    await retry(() => rename(from, to));
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
  }
  await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  try {
    await retry(() => rm(from, { recursive: true, force: true }));
  } catch (err) {
    err.copied = true;
    throw err;
  }
}

/** Keeps a file or folder for Undo: moved there (or copied, for a file about to be replaced). */
async function keep(item, reason, { copy = false } = {}) {
  await mkdir(KEPT_DIR, { recursive: true });
  await pruneKept();
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(KEPT_DIR, id);
  await mkdir(dir);
  const meta = () => writeFile(`${dir}.json`, JSON.stringify({ rel: item.rel, type: item.isDir ? 'dir' : 'file', reason, at: Date.now() }));
  try {
    if (copy) await copyFile(item.full, path.join(dir, item.name));
    else await move(item.full, path.join(dir, item.name));
  } catch (err) {
    if (err?.copied) {
      // Across drives, with a file in it still open: a whole copy is kept, part of it stayed.
      await meta();
      throw new HttpError(423, `A file in ${item.name} is open in another program, so only part of it could be deleted. A whole copy is kept in ${dir}.`);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw friendly(err, item.name);
  }
  await meta();
  return { id, dir };
}

async function keptItem(id) {
  if (!KEPT_ID.test(String(id))) throw new HttpError(400, 'Invalid item');
  const dir = path.join(KEPT_DIR, id);
  let meta = null;
  try { meta = JSON.parse(await readFile(`${dir}.json`, 'utf8')); } catch { /* gone */ }
  const names = meta ? await readdir(dir).catch(() => []) : [];
  if (!meta || names.length !== 1) throw new HttpError(410, `The kept copy is gone. CityHQ keeps what it replaces or deletes for ${KEEP_DAYS} days.`);
  return { dir, meta, src: path.join(dir, names[0]) };
}

const forgetKept = async (dir) => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await rm(`${dir}.json`, { force: true }).catch(() => {});
};

const changed = (id, title) => (id ? { id, title } : null);

// ---------------------------------------------------------------- receiving a file
const declaredSize = (value) => {
  if (value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
};
export const contentLength = (req) => declaredSize(req.headers['content-length']);

/** Streams an upload into a copy beside where it goes, checked to be whole. */
async function receive(req, target, declared, alsoNeeded = 0) {
  if (Number.isNaN(declared)) throw new HttpError(411, 'The upload didn\'t say how big the file is. Try again.');
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, `That file is ${formatSize(declared)}. Files up to 4 GB can be added here.`);
  await assertRoom(path.dirname(target), declared + alsoNeeded);
  const tmp = tempNameFor(target);
  try {
    await pipeline(req, createWriteStream(tmp, { flags: 'wx' }));
    if ((await stat(tmp)).size !== declared) throw new HttpError(400, STOPPED);
    return tmp;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    if (err instanceof HttpError) throw err;
    if (req.aborted || req.destroyed || ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED'].includes(err?.code)) {
      throw new HttpError(400, STOPPED);
    }
    throw friendly(err, path.basename(target));
  }
}

/**
 * Before anything is sent: which files are already in the folder (to ask before replacing
 * them), which can't be added and why, and whether there is room for them all.
 */
export async function checkUploads(folderRel, files) {
  if (!Array.isArray(files) || !files.length || files.length > 1000) throw new HttpError(400, 'Pick some files first.');
  const ctx = await context();
  const folder = await folderFor(folderRel, ctx);
  const here = new Map((await readdir(folder.full).catch(() => [])).map((n) => [n.toLowerCase(), n]));
  let needed = 0;
  const out = [];
  for (const f of files) {
    const name = typeof f?.name === 'string' ? f.name : '';
    const size = declaredSize(f?.size);
    let problem = nameProblem(name);
    let existingName = null;
    if (!problem && Number.isNaN(size)) problem = `${name} has no size, so it can't be added.`;
    if (!problem && size > MAX_UPLOAD_BYTES) problem = `${name} is ${formatSize(size)}. Files up to 4 GB can be added here.`;
    const same = !problem && here.get(name.toLowerCase());
    if (same) {
      const full = path.join(folder.full, same);
      const info = await stat(full).catch(() => null);
      if (info?.isDirectory()) problem = `There's already a folder named ${same} here.`;
      else if (isSecretFile(full)) problem = 'That file is private to the app and cannot be replaced.';
      else {
        const lock = lockFor(norm(full), false, ctx.place);
        if (lock) problem = LOCKS[lock];
        else { existingName = same; needed += info?.size || 0; }
      }
    }
    if (!problem) needed += size;
    out.push({ name, existing: existingName, problem });
  }
  let room = null;
  try { await assertRoom(folder.full, needed); } catch (err) { room = err.message; }
  return { files: out, problem: room };
}

// ---------------------------------------------------------------- the changes
/** Puts an uploaded file in place of one that's there, under that one's name. */
export async function replaceFromUpload(req, rel, declared) {
  const ctx = await context();
  const first = await existing(rel, ctx);
  if (first.isDir) throw new HttpError(400, 'That is a folder. Open it and add files to it instead.');
  refuseLocked(first, ctx);
  const tmp = await receive(req, first.full, declared, first.size);
  try {
    return await withFileLock(fileLock(first.full), async () => {
      // The upload can take a while; look again at what is there now.
      const item = await existing(rel, ctx);
      if (item.isDir) throw new HttpError(409, `${item.name} is a folder now, so it wasn't replaced.`);
      refuseLocked(item, ctx);
      const kept = await keep(item, 'replaced', { copy: true });
      try {
        await retry(() => rename(tmp, item.full));
      } catch (err) {
        await forgetKept(kept.dir);
        throw friendly(err, item.name);
      }
      const title = `Replaced ${item.name}`;
      const id = await recordChange({
        kind: 'file',
        title,
        detail: where(item.rel),
        undo: { type: 'browse-replaced', rel: item.rel, id: kept.id },
        undoHint: `${item.name} goes back to the file it was before. CityHQ keeps a replaced file for ${KEEP_DAYS} days.`,
      });
      return { path: item.rel, change: changed(id, title), script: await scriptAt(item.full, ctx) };
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Adds an uploaded file to a folder. One that's already there is replaced with replaceFromUpload. */
export async function addFromUpload(req, folderRel, name, declared) {
  const ctx = await context();
  const folder = await folderFor(folderRel, ctx);
  const full = path.join(folder.full, checkedName(name));
  assertInside(full, ctx);
  const taken = () => new HttpError(409, `${name} is already in this folder.`, { exists: true });
  if (await stat(full).catch(() => null)) throw taken();
  const tmp = await receive(req, full, declared);
  try {
    return await withFileLock(fileLock(full), async () => {
      if (await stat(full).catch(() => null)) throw taken();
      try { await retry(() => rename(tmp, full)); } catch (err) { throw friendly(err, name); }
      const rel = toPosix(path.relative(ctx.dataPath, full));
      const title = `Added ${name}`;
      const id = await recordChange({
        kind: 'file',
        title,
        detail: where(rel),
        undo: { type: 'browse-added', rel },
        undoHint: `${name} is deleted again. CityHQ keeps it for ${KEEP_DAYS} days.`,
      });
      return { path: rel, change: changed(id, title), script: await scriptAt(full, ctx) };
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function makeFolder(parentRel, name) {
  const ctx = await context();
  const folder = await folderFor(parentRel, ctx);
  const full = path.join(folder.full, checkedName(name));
  assertInside(full, ctx);
  try {
    await mkdir(full);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new HttpError(409, `Something named ${name} is already in this folder.`);
    throw friendly(err, name);
  }
  const rel = toPosix(path.relative(ctx.dataPath, full));
  const title = `Made the folder ${name}`;
  const id = await recordChange({
    kind: 'file',
    title,
    detail: where(rel),
    undo: { type: 'browse-made-folder', rel },
    undoHint: `The folder ${name} is deleted again. Anything added to it since is kept for ${KEEP_DAYS} days.`,
  });
  return { path: rel, change: changed(id, title), script: null };
}

/** What server.cfg needs after a script's folder, or a [category] it starts, gets a new name. */
async function bootNote(item, newName, inside, ctx) {
  const boot = parseBoot(await readCfg(ctx.cfgPath).catch(() => ''));
  const isScript = inside.some((r) => norm(r.dir) === item.real);
  if (isScript && boot.names.has(item.name)) {
    return `server.cfg starts this script with "ensure ${item.name}". Change that line to "ensure ${newName}", or it won't start with the server.`;
  }
  if (/^\[.*\]$/.test(item.name) && boot.categories.has(item.name)) {
    return `server.cfg starts this folder with "ensure ${item.name}". Change that line to "ensure ${newName}", or its scripts won't start with the server.`;
  }
  return null;
}

/** Gives a file or folder a new name in the same folder. */
export async function renameItem(rel, name) {
  const ctx = await context();
  const item = await existing(rel, ctx);
  refuseLocked(item, ctx);
  checkedName(name);
  if (name === item.name) return { path: item.rel, change: null, script: null, note: null };
  const target = path.join(path.dirname(item.full), name);
  assertInside(target, ctx);
  const sameFile = target.toLowerCase() === item.full.toLowerCase();
  if (!sameFile && await stat(target).catch(() => null)) throw new HttpError(409, `Something named ${name} is already in this folder.`);
  const scripts = item.isDir ? await scriptsIn(item, ctx) : { inside: [], running: [] };
  refuseRunning(scripts.running, 'rename');
  try {
    await withFileLock(fileLock(item.full), () => withFileLock(fileLock(target), () => retry(() => rename(item.full, target))));
  } catch (err) {
    throw friendly(err, item.name);
  }
  if (scripts.inside.length) await refreshResources();
  const newRel = toPosix(path.relative(ctx.dataPath, target));
  const title = `Renamed ${item.name} to ${name}`;
  const id = await recordChange({
    kind: 'file',
    title,
    detail: where(newRel),
    undo: { type: 'browse-renamed', from: item.rel, to: newRel },
    undoHint: `It gets its old name, ${item.name}, back.`,
  });
  return {
    path: newRel,
    change: changed(id, title),
    script: scripts.inside.length ? null : await scriptAt(target, ctx),
    note: scripts.inside.length ? await bootNote(item, name, scripts.inside, ctx) : null,
  };
}

/**
 * Deletes a file or folder by keeping it aside for 30 days. A script's own folder is removed the
 * way the Resources page removes a script: stopped first, then kept in Recently removed together
 * with its server.cfg line.
 */
export async function deleteItem(rel) {
  const ctx = await context();
  const item = await existing(rel, ctx);
  refuseLocked(item, ctx);
  let inside = [];
  if (item.isDir) {
    const scripts = await scriptsIn(item, ctx);
    const own = scripts.inside.find((r) => norm(r.dir) === item.real);
    // With two folders of the same name, removing by name could pick the other one.
    if (own && ctx.disk.filter((r) => r.name === own.name).length === 1) {
      const removed = await removeResource(own.name);
      return { path: item.rel, change: removed.change, script: null, removedScript: own.name };
    }
    refuseRunning(scripts.running, 'delete');
    inside = scripts.inside;
  }
  const script = await scriptAt(path.dirname(item.full), ctx);
  const kept = await withFileLock(fileLock(item.full), () => keep(item, 'deleted'));
  let note = null;
  if (inside.length) {
    await refreshResources();
    const boot = parseBoot(await readCfg(ctx.cfgPath).catch(() => ''));
    const started = inside.map((r) => r.name).filter((n) => boot.names.has(n));
    if (started.length) note = `server.cfg still starts ${listNames(started)}. The server will say ${started.length === 1 ? 'it is' : 'they are'} missing when it starts, until you undo this or take ${started.length === 1 ? 'that line' : 'those lines'} out.`;
  }
  const title = `Deleted ${item.name}`;
  const id = await recordChange({
    kind: 'file',
    title,
    detail: where(item.rel),
    undo: { type: 'browse-deleted', rel: item.rel, id: kept.id },
    undoHint: `${item.name} comes back where it was. CityHQ keeps deleted files for ${KEEP_DAYS} days.`,
  });
  return {
    path: item.rel, change: changed(id, title), script, note,
  };
}

// ---------------------------------------------------------------- undo
async function undoReplaced({ rel, id }) {
  const kept = await keptItem(id);
  const ctx = await context();
  assertSafeRel(rel);
  const full = resolveInside(ctx.dataPath, rel);
  const name = path.basename(full);
  return withFileLock(fileLock(full), async () => {
    const now = await stat(full).catch(() => null);
    if (now?.isDirectory()) throw new HttpError(409, `${name} is a folder now, so the earlier file can't be put back.`);
    const lock = lockFor(norm(full), false, ctx.place);
    if (lock) throw new HttpError(403, LOCKS[lock]);
    await assertRoom(path.dirname(full), (await stat(kept.src)).size + (now?.size || 0));
    // What is there now is kept too, so this can be undone in turn.
    const before = now ? await keep({ full, rel, name, isDir: false }, 'replaced', { copy: true }) : null;
    const tmp = tempNameFor(full);
    try {
      await copyFile(kept.src, tmp);
      await retry(() => rename(tmp, full));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      if (before) await forgetKept(before.dir);
      throw friendly(err, name);
    }
    await forgetKept(kept.dir);
    if (before) {
      await recordChange({
        kind: 'file',
        title: `Put back the earlier ${name}`,
        detail: where(rel),
        undo: { type: 'browse-replaced', rel, id: before.id },
        undoHint: `${name} goes back to the file it was before.`,
      });
    }
    return `${name} is back to the file it was before that change.`;
  });
}

async function undoDeleted({ rel, id }) {
  const kept = await keptItem(id);
  const ctx = await context();
  assertSafeRel(rel);
  const full = resolveInside(ctx.dataPath, rel);
  const name = path.basename(full);
  const parent = path.dirname(full);
  assertInside(parent, ctx);
  if (lockFor(norm(parent), true, ctx.place) === 'helper') throw new HttpError(403, LOCKS.helper);
  try {
    await withFileLock(fileLock(full), async () => {
      if (await stat(full).catch(() => null)) throw new HttpError(409, `Something named ${name} is in that folder now. Rename or delete it first, then undo again.`);
      await mkdir(parent, { recursive: true });
      assertInside(full, ctx);
      await move(kept.src, full);
    });
  } catch (err) {
    throw friendly(err, name);
  }
  await forgetKept(kept.dir);
  if (kept.meta.type === 'dir') await refreshResources();
  await recordChange({
    kind: 'file',
    title: `Brought back ${name}`,
    detail: where(toPosix(path.relative(ctx.dataPath, full))),
    undo: { type: 'browse-delete', rel },
    undoHint: `${name} is deleted again. CityHQ keeps it for ${KEEP_DAYS} days.`,
  });
  return `${name} is back where it was.`;
}

async function deleteAgain({ rel }) {
  await deleteItem(rel);
  return `${path.posix.basename(rel)} was deleted again. CityHQ keeps it for ${KEEP_DAYS} days.`;
}

async function undoMadeFolder({ rel }) {
  const ctx = await context();
  const item = await existing(rel, ctx);
  if (!item.isDir) throw new HttpError(409, `${item.name} isn't a folder any more.`);
  refuseLocked(item, ctx);
  if (!(await readdir(item.full)).length) {
    try { await retry(() => rmdir(item.full)); } catch (err) { throw friendly(err, item.name); }
    return `The folder ${item.name} was deleted again.`;
  }
  await deleteItem(rel);
  return `The folder ${item.name} was deleted again, with what was added to it. CityHQ keeps it for ${KEEP_DAYS} days.`;
}

async function undoRenamed({ from, to }) {
  if (typeof from !== 'string' || typeof to !== 'string' || path.posix.dirname(from) !== path.posix.dirname(to)) throw new HttpError(400, 'Invalid change');
  await renameItem(to, path.posix.basename(from));
  return `${path.posix.basename(to)} has its old name, ${path.posix.basename(from)}, again.`;
}

/** How each Files page change is undone, for History. */
export const FILE_PAGE_UNDO = {
  'browse-replaced': undoReplaced,
  'browse-deleted': undoDeleted,
  'browse-added': deleteAgain,
  'browse-delete': deleteAgain,
  'browse-made-folder': undoMadeFolder,
  'browse-renamed': undoRenamed,
};
