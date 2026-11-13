// Health checks for a hosted server: the ones that make sense at a host. Sleep, Smart App Control,
// this PC's disk and memory, and the router don't apply; the plan's own limits do.
import { agentRequest, installedAgentVersion } from '../agent.js';
import { readCfg } from '../cfg.js';
import { duplicateFindings, missingStartFindings, startOrderFindings } from '../health.js';
import { findServerData, REMOTE, STATE_DIR } from '../paths.js';
import { scanDisk } from '../resources.js';
import { joinLinkOf, lastHelperAddress } from './helper.js';
import { listedNow } from './listing.js';
import { hostedTxAdmin, txAdminFinding } from './txadmin.js';
import { panelClient } from './panel.js';
import { loadSecret } from './secret.js';

const GB = 1024 ** 3;
const finding = (id, status, title, detail, extra = {}) => ({ id, status, title, detail, steps: [], ...extra });

/** Use against the plan's limit: ok below 80%, warn below 95%, bad above. */
export function limitFinding(id, used, limit, what, { full, near, ok }) {
  if (!limit || used === null || used === undefined) return null;
  const pct = used / limit;
  const label = `${(used / GB).toFixed(1)} GB of ${(limit / GB).toFixed(1)} GB`;
  if (pct >= 0.95) return finding(id, 'bad', full, `${label} ${what}.`, { steps: ['Free some up, or ask your host for a bigger plan.'] });
  if (pct >= 0.8) return finding(id, 'warn', near, `${label} ${what}.`, { steps: ['Keep an eye on it; ask your host for a bigger plan if it keeps growing.'] });
  return finding(id, 'ok', ok, `${label} ${what}.`);
}

async function checkHelper() {
  try {
    const status = await agentRequest('/status', { timeoutMs: 8000 });
    if (status.agentVersion !== installedAgentVersion()) {
      return finding('helper', 'warn', 'CityHQ\'s helper needs a server restart', 'A newer helper is on your host but only loads at the next restart, so some CityHQ controls may not work until then.', { steps: ['Restart the server when nobody is playing.'] });
    }
    return finding('helper', 'ok', 'CityHQ\'s helper is up to date', 'All in-city controls work.');
  } catch {
    return finding('helper', 'warn', 'CityHQ\'s helper isn\'t answering', 'It starts when the server starts. If the server is running, restart it once from your host\'s panel so the helper loads.');
  }
}

async function checkDatabase() {
  try {
    const r = await agentRequest('/db-ping', { timeoutMs: 8000 });
    if (r.ok) return finding('database', 'ok', 'The database is answering', 'Scripts can save and load data.');
  } catch (err) {
    if (/oxmysql is not running/.test(err.message)) {
      return finding('database', 'bad', 'oxmysql isn\'t running', 'Scripts can\'t reach the database without it, so players may not be able to load in.', { steps: ['Check the Console page for oxmysql\'s error, usually a wrong mysql_connection_string in server.cfg.'] });
    }
    return null;
  }
  return finding('database', 'bad', 'The database isn\'t answering', 'Scripts can\'t save or load anything.', { steps: ['Check your host\'s database page, and the mysql_connection_string line in server.cfg.'] });
}

function checkJoinable() {
  const link = joinLinkOf(lastHelperAddress());
  if (!link) return null;
  if (listedNow(link) === false) {
    return finding('reachable', 'warn', 'Your server isn\'t on FiveM\'s server list', 'Players can join with its address, but can\'t find it in FiveM (or see it as private), and its join link doesn\'t open. Things to fix on Home says why.');
  }
  return finding('reachable', 'ok', 'Players can join from anywhere', 'The server has its Cfx.re address, so it shows up for players and the join link works.');
}

async function checkTxAdmin() {
  const f = txAdminFinding(await hostedTxAdmin());
  return f ? finding('txadmin', f.status, f.title, f.detail, { steps: f.steps }) : null;
}

async function checkPlan() {
  if (REMOTE.type !== 'panel') return [];
  const key = loadSecret(STATE_DIR);
  if (!key) return [];
  const panel = panelClient({ url: REMOTE.panelUrl, key, serverId: REMOTE.serverId });
  const [limits, use] = await Promise.all([panel.limits(), panel.resources().catch(() => null)]);
  return [
    limitFinding('host-disk', use?.diskBytes, limits.diskMb ? limits.diskMb * 1024 * 1024 : null, 'of your plan\'s disk used', {
      full: 'Your host\'s disk is almost full', near: 'Your host\'s disk is getting full', ok: 'Plenty of room on your host',
    }),
    limitFinding('host-memory', use?.state === 'running' ? use.memBytes : null, limits.memoryMb ? limits.memoryMb * 1024 * 1024 : null, 'of your plan\'s memory in use', {
      full: 'The server is using almost all its memory', near: 'The server is using most of its memory', ok: 'The server has memory to spare',
    }),
  ].filter(Boolean);
}

/** Every hosted check, problems first. */
export async function hostedHealthChecks() {
  const server = findServerData();
  const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
  const [helper, database, plan, disk, cfg, txAdmin] = await Promise.all([
    settle(checkHelper()), settle(checkDatabase()), settle(checkPlan()),
    settle(scanDisk()), server ? settle(readCfg(server.cfgPath)) : null, settle(checkTxAdmin()),
  ]);
  const findings = [helper, database, checkJoinable(), txAdmin, ...(plan || [])].filter(Boolean);
  // Script checks need the running server's list; without it they'd call everything missing.
  if (disk?.length && cfg) {
    const order = startOrderFindings(disk, cfg);
    findings.push(...(order.length ? order : [finding('start-order', 'ok', 'Scripts start in a working order', 'No script pulls an old, replaced script back in at startup.')]));
    const missing = missingStartFindings(disk, cfg);
    findings.push(...(missing.length ? missing : [finding('missing-start', 'ok', 'server.cfg only starts installed scripts', 'No start lines point at scripts that aren\'t there.')]));
    findings.push(...duplicateFindings(disk, server.dataPath));
  } else {
    findings.push(finding('scripts', 'info', 'Script checks need the server running', 'Start the server, and once CityHQ\'s helper answers, the start order and missing scripts are checked here too.'));
  }
  const ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
  return findings.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}
