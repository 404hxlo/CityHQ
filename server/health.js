// The Health page's checks: beginner traps found by looking at the PC, the database and the
// server's files, each explained in plain words, with a one-click fix where one is safe.
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { agentRequest, installedAgentVersion } from './agent.js';
import { awakeStatus } from './awake.js';
import { parseBoot, readCfg } from './cfg.js';
import { serverLogTail } from './doctor.js';
import { dbRun, VALID_TABLE } from './db.js';
import { columnsOf, createStatementFor, stripSqlComments } from './fixes.js';
import { serverFramework } from './framework.js';
import { findServerData, MANAGED_DB, ROOT } from './paths.js';
import { liveStates, listSqlFiles, scanDisk } from './resources.js';
import { listingStatus } from './reach.js';
import { getSettings } from './settings.js';

const exec = promisify(execFile);
const GB = 1024 ** 3;
const OTHER_FRAMEWORK_SQL = /(^|[\\/_.-])(esx|vrp|qbx|qbox|ox[_-]?core|nd[_-]?core)([\\/_.-]|$)/i;
const NOT_QBOX_SQL = /(^|[\\/_.-])(esx|vrp|ox[_-]?core|nd[_-]?core)([\\/_.-]|$)/i;

/** .sql files written for a framework this server doesn't run, which the table check skips. */
export const otherFrameworkSql = (file, framework) => (framework === 'qbox' ? NOT_QBOX_SQL : OTHER_FRAMEWORK_SQL).test(file);

const finding = (id, status, title, detail, extra = {}) => ({ id, status, title, detail, steps: [], ...extra });

/** Seconds from a powercfg line such as "Current AC Power Setting Index: 0x0000012c". */
export function powercfgSeconds(text, kind) {
  const m = text.match(new RegExp(`Current ${kind} Power Setting Index:\\s*0x([0-9a-f]+)`, 'i'));
  return m ? parseInt(m[1], 16) : null;
}

const minutes = (s) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);

async function checkSleep() {
  let ac = null;
  let dc = null;
  try {
    const { stdout } = await exec('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { windowsHide: true, timeout: 8000 });
    ac = powercfgSeconds(stdout, 'AC');
    dc = powercfgSeconds(stdout, 'DC');
  } catch { /* not readable */ }
  const awake = awakeStatus();
  const { keepAwake } = getSettings();
  const sleepy = (ac ?? 0) > 0 || (dc ?? 0) > 0;
  if (!sleepy) return finding('sleep', 'ok', 'The PC never sleeps on its own', 'Windows is set not to sleep, so the server won\'t be paused.');
  const timers = [ac ? `${minutes(ac)} when plugged in` : null, dc ? `${minutes(dc)} on battery` : null].filter(Boolean).join(' and ');
  if (!awake.supported) {
    return finding('sleep', 'warn', 'The PC may go to sleep and pause the server', `Windows sleeps after ${timers} without use. Sleep freezes the server, and txAdmin restarts it when the PC wakes.`, {
      steps: ['Open the CityHQ desktop app on the PC running the server: it can keep the PC awake while the server runs.'],
    });
  }
  if (!keepAwake.enabled) {
    return finding('sleep', 'bad', 'The PC goes to sleep and pauses the server', `Windows sleeps after ${timers} without use. Sleep freezes the server, and txAdmin restarts it when the PC wakes.`, {
      fix: { label: 'Keep the PC awake while the server runs', confirm: 'CityHQ will ask Windows not to sleep while the server runs, and let go when it stops. Your Windows settings stay as they are. Closing the lid still puts the PC to sleep.', fix: { type: 'keep-awake', screenOnBattery: keepAwake.screenOnBattery } },
    });
  }
  if (awake.onBattery && !keepAwake.screenOnBattery && awake.serverRunning) {
    return finding('sleep', 'warn', 'On battery, the PC can still fall asleep', `CityHQ keeps the PC awake, but on battery Windows only allows that for a few minutes past its ${minutes(dc || ac)} sleep timer unless the screen stays on.`, {
      steps: ['Plug the charger in, or let CityHQ keep the screen on while on battery.'],
      fix: { label: 'Keep the screen on while on battery', confirm: 'While the server runs on battery, CityHQ will keep the screen on too, which is the only way Windows stays awake on battery. This uses more battery.', fix: { type: 'keep-awake', screenOnBattery: true } },
    });
  }
  return finding('sleep', 'ok', 'CityHQ keeps the PC awake while the server runs', `Windows would sleep after ${timers}, but CityHQ asks it not to while the server runs. Closing the lid still puts it to sleep.`);
}

/** Smart App Control: 0 off, 1 on, 2 evaluation. */
export function sacState(regOutput) {
  const m = regOutput.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}

async function checkSmartAppControl() {
  let state = null;
  try {
    const { stdout } = await exec('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'], { windowsHide: true, timeout: 8000 });
    state = sacState(stdout);
  } catch { return null; }
  const steps = ['Open Windows Security, then App & browser control, then Smart App Control settings.', 'Choose Off. Windows doesn\'t let apps change this, so it has to be done by hand.'];
  if (state === 1) return finding('sac', 'bad', 'Smart App Control blocks the server from starting', 'It blocks a file FiveM\'s server needs (libnode22.dll), so the server shows a "Fatal Error" and never starts.', { steps });
  if (state === 2) return finding('sac', 'warn', 'Smart App Control may switch itself on', 'It is in evaluation mode, and on this PC it has switched on by itself before, which stops the server from starting.', { steps });
  return finding('sac', 'ok', 'Smart App Control is off', 'It can\'t block the server\'s files.');
}

