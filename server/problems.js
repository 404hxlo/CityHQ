// Gathers everything wrong right now and explains it, for the Overview and resource panels.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { agentRequest } from './agent.js';
import { parseBoot, readCfg } from './cfg.js';
import { readConsole } from './console.js';
import { buildDocIndex, repoFor, withDocLinks } from './docs.js';
import { explainLogLines, explainMissingDependency } from './explain.js';
import { tableInfo } from './db.js';
import {
  fixedThisBoot, recordFix, runFix, tablesDefining,
} from './fixes.js';
import { findServerData, HttpError } from './paths.js';
import {
  assertCanControl, listSqlFiles, liveStates, replacementsOf, scanDisk,
} from './resources.js';

const CACHE_MS = 5000;
const DOCS_MS = 10 * 60 * 1000;
let cached = { at: 0, value: [], boot: null };
let docCache = { at: 0, key: '', value: null };

/** The documentation index, rebuilt every ten minutes or when the installed scripts change. */
async function docIndex(disk) {
  const key = disk.map((r) => r.name).sort().join(',');
  if (docCache.value && docCache.key === key && Date.now() - docCache.at < DOCS_MS) return docCache.value;
  try {
    docCache = { at: Date.now(), key, value: await buildDocIndex(disk) };
  } catch {
    docCache = { at: Date.now(), key, value: { index: new Map(), links: new Map() } };
  }
  return docCache.value;
}

/** One script's documentation and the links in its own files, from the shared index. */
export async function docsFor(name) {
  const { index, links } = await docIndex(await scanDisk());
  return { docs: index.get(name) || null, links: links.get(name) || [] };
}

/** Which of a resource's .sql files create a table, best first. */
export function sqlFilesCreating(table, files) {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"]?${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\`"]?\\s*\\(`, 'i');
  return files.filter((f) => re.test(f.text)).map((f) => f.file);
}

/**
 * Problems seen in the server's current state rather than its log: a resource set to start with
 * the server that isn't running, and the special case where it was stopped during startup because
 * something it needs was swapped for its stand-in (qb-clothing for um-clothing-qb).
 */
export function stateProblems({ disk, cfg, live, existing = new Set() }) {
  if (!live) return [];
  const boot = parseBoot(cfg);
  const replaced = replacementsOf(disk, live);
  const out = [];
  for (const r of disk) {
    if (r.categories.includes('[disabled]')) continue;
    const atBoot = boot.names.has(r.name) || r.categories.some((c) => boot.categories.has(c));
    if (!atBoot || replaced.has(r.name) || live.get(r.name)?.state !== 'stopped') continue;
    const swapped = r.dependencies.find((d) => replaced.has(d));
    if (swapped) {
      const provider = replaced.get(swapped);
      out.push({
        id: `stopped-by-replacement:${r.name}:${swapped}`,
        rule: 'stopped-by-replacement',
        severity: 'error',
        resource: r.name,
        count: 1,
        title: `${r.name} was stopped during startup`,
        what: `${r.name} needs ${swapped}. ${provider} stands in for ${swapped}, but it starts after ${r.name} in server.cfg. So FiveM started the old ${swapped} for ${r.name}, then stopped both when ${provider} took over.`,
        fix: [`Press the button: ${provider} will start before ${r.name} in server.cfg, and ${r.name} is started now.`],
        actions: [
          {
            kind: 'fix',
            label: `Start ${provider} first`,
            confirm: `server.cfg will start ${provider} just before ${r.name}, so ${r.name} gets ${provider} instead of the old ${swapped}. A copy of server.cfg is saved first, and you can undo this. ${r.name} is started straight away.`,
            fix: { type: 'start-before', provider, dependent: r.name, original: swapped },
          },
          { kind: 'open-resource', label: `Open ${r.name}`, name: r.name },
        ],
        links: [],
        raw: `${r.name} is set to start with the server but is stopped; it needs ${swapped}, which ${provider} stands in for`,
      });
      continue;
    }
    if ([...existing].some((id) => id.split(':').includes(r.name))) continue;
    out.push({
      id: `not-running:${r.name}`,
      rule: 'not-running',
      severity: 'warning',
      resource: r.name,
      count: 1,
      title: `${r.name} is set to start with the server but isn't running`,
      what: 'Someone may have stopped it, or it stopped after an error. Starting it shows any error it hits.',
      fix: ['Press the button to start it.', 'If it stops again, check the Console page for its error.'],
      actions: [
        { kind: 'fix', label: 'Start it now', confirm: `${r.name} will be started on the running server. Players stay connected.`, fix: { type: 'start', name: r.name } },
        { kind: 'open-resource', label: `Open ${r.name}`, name: r.name },
      ],
      links: [],
      raw: `${r.name} is set to start with the server but is stopped`,
    });
  }
  return out;
}

