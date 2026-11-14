// Everything about resources on disk: discovery, boot state, install, remove, restore.
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import {
  cp, lstat, mkdir, readdir, readFile, rm, stat, statfs, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { agentRequest } from './agent.js';
import { createBackup } from './backups.js';
import { findInstallSource } from './catalog.js';
import {
  addBootLine, changeCfgFile, connectionStringOf, convarOn, ensureManagedBlock, forgetBootLines, parseBoot, parseConnection, readCfg,
  readConvar, removeBootLine, setConvar, withCfg, writeCfg,
} from './cfg.js';
import { clientArgs, clientEnv, dbClient } from './dbtools.js';
import { serverFramework } from './framework.js';
import {
  findServerData, FXSERVER_DIR, HttpError, resolveInside, STATE_DIR, TMP_DIR, TRASH_DIR,
} from './paths.js';
import { recordChange } from './history.js';
import { moveFolderSafely } from './retry.js';

const exec = promisify(execFile);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const DISABLED_FILE = path.join(STATE_DIR, 'disabled.json');
const DISABLED_CATEGORY = '[disabled]';
const ADDED_CATEGORY = '[added]';
const NEVER_REMOVE = new Set(['qb-core', 'qbx_core', 'oxmysql', 'qb-control', 'monitor']);
// On Qbox these are part of the framework itself: qbx_core won't start without them.
const QBOX_CORE = new Set(['ox_lib', 'ox_inventory']);
const isQboxCore = (name) => QBOX_CORE.has(name) && serverFramework().framework === 'qbox';
const neverRemove = (name) => NEVER_REMOVE.has(name) || isQboxCore(name);
export const warnOnStop = (name) => WARN_ON_STOP.has(name) || isQboxCore(name);
export const NEVER_STOP = new Set(['qb-control', 'monitor']);
export const LOCKED_REASON = {
  'qb-control': 'CityHQ uses qb-control to talk to the server, so it has to stay on.',
  monitor: 'monitor is txAdmin, which runs the server, so it has to stay on.',
};
const WARN_ON_STOP = new Set(['qb-core', 'qbx_core', 'oxmysql', 'sessionmanager', 'spawnmanager', 'mapmanager', 'chat']);
// Resources that ship inside FXServer itself (chat, txAdmin's monitor, yarn, webpack).
const SYSTEM_DIR = path.join(FXSERVER_DIR, 'citizen', 'system_resources');
export const BUILT_IN_CATEGORY = 'Built into FiveM';
// Built-in resources FXServer only offers while a server.cfg setting is on.
export const SYSTEM_SWITCHES = { chat: 'resources_useSystemChat' };
// Unpacking needs room for the archive and everything inside it at the same time.
const UNPACK_ROOM_FACTOR = 2.2;

let installState = null;
export const getInstallStatus = () => installState;
const setPhase = (phase, detail = '') => { installState = { phase, detail }; };

const formatSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** A clear message up front beats a half-finished install when the disk runs out. */
async function assertDiskSpace(archiveBytes) {
  if (!archiveBytes) return;
  await mkdir(TMP_DIR, { recursive: true });
  const { bavail, bsize } = await statfs(TMP_DIR);
  const free = Number(bavail) * Number(bsize);
  const needed = archiveBytes * UNPACK_ROOM_FACTOR;
  if (free < needed) {
    throw new HttpError(507, `There isn't enough disk space. This needs about ${formatSize(needed)}, and only ${formatSize(free)} is free.`);
  }
}

export const isValidName = (name) => typeof name === 'string' && /^[\w.-]+$/.test(name);

export function serverData() {
  const server = findServerData();
  if (!server) throw new HttpError(409, 'The server has not been deployed yet.');
  return server;
}

const manifestText = async (dir) => {
  for (const f of ['fxmanifest.lua', '__resource.lua']) {
    const p = path.join(dir, f);
    if (existsSync(p)) return readFile(p, 'utf8');
  }
  return null;
};

export function parseManifest(text) {
  const meta = {};
  for (const key of ['name', 'version', 'description', 'author']) {
    meta[key] = text.match(new RegExp(`^\\s*${key}\\s*[ (]?\\s*['"]([^'"\\n]*)['"]`, 'm'))?.[1] || '';
  }
  const deps = new Set();
  for (const m of text.matchAll(/^\s*dependency\s*\(?\s*['"]([^'"]+)['"]/gm)) deps.add(m[1]);
  for (const m of text.matchAll(/^\s*dependencies\s*\(?\s*\{([\s\S]*?)\}/gm)) {
    for (const d of m[1].matchAll(/['"]([^'"]+)['"]/g)) deps.add(d[1]);
  }
  meta.dependencies = [...deps].filter((d) => !d.startsWith('/')).map((d) => d.replace(/\s*[<>=].*$/, ''));
  // A resource can stand in for others: cfxlua-require declares `provide 'require'`.
  const provides = new Set();
  for (const m of text.matchAll(/^\s*provides?\s*\(?\s*['"]([^'"]+)['"]/gm)) provides.add(m[1]);
  for (const m of text.matchAll(/^\s*provides?\s*\(?\s*\{([\s\S]*?)\}/gm)) {
    for (const p of m[1].matchAll(/['"]([^'"]+)['"]/g)) provides.add(p[1]);
  }
  meta.provides = [...provides];
  return meta;
}

/** Database files that come with a resource, for the panel and problem explanations. */
export async function listSqlFiles(name) {
  const resource = await findResourceDir(name);
  return resource ? findSql(resource.dir) : [];
}

// A hosted server's resources are known from its helper, and changed through it and the host
// (remote/runtime.js sets this), instead of this PC's disk.
let hosted = null;
export const setHostedResources = (value) => { hosted = value; };

/** Walks resources/, treating [bracket] folders as categories. */
export async function scanDisk() {
  if (hosted) return hosted.disk();
  const { dataPath } = serverData();
  const root = path.join(dataPath, 'resources');
  const found = [];
  async function walk(dir, categories) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('[') && e.name.endsWith(']')) {
        await walk(full, [...categories, e.name]);
        continue;
      }
      const manifest = await manifestText(full);
      if (manifest === null) continue;
      // The folder name is what FXServer calls the resource; a manifest "name" is only a label.
      found.push({ ...parseManifest(manifest), name: e.name, dir: full, categories });
    }
  }
  await walk(root, []);
  return found;
}

export const findResourceDir = async (name) => (await scanDisk()).find((r) => r.name === name) || null;

/** The resources built into FXServer, which have no folder in resources/. */
export async function scanSystem(dir = SYSTEM_DIR) {
  if (hosted && dir === SYSTEM_DIR) return hosted.system();
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = await manifestText(path.join(dir, e.name));
    if (manifest !== null) found.push({ ...parseManifest(manifest), name: e.name });
  }
  return found;
}

/**
 * List entries for built-in resources. A folder of the same name in resources/ wins, as it does
 * for FXServer. A switched built-in (chat) only counts as starting at boot while its setting is on.
 */
export function builtInItems({ system, diskNames, cfg, live, dependents = new Map() }) {
  const boot = parseBoot(cfg);
  return system.filter((s) => !diskNames.has(s.name)).map((s) => {
    const key = SYSTEM_SWITCHES[s.name];
    const settingOn = !key || convarOn(readConvar(cfg, key));
    // txAdmin starts monitor itself, so it never needs a server.cfg line.
    const always = NEVER_STOP.has(s.name);
    const bootEnabled = always || (boot.names.has(s.name) && settingOn);
    const state = live ? (live.get(s.name)?.state || 'stopped') : 'offline';
    return {
      name: s.name,
      folder: null,
      category: BUILT_IN_CATEGORY,
      version: s.version,
      description: s.description,
      author: s.author,
      state,
      boot: {
        enabled: bootEnabled,
        source: always ? 'always' : boot.names.has(s.name) ? 'line' : 'none',
        turnedOffByApp: boot.turnedOff.has(s.name),
      },
      dependencies: [],
      missingDependencies: [],
      installable: [],
      dependents: dependents.get(s.name) || [],
      canStop: !NEVER_STOP.has(s.name),
      canRemove: false,
      warnOnStop: warnOnStop(s.name),
      hasEasyConfig: false,
      builtIn: true,
      setting: key ? { key, on: settingOn } : null,
      lockedReason: LOCKED_REASON[s.name] || null,
      problem: state === 'stopped' && bootEnabled ? 'Should be running but is stopped' : null,
    };
  });
}

async function readDisabled() {
  try { return JSON.parse(await readFile(DISABLED_FILE, 'utf8')); } catch { return {}; }
}
async function writeDisabled(map) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(DISABLED_FILE, JSON.stringify(map, null, 2));
}

