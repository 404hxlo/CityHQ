// One-click fixes for problems CityHQ recognizes. Nothing runs until someone presses the button;
// every server.cfg change saves a copy in its version history first and can be undone.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refreshAwake } from './awake.js';
import { createBackup } from './backups.js';
import {
  addBootLine, parseBoot, readCfg, removeBootLine, writeCfg,
} from './cfg.js';
import { dbRun, tableInfo, VALID_TABLE } from './db.js';
import { keepVersion, SERVER_SCOPE } from './files.js';
import { HttpError, resolveInside, STATE_DIR } from './paths.js';
import {
  isValidName, resourceAction, scanDisk, serverData, setBoot,
} from './resources.js';
import { getSettings, updateSettings } from './settings.js';

// ---- reading a script's .sql files ----

/** SQL without comments (-- ..., # ..., /* ... *\/), leaving quoted text alone. */
export function stripSqlComments(sql) {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote && sql[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    if ((c === '-' && sql[i + 1] === '-' && /[\s]/.test(sql[i + 2] ?? ' ')) || c === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** The CREATE TABLE statement for a table in an .sql file, up to its closing semicolon, or null. */
export function createStatementFor(table, rawSql) {
  const sql = stripSqlComments(rawSql);
  const start = sql.search(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"]?${table}[\`"]?\\s*\\(`, 'i'));
  if (start === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = sql.indexOf('(', start); i < sql.length; i++) {
    const c = sql[i];
    if (quote) { if (c === quote && sql[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const end = sql.indexOf(';', i);
      return sql.slice(start, end === -1 ? sql.length : end).trim();
    }
  }
  return null;
}

/** The column names a CREATE TABLE statement defines (keys and constraints left out). */
export function columnsOf(rawStatement) {
  const statement = stripSqlComments(rawStatement);
  const body = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const c of body) {
    if (quote) { if (c === quote) quote = null; current += c; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim())
    .filter((p) => p && !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK)\b/i.test(p))
    .map((p) => p.match(/^[`"]?(\w+)[`"]?/)?.[1])
    .filter(Boolean);
}

/**
 * Tables in a script's .sql files that define a column, so "Unknown column 'components'" can be
 * traced to player_outfits. When several do, the ones the failed query names come first.
 */
export function tablesDefining(column, files, query = '') {
  const found = [];
  for (const { file, text: raw } of files) {
    const text = stripSqlComments(raw);
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi)) {
      const statement = createStatementFor(m[1], text);
      if (statement && columnsOf(statement).some((c) => c.toLowerCase() === column.toLowerCase())) {
        found.push({ table: m[1], file });
      }
    }
  }
  const named = found.filter((f) => new RegExp(`\\b${f.table}\\b`, 'i').test(query));
  return named.length ? named : found;
}

const LOG_FILE = path.join(STATE_DIR, 'fixes.json');
const KEEP = 50;
const EOL = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const startLine = (name) => new RegExp(`^\\s*(ensure|start)\\s+["']?${esc(name)}["']?\\s*(?:#.*)?$`);
export const startBeforeNote = (provider, dependent) => `# CityHQ: ${provider} starts here so ${dependent} gets it (moved here by a fix)`;

/**
 * Moves the line that starts `provider` to just before the first line that starts `dependent`
 * (its own line or its [category]). Returns the new text and the line that came before the
 * provider's old spot, so the move can be undone.
 */
export function startBefore(text, provider, dependent, dependentCategories = []) {
  const eol = EOL(text);
  const lines = text.split(/\r?\n/);
  const p = lines.findIndex((l) => startLine(provider).test(l));
  const targets = [dependent, ...dependentCategories];
  const d = lines.findIndex((l) => targets.some((t) => startLine(t).test(l)));
  if (p === -1) throw new HttpError(409, `server.cfg has no line that starts ${provider}.`);
  if (d === -1) throw new HttpError(409, `server.cfg has no line that starts ${dependent}.`);
  if (p < d) return { text, changed: false, anchor: null };
  const anchor = p > 0 ? lines[p - 1] : null;
  const [moved] = lines.splice(p, 1);
  lines.splice(d, 0, startBeforeNote(provider, dependent), moved.trim());
  return { text: lines.join(eol), changed: true, anchor };
}

/** Puts a line moved by startBefore back where it was, right after its old neighbour. */
export function undoStartBefore(text, provider, dependent, anchor) {
  const eol = EOL(text);
  const lines = text.split(/\r?\n/);
  const note = lines.indexOf(startBeforeNote(provider, dependent));
  if (note === -1 || !startLine(provider).test(lines[note + 1] || '')) {
    throw new HttpError(409, 'server.cfg changed since this fix, so it can\'t be undone automatically. Use Backups on server.cfg instead.');
  }
  const [, moved] = lines.splice(note, 2);
  const at = anchor === null ? 0 : lines.indexOf(anchor) + 1;
  if (anchor !== null && at === 0) throw new HttpError(409, 'The line it came after is gone, so it can\'t be undone automatically. Use Backups on server.cfg instead.');
  lines.splice(at, 0, moved);
  return lines.join(eol);
}

