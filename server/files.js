// Safe file reading and editing for resources and server files, with automatic backups.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import {
  copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { agentRequest } from './agent.js';
import { maskSecrets, restoreSecrets, SECRET_MASK } from './cfg.js';
import { luaPlain } from './explain.js';
import { applyFieldChanges, parseCfgFields, parseLuaFields } from './fields.js';
import {
  BACKUP_DIR, findServerData, HttpError, resolveInside,
} from './paths.js';
import { recordChange } from './history.js';
import { findResourceDir, serverData } from './resources.js';
import { replaceFile } from './retry.js';

const shownPath = (scope, rel) => (scope === SERVER_SCOPE || scope === DATA_SCOPE ? rel : `${scope}/${rel}`);
const FILE_UNDO_HINT = 'This puts the file back to how it was just before this change. Later changes to the same file are undone too.';
const recordFileChange = (scope, rel, versionId, title) => recordChange({
  kind: 'file', title: title || `Changed ${shownPath(scope, rel)}`, undo: versionId ? { type: 'file-version', scope, rel, versionId } : null, undoHint: FILE_UNDO_HINT,
});

export const SERVER_SCOPE = '__server__';
export const DATA_SCOPE = '__data__';
const LOCKED_RESOURCE = 'qb-control';
export const EDITABLE = new Set([
  '.lua', '.js', '.json', '.cfg', '.txt', '.md', '.html', '.htm', '.css', '.xml', '.meta', '.yml', '.yaml', '.toml', '.sql', '.ts',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'stream', '.github']);
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 1500;
const MAX_VERSIONS = 25;

const etagOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Windows opens `name.`, `name ` and `name::$DATA` as if they were `name`, which could slip
 * past checks based on the file's name. Nothing legitimate in a server folder needs them.
 */
export function assertSafeRel(rel) {
  if (typeof rel !== 'string') throw new HttpError(400, 'Invalid path');
  if (rel.includes(':') || rel.includes('\0')) throw new HttpError(400, 'Invalid path');
  for (const segment of rel.split(/[\\/]/)) {
    if (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) throw new HttpError(400, 'Invalid path');
  }
}

/** The long, real name of a file, which also sees through short 8.3 names like SERVER~1.CFG. */
const realName = (full) => {
  try { return realpathSync.native(full); } catch { return full; }
};

/** Where the helper's private token is kept. The app and the server read it; nothing shows it. */
export function tokenPath() {
  const server = findServerData();
  return server ? path.join(server.dataPath, 'resources', '[local]', LOCKED_RESOURCE, 'token.txt') : null;
}

export function isSecretFile(full) {
  const token = tokenPath();
  if (!token || !existsSync(token) || !existsSync(full)) return false;
  return realName(full).toLowerCase() === realName(token).toLowerCase();
}

/** A real .cfg can be edited because its hidden values are put back when it is saved. */
export const isCfgFile = (full) => path.extname(realName(full)).toLowerCase() === '.cfg';

/** A .cfg or a copy of one, such as the server.cfg.bkp that txAdmin leaves behind. */
export const isCfgLike = (full) => /\.cfg(\.|$)/i.test(path.basename(realName(full)));

const SECRET_VALUE = /cfxk_[A-Za-z0-9_]{8,}|mysql:\/\/[^:\s"'/]+:[^@\s"']+@/;
export const hasSecretValue = (text) => SECRET_VALUE.test(text);

const scrub = (text) => text
  .replace(/cfxk_[A-Za-z0-9_]{8,}/g, 'cfxk_(hidden)')
  .replace(/(mysql:\/\/[^:\s"'/]+:)[^@\s"']+@/g, '$1(hidden)@');

/**
 * What a person may see of a file. Secrets are recognised by the file's name and by its
 * contents, because keys also end up in backups, comments and scripts. A secret that masking
 * cannot put back on save leaves the file view-only, so saving can never destroy the real value.
 */
export function safeView(full, text) {
  const masked = isCfgLike(full) ? maskSecrets(text) : text;
  const leftover = hasSecretValue(masked);
  return { content: leftover ? scrub(masked) : masked, viewOnly: leftover };
}

/** Whether a file's raw bytes may leave the app. Large game files are not worth scanning. */
export async function safeToDownload(full, size) {
  if (isCfgLike(full)) return false;
  if (size > 5 * 1024 * 1024) return true;
  return !hasSecretValue((await readFile(full)).toString('latin1'));
}

export function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return sample.length === 0 || control / sample.length < 0.05;
}

async function scopeBase(scope) {
  if (scope === SERVER_SCOPE) return path.dirname(serverData().cfgPath);
  if (scope === DATA_SCOPE) return serverData().dataPath;
  const resource = await findResourceDir(scope);
  if (!resource) throw new HttpError(404, 'That resource was not found');
  return resource.dir;
}

/** The server scope only ever exposes server.cfg, never txAdmin or database files. */
function assertScopePath(scope, rel) {
  assertSafeRel(rel);
  if (scope === SERVER_SCOPE && rel !== 'server.cfg') {
    throw new HttpError(403, 'Only server.cfg can be edited here');
  }
}

function refuseSecret(full) {
  if (isSecretFile(full)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');
}

export async function listFiles(scope) {
  if (scope === SERVER_SCOPE) return { files: [{ path: 'server.cfg', editable: true, size: 0 }], truncated: false };
  const base = await scopeBase(scope);
  const token = tokenPath()?.toLowerCase();
  const files = [];
  let truncated = false;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!EDITABLE.has(ext) || full.toLowerCase() === token) continue;
        const { size } = await stat(full);
        files.push({ path: path.relative(base, full).replaceAll('\\', '/'), editable: size <= MAX_EDIT_BYTES, size });
      }
    }
  }
  await walk(base);
  files.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  return { files, truncated };
}