/**
 * Which resources a running one stands in for, from its `provides` (qb-clothing -> um-clothing-qb).
 * FiveM answers for the stand-in when asked about the replaced name, and sends start, stop and
 * restart for that name to the stand-in too, so the replaced one can't be told apart or controlled.
 */
export function replacementsOf(disk, live) {
  const map = new Map();
  if (!live) return map;
  for (const r of disk) {
    if (live.get(r.name)?.state !== 'started') continue;
    for (const p of r.provides) if (p !== r.name && !map.has(p)) map.set(p, r.name);
  }
  return map;
}

/** Every resource's state on the running server, or null when it's offline. */
export const liveStates = () => liveMap();

const liveMap = async () => {
  try {
    const list = await agentRequest('/resources', { timeoutMs: 2500 });
    return new Map(list.map((r) => [r.name, r]));
  } catch { return null; }
};

/** The groups people change most come first; FiveM's samples and turned-off ones come last. */
const CATEGORY_ORDER = ['[qb]', '[added]', '[standalone]', '[voice]', '[defaultmaps]'];
const CATEGORY_LAST = new Set(['[examples]', '[test]', '[disabled]']);
export function categoryRank(category) {
  const i = CATEGORY_ORDER.indexOf(category);
  if (i !== -1) return i;
  if (category === BUILT_IN_CATEGORY) return 90;
  return CATEGORY_LAST.has(category) ? 100 : 50;
}

