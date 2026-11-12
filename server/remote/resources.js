// The Resources page for a hosted server: what runs comes from the helper (which also says where
// each one is), what starts with the server from server.cfg. Turning one on or off and choosing
// whether it starts with the server work; installing and removing come in a later version.
import path from 'node:path';
import { agentRequest } from '../agent.js';
import { addBootLine, parseBoot, readCfg, removeBootLine, writeCfg } from '../cfg.js';
import { serverFramework } from '../framework.js';
import { findServerData, HttpError } from '../paths.js';
import { recordChange } from '../history.js';
import {
  BUILT_IN_CATEGORY, categoryRank, isValidName, LOCKED_REASON, NEVER_STOP, warnOnStop,
} from '../resources.js';
import { hostPath } from './find.js';

/** The [category] folders a resource sits in, from its path on the host. */
export function categoriesOf(resourcePath, dataPath) {
  const p = hostPath(resourcePath || '');
  const base = `${(dataPath || '/').replace(/\/$/, '')}/resources/`;
  if (p.includes('/citizen/system_resources/')) return { builtIn: true, categories: [], folder: null };
  const rel = p.startsWith(base) ? p.slice(base.length) : null;
  if (rel === null) return { builtIn: false, categories: [], folder: null };
  const parts = rel.split('/');
  return { builtIn: false, categories: parts.slice(0, -1).filter((x) => /^\[.+\]$/.test(x)), folder: `resources/${rel}` };
}

let metaCache = { at: 0, value: null };

/**
 * What every resource needs and provides, from the running server's helper (cached briefly).
 * An older helper only lists names and places; a stopped server lists nothing.
 */
async function resourceMeta() {
  if (metaCache.value && Date.now() - metaCache.at < 20000) return metaCache.value;
  let list = null;
  try {
    list = await agentRequest('/resources/meta', { timeoutMs: 20000 });
  } catch {
    list = await agentRequest('/resources', { timeoutMs: 20000 }).catch(() => null);
  }
  metaCache = { at: Date.now(), value: list || [] };
  return metaCache.value;
}

/** The helper's list, shaped like the local disk scan (resources.js scanDisk) and built-ins. */
export function diskFromMeta(list, dataPath) {
  const disk = [];
  const system = [];
  for (const r of list || []) {
    const where = categoriesOf(r.path, dataPath);
    const base = {
      name: r.name, version: r.version || '', description: r.description || '', author: r.author || '',
      dependencies: r.dependencies || [], provides: r.provides || [],
    };
    if (where.builtIn) system.push(base);
    else if (where.folder) disk.push({ ...base, dir: path.posix.join(dataPath, where.folder), categories: where.categories });
  }
  return { disk, system };
}

/** Resources in the server's folder, shaped like the local disk scan (resources.js scanDisk). */
export async function hostedDisk() {
  return diskFromMeta(await resourceMeta(), server().dataPath).disk;
}

/** The resources built into FXServer, as the running server reports them. */
export async function hostedSystem() {
  return diskFromMeta(await resourceMeta(), server().dataPath).system;
}

export const forgetResourceMeta = () => { metaCache = { at: 0, value: null }; };

function server() {
  const s = findServerData();
  if (!s) throw new HttpError(409, 'CityHQ doesn\'t know where your hosted server\'s files are yet.');
  return s;
}