/** Config files first, since those are what people open most. */
function rank(p) {
  const lower = p.toLowerCase();
  if (lower === 'config.lua') return 0;
  if (/(^|\/)config\.lua$/.test(lower)) return 1;
  if (/config/.test(lower)) return 2;
  if (lower === 'fxmanifest.lua') return 3;
  return 4;
}

const isConfigFile = (rel) => /(^|\/)[^/]*(config|settings)[^/]*\.lua$/i.test(rel);

function fieldsFor(scope, rel, text) {
  if (scope === SERVER_SCOPE) return { kind: 'cfg', fields: parseCfgFields(text) };
  if (isConfigFile(rel)) return { kind: 'lua', fields: parseLuaFields(text) };
  return { kind: null, fields: [] };
}

function readOnlyReason(scope, full, text) {
  if (scope === LOCKED_RESOURCE) return 'The app manages this file, so it can only be viewed.';
  if (!EDITABLE.has(path.extname(realName(full)).toLowerCase())) return 'This type of file can only be viewed here.';
  if (safeView(full, text).viewOnly) return 'This file contains a password or key. It is hidden here, so the file can only be viewed.';
  return null;
}

export async function readEditable(scope, rel) {
  assertScopePath(scope, rel);
  const base = await scopeBase(scope);
  const full = resolveInside(base, rel);
  if (!existsSync(full)) throw new HttpError(404, 'That file no longer exists');
  refuseSecret(full);
  const info = await stat(full);
  if (!info.isFile()) throw new HttpError(400, 'That is not a file');
  if (info.size > MAX_EDIT_BYTES) throw new HttpError(413, 'That file is too large to open here (over 2 MB)');
  const buffer = await readFile(full);
  const known = EDITABLE.has(path.extname(realName(full)).toLowerCase());
  if (!known && !looksLikeText(buffer)) throw new HttpError(415, 'That file is not text, so it cannot be opened here.');
  const text = buffer.toString('utf8');
  const reason = readOnlyReason(scope, full, text);
  const { kind, fields } = reason ? { kind: null, fields: [] } : fieldsFor(scope, rel, text);
  return {
    path: rel,
    content: safeView(full, text).content,
    etag: etagOf(text),
    fieldKind: kind,
    fields: fields.map(({ start, end, raw, ...f }) => f),
    readOnly: Boolean(reason),
    readOnlyReason: reason,
  };
}

const backupDirFor = (scope, rel) => {
  const key = createHash('sha1').update(`${scope}/${rel}`).digest('hex').slice(0, 12);
  return path.join(BACKUP_DIR, `${scope}--${path.basename(rel)}--${key}`);
};

async function backup(scope, rel, full) {
  const dir = backupDirFor(scope, rel);
  await mkdir(dir, { recursive: true });
  const id = String(Date.now());
  await copyFile(full, path.join(dir, `${id}.bak`));
  const old = (await readdir(dir)).filter((n) => n.endsWith('.bak')).sort();
  for (const name of old.slice(0, Math.max(0, old.length - MAX_VERSIONS))) {
    await rm(path.join(dir, name), { force: true });
  }
  return id;
}

/**
 * Looks for a typo before saving. Lua is compiled by the running server itself, so FiveM's own
 * extensions are understood and there are no false alarms. With the server off, it can't check.
 */