const hasEasyConfig = (r) => existsSync(path.join(r.dir, 'config.lua'))
  || existsSync(path.join(r.dir, 'shared', 'config.lua'))
  || existsSync(path.join(r.dir, 'config', 'config.lua'));

export async function listResources() {
  const { cfgPath, dataPath } = serverData();
  const [disk, live, cfg, disabled, system] = await Promise.all([scanDisk(), liveMap(), readCfg(cfgPath), readDisabled(), scanSystem()]);
  const boot = parseBoot(cfg);
  // Built-in ones count too, so a resource that needs yarn isn't shown as missing it.
  const allNames = new Set([...disk.flatMap((r) => [r.name, ...r.provides]), ...system.map((s) => s.name)]);
  const needs = new Map();
  for (const r of disk) {
    for (const d of r.dependencies) {
      if (!needs.has(d)) needs.set(d, []);
      needs.get(d).push(r.name);
    }
  }
  const dependents = new Map(disk.map((r) => [r.name, [...new Set([r.name, ...r.provides].flatMap((n) => needs.get(n) || []))]]));
  for (const s of system) if (!dependents.has(s.name)) dependents.set(s.name, needs.get(s.name) || []);
  const replaced = replacementsOf(disk, live);
  const items = disk.map((r) => {
    const liveEntry = live?.get(r.name);
    const viaCategory = r.categories.some((c) => boot.categories.has(c));
    const bootEnabled = boot.names.has(r.name) || viaCategory;
    const replacedBy = replaced.get(r.name) || null;
    const state = replacedBy ? 'replaced' : live ? (liveEntry?.state || 'unknown') : 'offline';
    const missingDeps = r.dependencies.filter((d) => !allNames.has(d) && !live?.has(d));
    let problem = null;
    if (replacedBy && bootEnabled) problem = `${replacedBy} replaces it, so it can't run. Turn off "At boot"`;
    else if (state === 'stopped' && bootEnabled) problem = 'Should be running but is stopped';
    else if (missingDeps.length) problem = `Missing: ${missingDeps.join(', ')}`;
    return {
      name: r.name,
      folder: path.relative(dataPath, r.dir).replaceAll('\\', '/'),
      category: r.categories[r.categories.length - 1] || '(no category)',
      version: r.version,
      description: r.description,
      author: r.author,
      state,
      boot: {
        enabled: bootEnabled,
        source: boot.names.has(r.name) ? 'line' : viaCategory ? 'category' : 'none',
        turnedOffByApp: Boolean(disabled[r.name]) || boot.turnedOff.has(r.name),
      },
      dependencies: r.dependencies,
      missingDependencies: missingDeps,
      installable: missingDeps.map(findInstallSource).filter(Boolean),
      dependents: dependents.get(r.name) || [],
      canStop: !NEVER_STOP.has(r.name),
      canRemove: !neverRemove(r.name),
      warnOnStop: warnOnStop(r.name),
      hasEasyConfig: hasEasyConfig(r),
      builtIn: false,
      setting: null,
      lockedReason: LOCKED_REASON[r.name] || null,
      replacedBy,
      problem,
    };
  });
  items.push(...builtInItems({ system, diskNames: new Set(disk.map((r) => r.name)), cfg, live, dependents }));
  items.sort((a, b) => categoryRank(a.category) - categoryRank(b.category)
    || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { serverOnline: Boolean(live), resources: items };
}

/** Refuses to start, stop or restart a resource that must stay on, or one FiveM would swap for its stand-in. */
export async function assertCanControl(name) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  if (NEVER_STOP.has(name)) throw new HttpError(400, `${name} is needed by the server and cannot be changed`);
  const [disk, live] = await Promise.all([scanDisk(), liveMap()]);
  const by = replacementsOf(disk, live).get(name);
  if (by) {
    throw new HttpError(409, `${by} replaces ${name} and is running, so FiveM would do this to ${by} instead. Stop ${by} first if you want to use ${name}.`);
  }
}

