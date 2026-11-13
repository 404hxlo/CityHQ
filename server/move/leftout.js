// What a move to a host left out of server.cfg before CityHQ 1.8.4: CityHQ's own section of the
// PC's server.cfg, which holds scripts installed or switched on in CityHQ, admins, and settings
// changed there. The server on the PC is kept, so they're read from there and put back from
// Things to fix on Home.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { addToManagedBlock } from '../cfg.js';
import {
  CONFIG_NAME, findLocalServerData, HttpError, layoutOf, readConfig, REMOTE, STATE_DIR,
} from '../paths.js';
import { replaceFileSync } from '../retry.js';
import { searchStarts, SKIP_FOLDERS } from '../welcome.js';
import { describeLeftOut, linesLeftOut } from './plan.js';

const FILE = 'moved-from.json';

function readState(stateDir) {
  try { return JSON.parse(readFileSync(path.join(stateDir, FILE), 'utf8')); } catch { return null; }
}
function writeState(stateDir, value) {
  try {
    mkdirSync(stateDir, { recursive: true });
    replaceFileSync(path.join(stateDir, FILE), JSON.stringify(value, null, 2));
  } catch { /* looked into again at the next start */ }
}

/** Kept when a move switches over: where the server came from. Moves since 1.8.4 keep CityHQ's lines. */
export function rememberMovedFrom(hostedRoot, { root, cfgPath }) {
  writeState(path.join(hostedRoot, '.qbcontrol'), { root, cfgPath, at: Date.now(), keptCityHqLines: true });
}

const sameTarget = (t, remote) => Boolean(t && remote && t.type === remote.type && (t.type === 'panel'
  ? t.panelUrl === remote.panelUrl && String(t.serverId) === String(remote.serverId)
  : t.host === remote.host && Number(t.port || 22) === Number(remote.port || 22) && t.username === remote.username));

/** A server folder on this PC whose finished move went to this hosted server, with its server.cfg. */
async function movedHere(root, remote) {
  if (!existsSync(path.join(root, CONFIG_NAME))) return null;
  let move = null;
  try { move = JSON.parse(await readFile(path.join(root, '.qbcontrol', 'move.json'), 'utf8')); } catch { return null; }
  if (move?.phase !== 'done' || !sameTarget(move.target, remote)) return null;
  const layout = layoutOf(root, readConfig(root));
  const server = findLocalServerData(path.join(layout.txDataDir, layout.profile), layout.txDataDir);
  return server ? { root, cfgPath: server.cfgPath } : null;
}

/** Looks for that folder where servers usually are: each drive's top folders, Desktop, Documents. */
export async function findMovedFrom(remote, { starts = searchStarts(), maxDepth = 2, timeLimitMs = 8000 } = {}) {
  const deadline = Date.now() + timeLimitMs;
  let level = starts;
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      if (Date.now() > deadline) return null;
      const found = await movedHere(dir, remote).catch(() => null);
      if (found) return found;
      if (depth === maxDepth) continue;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && !SKIP_FOLDERS.test(e.name)) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return null;
}

// One search per start of CityHQ (per hosted server), whatever it finds.
const searches = new Map();

/**
 * Where this hosted server was moved from, when that move may have left lines out; otherwise
 * null. The first time, the folder is looked for in the background, so a later check has the
 * answer (wait: true waits for it instead).
 */
export async function leftOutSource({
  remote = REMOTE, stateDir = STATE_DIR, find = findMovedFrom, wait = false,
} = {}) {
  if (!remote) return null;
  const known = readState(stateDir);
  if (known?.keptCityHqLines || known?.restoredAt) return null;
  if (known?.cfgPath) return known;
  if (known?.searched) return null;
  if (!searches.has(stateDir)) {
    searches.set(stateDir, Promise.resolve().then(() => find(remote)).then((found) => {
      writeState(stateDir, found ? { ...found, foundAt: Date.now() } : { searched: true, searchedAt: Date.now() });
    }).catch(() => {}));
  }
  if (!wait) return null;
  await searches.get(stateDir);
  return leftOutSource({ remote, stateDir, find });
}

/** For Things to fix: what an earlier move left out, with a button that puts it back. */
export async function leftOutProblem(hostCfg, options = {}) {
  const from = await leftOutSource(options);
  const pcCfg = from ? await readFile(from.cfgPath, 'utf8').catch(() => null) : null;
  if (pcCfg === null) return null;
  const lines = linesLeftOut(pcCfg, hostCfg);
  if (!lines.length) return null;
  const what = describeLeftOut(lines);
  const one = lines.length === 1;
  return {
    id: 'move-left-out',
    rule: 'move-left-out',
    // Missing scripts and admins change how the server works; a setting matters less.
    severity: lines.some((l) => /^(?:ensure|start|restart|add_principal)\s/i.test(l)) ? 'error' : 'warning',
    resource: null,
    count: lines.length,
    title: `The move left out ${one ? 'a line' : `${lines.length} lines`} of your server.cfg`,
    what: `When CityHQ moved your server here, it didn't bring what CityHQ itself had added to server.cfg on your PC: ${what}. Your server on the PC still has ${one ? 'it' : 'them'}.`,
    fix: [`Press the button to add ${one ? 'it' : 'them'} to server.cfg on your host, as on your PC.`, 'Restart the server so the change takes effect.'],
    actions: [{
      kind: 'fix',
      label: one ? 'Put it back' : 'Put them back',
      confirm: `CityHQ adds ${what} to server.cfg on your host, in CityHQ's own section like on your PC. A copy of server.cfg is saved first, and you can undo this. ${one ? 'It takes' : 'They take'} effect when the server restarts.`,
      fix: { type: 'restore-moved-lines' },
    }],
    links: [],
    raw: lines.join('\n'),
  };
}

/**
 * Puts the lines back through changeCfg, which keeps a copy of server.cfg first. The problem isn't
 * shown again afterwards, even after an undo, which counts as choosing to leave them out.
 */
export async function restoreLeftOut(changeCfg, options = {}) {
  const from = await leftOutSource(options);
  const pcCfg = from ? await readFile(from.cfgPath, 'utf8').catch(() => null) : null;
  if (pcCfg === null) throw new HttpError(409, 'CityHQ can\'t read server.cfg of your server on this PC any more, so it can\'t tell what to put back.');
  let added = [];
  const versionId = await changeCfg((cfg) => {
    added = linesLeftOut(pcCfg, cfg);
    return added.length ? addToManagedBlock(cfg, added) : cfg;
  });
  const stateDir = options.stateDir || STATE_DIR;
  writeState(stateDir, { ...(readState(stateDir) || {}), restoredAt: Date.now() });
  if (!added.length) return { message: 'server.cfg on your host already has everything from your PC, so nothing needed adding.', versionId: null, undo: null };
  const one = added.length === 1;
  return {
    message: `Added ${describeLeftOut(added)} to server.cfg on your host. Restart the server to use ${one ? 'it' : 'them'}.`,
    versionId,
    undo: { type: 'remove-lines', lines: added },
  };
}