async function readLog() {
  try { return JSON.parse(await readFile(LOG_FILE, 'utf8')); } catch { return []; }
}
async function writeLog(list) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(LOG_FILE, JSON.stringify(list.slice(0, KEEP), null, 1));
}

/** Fixes made so far, newest first, for the "Recently fixed" list and to hide what's been fixed. */
export async function listFixes() {
  return (await readLog()).map(({ undo, ...rest }) => ({ ...rest, undoable: Boolean(undo) && !rest.undone }));
}

/** The problem ids already fixed during this boot of the server (their log lines remain until a restart). */
export async function fixedThisBoot(bootMarker) {
  return new Set((await readLog()).filter((f) => !f.undone && f.boot === bootMarker).map((f) => f.problemId));
}

async function changeCfg(mutate) {
  const { cfgPath } = serverData();
  const before = await readCfg(cfgPath);
  const after = mutate(before);
  if (after === before) return null;
  const versionId = await keepVersion(SERVER_SCOPE, 'server.cfg');
  await writeCfg(cfgPath, after);
  return versionId;
}

/** Runs a fix after checking, again, that the situation it was planned for is still true. */
export async function runFix(fix) {
  const { cfgPath } = serverData();
  if (fix.type === 'cfg-off') {
    if (!isValidName(fix.name)) throw new HttpError(400, 'Invalid resource name');
    const disk = await scanDisk();
    if (disk.some((r) => r.name === fix.name || r.provides.includes(fix.name))) {
      throw new HttpError(409, `${fix.name} is installed now, so its line was left on.`);
    }
    if (!parseBoot(await readCfg(cfgPath)).names.has(fix.name)) throw new HttpError(409, `server.cfg no longer starts ${fix.name}.`);
    const versionId = await changeCfg((cfg) => removeBootLine(cfg, fix.name));
    return {
      message: `server.cfg no longer starts ${fix.name}. The line is kept, switched off. The warning goes away at the next restart.`,
      versionId,
      undo: { type: 'cfg-on', name: fix.name },
    };
  }
  if (fix.type === 'start-before') {
    for (const n of [fix.provider, fix.dependent]) if (!isValidName(n)) throw new HttpError(400, 'Invalid resource name');
    const disk = await scanDisk();
    const dependent = disk.find((r) => r.name === fix.dependent);
    const provider = disk.find((r) => r.name === fix.provider);
    if (!dependent || !provider) throw new HttpError(409, 'One of these resources is no longer installed.');
    let anchor = null;
    const versionId = await changeCfg((cfg) => {
      const moved = startBefore(cfg, fix.provider, fix.dependent, dependent.categories);
      anchor = moved.anchor;
      return moved.text;
    });
    let started = '';
    try {
      await resourceAction(fix.dependent, 'ensure');
      started = ` ${fix.dependent} is running again.`;
    } catch (err) {
      started = ` ${fix.dependent} didn't start: ${err.message}`;
    }
    return {
      message: `${fix.provider} now starts before ${fix.dependent} in server.cfg.${started}`,
      versionId,
      undo: versionId ? { type: 'start-before', provider: fix.provider, dependent: fix.dependent, anchor } : null,
    };
  }
  if (fix.type === 'start') {
    if (!isValidName(fix.name)) throw new HttpError(400, 'Invalid resource name');
    await resourceAction(fix.name, 'ensure');
    return { message: `${fix.name} started.`, versionId: null, undo: null };
  }
  if (fix.type === 'rebuild-table') {
    if (!isValidName(fix.resource) || !VALID_TABLE.test(fix.table) || !/^\w+$/.test(fix.column)) throw new HttpError(400, 'Invalid fix');
    const resource = (await scanDisk()).find((r) => r.name === fix.resource);
    if (!resource) throw new HttpError(409, `${fix.resource} is no longer installed.`);
    const file = resolveInside(resource.dir, fix.file);
    if (!file.toLowerCase().endsWith('.sql') || !existsSync(file)) throw new HttpError(409, `${fix.file} is no longer there.`);
    const statement = createStatementFor(fix.table, await readFile(file, 'utf8'));
    if (!statement || !columnsOf(statement).includes(fix.column)) throw new HttpError(409, `${fix.file} no longer creates ${fix.table} with ${fix.column}.`);
    const before = await tableInfo(fix.table);
    if (before?.rows > 0) throw new HttpError(409, `${fix.table} has data in it now, so it was left alone.`);
    if (before?.columns.includes(fix.column)) throw new HttpError(409, `${fix.table} already has ${fix.column}.`);
    const backup = await createBackup('before-fix', { parts: ['database'] });
    await dbRun(`DROP TABLE IF EXISTS \`${fix.table}\`; ${statement};`);
    const after = await tableInfo(fix.table);
    if (!after?.columns.includes(fix.column)) throw new HttpError(500, `${fix.table} could not be rebuilt. Your database backup ${backup.id} has it as it was.`);
    return {
      message: `${fix.table} was rebuilt from ${path.basename(fix.file)}, the way ${fix.resource} expects. A database backup (${backup.id}) was made first.`,
      versionId: null,
      undo: null,
    };
  }
  if (fix.type === 'create-tables') {
    if (!isValidName(fix.resource) || !Array.isArray(fix.tables) || !fix.tables.length) throw new HttpError(400, 'Invalid fix');
    const resource = (await scanDisk()).find((r) => r.name === fix.resource);
    if (!resource) throw new HttpError(409, `${fix.resource} is no longer installed.`);
    const statements = [];
    for (const { table, file } of fix.tables) {
      if (!VALID_TABLE.test(table)) throw new HttpError(400, 'Invalid table name');
      const full = resolveInside(resource.dir, file);
      if (!full.toLowerCase().endsWith('.sql') || !existsSync(full)) throw new HttpError(409, `${file} is no longer there.`);
      if (await tableInfo(table)) continue;
      const statement = createStatementFor(table, await readFile(full, 'utf8'));
      if (!statement) throw new HttpError(409, `${file} no longer creates ${table}.`);
      // Only ever creates; an existing table is never touched.
      statements.push(statement.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '));
    }
    if (!statements.length) return { message: 'Those tables exist now, so nothing needed doing.', versionId: null, undo: null };
    const backup = await createBackup('before-fix', { parts: ['database'] });
    await dbRun(statements.map((s) => `${s};`).join('\n'));
    const still = [];
    for (const { table } of fix.tables) if (!(await tableInfo(table))) still.push(table);
    if (still.length) throw new HttpError(500, `${still.join(', ')} could not be created. Your database backup ${backup.id} has it as it was.`);
    return { message: `Created ${fix.tables.map((t) => t.table).join(', ')} for ${fix.resource}. A database backup (${backup.id}) was made first.`, versionId: null, undo: null };
  }
  if (fix.type === 'keep-awake') {
    const previous = getSettings().keepAwake;
    updateSettings({ keepAwake: { enabled: true, screenOnBattery: Boolean(fix.screenOnBattery) } });
    refreshAwake();
    return {
      message: fix.screenOnBattery ? 'CityHQ now keeps the PC and its screen awake while the server runs on battery.' : 'CityHQ now keeps the PC awake while the server runs.',
      versionId: null,
      undo: { type: 'keep-awake', previous },
    };
  }
  if (fix.type === 'boot-off') {
    if (!isValidName(fix.name)) throw new HttpError(400, 'Invalid resource name');
    await setBoot(fix.name, false, { record: false });
    return { message: `${fix.name} won't start with the server any more. You can turn it back on from Resources.`, versionId: null, undo: { type: 'boot-on', name: fix.name } };
  }
  throw new HttpError(400, 'Unknown fix');
}

/** Saves what a fix did, so it can be listed, hidden from problems and undone. */
export async function recordFix(entry) {
  const list = await readLog();
  const record = { id: String(Date.now()), at: Date.now(), undone: false, ...entry };
  await writeLog([record, ...list]);
  return record;
}

export async function undoFix(id) {
  const list = await readLog();
  const record = list.find((f) => f.id === String(id));
  if (!record) throw new HttpError(404, 'That fix was not found.');
  if (record.undone) throw new HttpError(409, 'That fix was already undone.');
  if (!record.undo) throw new HttpError(400, 'This fix can\'t be undone here.');
  const { undo } = record;
  if (undo.type === 'cfg-on') {
    await changeCfg((cfg) => addBootLine(cfg, undo.name));
  } else if (undo.type === 'start-before') {
    await changeCfg((cfg) => undoStartBefore(cfg, undo.provider, undo.dependent, undo.anchor));
  } else if (undo.type === 'keep-awake') {
    updateSettings({ keepAwake: undo.previous });
    refreshAwake();
  } else if (undo.type === 'boot-on') {
    await setBoot(undo.name, true, { record: false });
  } else {
    throw new HttpError(400, 'Unknown undo');
  }
  record.undone = true;
  record.undoneAt = Date.now();
  await writeLog(list);
  return { message: `Undone: ${record.title}` };
}