export async function resourceAction(name, action) {
  if (hosted) return hosted.action(name, action);
  if (!['start', 'stop', 'restart', 'ensure'].includes(action)) throw new HttpError(400, 'Invalid action');
  await assertCanControl(name);
  // A resource with gigabytes of game files can take a while to mount.
  const result = await agentRequest('/resources/action', { method: 'POST', body: { name, action }, timeoutMs: 120000 });
  if (action !== 'stop' && result.state !== 'started' && result.state !== 'starting') {
    const key = SYSTEM_SWITCHES[name];
    if (key && (await scanDisk()).every((r) => r.name !== name)) {
      throw new HttpError(400, `${name} is built into FiveM and is switched off (${key}). Turn on "Start with the server", then restart the server to use it.`);
    }
    throw new HttpError(400, `${name} did not start. Check the Console page for the reason.`);
  }
  return result;
}

/** Built-in resources start from a server.cfg line; chat also needs its setting on. */
async function setBuiltInBoot(cfgPath, cfg, name, enabled) {
  let next = cfg;
  if (enabled) {
    if (!parseBoot(next).names.has(name)) next = addBootLine(next, name);
  } else {
    next = removeBootLine(next, name);
  }
  const key = SYSTEM_SWITCHES[name];
  if (key) next = setConvar(next, key, enabled ? 'true' : 'false');
  if (next !== cfg) await writeCfg(cfgPath, next);
  return { name, enabled, stoppedNow: false, builtIn: true };
}

export const refreshResources = () => agentRequest('/refresh', { method: 'POST', timeoutMs: 10000 }).catch(() => null);