export async function listHostedResources() {
  const { cfgPath, dataPath } = server();
  forgetResourceMeta();
  const [live, cfg] = await Promise.all([
    resourceMeta().then((l) => (l.length ? l : null)).catch(() => null),
    readCfg(cfgPath),
  ]);
  if (!live) return { serverOnline: false, resources: [], hostedNote: 'The list comes from the running server, so it shows once the server is on and CityHQ\'s helper has started.' };
  const boot = parseBoot(cfg);
  // What each needs, and what's there to give it (names, and names others stand in for).
  const available = new Set(live.flatMap((r) => [r.name, ...(r.provides || [])]));
  const needs = new Map();
  for (const r of live) for (const d of r.dependencies || []) needs.set(d, [...(needs.get(d) || []), r.name]);
  const qbox = serverFramework().framework === 'qbox';
  const items = live.filter((r) => r.name && r.name !== '_cfx_internal').map((r) => {
    const where = categoriesOf(r.path, dataPath);
    const viaCategory = where.categories.some((c) => boot.categories.has(c));
    const bootEnabled = boot.names.has(r.name) || viaCategory;
    const state = r.state || 'unknown';
    return {
      name: r.name,
      folder: where.folder,
      category: where.builtIn ? BUILT_IN_CATEGORY : where.categories[where.categories.length - 1] || '(no category)',
      version: r.version || null,
      description: r.description || null,
      author: r.author || null,
      state,
      boot: { enabled: bootEnabled, source: boot.names.has(r.name) ? 'line' : viaCategory ? 'category' : 'none', turnedOffByApp: boot.turnedOff.has(r.name) },
      dependencies: r.dependencies || [],
      missingDependencies: (r.dependencies || []).filter((d) => !available.has(d)),
      installable: [],
      dependents: [...new Set([r.name, ...(r.provides || [])].flatMap((n) => needs.get(n) || []))],
      canStop: !NEVER_STOP.has(r.name),
      canRemove: !where.builtIn && !['qb-core', 'qbx_core', 'oxmysql', 'qb-control', 'monitor'].includes(r.name)
        && !(qbox && ['ox_lib', 'ox_inventory'].includes(r.name)),
      warnOnStop: warnOnStop(r.name),
      hasEasyConfig: false,
      builtIn: where.builtIn,
      setting: null,
      lockedReason: LOCKED_REASON[r.name] || null,
      replacedBy: null,
      problem: state === 'stopped' && bootEnabled ? 'Should be running but is stopped'
        : (r.dependencies || []).some((d) => !available.has(d)) ? `Missing: ${(r.dependencies || []).filter((d) => !available.has(d)).join(', ')}` : null,
    };
  });
  items.sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { serverOnline: true, resources: items };
}

export async function hostedResourceAction(name, action) {
  if (!['start', 'stop', 'restart', 'ensure'].includes(action)) throw new HttpError(400, 'Invalid action');
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  if (NEVER_STOP.has(name)) throw new HttpError(400, `${name} is needed by the server and cannot be changed`);
  const result = await agentRequest('/resources/action', { method: 'POST', body: { name, action }, timeoutMs: 120000 });
  forgetResourceMeta();
  if (action !== 'stop' && result.state !== 'started' && result.state !== 'starting') {
    throw new HttpError(400, `${name} did not start. Check the Console page for the reason.`);
  }
  return result;
}

/** Whether it starts with the server: a start line in server.cfg, kept in CityHQ's own block. */
export async function setHostedBoot(name, enabled, { record = true } = {}) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  if (NEVER_STOP.has(name)) throw new HttpError(400, `${name} must always start with the server`);
  const { cfgPath, dataPath } = server();
  const cfg = await readCfg(cfgPath);
  const boot = parseBoot(cfg);
  let next = cfg;
  if (enabled) {
    if (!boot.names.has(name)) next = addBootLine(cfg, name);
  } else {
    next = removeBootLine(cfg, name);
    const live = await agentRequest('/resources', { timeoutMs: 15000 }).catch(() => []);
    const entry = live.find((r) => r.name === name);
    const where = categoriesOf(entry?.path, dataPath);
    const covering = where.categories.find((c) => parseBoot(next).categories.has(c));
    if (covering) {
      throw new HttpError(409, `${name} starts because server.cfg starts its whole ${covering} folder. To leave it out, move its folder out of ${covering} with your host's file manager.`);
    }
  }
  if (next !== cfg) await writeCfg(cfgPath, next);
  if (record) {
    recordChange({
      kind: 'boot',
      title: enabled ? `${name} starts with the server` : `${name} no longer starts with the server`,
      undo: { type: 'boot', name, enabled: !enabled },
      undoHint: enabled ? `${name} won't start with the server again.` : `${name} will start with the server again.`,
    });
  }
  return { name, enabled, stoppedNow: false };
}
