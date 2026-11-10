// Gathers everything wrong right now and explains it, for the Overview and resource panels.
import path from 'node:path';
import { agentRequest } from './agent.js';
import { readCfg } from './cfg.js';
import { readConsole } from './console.js';
import { explainLogLines, explainMissingDependency } from './explain.js';
import { findServerData } from './paths.js';
import { listSqlFiles, scanDisk } from './resources.js';

const CACHE_MS = 5000;
let cached = { at: 0, value: [] };

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

async function addSqlActions(items, ctx) {
  for (const item of items) {
    if (!item.needsSqlFor) continue;
    const files = await listSqlFiles(item.needsSqlFor).catch(() => []);
    const run = files.slice(0, 3).map((file) => ({ kind: 'run-sql', label: `Run ${path.basename(file)}`, name: item.needsSqlFor, file }));
    item.actions = [...run, ...item.actions];
    if (!files.length) item.fix = [`${item.needsSqlFor} has no .sql file in its folder, so look for one where you got the resource.`, ...item.fix.slice(1)];
    delete item.needsSqlFor;
  }
  return ctx;
}

/** Explains specific log lines, such as the ones from a restart that just failed. */
export async function explainLines(lines, { currentResource = null } = {}) {
  const server = findServerData();
  if (!server) return [];
  const [disk, cfgText] = await Promise.all([scanDisk(), readCfg(server.cfgPath).catch(() => '')]);
  const ctx = { ...makeContext(disk, cfgText, server.dataPath), currentResource };
  const items = explainLogLines(lines, ctx);
  await addSqlActions(items, ctx);
  return items;
}

export async function currentProblems({ fresh = false } = {}) {
  if (!fresh && Date.now() - cached.at < CACHE_MS) return cached.value;
  const server = findServerData();
  if (!server) return [];
  const [disk, cfgText, log] = await Promise.all([scanDisk(), readCfg(server.cfgPath).catch(() => ''), readConsole()]);
  const ctx = makeContext(disk, cfgText, server.dataPath);

  // Only the latest boot matters; older errors may already be fixed.
  const texts = log.lines.map((l) => l.text);
  const boot = texts.findLastIndex((t) => t.includes('FXServer Starting'));
  // Once a resource has been removed, its old errors aren't worth reporting.
  const items = explainLogLines(boot >= 0 ? texts.slice(boot) : texts, ctx)
    .filter((item) => !item.resource || ctx.isInstalled(item.resource));
  await addSqlActions(items, ctx);

  const known = new Set(items.map((i) => i.id));
  const available = new Set(disk.flatMap((r) => [r.name, ...r.provides]));
  for (const r of disk) {
    for (const dep of r.dependencies) {
      const item = explainMissingDependency(r.name, dep, ctx);
      if (!available.has(dep) && !known.has(item.id)) items.push(item);
    }
  }
  const sorted = items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  cached = { at: Date.now(), value: sorted };
  return sorted;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_WAIT_MS = 9000;

/**
 * Restarts a resource and reports, in plain English, anything that went wrong while it started.
 * It reads the server's log, which txAdmin writes every few seconds, so it waits until this
 * resource's start shows up there. Reading the log also captures the lines around an error.
 */
export async function restartChecked(name) {
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