/** Switches whether a resource starts with the server, and notes it in the change history. */
export async function setBoot(name, enabled, { record = true } = {}) {
  if (hosted) return hosted.setBoot(name, enabled, { record });
  const result = await switchBoot(name, enabled);
  if (record) {
    recordChange({
      kind: 'boot',
      title: enabled ? `${name} starts with the server` : `${name} no longer starts with the server`,
      undo: { type: 'boot', name, enabled: !enabled },
      undoHint: enabled ? `${name} won't start with the server again.` : `${name} will start with the server again.`,
    });
  }
  return result;
}

async function switchBoot(name, enabled) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  if (NEVER_STOP.has(name)) throw new HttpError(400, `${name} must always start with the server`);
  const { cfgPath } = serverData();
  // server.cfg is read, decided on and saved as one change, so one made meanwhile isn't lost.
  return withCfg(cfgPath, () => switchBootNow(name, enabled));
}

async function switchBootNow(name, enabled) {
  const { cfgPath, dataPath } = serverData();
  let cfg = await readCfg(cfgPath);
  const resource = await findResourceDir(name);
  if (!resource) {
    if ((await scanSystem()).some((s) => s.name === name)) return setBuiltInBoot(cfgPath, cfg, name, enabled);
    throw new HttpError(404, 'That resource was not found');
  }
  const disabled = await readDisabled();

  if (enabled) {
    if (disabled[name]) {
      const origin = path.join(dataPath, 'resources', disabled[name]);
      await mkdir(path.dirname(origin), { recursive: true });
      await moveFolderSafely(resource.dir, origin, name);
      delete disabled[name];
      await writeDisabled(disabled);
      await refreshResources();
    }
    const boot = parseBoot(cfg);
    const after = await findResourceDir(name);
    if (!boot.names.has(name) && !after.categories.some((c) => boot.categories.has(c))) {
      cfg = addBootLine(cfg, name);
      await writeCfg(cfgPath, cfg);
    }
    return { name, enabled: true, movedBack: true };
  }

  cfg = removeBootLine(cfg, name);
  await writeCfg(cfgPath, cfg);
  const boot = parseBoot(cfg);
  if (resource.categories.some((c) => boot.categories.has(c))) {
    // A [category] start line covers everything inside it, so the only way to leave
    // one resource out is to move it to a folder that does not auto-start.
    await agentRequest('/resources/action', { method: 'POST', body: { name, action: 'stop' }, timeoutMs: 15000 }).catch(() => null);
    const resourcesRoot = path.join(dataPath, 'resources');
    const dest = path.join(resourcesRoot, DISABLED_CATEGORY, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await moveFolderSafely(resource.dir, dest, name);
    disabled[name] = path.relative(resourcesRoot, resource.dir);
    await writeDisabled(disabled);
    await refreshResources();
    return { name, enabled: false, stoppedNow: true };
  }
  return { name, enabled: false, stoppedNow: false };
}

async function assertNoLinks(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if ((await lstat(full)).isSymbolicLink()) throw new HttpError(400, 'This package contains links, which is not allowed.');
    if (e.isDirectory()) await assertNoLinks(full);
  }
}

async function findManifests(dir, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && ['fxmanifest.lua', '__resource.lua'].includes(e.name))) return [dir];
  if (depth >= 4) return [];
  const out = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      out.push(...await findManifests(path.join(dir, e.name), depth + 1));
    }
  }
  return out;
}

async function findSql(dir, base = dir, found = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'stream') await findSql(full, base, found);
    } else if (e.name.toLowerCase().endsWith('.sql')) {
      found.push(path.relative(base, full).replaceAll('\\', '/'));
    }
  }
  return found;
}

const tidyName = (folder) => folder
  .replace(/-(main|master|develop|dev|latest|head)$/i, '')
  .replace(/[^\w.-]+/g, '-')
  .replace(/^-+|-+$/g, '');

/** Moves within the same drive, which is instant even for gigabytes; copies otherwise. */
async function moveFolder(from, to) {
  try {
    await moveFolderSafely(from, to, path.basename(to));
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true });
  }
}

