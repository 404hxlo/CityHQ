// The install check: reads one script before (or after) it runs and says, in plain words, what it
// needs to work on this QBCore server, with a fix where one is safe.
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { findInstallSource } from './catalog.js';
import { parseBoot, readCfg } from './cfg.js';
import { repoFor } from './docs.js';
import { startOrderFindings, tableFindings } from './health.js';
import { HttpError } from './paths.js';
import { docsFor } from './problems.js';
import {
  isValidName, liveStates, scanDisk, scanSystem, serverData,
} from './resources.js';

const FRAMEWORK_IMPORTS = [
  { re: /@es_extended\//i, name: 'ESX' },
  { re: /@vrp\//i, name: 'vRP' },
  { re: /@qbx_core\//i, name: 'Qbox' },
  { re: /@ox_core\//i, name: 'ox_core' },
  { re: /@nd_core\//i, name: 'ND Core' },
];
const OTHER_FRAMEWORK_VALUE = /^(esx|es_extended|vrp|qbox|qbx|qbx_core|ox|ox_core|nd|nd_core|standalone)$/i;
const QB_FRAMEWORK_VALUE = /^(qb|qbcore|qb-core|qb_core|auto|autodetect)$/i;
const CONFIGS = ['config.lua', 'shared/config.lua', 'config/config.lua', 'configs/config.lua', 'shared/sh_config.lua', 'config/main.lua'];
const NOTES = /^(readme|install|installation|setup|docs?|documentation)[^/]*\.(md|txt)$/i;
const MAX_NOTES = 4000;

const item = (id, status, title, detail, extra = {}) => ({ id, status, title, detail, steps: [], ...extra });

async function readText(full) {
  try {
    const buf = await readFile(full);
    return buf.subarray(0, 4).toString() === 'FXAP' ? null : buf.toString('utf8');
  } catch { return null; }
}

async function folderSize(dir) {
  let total = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await folderSize(full);
      else total += (await stat(full)).size;
    }
  } catch { /* unreadable */ }
  return total;
}

/**
 * Which framework a script is written for, from what its manifest loads and what its config is set
 * to. Scripts with a bridge for several frameworks count as fine.
 */
export function frameworkFit({ manifest, configs, folders }) {
  const imports = FRAMEWORK_IMPORTS.filter((f) => f.re.test(manifest)).map((f) => f.name);
  const loadsQb = /@qb-core\//i.test(manifest);
  const bridges = folders.filter((f) => /^(bridge|bridges|framework|frameworks|modules\/framework)$/i.test(f.parent) && /^(qb|qbcore|qb-core)$/i.test(f.name));
  for (const { file, text } of configs) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*[\w.]*Framework\s*=\s*['"]([\w-]+)['"]/i);
      if (!m) continue;
      if (OTHER_FRAMEWORK_VALUE.test(m[1])) {
        return item('framework', 'bad', `It's set to the ${m[1]} framework`, `Its config says Framework = "${m[1]}", but this server runs QBCore, so most of it won't work.`, {
          steps: [`Open ${file} at line ${i + 1} and change it to QBCore. The comment next to it usually lists the exact word to use, often "qb" or "qbcore".`],
          openFile: { file, line: i + 1, label: `Open ${file} at line ${i + 1}` },
        });
      }
      if (QB_FRAMEWORK_VALUE.test(m[1])) return item('framework', 'ok', 'It\'s set up for QBCore', `Its config says Framework = "${m[1]}".`);
    }
  }
  if (imports.length && !loadsQb && !bridges.length) {
    return item('framework', 'bad', `It's made for ${imports.join(' and ')}, not QBCore`, `It loads files from ${imports.join(' and ')}, which this server doesn't have, so it will fail or only partly work.`, {
      steps: ['Look for a QBCore version from the same author, or one that says it supports QBCore.', 'If it has a framework setting, set it to QBCore.'],
    });
  }
  if (loadsQb || bridges.length) return item('framework', 'ok', 'It works with QBCore', loadsQb ? 'It loads QBCore directly.' : 'It has a QBCore bridge built in.');
  if (imports.length) return item('framework', 'warn', `It also loads ${imports.join(' and ')} files`, `It may support QBCore too, but loads ${imports.join(' and ')} files that this server doesn't have. That's often harmless, but check it works in game.`);
  return item('framework', 'info', 'No framework needed, or none could be found', 'It doesn\'t say which framework it uses, which is normal for maps, cars and standalone scripts.');
}

/** Everything the install check finds for one script. */
export async function inspectResource(name) {
  if (!isValidName(name)) throw new HttpError(400, 'Invalid resource name');
  const disk = await scanDisk();
  const resource = disk.find((r) => r.name === name);
  if (!resource) throw new HttpError(404, 'That resource was not found');
  const { cfgPath } = serverData();
  const cfg = await readCfg(cfgPath);
  const [system, live, { docs, links }] = await Promise.all([scanSystem(), liveStates(), docsFor(name).catch(() => ({ docs: null, links: [] }))]);
  const checks = [];

  // Framework
  const manifest = (await readText(path.join(resource.dir, 'fxmanifest.lua'))) || (await readText(path.join(resource.dir, '__resource.lua'))) || '';
  const configs = [];
  for (const file of CONFIGS) {
    const text = await readText(path.join(resource.dir, file));
    if (text) configs.push({ file, text });
  }
  const folders = [];
  for (const parent of ['bridge', 'bridges', 'framework', 'frameworks']) {
    try { for (const e of await readdir(path.join(resource.dir, parent), { withFileTypes: true })) if (e.isDirectory()) folders.push({ parent, name: e.name }); } catch { /* none */ }
  }
  const fit = frameworkFit({ manifest, configs, folders });
  if (fit.openFile) {
    const { dataPath } = serverData();
    const folder = path.relative(dataPath, resource.dir).replaceAll('\\', '/');
    fit.openFile = { path: `${folder}/${fit.openFile.file}`, line: fit.openFile.line, label: fit.openFile.label };
  }
  checks.push(fit);

  // What it needs
  const available = new Set([...disk.flatMap((r) => [r.name, ...r.provides]), ...system.map((s) => s.name)]);
  const missing = resource.dependencies.filter((d) => !available.has(d));
  for (const dep of missing) {
    const source = findInstallSource(dep);
    const repo = repoFor(dep, links);
    const url = source?.url || repo;
    checks.push(item(`needs:${dep}`, 'bad', `It needs ${dep}, which isn't installed`, `${name} won't start until ${dep} is installed.`, {
      install: url ? { label: `Install ${source?.resource || dep}${!source && repo ? ` (linked in ${name}'s files)` : ''}`, url } : undefined,
      steps: url ? [] : [`Find ${dep} where you got ${name}; its install notes usually link to it.`],
    }));
  }
  if (!missing.length && resource.dependencies.length) {
    checks.push(item('needs', 'ok', 'Everything it needs is installed', `It needs ${resource.dependencies.join(', ')}.`));
  }

  // Database
  checks.push(...(await tableFindings([resource]).catch(() => [])).map((f) => ({ ...f, id: `db:${f.id}` })));

  // What it replaces
  const boot = parseBoot(cfg);
  const atBoot = (r) => !r.categories.includes('[disabled]') && (boot.names.has(r.name) || r.categories.some((c) => boot.categories.has(c)));
  for (const replaced of resource.provides.filter((p) => p !== name)) {
    const old = disk.find((r) => r.name === replaced);
    if (!old) continue;
    if (atBoot(old) || live?.get(replaced)?.state === 'started') {
      checks.push(item(`replaces:${replaced}`, 'warn', `It replaces ${replaced}, which still starts`, `${name} says it stands in for ${replaced}. Only one of them can run, so whichever starts last stops the other, and anything that needs it.`, {
        fix: { label: `Turn ${replaced} off at boot`, confirm: `${replaced} won't start with the server any more, so ${name} takes its place. You can turn it back on from Resources, or with Undo.`, fix: { type: 'boot-off', name: replaced } },
      }));
    } else {
      checks.push(item(`replaces:${replaced}`, 'ok', `It replaces ${replaced}`, `${replaced} is already off, so ${name} takes its place.`));
    }
  }
  checks.push(...startOrderFindings(disk, cfg).filter((f) => f.fix?.fix?.provider === name).map((f) => ({ ...f, id: `order:${f.id}` })));

  // Locked (escrow)
  if (existsSync(path.join(resource.dir, '.fxap'))) {
    checks.push(item('escrow', 'info', 'It\'s a locked, paid script', 'Its code is encrypted by FiveM (escrow), so it only runs on a server whose license key belongs to the Cfx.re account that bought it.', {
      steps: ['If the console says "You lack the required entitlement", it was bought on a different Cfx.re account than your server\'s license key. Re-download it from the account that owns your key, or transfer it on portal.cfx.re.'],
    }));
  }

  // Download size for players
  const stream = path.join(resource.dir, 'stream');
  if (existsSync(stream)) {
    const mb = Math.round((await folderSize(stream)) / 1024 / 1024);
    if (mb >= 300) {
      checks.push(item('size', mb >= 1500 ? 'warn' : 'info', `Players download about ${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`} for it`, 'Its game files (cars, maps, clothes) are sent to every player the first time they join, which makes the first join slower.'));
    }
  }

  // The author's own notes
  let notes = null;
  try {
    const file = (await readdir(resource.dir)).find((n) => NOTES.test(n));
    if (file) {
      const text = await readText(path.join(resource.dir, file));
      if (text?.trim()) notes = { file, text: text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES)}\n...` : text };
    }
  } catch { /* none */ }

  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.status] - order[b.status]);
  return { name, checks, docs, notes };
}