async function checkDisk() {
  try {
    const { bavail, bsize } = await statfs(ROOT);
    const free = Number(bavail) * Number(bsize);
    const label = `${(free / GB).toFixed(1)} GB free on the server's drive`;
    if (free < 5 * GB) return finding('disk', 'bad', 'The server\'s drive is almost full', `${label}. Backups and scripts can fail when it fills up.`, { steps: ['Delete old backups on the Backups page, or move files off this drive.'] });
    if (free < 15 * GB) return finding('disk', 'warn', 'The server\'s drive is getting full', `${label}. Each full backup takes a few hundred MB.`, { steps: ['Keep fewer backups on the Backups page, or free up space.'] });
    return finding('disk', 'ok', 'Plenty of disk space', `${label}.`);
  } catch { return null; }
}

function checkMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const label = `${(free / GB).toFixed(1)} GB of ${(total / GB).toFixed(1)} GB free`;
  if (free < 1 * GB) return finding('memory', 'warn', 'The PC is low on memory', `${label}. With the game, the server and the database open at once, things can stutter or crash.`, { steps: ['Close programs you aren\'t using, especially browsers with many tabs.', 'Don\'t play on the same PC while the server has a lot of players, if you can.'] });
  return finding('memory', 'ok', 'Enough free memory', `${label}.`);
}

async function checkDatabase() {
  try {
    await dbRun('SELECT 1', { timeoutMs: 8000 });
    return finding('database', 'ok', 'The database is running', 'Scripts can save and load data.');
  } catch {
    const steps = MANAGED_DB
      ? ['Start the server from the Overview page; CityHQ starts the database with it.', 'If it stays down, check the Console page for database errors.']
      : ['Start your database first, for example MySQL in XAMPP\'s control panel, or the MySQL or MariaDB service in Windows.', 'Check that the mysql_connection_string line in server.cfg has the right address, user and password.'];
    return finding('database', 'bad', 'The database isn\'t answering', 'Scripts can\'t save or load anything, and players may not be able to load in.', { steps });
  }
}

/** Where each resource starts in server.cfg: its own line, or its [category] line. */
function startLineIndex(lines, resource) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [resource.name, ...resource.categories];
  return lines.findIndex((l) => names.some((n) => new RegExp(`^\\s*(ensure|start)\\s+["']?${esc(n)}["']?\\s*(#.*)?$`).test(l)));
}

/**
 * The qb-houses trap before it happens: a script that needs an old script kept in [disabled], whose
 * replacement starts later in server.cfg, so FiveM digs the old one out and then stops both.
 */
export function startOrderFindings(disk, cfg) {
  const boot = parseBoot(cfg);
  const lines = cfg.split(/\r?\n/);
  const atBoot = (r) => !r.categories.includes('[disabled]') && (boot.names.has(r.name) || r.categories.some((c) => boot.categories.has(c)));
  const byName = new Map(disk.map((r) => [r.name, r]));
  const out = [];
  for (const dependent of disk.filter(atBoot)) {
    for (const dep of dependent.dependencies) {
      const original = byName.get(dep);
      if (!original || !original.categories.includes('[disabled]')) continue;
      const provider = disk.find((r) => r.name !== dep && atBoot(r) && r.provides.includes(dep));
      if (!provider) continue;
      const pAt = startLineIndex(lines, provider);
      const dAt = startLineIndex(lines, dependent);
      if (pAt === -1 || dAt === -1 || pAt < dAt) continue;
      out.push(finding(`start-order:${dependent.name}:${dep}`, 'bad', `${dependent.name} will be stopped at every startup`, `${dependent.name} needs ${dep}. ${provider.name} replaces ${dep}, but starts later in server.cfg, so FiveM starts the old ${dep} from [disabled] for ${dependent.name}, then stops both when ${provider.name} takes over.`, {
        fix: { label: `Start ${provider.name} first`, confirm: `server.cfg will start ${provider.name} just before ${dependent.name}. A copy of server.cfg is saved first, and you can undo this.`, fix: { type: 'start-before', provider: provider.name, dependent: dependent.name, original: dep } },
      }));
    }
  }
  return out;
}