/**
 * Installs every resource found inside a folder. The folder name becomes the resource name and
 * scripts look each other up by it, so a GitHub repo's own name wins over the name GitHub gives
 * the archive folder (like qb-thing-HEAD or qb-thing-my-branch).
 */
async function installFromFolder(root, hintName, { preferHint = false, keepSource = false } = {}) {
  setPhase('checking', 'Looking for resources inside');
  await assertNoLinks(root);
  const manifests = await findManifests(root);
  if (!manifests.length) {
    throw new HttpError(400, 'No fxmanifest.lua was found, so this does not look like a FiveM resource. If it is one, check it isn\'t still inside another zip.');
  }
  const { dataPath } = serverData();
  const existing = new Set((await scanDisk()).map((r) => r.name));
  const planned = manifests.map((dir) => {
    const isRoot = dir === root;
    const isTopFolder = path.dirname(dir) === root;
    const useHint = isRoot || (preferHint && isTopFolder && manifests.length === 1);
    const name = tidyName(useHint ? (hintName || 'new-resource') : path.basename(dir));
    if (!isValidName(name) || !name) throw new HttpError(400, `"${name}" is not a usable resource name.`);
    if (existing.has(name)) throw new HttpError(409, `A resource named ${name} already exists. Remove it first to replace it.`);
    existing.add(name);
    return { dir, name };
  });

  const installed = [];
  for (const { dir, name } of planned) {
    setPhase('installing', name);
    // A hosted server gets the folder through its host; what's in it is read here first.
    if (hosted) {
      const meta = parseManifest(await manifestText(dir));
      const sqlFiles = await findSql(dir);
      setPhase('installing', `${name} (sending it to your host)`);
      await hosted.place(dir, name);
      installed.push({ name, version: meta.version, description: meta.description, dependencies: meta.dependencies, sqlFiles });
      continue;
    }
    const dest = path.join(dataPath, 'resources', ADDED_CATEGORY, name);
    await mkdir(path.dirname(dest), { recursive: true });
    if (keepSource) await cp(dir, dest, { recursive: true });
    else await moveFolder(dir, dest);
    const meta = parseManifest(await manifestText(dest));
    installed.push({ name, version: meta.version, description: meta.description, dependencies: meta.dependencies, sqlFiles: await findSql(dest) });
  }
  const available = new Set((await scanDisk()).flatMap((r) => [r.name, ...r.provides]));
  for (const item of installed) item.missingDependencies = item.dependencies.filter((d) => !available.has(d));
  await refreshResources();
  for (const item of installed) {
    recordChange({ kind: 'install', title: `Installed ${item.name}`, undo: { type: 'remove', name: item.name }, undoHint: hosted ? `${item.name} is stopped and moved aside on your host (resources/[cityhq-removed]).` : `${item.name} is stopped and moved to Recently removed, where it can be restored.` });
  }
  return { installed };
}

async function installFromZip(zipPath, hintName, options = {}) {
  const { size } = await stat(zipPath);
  await assertDiskSpace(size);
  const workDir = path.join(TMP_DIR, `unpack-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  try {
    setPhase('unpacking', formatSize(size));
    await exec(TAR, ['-xf', zipPath, '-C', workDir], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).catch((err) => {
      const detail = String(err.stderr || '').trim().split('\n').pop();
      throw new HttpError(400, `That file could not be unpacked. It may be damaged or incomplete. Zip, rar and 7z files work.${detail ? ` (${detail})` : ''}`);
    });
    return await installFromFolder(workDir, hintName, options);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reads directly from a location on this PC, so nothing has to be uploaded or copied twice. */
export async function installFromLocalPath(source) {
  try {
    const info = await stat(source);
    const base = tidyName(path.basename(source).replace(/\.(zip|rar|7z)$/i, ''));
    if (info.isDirectory()) return await installFromFolder(source, base, { keepSource: true });
    return await installFromZip(source, base);
  } finally {
    installState = null;
  }
}

export function parseGithubUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new HttpError(400, 'Paste a full GitHub link, like https://github.com/owner/repo'); }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname)) {
    throw new HttpError(400, 'Only https://github.com links are supported here. For anything else, upload a zip.');
  }
  const [owner, repoRaw, kind, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repoRaw) throw new HttpError(400, 'That link is missing the repository name.');
  const repo = repoRaw.replace(/\.git$/, '');
  if (![owner, repo].every((p) => /^[\w.-]+$/.test(p))) throw new HttpError(400, 'That GitHub link does not look valid.');
  if (kind === 'releases' && rest.includes('download') && rest[rest.length - 1]?.toLowerCase().endsWith('.zip')) {
    return { owner, repo, download: `https://github.com${url.pathname}` };
  }
  if (kind === 'tree' && rest.length) {
    return { owner, repo, download: `https://codeload.github.com/${owner}/${repo}/zip/${rest.map(encodeURIComponent).join('/')}` };
  }
  return { owner, repo, download: `https://codeload.github.com/${owner}/${repo}/zip/HEAD` };
}

