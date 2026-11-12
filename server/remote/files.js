// The file editor and the Files page for a hosted server: the same answers the local ones give,
// read and written through the host. Earlier versions of each saved file are kept on this PC.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restoreSecrets, SECRET_MASK } from '../cfg.js';
import {
  assertSafeRel, backupDirFor, DATA_SCOPE, EDITABLE, etagOf, fieldsFor, findMistake, hasSecretValue, isCfgLike, looksLikeText,
  MAX_EDIT_BYTES, recordFileChange, refuseMistake, safeView, SERVER_SCOPE,
} from '../files.js';
import { applyFieldChanges } from '../fields.js';
import { findServerData, HttpError } from '../paths.js';
import { connection } from './connection.js';

const MAX_VERSIONS = 25;
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};

function server() {
  const s = findServerData();
  if (!s) throw new HttpError(409, 'CityHQ doesn\'t know where your hosted server\'s files are yet.');
  return s;
}

/** The host path for a path inside the server's folder, refusing anything outside it. */
function hostFile(rel = '') {
  assertSafeRel(rel);
  const { dataPath } = server();
  const full = path.posix.normalize(path.posix.join(dataPath, String(rel).replaceAll('\\', '/')));
  const base = path.posix.normalize(dataPath);
  if (full !== base && !full.startsWith(base === '/' ? '/' : `${base}/`)) throw new HttpError(400, 'That path is outside the allowed folder');
  return full;
}

const relOf = (full) => {
  const base = server().dataPath;
  return path.posix.relative(base, full);
};

/** The helper's token never leaves the server: not shown, not downloaded. */
const isTokenFile = (rel) => /(^|\/)qb-control\/token\.txt$/i.test(String(rel).replaceAll('\\', '/'));
const isHelperFile = (rel) => /(^|\/)\[local\]\/qb-control\//i.test(String(rel).replaceAll('\\', '/'));

function scopeFile(scope, rel) {
  assertSafeRel(rel);
  if (scope === SERVER_SCOPE) {
    if (rel !== 'server.cfg') throw new HttpError(403, 'Only server.cfg can be edited here');
    return { full: server().cfgPath, rel: 'server.cfg' };
  }
  if (scope !== DATA_SCOPE) throw new HttpError(409, 'On a hosted server, open files from the Files page.');
  if (isTokenFile(rel)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');
  return { full: hostFile(rel), rel };
}

function readOnlyReason(rel, text) {
  if (isHelperFile(rel)) return 'The app manages this file, so it can only be viewed.';
  if (!EDITABLE.has(path.posix.extname(rel).toLowerCase())) return 'This type of file can only be viewed here.';
  if (safeView(rel, text).viewOnly) return 'This file contains a password or key. It is hidden here, so the file can only be viewed.';
  return null;
}

async function readText(full) {
  const text = await connection().files.read(full);
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) throw new HttpError(413, 'That file is too large to open here (over 2 MB)');
  return text;
}

export async function listFiles(scope) {
  if (scope === SERVER_SCOPE) return { files: [{ path: 'server.cfg', editable: true, size: 0 }], truncated: false };
  throw new HttpError(409, 'On a hosted server, open files from the Files page.');
}

export async function readEditable(scope, relIn) {
  const { full, rel } = scopeFile(scope, relIn);
  const text = await readText(full);
  if (!EDITABLE.has(path.posix.extname(rel).toLowerCase()) && !looksLikeText(Buffer.from(text.slice(0, 8192)))) {
    throw new HttpError(415, 'That file is not text, so it cannot be opened here.');
  }
  const reason = readOnlyReason(rel, text);
  const { kind, fields } = reason ? { kind: null, fields: [] } : fieldsFor(scope, rel, text);
  return {
    path: relIn,
    content: safeView(rel, text).content,
    etag: etagOf(text),
    fieldKind: kind,
    fields: fields.map(({ start, end, raw, ...f }) => f),
    readOnly: Boolean(reason),
    readOnlyReason: reason,
  };
}

async function backup(scope, rel, text) {
  const dir = backupDirFor(scope, rel);
  await mkdir(dir, { recursive: true });
  const id = String(Date.now());
  await writeFile(path.join(dir, `${id}.bak`), text);
  const old = (await readdir(dir)).filter((n) => n.endsWith('.bak')).sort();
  for (const name of old.slice(0, Math.max(0, old.length - MAX_VERSIONS))) await rm(path.join(dir, name), { force: true });
  return id;
}

async function loadForWrite(scope, relIn, etag) {
  const { full, rel } = scopeFile(scope, relIn);
  const current = await readText(full);
  const reason = readOnlyReason(rel, current);
  if (reason) throw new HttpError(403, reason);
  if (etag && etag !== etagOf(current)) throw new HttpError(409, 'This file changed since you opened it. Reload it to get the latest version.');
  return { full, rel, current };
}

