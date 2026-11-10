// The Files page: browse, inspect, search and download anything in the server's data folder.
// It never reaches outside that folder, so txAdmin accounts and the database stay out of it.
import { createReadStream, existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { agentRequest } from './agent.js';
import {
  assertSafeRel, DATA_SCOPE, EDITABLE, isSecretFile, looksLikeText, MAX_EDIT_BYTES, safeToDownload, safeView, SERVER_SCOPE, tokenPath,
} from './files.js';
import { HttpError, resolveInside } from './paths.js';
import { findResourceDir, serverData } from './resources.js';

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MAX_FOLDER_ENTRIES = 3000;
const MAX_RESULTS = 200;
const MAX_HITS_PER_FILE = 8;
const MAX_SEARCH_BYTES = 1024 * 1024;
const SEARCH_MS = 12000;
const SEARCH_WORKERS = 6;
const SKIP_IN_SEARCH = new Set(['node_modules', '.git']);

const toPosix = (p) => p.replaceAll('\\', '/');
const relFrom = (root, full) => toPosix(path.relative(root, full));

function kindByName(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return 'image';
  return EDITABLE.has(ext) ? 'text' : 'other';
}

function locate(rel) {
  assertSafeRel(rel);
  const { dataPath } = serverData();
  return { dataPath, full: resolveInside(dataPath, rel) };
}

export async function browseFolder(rel = '') {
  const { dataPath, full } = locate(rel);
  const info = await stat(full).catch(() => null);
  if (!info) throw new HttpError(404, 'That folder no longer exists');
  if (!info.isDirectory()) throw new HttpError(400, 'That is not a folder');

  const token = tokenPath()?.toLowerCase();
  const all = await readdir(full, { withFileTypes: true });
  const visible = all.filter((e) => (e.isDirectory() || e.isFile()) && path.join(full, e.name).toLowerCase() !== token);
  const truncated = visible.length > MAX_FOLDER_ENTRIES;

  const entries = await Promise.all(visible.slice(0, MAX_FOLDER_ENTRIES).map(async (e) => {
    const child = path.join(full, e.name);
    const childInfo = await stat(child).catch(() => null);
    const entry = {
      name: e.name,
      path: relFrom(dataPath, child),
      type: e.isDirectory() ? 'dir' : 'file',
      size: childInfo?.size ?? 0,
      modified: childInfo?.mtimeMs ?? 0,
    };
    if (e.isDirectory()) entry.items = (await readdir(child).catch(() => [])).length;
    else entry.kind = kindByName(e.name);
    return entry;
  }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return { path: toPosix(path.relative(dataPath, full)), entries, truncated };
}

/** Finds the editor scope for a file, so backups stay with the file however it was opened. */
async function editorTarget(rel, dataPath) {
  const parts = rel.split('/');
  if (path.resolve(dataPath, rel).toLowerCase() === serverData().cfgPath.toLowerCase()) {
    return { scope: SERVER_SCOPE, path: 'server.cfg' };
  }
  if (parts[0].toLowerCase() === 'resources') {
    let dir = path.join(dataPath, 'resources');
    for (let i = 1; i < parts.length - 1; i++) {
      dir = path.join(dir, parts[i]);
      if (parts[i].startsWith('[') && parts[i].endsWith(']')) continue;
      if (existsSync(path.join(dir, 'fxmanifest.lua')) || existsSync(path.join(dir, '__resource.lua'))) {
        // Two folders can hold a resource of the same name; only trust an exact match.
        const known = await findResourceDir(parts[i]);
        if (known && path.resolve(known.dir).toLowerCase() === path.resolve(dir).toLowerCase()) {
          return { scope: parts[i], path: parts.slice(i + 1).join('/') };
        }
      }
      break;
    }
  }
  return { scope: DATA_SCOPE, path: rel };
}

async function sniffText(full) {
  const handle = await open(full, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return looksLikeText(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function fileDetails(rel) {
  const { dataPath, full } = locate(rel);
  const info = await stat(full).catch(() => null);
  if (!info) throw new HttpError(404, 'That file no longer exists');
  if (!info.isFile()) throw new HttpError(400, 'That is not a file');
  if (isSecretFile(full)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');

  const normalized = relFrom(dataPath, full);
  let kind = kindByName(full);
  if (kind === 'other' && info.size <= MAX_EDIT_BYTES) kind = await sniffText(full) ? 'text' : 'binary';
  else if (kind === 'other') kind = 'binary';
  if (kind === 'text' && info.size > MAX_EDIT_BYTES) kind = 'large';

  const editor = await editorTarget(normalized, dataPath);
  let resourceRunning = false;
  if (kind === 'text' && editor.scope !== SERVER_SCOPE && editor.scope !== DATA_SCOPE) {
    const live = await agentRequest('/resources', { timeoutMs: 2500 }).catch(() => null);
    resourceRunning = live?.find((r) => r.name === editor.scope)?.state === 'started';
  }
  return {
    path: normalized,
    name: path.basename(full),
    size: info.size,
    modified: info.mtimeMs,
    kind,
    editor,
    resourceRunning,
    canDownload: await safeToDownload(full, info.size),
  };
}

/** Sends a file's bytes: images shown inline, everything else as a download. */
export async function sendRaw(res, rel, wantDownload) {
  const { full } = locate(rel);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, 'That file no longer exists');
  if (isSecretFile(full)) throw new HttpError(403, 'That file is private to the app and cannot be opened.');
  if (!await safeToDownload(full, info.size)) {
    throw new HttpError(403, 'This file can hold passwords or keys, so it can only be viewed here.');
  }

  const imageType = IMAGE_TYPES[path.extname(full).toLowerCase()];
  res.setHeader('Content-Length', info.size);
  res.setHeader('Cache-Control', 'no-store');
  if (imageType && !wantDownload) {
    res.setHeader('Content-Type', imageType);
  } else {
    res.attachment(path.basename(full));
    // attachment() guesses a type from the name; a download should never be rendered as one.
    res.setHeader('Content-Type', 'application/octet-stream');
  }
  try {
    await pipeline(createReadStream(full), res);
  } catch (err) {
    // The person cancelled or closed the page; nothing is wrong with the file.
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
  }
}

async function* walkFiles(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { full, name: e.name, dir: true };
      if (!SKIP_IN_SEARCH.has(e.name)) yield* walkFiles(full);
    } else if (e.isFile()) {
      yield { full, name: e.name, dir: false };
    }
  }
}

/** A short piece of the line around the match, since minified files can be one huge line. */
export function snippetAround(line, index, queryLength) {
  const trimmedStart = line.length - line.trimStart().length;
  const start = Math.max(trimmedStart, index - 70);
  const end = Math.min(line.length, index + queryLength + 110);
  return `${start > trimmedStart ? '...' : ''}${line.slice(start, end).trimEnd()}${end < line.length ? '...' : ''}`;
}

export async function searchFiles(rawQuery, mode, rel = '') {
  const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
  if (query.length < 2) throw new HttpError(400, 'Type at least 2 characters to search');
  const { dataPath, full: root } = locate(rel);
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new HttpError(404, 'That folder no longer exists');
  const token = tokenPath()?.toLowerCase();

  if (mode !== 'text') {
    const results = [];
    let truncated = false;
    for await (const item of walkFiles(root)) {
      if (item.full.toLowerCase() === token || !item.name.toLowerCase().includes(query)) continue;
      if (results.length >= MAX_RESULTS) { truncated = true; break; }
      results.push({ path: relFrom(dataPath, item.full), name: item.name, type: item.dir ? 'dir' : 'file' });
    }
    return { results, truncated, timedOut: false };
  }

  const candidates = [];
  for await (const item of walkFiles(root)) {
    if (!item.dir && item.full.toLowerCase() !== token && EDITABLE.has(path.extname(item.name).toLowerCase())) candidates.push(item);
  }
  const deadline = Date.now() + SEARCH_MS;
  const results = [];
  let next = 0;
  let truncated = false;
  let timedOut = false;

  await Promise.all(Array.from({ length: SEARCH_WORKERS }, async () => {
    while (next < candidates.length && results.length < MAX_RESULTS) {
      if (Date.now() > deadline) { timedOut = true; return; }
      const item = candidates[next++];
      const info = await stat(item.full).catch(() => null);
      if (!info || info.size > MAX_SEARCH_BYTES) continue;
      const raw = await readFile(item.full, 'utf8').catch(() => null);
      if (raw === null || !raw.toLowerCase().includes(query)) continue;
      const text = safeView(item.full, raw).content;
      let hits = 0;
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        const at = line.toLowerCase().indexOf(query);
        if (at === -1) continue;
        if (results.length >= MAX_RESULTS) { truncated = true; break; }
        results.push({ path: relFrom(dataPath, item.full), name: item.name, type: 'file', line: i + 1, text: snippetAround(line, at, query.length) });
        if (++hits >= MAX_HITS_PER_FILE) break;
      }
    }
  }));
  if (next < candidates.length && results.length >= MAX_RESULTS) truncated = true;
  results.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { results, truncated, timedOut };
}