/** Adds the one-click fixes CityHQ knows for problems found in the log. */
function addLogFixes(items, disk, cfg) {
  const boot = parseBoot(cfg);
  const installed = new Set(disk.flatMap((r) => [r.name, ...r.provides]));
  for (const item of items) {
    if (item.rule !== 'unknown-resource') continue;
    const name = item.id.slice('unknown-resource:'.length);
    if (installed.has(name) || !boot.names.has(name)) continue;
    item.actions = [{
      kind: 'fix',
      label: 'Switch that line off',
      confirm: `server.cfg keeps the "ensure ${name}" line but switches it off, so nothing tries to start a script that isn't there. A copy of server.cfg is saved first, and you can undo this.`,
      fix: { type: 'cfg-off', name },
    }, ...item.actions];
  }
}

/** A missing script's GitHub page, when the script that needs it links to it in its own files. */
function addRepoInstalls(items, links) {
  for (const item of items) {
    if (item.rule !== 'missing-dependency' || item.actions.some((a) => a.kind === 'install')) continue;
    const dependency = item.id.split(':')[2];
    const url = dependency && repoFor(dependency, links.get(item.resource) || []);
    if (url) item.actions = [{ kind: 'install', label: `Install ${dependency} (linked in ${item.resource}'s files)`, url, name: dependency }, ...item.actions];
  }
}

