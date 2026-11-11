// One timeline of everything changed on the server through CityHQ, each with a way back.
// The parts of the app that make changes record them here and register how to undo them, so
// this file knows nothing about files, resources or the database itself.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, STATE_DIR } from './paths.js';

const FILE = path.join(STATE_DIR, 'history.json');
const KEEP = 300;
const undoers = new Map();
let writing = Promise.resolve();
const undoing = new Set();
// One-click fixes keep their own log; it's plugged in from app.js to keep imports one-way.
let fixLog = { list: async () => [], undo: async () => { throw new HttpError(400, 'Fixes are not available.'); } };

/** How to undo one kind of change: fn(undo) returns a message, or nothing. */
export function registerUndo(type, fn) { undoers.set(type, fn); }

/** Shows one-click fixes in the same timeline: { list(), undo(id) }. */
export function registerFixLog(source) { fixLog = source; }

async function readAll() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); } catch { return []; }
}

/** Runs a read-and-write of the history file after the ones before it, so none is lost. */
function queue(task) {
  const run = writing.then(task);
  writing = run.catch(() => {});
  return run;
}

/** Remembers a change. Never throws: history must not break the change itself. */
export function recordChange({ kind, title, detail = '', undo = null, undoHint = '' }) {
  return queue(async () => {
    try {
      const list = await readAll();
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      list.unshift({ id, at: Date.now(), kind, title, detail, undo, undoHint, undone: false });
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(FILE, JSON.stringify(list.slice(0, KEEP), null, 1));
    } catch { /* only a record */ }
  });
}

/** The newest changes first, one-click fixes included, each saying whether it can be undone. */
export async function listChanges(limit = 100) {
  await writing;
  const own = (await readAll()).map(({ undo, ...rest }) => ({ ...rest, undoable: Boolean(undo && undoers.has(undo.type)) && !rest.undone }));
  const fixes = (await fixLog.list().catch(() => [])).map((f) => ({
    id: `fix:${f.id}`, at: f.at, kind: 'fix', title: f.label, detail: `${f.message} (${f.title})`, undoHint: 'This puts it back the way it was before the fix.', undone: f.undone, undoable: f.undoable,
  }));
  return [...own, ...fixes].sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function undoChange(id) {
  if (String(id).startsWith('fix:')) return fixLog.undo(String(id).slice(4));
  // A second press (or another device) while the first undo is still running must not run it again.
  if (undoing.has(id)) throw new HttpError(409, 'That change is already being undone.');
  undoing.add(id);
  try {
    await writing;
    const list = await readAll();
    const record = list.find((c) => c.id === id);
    if (!record) throw new HttpError(404, 'That change was not found.');
    if (record.undone) throw new HttpError(409, 'That change was already undone.');
    const undo = record.undo && undoers.get(record.undo.type);
    if (!undo) throw new HttpError(400, 'This change can\'t be undone here.');
    const message = await undo(record.undo);
    // Re-read inside the queue: the undo itself, or another request, may have recorded a change.
    await queue(async () => {
      const fresh = await readAll();
      const again = fresh.find((c) => c.id === id);
      if (!again) return;
      again.undone = true;
      again.undoneAt = Date.now();
      await writeFile(FILE, JSON.stringify(fresh, null, 1));
    });
    return { message: message || `Undone: ${record.title}` };
  } finally {
    undoing.delete(id);
  }
}