async function downloadWithRetry(url, dest) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(3_600_000) });
      if (res.status === 404) throw new HttpError(404, 'GitHub could not find that repository or release. It may be private or the link may be wrong.');
      if (!res.ok) throw new Error(`GitHub replied with HTTP ${res.status}`);
      await assertDiskSpace(Number(res.headers.get('content-length')) || 0);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new HttpError(502, `Download failed after several tries: ${lastError.message}`);
}

export async function installFromGithub(link) {
  const parsed = parseGithubUrl(link);
  await mkdir(TMP_DIR, { recursive: true });
  const zip = path.join(TMP_DIR, `github-${Date.now()}.zip`);
  try {
    setPhase('downloading', `${parsed.owner}/${parsed.repo}`);
    await downloadWithRetry(parsed.download, zip);
    return await installFromZip(zip, parsed.repo, { preferHint: true });
  } finally {
    await rm(zip, { force: true }).catch(() => {});
    installState = null;
  }
}

export async function installFromUpload(stream, filename, declaredSize) {
  await assertDiskSpace(declaredSize);
  await mkdir(TMP_DIR, { recursive: true });
  const archive = path.join(TMP_DIR, `upload-${Date.now()}.tmp`);
  try {
    setPhase('receiving', '');
    await pipeline(stream, createWriteStream(archive));
    return await installFromZip(archive, tidyName(String(filename || '').replace(/\.(zip|rar|7z)$/i, '')));
  } finally {
    await rm(archive, { force: true }).catch(() => {});
    installState = null;
  }
}

/** Starts a resource now and/or adds it to the boot list after installing. */
export async function activateInstalled(name, { boot, start }) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  const { cfgPath } = serverData();
  if (boot) await changeCfgFile(cfgPath, (cfg) => addBootLine(cfg, name));
  if (start) {
    await refreshResources();
    return resourceAction(name, 'ensure');
  }
  return { name };
}

export async function runSql(name, file) {
  const resource = await findResourceDir(name);
  if (!resource) throw new HttpError(404, 'That resource was not found');
  if (!String(file).toLowerCase().endsWith('.sql')) throw new HttpError(400, 'Only .sql files can be run');
  const sqlPath = resolveInside(resource.dir, file);
  if (!existsSync(sqlPath)) throw new HttpError(404, 'That SQL file was not found');
  const { cfgPath } = serverData();
  const conn = parseConnection(connectionStringOf(await readCfg(cfgPath)));
  if (!conn?.database) throw new HttpError(400, 'Could not read the database settings from server.cfg');
  // SQL files can change or delete data, so keep a way back.
  const before = await createBackup('before-sql', { parts: ['database'] });
  const args = [...clientArgs(conn), conn.database, '--batch', '--execute', `source ${sqlPath.replaceAll('\\', '/')}`];
  try {
    await exec(dbClient(), args, { env: clientEnv(conn), windowsHide: true, timeout: 120_000 });
  } catch (err) {
    throw new HttpError(400, `The SQL file failed: ${String(err.stderr || err.message).trim().split('\n').slice(-2).join(' ')}`);
  }
  recordChange({
    kind: 'sql',
    title: `Ran ${path.basename(file)} for ${name}`,
    detail: `Database backup ${before.id} was made first.`,
    undo: { type: 'restore-db', backupId: before.id },
    undoHint: `The database goes back to backup ${before.id}, made just before this. The server is stopped while that happens and players are disconnected, and anything saved since then is lost.`,
  });
  return { ran: file };
}