/** Log channels are cut to a fixed width, so find a resource from the start of its name. */
function makeContext(disk, cfgText, dataPath) {
  const byName = new Map(disk.map((r) => [r.name, r]));
  const lower = new Map(disk.map((r) => [r.name.toLowerCase(), r.name]));
  const provided = new Set(disk.flatMap((r) => r.provides));
  const toFolder = (r) => path.relative(dataPath, r.dir).replaceAll('\\', '/');
  return {
    folderOf: (name) => (byName.has(name) ? toFolder(byName.get(name)) : null),
    isInstalled: (name) => byName.has(name) || lower.has(String(name).toLowerCase()) || provided.has(name),
    resolveName(prefix) {
      if (byName.has(prefix)) return prefix;
      const matches = disk.filter((r) => r.name.startsWith(prefix));
      return matches.length === 1 ? matches[0].name : null;
    },
    cfgLineOf(name) {
      const pattern = new RegExp(`^\\s*(ensure|start)\\s+["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const index = cfgText.split(/\r?\n/).findIndex((l) => pattern.test(l));
      return index === -1 ? null : index + 1;
    },
  };
}

/**
 * "Unknown column": when the script's own .sql file defines that column for a table that exists
 * without it and holds no rows (made earlier by another script), offer to rebuild that table.
 */
const TABLE_MEMO_MS = 30000;
const tableMemo = new Map();
const recentTableInfo = async (table) => {
  const hit = tableMemo.get(table);
  if (hit && Date.now() - hit.at < TABLE_MEMO_MS) return hit.info;
  const info = await tableInfo(table).catch(() => null);
  tableMemo.set(table, { at: Date.now(), info });
  return info;
};

async function tableLayoutFix(item, texts) {
  const candidates = tablesDefining(item.sqlColumn, texts, item.sqlQuery || '');
  if (candidates.length !== 1) return null;
  const { table, file } = candidates[0];
  const info = await recentTableInfo(table);
  if (!info || info.columns.includes(item.sqlColumn)) return null;
  if (info.rows > 0) {
    item.fix = [`${table} already has data, so CityHQ won't rebuild it. Add the missing "${item.sqlColumn}" column by hand, or ask ${item.resource}'s author for an update file.`, ...item.fix];
    return null;
  }
  return {
    kind: 'fix',
    label: 'Rebuild the empty table',
    confirm: `${table} is empty, but it was made with a different layout (probably by another script), so ${item.resource} can't use it. It will be dropped and created again from ${path.basename(file)}, exactly as ${item.resource} expects. A database backup is made first.`,
    fix: { type: 'rebuild-table', resource: item.resource, file, table, column: item.sqlColumn },
  };
}

async function addSqlActions(items, disk) {
  for (const item of items) {
    if (!item.needsSqlFor) continue;
    let files = await listSqlFiles(item.needsSqlFor).catch(() => []);
    // For a missing table, the file that actually creates it goes first.
    let creates = [];
    let rebuild = null;
    const dir = disk.find((r) => r.name === item.needsSqlFor)?.dir;
    if ((item.sqlTable || item.sqlColumn) && dir) {
      const texts = await Promise.all(files.map(async (file) => ({ file, text: await readFile(path.join(dir, file), 'utf8').catch(() => '') })));
      if (item.sqlTable) {
        creates = sqlFilesCreating(item.sqlTable, texts);
        files = [...creates, ...files.filter((f) => !creates.includes(f))];
      }
      if (item.sqlColumn) rebuild = await tableLayoutFix(item, texts);
    }
    // The query lines can hold player data, so they never leave the server.
    delete item.sqlQuery;
    delete item.sqlColumn;
    const run = files.slice(0, 3).map((file) => ({
      kind: 'run-sql',
      label: creates.includes(file) ? `Create the missing table (runs ${path.basename(file)})` : `Run ${path.basename(file)}`,
      name: item.needsSqlFor,
      file,
    }));
    item.actions = [...(rebuild ? [rebuild] : []), ...run, ...item.actions];
    if (!files.length) item.fix = [`${item.needsSqlFor} has no .sql file in its folder, so look for one where you got the resource.`, ...item.fix.slice(1)];
    delete item.needsSqlFor;
    delete item.sqlTable;
  }
}

/** Explains specific log lines, such as the ones from a restart that just failed. */
export async function explainLines(lines, { currentResource = null } = {}) {
  const server = findServerData();
  if (!server) return [];
  const [disk, cfgText] = await Promise.all([scanDisk(), readCfg(server.cfgPath).catch(() => '')]);
  const ctx = { ...makeContext(disk, cfgText, server.dataPath), currentResource };
  const items = explainLogLines(lines, ctx);
  await addSqlActions(items, disk);
  const { index } = await docIndex(disk);
  for (const item of items) item.links = withDocLinks(item, index);
  return items;
}

export async function currentProblems({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < CACHE_MS) return cached.value;
  const server = findServerData();
  if (!server) return [];
  const [disk, cfgText, log, live] = await Promise.all([
    scanDisk(), readCfg(server.cfgPath).catch(() => ''), readConsole(), liveStates(),
  ]);
  const ctx = makeContext(disk, cfgText, server.dataPath);

  // Only the latest boot matters; older errors may already be fixed.
  const texts = log.lines.map((l) => l.text);
  const boot = texts.findLastIndex((t) => t.includes('FXServer Starting'));
  const bootMarker = boot >= 0 ? texts[boot] : null;
  // Once a resource has been removed, its old errors aren't worth reporting.
  const items = explainLogLines(boot >= 0 ? texts.slice(boot) : texts, ctx)
    .filter((item) => !item.resource || ctx.isInstalled(item.resource));
  await addSqlActions(items, disk);

  const known = new Set(items.map((i) => i.id));
  const available = new Set(disk.flatMap((r) => [r.name, ...r.provides]));
  for (const r of disk) {
    for (const dep of r.dependencies) {
      const item = explainMissingDependency(r.name, dep, ctx);
      if (!available.has(dep) && !known.has(item.id)) items.push(item);
    }
  }
  items.push(...stateProblems({ disk, cfg: cfgText, live, existing: new Set(items.map((i) => i.id)) }));

  addLogFixes(items, disk, cfgText);
  const { index, links } = await docIndex(disk);
  addRepoInstalls(items, links);
  for (const item of items) item.links = withDocLinks(item, index);

  // A fix made during this boot hides its problem; the log line itself stays until a restart.
  const fixed = await fixedThisBoot(bootMarker).catch(() => new Set());
  const sorted = items
    .filter((i) => !fixed.has(i.id))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  cached = { at: Date.now(), value: sorted, boot: bootMarker };
  return sorted;
}

/** Runs the one-click fix of a problem that is still listed; the server plans and checks it again. */
export async function fixProblem(id) {
  const problems = await currentProblems({ fresh: true });
  const problem = problems.find((p) => p.id === id);
  if (!problem) throw new HttpError(404, 'That problem is no longer listed. It may already be fixed.');
  const action = problem.actions.find((a) => a.kind === 'fix');
  if (!action) throw new HttpError(400, 'There\'s no one-click fix for this problem.');
  const result = await runFix(action.fix);
  tableMemo.clear();
  const record = await recordFix({
    problemId: id, boot: cached.boot, title: problem.title, label: action.label, message: result.message, undo: result.undo, versionId: result.versionId,
  });
  cached.at = 0;
  return { message: result.message, fixId: record.id, undoable: Boolean(result.undo) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_WAIT_MS = 9000;

/**
 * Restarts a resource and reports, in plain English, anything that went wrong while it started.
 * It reads the server's log, which txAdmin writes every few seconds, so it waits until this
 * resource's start shows up there. Reading the log also captures the lines around an error.
 */
export async function restartChecked(name) {
  await assertCanControl(name);
  let { offset } = await readConsole();
  const result = await agentRequest('/resources/action', { method: 'POST', body: { name, action: 'ensure' }, timeoutMs: 120000 });
  const lines = [];
  const finished = new RegExp(`(Started resource|Couldn't start resource) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const deadline = Date.now() + LOG_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    const chunk = await readConsole(offset);
    offset = chunk.offset;
    lines.push(...chunk.lines.map((l) => l.text));
    if (lines.some((l) => finished.test(l))) break;
  }
  const all = lines.length ? await explainLines(lines, { currentResource: name }) : [];
  const problems = all.filter((p) => p.resource === name);
  const started = result.state === 'started' || result.state === 'starting';
  return { ok: started && !problems.some((p) => p.severity === 'error'), state: result.state, problems };
}
