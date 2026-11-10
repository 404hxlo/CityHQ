// Lets the whole server folder be copied to another drive or PC. Two settings files hold the
// folder's full path, so when the folder has moved they are pointed at where it is now.
import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DB_INI, DB_PORT, ROOT, ROOT_FOUND, TX_PROFILE, TXADMIN_PORT, TXDATA,
} from './paths.js';
import { isPortOpen } from './processes.js';
import { replaceFile } from './retry.js';

const slashes = (p) => p.replaceAll('\\', '/');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** my.ini with its data folder and error log pointed at this root. Returns null if nothing changes. */
export function relocateIni(text, root) {
  const wanted = {
    datadir: slashes(path.join(root, 'db', 'data')),
    'log-error': slashes(path.join(root, 'logs', 'mariadb.err')),
  };
  let changed = false;
  const out = text.split(/\r?\n/).map((line) => {
    const m = /^(\s*)(datadir|log-error)(\s*=\s*)(.*)$/.exec(line);
    if (!m || same(m[4].trim(), wanted[m[2]])) return line;
    changed = true;
    return `${m[1]}${m[2]}${m[3]}${wanted[m[2]]}`;
  });
  return changed ? out.join('\n') : null;
}

/**
 * Where txAdmin's server folder is now, if the saved one is gone but a folder of the same name
 * sits in this root's txData. Returns null when the saved path is fine or nothing matches.
 */
export function relocatedDataPath(saved, txData, exists = existsSync) {
  if (!saved || exists(saved)) return null;
  const candidate = path.join(txData, path.basename(saved.replace(/[\\/]+$/, '')));
  return exists(path.join(candidate, 'server.cfg')) ? `${slashes(candidate)}/` : null;
}

async function updateFile(file, text) {
  const keep = `${file}.before-move`;
  if (!existsSync(keep)) await copyFile(file, keep);
  await replaceFile(file, text);
}

/** Runs at startup. Each file is only touched while the program that reads it is not running. */
export async function repairMovedFolder() {
  if (!ROOT_FOUND) return [];
  const fixed = [];
  try {
    if (existsSync(DB_INI) && existsSync(path.join(ROOT, 'db', 'data')) && !(await isPortOpen(DB_PORT))) {
      const updated = relocateIni(await readFile(DB_INI, 'utf8'), ROOT);
      if (updated) { await updateFile(DB_INI, updated); fixed.push('database settings'); }
    }
  } catch (err) { console.error('[cityhq] could not update my.ini after a move:', err.message); }
  try {
    const file = path.join(TX_PROFILE, 'config.json');
    if (existsSync(file) && !(await isPortOpen(TXADMIN_PORT))) {
      const config = JSON.parse(await readFile(file, 'utf8'));
      const moved = relocatedDataPath(config?.server?.dataPath, TXDATA);
      if (moved) {
        config.server.dataPath = moved;
        await updateFile(file, JSON.stringify(config, null, 2));
        fixed.push('txAdmin settings');
      }
    }
  } catch (err) { console.error('[cityhq] could not update txAdmin settings after a move:', err.message); }
  return fixed;
}