/** Moves a resource to the app's trash so it can be brought back. */
export async function removeResource(name) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  if (neverRemove(name)) throw new HttpError(400, `${name} is required by the server and cannot be removed`);
  if (hosted) return hosted.remove(name);
  const resource = await findResourceDir(name);
  if (!resource) throw new HttpError(404, 'That resource was not found');
  await agentRequest('/resources/action', { method: 'POST', body: { name, action: 'stop' }, timeoutMs: 15000 }).catch(() => null);

  const { cfgPath, dataPath } = serverData();
  const id = `${Date.now()}-${name}`;
  const dest = path.join(TRASH_DIR, id);
  await mkdir(TRASH_DIR, { recursive: true });
  const rel = path.relative(path.join(dataPath, 'resources'), resource.dir);
  const startedAtBoot = await withCfg(cfgPath, async () => {
    const boot = parseBoot(await readCfg(cfgPath));
    const wasAtBoot = boot.names.has(name) || resource.categories.some((c) => boot.categories.has(c));
    await moveFolderSafely(resource.dir, dest, name);
    await writeFile(`${dest}.json`, JSON.stringify({ name, origin: rel, removedAt: Date.now() }));
    await writeCfg(cfgPath, forgetBootLines(await readCfg(cfgPath), name));
    return wasAtBoot;
  });

  const disabled = await readDisabled();
  if (disabled[name]) { delete disabled[name]; await writeDisabled(disabled); }
  await refreshResources();
  recordChange({
    kind: 'remove',
    title: `Removed ${name}`,
    undo: { type: 'restore-trash', id, name, boot: startedAtBoot },
    undoHint: `${name} comes back from Recently removed${startedAtBoot ? ' and starts with the server again' : ''}.`,
  });
  return { removed: name, id };
}

export async function listTrash() {
  await mkdir(TRASH_DIR, { recursive: true });
  const out = [];
  for (const e of await readdir(TRASH_DIR)) {
    if (!e.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(TRASH_DIR, e), 'utf8'));
      out.push({ id: e.slice(0, -5), ...meta });
    } catch { /* skip unreadable entries */ }
  }
  return out.sort((a, b) => b.removedAt - a.removedAt);
}

export async function restoreFromTrash(id) {
  if (!/^\d+-[\w.-]+$/.test(id)) throw new HttpError(400, 'Invalid item');
  const src = resolveInside(TRASH_DIR, id);
  const metaFile = `${src}.json`;
  if (!existsSync(src) || !existsSync(metaFile)) throw new HttpError(404, 'That item is no longer in the trash');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  if ((await scanDisk()).some((r) => r.name === meta.name)) {
    throw new HttpError(409, `A resource named ${meta.name} already exists.`);
  }
  const { dataPath } = serverData();
  const dest = resolveInside(path.join(dataPath, 'resources'), meta.origin);
  await mkdir(path.dirname(dest), { recursive: true });
  await moveFolderSafely(src, dest, meta.name);
  await rm(metaFile, { force: true });
  await refreshResources();
  recordChange({ kind: 'restore', title: `Brought back ${meta.name}`, undo: { type: 'remove', name: meta.name }, undoHint: `${meta.name} is moved to Recently removed again.` });
  return { restored: meta.name };
}

/** Installs the managed block in server.cfg when the file does not have it yet. */
export async function ensureCfgBlock() {
  const server = findServerData();
  if (!server) return false;
  return (await changeCfgFile(server.cfgPath, (before) => ensureManagedBlock(before))).changed;
}