async function findMistake(full, text) {
  const ext = path.extname(realName(full)).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text.replace(/^﻿/, ''));
      return { checked: true };
    } catch (err) {
      const position = Number(String(err.message).match(/position (\d+)/)?.[1]);
      const line = Number.isFinite(position) ? text.slice(0, position).split('\n').length : undefined;
      return { checked: true, line, message: err.message, plain: 'This JSON has a mistake, often a missing or extra comma, quote or bracket.' };
    }
  }
  if (ext === '.lua') {
    try {
      const result = await agentRequest('/lua-check', { method: 'POST', body: { source: text, name: path.basename(full) }, timeoutMs: 8000 });
      if (result.ok) return { checked: true };
      return { checked: true, line: result.line, message: result.message, plain: luaPlain(result.message) };
    } catch {
      return { checked: false };
    }
  }
  return { checked: false };
}

function refuseMistake(check, force) {
  if (force || !check.plain) return;
  throw new HttpError(422, check.line ? `Line ${check.line}: ${check.plain}` : check.plain, {
    syntax: { line: check.line, message: check.message, plain: check.plain },
  });
}

async function loadForWrite(scope, rel, etag) {
  assertScopePath(scope, rel);
  const base = await scopeBase(scope);
  const full = resolveInside(base, rel);
  if (!existsSync(full)) throw new HttpError(404, 'That file no longer exists');
  refuseSecret(full);
  const current = await readFile(full, 'utf8');
  const reason = readOnlyReason(scope, full, current);
  if (reason) throw new HttpError(403, reason);
  if (etag && etag !== etagOf(current)) {
    throw new HttpError(409, 'This file changed since you opened it. Reload it to get the latest version.');
  }
  return { full, current };
}

export async function saveContent(scope, rel, content, etag, { force = false } = {}) {
  if (typeof content !== 'string') throw new HttpError(400, 'Missing file content');
  const { full, current } = await loadForWrite(scope, rel, etag);
  let next = content;
  if (isCfgFile(full)) {
    try { next = restoreSecrets(content, current); } catch (err) { throw new HttpError(409, err.message); }
    if (next.includes(SECRET_MASK)) throw new HttpError(409, 'A hidden value could not be restored. Reload and try again.');
  }
  if (next === current) return { ...(await readEditable(scope, rel)), backupId: null, syntaxChecked: false };
  const check = await findMistake(full, next);
  refuseMistake(check, force);
  const backupId = await backup(scope, rel, full);
  await replaceFile(full, next);
  recordFileChange(scope, rel, backupId);
  return { ...(await readEditable(scope, rel)), backupId, syntaxChecked: check.checked && !check.plain };
}

export async function saveFields(scope, rel, changes, etag, { force = false } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw new HttpError(400, 'No changes to save');
  const { full, current } = await loadForWrite(scope, rel, etag);
  const { kind } = fieldsFor(scope, rel, current);
  if (!kind) throw new HttpError(400, 'This file does not have simple settings');
  let next;
  try { next = applyFieldChanges(current, kind, changes); } catch (err) { throw new HttpError(409, err.message); }
  const check = await findMistake(full, next);
  refuseMistake(check, force);
  const backupId = await backup(scope, rel, full);
  await replaceFile(full, next);
  recordFileChange(scope, rel, backupId, `Changed settings in ${shownPath(scope, rel)}`);
  return { ...(await readEditable(scope, rel)), backupId, syntaxChecked: check.checked && !check.plain };
}

/** Saves a copy of a file into its version history, the same one the editor's Backups button shows. */
export async function keepVersion(scope, rel) {
  assertScopePath(scope, rel);
  const base = await scopeBase(scope);
  return backup(scope, rel, resolveInside(base, rel));
}

export async function listVersions(scope, rel) {
  assertScopePath(scope, rel);
  await scopeBase(scope);
  const dir = backupDirFor(scope, rel);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => n.endsWith('.bak'));
  const out = [];
  for (const n of names) {
    const { size } = await stat(path.join(dir, n));
    out.push({ id: n.slice(0, -4), savedAt: Number(n.slice(0, -4)), size });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export async function restoreVersion(scope, rel, id) {
  if (!/^\d+$/.test(String(id))) throw new HttpError(400, 'Invalid version');
  const { full } = await loadForWrite(scope, rel);
  const source = path.join(backupDirFor(scope, rel), `${id}.bak`);
  if (!existsSync(source)) throw new HttpError(404, 'That backup no longer exists');
  const before = await backup(scope, rel, full);
  await replaceFile(full, await readFile(source, 'utf8'));
  recordFileChange(scope, rel, before, `Put back an older version of ${shownPath(scope, rel)}`);
  return readEditable(scope, rel);
}