/** server.cfg lines for scripts that aren't installed. */
export function missingStartFindings(disk, cfg) {
  const boot = parseBoot(cfg);
  const installed = new Set(disk.flatMap((r) => [r.name, ...r.provides]));
  const builtIn = new Set(['chat', 'monitor', 'yarn', 'webpack', 'sessionmanager', 'hardcap']);
  return [...boot.names].filter((n) => !installed.has(n) && !builtIn.has(n)).map((name) => finding(`missing-start:${name}`, 'warn', `server.cfg starts "${name}", which isn't installed`, 'FiveM skips it with a warning at every startup.', {
    fix: { label: 'Switch that line off', confirm: `server.cfg keeps the "ensure ${name}" line but switches it off. A copy of server.cfg is saved first, and you can undo this.`, fix: { type: 'cfg-off', name } },
  }));
}

/** The same script installed twice in different folders: FiveM only uses one of them. */
export function duplicateFindings(disk, dataPath) {
  const seen = new Map();
  for (const r of disk) seen.set(r.name, [...(seen.get(r.name) || []), r]);
  return [...seen.entries()].filter(([, list]) => list.length > 1).map(([name, list]) => finding(`duplicate:${name}`, 'warn', `${name} is installed twice`, `It's in ${list.map((r) => path.relative(dataPath, r.dir).replaceAll('\\', '/')).join(' and ')}. FiveM only uses one of them, so changes to the other do nothing.`, {
    steps: ['Keep the newer one and remove the other on the Resources page.'],
  }));
}

/** Database tables and columns the running scripts' own .sql files define but the database lacks. */
async function checkTables(disk, cfg) {
  const boot = parseBoot(cfg);
  const running = disk.filter((r) => !r.categories.includes('[disabled]') && (boot.names.has(r.name) || r.categories.some((c) => boot.categories.has(c))));
  return tableFindings(running);
}