export async function saveContent(scope, relIn, content, etag, { force = false } = {}) {
  if (typeof content !== 'string') throw new HttpError(400, 'Missing file content');
  const { full, rel, current } = await loadForWrite(scope, relIn, etag);
  let next = content;
  if (isCfgLike(rel)) {
    try { next = restoreSecrets(content, current); } catch (err) { throw new HttpError(409, err.message); }
    if (next.includes(SECRET_MASK)) throw new HttpError(409, 'A hidden value could not be restored. Reload and try again.');
  }
  if (next === current) return { ...(await readEditable(scope, relIn)), backupId: null, syntaxChecked: false };
  const check = await findMistake(rel, next);
  refuseMistake(check, force);
  const backupId = await backup(scope, relIn, current);
  await connection().files.write(full, next);
  recordFileChange(scope, relIn, backupId);
  return { ...(await readEditable(scope, relIn)), backupId, syntaxChecked: check.checked && !check.plain };
}

export async function saveFields(scope, relIn, changes, etag, { force = false } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw new HttpError(400, 'No changes to save');
  const { full, rel, current } = await loadForWrite(scope, relIn, etag);
  const { kind } = fieldsFor(scope, rel, current);
  if (!kind) throw new HttpError(400, 'This file does not have simple settings');
  let next;
  try { next = applyFieldChanges(current, kind, changes); } catch (err) { throw new HttpError(409, err.message); }
  const check = await findMistake(rel, next);
  refuseMistake(check, force);
  const backupId = await backup(scope, relIn, current);
  await connection().files.write(full, next);
  recordFileChange(scope, relIn, backupId, `Changed settings in ${rel}`);
  return { ...(await readEditable(scope, relIn)), backupId, syntaxChecked: check.checked && !check.plain };
}

export async function listVersions(scope, rel) {
  scopeFile(scope, rel);
  const dir = backupDirFor(scope, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of (await readdir(dir)).filter((x) => x.endsWith('.bak'))) {
    const { size } = await stat(path.join(dir, n));
    out.push({ id: n.slice(0, -4), savedAt: Number(n.slice(0, -4)), size });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export async function restoreVersion(scope, rel, id) {
  if (!/^\d+$/.test(String(id))) throw new HttpError(400, 'Invalid version');
  const { full, current } = await loadForWrite(scope, rel);
  const source = path.join(backupDirFor(scope, rel), `${id}.bak`);
  if (!existsSync(source)) throw new HttpError(404, 'That backup no longer exists');
  const before = await backup(scope, rel, current);
  await connection().files.write(full, await readFile(source, 'utf8'));
  recordFileChange(scope, rel, before, `Put back an older version of ${rel}`);
  return readEditable(scope, rel);
}

// ---------------------------------------------------------------- the Files page
const kindByName = (name) => {
  const ext = path.posix.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return 'image';
  return EDITABLE.has(ext) ? 'text' : 'other';
};

export async function browseFolder(rel = '') {
  const full = hostFile(rel);
  const entries = (await connection().files.list(full))
    .filter((e) => !isTokenFile(path.posix.join(rel, e.name)))
    .map((e) => ({
      name: e.name,
      path: relOf(path.posix.join(full, e.name)),
      type: e.dir ? 'dir' : 'file',
      size: e.size ?? 0,
      modified: e.modified ?? 0,
      ...(e.dir ? { items: null } : { kind: kindByName(e.name) }),
    }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return { path: relOf(full), entries: entries.slice(0, 3000), truncated: entries.length > 3000 };
}

export async function fileDetails(rel) {
  const full = hostFile(rel);
  if (isTokenFile(rel)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');
  const parent = await connection().files.list(path.posix.dirname(full));
  const entry = parent.find((e) => e.name === path.posix.basename(full));
  if (!entry) throw new HttpError(404, 'That file no longer exists');
  if (entry.dir) throw new HttpError(400, 'That is not a file');
  let kind = kindByName(entry.name);
  if (kind === 'other') kind = 'binary';
  if (kind === 'text' && entry.size > MAX_EDIT_BYTES) kind = 'large';
  const isCfg = full === server().cfgPath;
  return {
    path: relOf(full),
    name: entry.name,
    size: entry.size,
    modified: entry.modified,
    kind,
    editor: isCfg ? { scope: SERVER_SCOPE, path: 'server.cfg' } : { scope: DATA_SCOPE, path: relOf(full) },
    resourceRunning: false,
    // Text is downloaded only when it holds no key or password; other files only when small.
    canDownload: !isCfgLike(entry.name) && (kind === 'image' || kind === 'text') && entry.size <= MAX_EDIT_BYTES,
  };
}

export async function sendRaw(res, rel, wantDownload) {
  const details = await fileDetails(rel);
  if (!details.canDownload) throw new HttpError(403, 'On a hosted server, download this file from your host\'s file manager.');
  const full = hostFile(rel);
  const conn = connection();
  const body = await conn.files.readBytes(full);
  if (details.kind === 'text' && hasSecretValue(body.toString('utf8'))) throw new HttpError(403, 'This file can hold passwords or keys, so it can only be viewed here.');
  const imageType = IMAGE_TYPES[path.posix.extname(full).toLowerCase()];
  res.setHeader('Cache-Control', 'no-store');
  if (imageType && !wantDownload) res.setHeader('Content-Type', imageType);
  else { res.attachment(path.posix.basename(full)); res.setHeader('Content-Type', 'application/octet-stream'); }
  res.end(body);
}