/** The same check for any list of scripts, such as one that was just installed. */
export async function tableFindings(resources) {
  const wanted = [];
  const { framework } = serverFramework();
  for (const r of resources) {
    const files = (await listSqlFiles(r.name).catch(() => [])).filter((f) => !otherFrameworkSql(f, framework));
    for (const file of files) {
      const text = stripSqlComments(await readFile(path.join(r.dir, file), 'utf8').catch(() => ''));
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi)) {
        const statement = createStatementFor(m[1], text);
        if (statement && VALID_TABLE.test(m[1])) wanted.push({ resource: r.name, file, table: m[1], columns: columnsOf(statement) });
      }
    }
  }
  if (!wanted.length) return [];
  const names = [...new Set(wanted.map((w) => w.table))];
  let rows;
  try {
    rows = await dbRun(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (${names.map((n) => `'${n}'`).join(',')})`, { timeoutMs: 15000 });
  } catch { return []; }
  const existing = new Map();
  for (const [t, c] of rows) existing.set(t.toLowerCase(), [...(existing.get(t.toLowerCase()) || []), c.toLowerCase()]);
  const out = [];
  const byResource = new Map();
  for (const w of wanted) {
    const cols = existing.get(w.table.toLowerCase());
    if (!cols) {
      if (!byResource.has(w.resource)) byResource.set(w.resource, []);
      if (!byResource.get(w.resource).some((x) => x.table === w.table)) byResource.get(w.resource).push({ table: w.table, file: w.file });
      continue;
    }
    const missingCols = w.columns.filter((c) => !cols.includes(c.toLowerCase()));
    if (!missingCols.length) continue;
    let count = null;
    try { count = Number((await dbRun(`SELECT COUNT(*) FROM \`${w.table}\``))[0][0]); } catch { /* unknown */ }
    const id = `table-layout:${w.table}`;
    if (out.some((f) => f.id === id)) continue;
    out.push(finding(id, 'bad', `${w.table} is missing columns ${w.resource} needs`, `${w.resource}'s ${path.basename(w.file)} gives ${w.table} the columns ${missingCols.join(', ')}, but your database's ${w.table} doesn't have them. This usually means another script made the table first.`, count === 0
      ? { fix: { label: 'Rebuild the empty table', confirm: `${w.table} is empty, so it can be dropped and created again from ${path.basename(w.file)}, exactly as ${w.resource} expects. A database backup is made first.`, fix: { type: 'rebuild-table', resource: w.resource, file: w.file, table: w.table, column: missingCols[0] } } }
      : { steps: [`${w.table} has data in it, so CityHQ won't rebuild it. Add the missing columns by hand, or ask ${w.resource}'s author for an update file.`] }));
  }
  for (const [resource, tables] of byResource) {
    out.push(finding(`missing-tables:${resource}`, 'bad', `${resource} is missing database tables`, `Its .sql files create ${tables.map((t) => t.table).join(', ')}, but your database doesn't have ${tables.length === 1 ? 'it' : 'them'}, so parts of it won't save or load.`, {
      fix: { label: `Create ${tables.length === 1 ? 'the missing table' : `the ${tables.length} missing tables`}`, confirm: `CityHQ will run only the CREATE TABLE parts of ${resource}'s .sql files for ${tables.map((t) => t.table).join(', ')}. Nothing existing is changed, and a database backup is made first.`, fix: { type: 'create-tables', resource, tables } },
    }));
  }
  if (!out.length) out.push(finding('tables', 'ok', resources.length === 1 ? 'Its database tables are there' : 'Every script\'s database tables are there', `Checked ${names.length} table${names.length === 1 ? '' : 's'} from ${resources.length === 1 ? 'its' : 'the'} .sql files${resources.length === 1 ? '' : ' of scripts that start with the server'}.`));
  return out;
}

async function checkHelper() {
  try {
    const live = await liveStates();
    if (!live) return null;
    const status = await agentRequest('/status', { timeoutMs: 3000 });
    if (status.agentVersion !== installedAgentVersion()) {
      return finding('helper', 'warn', 'CityHQ\'s helper needs a server restart', 'A newer helper is installed but only loads at the next full restart, so some CityHQ controls may not work until then.', { steps: ['Restart the server when nobody is playing.'] });
    }
    return finding('helper', 'ok', 'CityHQ\'s helper is up to date', 'All in-city controls work.');
  } catch { return null; }
}

async function checkReachable() {
  try {
    const listing = listingStatus(await serverLogTail(4 * 1024 * 1024));
    if (listing.status === 'blocked' || (listing.status === 'pending' && listing.lastFailed)) {
      return finding('reachable', 'warn', 'Friends outside your home can\'t join yet', `FiveM's server list tried to reach your server from the internet and couldn't${listing.status === 'pending' ? ' (last time it checked)' : ''}. People on your own Wi-Fi can still join.`, { goTo: 'friends' });
    }
    if (listing.status === 'ok') return finding('reachable', 'ok', 'Friends outside your home can reach the server', 'FiveM\'s server list hasn\'t reported any trouble reaching it since it started.');
    return null;
  } catch { return null; }
}

const ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };

/** Every check, problems first. A check that can't run is left out rather than guessed. */
export async function healthChecks() {
  const server = findServerData();
  const [disk, cfg] = server ? await Promise.all([scanDisk(), readCfg(server.cfgPath).catch(() => '')]) : [[], ''];
  const settle = (p) => Promise.resolve(p).then((v) => v, () => null);
  const results = await Promise.all([
    settle(checkSleep()), settle(checkSmartAppControl()), settle(checkDatabase()), settle(checkDisk()), settle(checkMemory()),
    settle(checkHelper()), settle(checkReachable()),
    server ? settle(checkTables(disk, cfg)) : null,
  ]);
  const findings = results.flat().filter(Boolean);
  if (server) {
    const order = startOrderFindings(disk, cfg);
    findings.push(...(order.length ? order : [finding('start-order', 'ok', 'Scripts start in a working order', 'No script pulls an old, replaced script back in at startup.')]));
    const missing = missingStartFindings(disk, cfg);
    findings.push(...(missing.length ? missing : [finding('missing-start', 'ok', 'server.cfg only starts installed scripts', 'No start lines point at scripts that aren\'t there.')]));
    findings.push(...duplicateFindings(disk, server.dataPath));
  }
  return findings.sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}
