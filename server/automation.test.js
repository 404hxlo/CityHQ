import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { findInstallSource } from './catalog.js';
import { explainLogLines, explainMissingDependency, luaPlain } from './explain.js';
import {
  BUILT_IN_CATEGORY, builtInItems, parseGithubUrl, replacementsOf, scanSystem,
} from './resources.js';
import {
  bestLink, buildDocIndex, docLinksIn, QB_HOME, repoFor, siteOf, withDocLinks,
} from './docs.js';
import {
  columnsOf, createStatementFor, startBefore, startBeforeNote, tablesDefining, undoStartBefore,
} from './fixes.js';
import { sqlFilesCreating, stateProblems } from './problems.js';
import { awakeMode } from './awake.js';
import {
  duplicateFindings, missingStartFindings, powercfgSeconds, sacState, startOrderFindings,
} from './health.js';
import {
  adminRestarts, bootSegments, explainRestart, lastActivity, wholePause,
} from './doctor.js';
import { stripSqlComments } from './fixes.js';
import { frameworkFit } from './inspect.js';
import {
  firewallCovers, listingStatus, parseFirewall, parseRoute,
} from './reach.js';
import { gameBuildName } from './profile.js';
import { readCommand, setCommand } from './cfg.js';
import { BOOT_MAX_MS, BOOT_STALL_MS, bootVerdict } from './control.js';
import {
  addBootLine, convarOn, parseBoot, readConvar, removeBootLine, setConvar,
} from './cfg.js';
import {
  createProcessWatch, isValidTime, lastOccurrence, nextOccurrence, warningDue,
} from './scheduler.js';
import { BLOCK_END, BLOCK_START, ensureManagedBlock } from './cfg.js';
import { findRoot, layoutOf, portOr } from './paths.js';
import { gamePortOf } from './cfg.js';
import { ownProcesses } from './processes.js';
import {
  findServerFolders, inspectServerFolder, suggestNewFolder, txAdminPinIn, txAdminPortIn,
} from './welcome.js';
import { checksumFor } from './dbtools.js';
import {
  parseAdmins, removeAdmin, setAdmin, VALID_IDENTIFIER,
} from './admins.js';
import { groupPlayers, parseBatch } from './people.js';
import {
  addReading, BUCKET_MS, countDay, diffPlayers, series,
} from './stats.js';

const CFG = [
  '## Permissions',
  'add_ace group.admin command allow # allow all commands',
  'add_principal identifier.fivem:1234567 group.admin #serverowner',
  'add_ace qbcore.god command allow # Allow all commands',
  'add_principal qbcore.god group.admin # Allow gods access to the main admin group',
  '# add_principal identifier.license:aaaa qbcore.admin  (a comment, not a real line)',
  '',
  '# >>> CityHQ (managed by the app, edits here may be replaced)',
  'add_ace resource.qb-control command allow',
  'ensure qb-control',
  '# <<< CityHQ',
  '',
].join('\n');
const LICENSE = 'license:0123456789abcdef0123456789abcdef01234567';

test('your real server.cfg: the hand-written admin line is found and named', () => {
  const admins = parseAdmins(CFG);
  assert.equal(admins.length, 1);
  assert.deepEqual(admins[0], { identifier: 'fivem:1234567', principal: 'group.admin', role: 'full', label: 'serverowner', line: 3 });
});

test('making someone an admin writes one line in the CityHQ block, and nothing else changes', () => {
  const { text, removed } = setAdmin(CFG, LICENSE, 'admin', 'PlayerOne');
  assert.deepEqual(removed, []);
  const lines = text.split('\n');
  const end = lines.indexOf('# <<< CityHQ');
  assert.equal(lines[end - 1], `add_principal identifier.${LICENSE} qbcore.admin # PlayerOne`);
  assert.ok(text.includes('add_principal identifier.fivem:1234567 group.admin #serverowner'));
  assert.equal(parseAdmins(text).length, 2);
});

test('changing a role replaces the old line instead of adding a second one', () => {
  const once = setAdmin(CFG, LICENSE, 'mod', 'Fuzzy').text;
  const { text, removed } = setAdmin(once, LICENSE, 'god', 'Fuzzy');
  assert.deepEqual(removed, ['qbcore.mod']);
  const mine = parseAdmins(text).filter((a) => a.identifier === LICENSE);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, 'god');
});

test('a hand-written admin line can be replaced or removed', () => {
  const promoted = setAdmin(CFG, 'fivem:1234567', 'god', 'serverowner');
  assert.deepEqual(promoted.removed, ['group.admin']);
  assert.ok(!promoted.text.includes('group.admin #serverowner'));
  const { text, removed } = removeAdmin(CFG, 'FIVEM:1234567');
  assert.deepEqual(removed, ['group.admin']);
  assert.equal(parseAdmins(text).length, 0);
  // The group rules themselves are not admin lines, so they stay.
  assert.ok(text.includes('add_principal qbcore.god group.admin'));
});

test('nothing harmful can get into server.cfg or a server command through an ID or name', () => {
  for (const bad of ['license:abc qbcore.god', 'license:zz11', 'license:abc;quit', 'discord:12 34', 'ip:127.0.0.1', '', 'fivem:']) {
    assert.equal(VALID_IDENTIFIER.test(bad), false, bad);
  }
  assert.throws(() => setAdmin(CFG, 'license:abc;quit', 'admin', 'x'));
  assert.throws(() => setAdmin(CFG, LICENSE, 'superuser', 'x'));
  const { text } = setAdmin(CFG, LICENSE, 'admin', 'Evil\nquit # name');
  assert.ok(!text.includes('\nquit'));
  assert.ok(text.includes(`add_principal identifier.${LICENSE} qbcore.admin # Evil quit name`));
});

test('players from the database are grouped by person, with all their characters', () => {
  const rows = parseBatch([
    `${LICENSE}\tPlayerOne\tABC123\tAlex\tRivera\t1794300000`,
    `${LICENSE}\tPlayerOne\tDEF456\tTony\tMontana\t1794200000`,
    'license:fedcba9876543210fedcba9876543210fedcba98\tPlayerTwo\tGHI789\tNULL\tNULL\t1794100000',
    'not-a-license\tSomeone\tX\ta\tb\t1',
  ].join('\n'));
  const people = groupPlayers(rows, { [LICENSE]: { name: 'PlayerOne', ids: [LICENSE, 'fivem:1234567'], lastSeen: 1794400000000 } });
  assert.equal(people.length, 2);
  assert.equal(people[0].name, 'PlayerOne');
  assert.deepEqual(people[0].characters.map((c) => c.name), ['Alex Rivera', 'Tony Montana']);
  assert.ok(people[0].ids.includes('fivem:1234567'));
  assert.deepEqual(people[1].characters.map((c) => c.name), ['GHI789']);
});

test('history: readings fold into 5-minute buckets, keeping the busiest moment', () => {
  const state = { samples: [], bucket: null };
  const start = 1_800_000_000_000 - (1_800_000_000_000 % BUCKET_MS);
  addReading(state, start + 1000, 2);
  addReading(state, start + 60000, 5);
  addReading(state, start + 120000, 3);
  assert.equal(state.samples.length, 0);
  addReading(state, start + BUCKET_MS + 1000, 1);
  assert.deepEqual(state.samples, [[start, 5]]);
  const out = series(state.samples, start + 3 * BUCKET_MS, 4, BUCKET_MS);
  assert.deepEqual(out.map((p) => p.v), [5, null, null, null]);
});

test('history: joins, leaves, unique players and the daily peak', () => {
  const before = new Map([['a', { name: 'A' }], ['b', { name: 'B' }]]);
  const after = new Map([['b', { name: 'B' }], ['c', { name: 'C' }]]);
  const { joined, left } = diffPlayers(before, after);
  assert.deepEqual(joined.map((p) => p.name), ['C']);
  assert.deepEqual(left.map((p) => p.name), ['A']);
  const store = { days: {}, today: { day: '', ids: [] } };
  const now = new Date(2026, 10, 10, 20, 0).getTime();
  countDay(store, now, ['a', 'b'], 2);
  countDay(store, now + 60000, ['b', 'c'], 2);
  countDay(store, now + 120000, ['b'], 1);
  const day = store.days['2026-11-10'];
  assert.equal(day.unique, 3);
  assert.equal(day.peak, 2);
});

import { relocatedDataPath, relocateIni } from './relocate.js';
import { isRetryableDumpError } from './backups.js';
import {
  isBusy, moveFolderSafely, replaceFile, retry,
} from './retry.js';

const busyError = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const noWait = async () => {};

test('your real error: a file busy for a moment is saved on a later try', async () => {
  const tmpDir = (await import('node:fs')).mkdtempSync(path.join((await import('node:os')).tmpdir(), 'cityhq-'));
  const target = path.join(tmpDir, 'server.cfg');
  writeFileSync(target, 'old');
  let calls = 0;
  const flakyRename = async (from, to) => {
    calls++;
    if (calls <= 2) throw busyError(calls === 1 ? 'EPERM' : 'EBUSY');
    renameSync(from, to);
  };
  await replaceFile(target, 'new', { renameFn: flakyRename, wait: noWait });
  assert.equal(calls, 3);
  assert.equal(readFileSync(target, 'utf8'), 'new');
  assert.equal(existsSync(`${target}.qbctmp`), false);
  rmSync(tmpDir, { recursive: true, force: true });
});

test('a file that stays busy: a plain message, the original untouched, no leftover copy', async () => {
  const tmpDir = (await import('node:fs')).mkdtempSync(path.join((await import('node:os')).tmpdir(), 'cityhq-'));
  const target = path.join(tmpDir, 'server.cfg');
  writeFileSync(target, 'old');
  let calls = 0;
  const stuck = async () => { calls++; throw busyError(); };
  await assert.rejects(replaceFile(target, 'new', { renameFn: stuck, wait: noWait }), (err) => {
    assert.equal(err.status, 423);
    assert.match(err.message, /server\.cfg is open in another program/);
    return true;
  });
  assert.equal(calls, 8);
  assert.equal(readFileSync(target, 'utf8'), 'old');
  assert.equal(existsSync(`${target}.qbctmp`), false);
  rmSync(tmpDir, { recursive: true, force: true });
});

test('other save errors are not retried and keep their own message', async () => {
  let calls = 0;
  const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  await assert.rejects(retry(async () => { calls++; throw missing; }, { wait: noWait }), /ENOENT/);
  assert.equal(calls, 1);
  assert.equal(isBusy(busyError('EACCES')), true);
  assert.equal(isBusy(missing), false);
});

test('a resource folder that stays busy says which one and what to do', async () => {
  const stuck = async () => { throw busyError(); };
  await assert.rejects(moveFolderSafely('a', 'b', 'cfx-gomstyling-subpack-1', { renameFn: stuck, wait: noWait }), (err) => {
    assert.equal(err.status, 423);
    assert.match(err.message, /move cfx-gomstyling-subpack-1, because a file in it is open in another program/);
    return true;
  });
  // A move across drives is not "busy": it falls through so the caller can copy instead.
  const crossDrive = async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
  await assert.rejects(moveFolderSafely('a', 'b', 'x', { renameFn: crossDrive, wait: noWait }), (err) => err.code === 'EXDEV');
});

test('your real error: the backup before a database file retries when a table just changed', () => {
  const real = { stderr: 'mariadb-dump.exe: Error 1412: Table definition has changed, please retry transaction when dumping table `garage_interiors` at row: 0' };
  assert.equal(isRetryableDumpError(real), true);
  assert.equal(isRetryableDumpError({ stderr: 'mariadb-dump: Got error: 1205: Lock wait timeout exceeded' }), true);
  assert.equal(isRetryableDumpError({ stderr: 'mariadb-dump: Got error: 2003: Can\'t connect to MySQL server' }), false);
  assert.equal(isRetryableDumpError({ stderr: 'mariadb-dump: Got error: 1049: Unknown database' }), false);
});

// Both names the app had before it was called CityHQ: a server.cfg written by either keeps working.
for (const oldName of ['QBCore Control', 'FiveM Server Manager']) {
  test(`the app's lines in server.cfg keep working after the rename from ${oldName}`, () => {
    const before = [
      'sv_hostname "Test"',
      'ensure qb-core',
      '',
      `# >>> ${oldName} (managed by the app, edits here may be replaced)`,
      'add_ace resource.qb-control command allow',
      'ensure qb-control',
      '# qb-control-off: ensure some-resource',
      `# <<< ${oldName}`,
      '',
    ].join('\n');
    const after = ensureManagedBlock(before);
    const count = (s) => after.split('\n').filter((l) => l === s).length;
    assert.equal(count(BLOCK_START), 1);
    assert.equal(count(BLOCK_END), 1);
    assert.match(BLOCK_START, /CityHQ/);
    assert.ok(!after.includes(oldName));
    assert.equal(count('ensure qb-control'), 1);
    assert.equal(count('add_ace resource.qb-control command allow'), 1);
    // Resources the user turned off stay off, and the rest of the file is untouched.
    assert.equal(count('# qb-control-off: ensure some-resource'), 1);
    assert.match(after, /^sv_hostname "Test"\nensure qb-core\n/);
    // Running it again changes nothing.
    assert.equal(ensureManagedBlock(after), after);
  });
}
import { blockMessage, parseBlockedFiles } from './startup.js';

test('the server folder is found from wherever the app is installed', () => {
  // Wherever this copy of the app sits, an explicit choice wins.
  assert.equal(findRoot('C:\\anywhere', 'E:\\Servers\\Mine'), 'E:\\Servers\\Mine');
  // A place with no server above it finds nothing, instead of guessing.
  assert.equal(findRoot('C:\\Windows\\System32', '', null), null);
  // A downloaded copy, outside any server folder, uses the one chosen on the Welcome screen.
  assert.equal(findRoot('C:\\Windows\\System32', '', 'E:\\FXServer'), 'E:\\FXServer');
});

test('your real problem: a copy unzipped under a folder that has server\\FXServer.exe still shows the Welcome screen', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cityhq-walk-'));
  try {
    // Someone's FiveM server sits at <drive>\server, and CityHQ was unzipped in Downloads below it.
    mkdirSync(path.join(root, 'server'), { recursive: true });
    writeFileSync(path.join(root, 'server', 'FXServer.exe'), '');
    const app = path.join(root, 'Users', 'me', 'Downloads', 'CityHQ-windows', 'CityHQ', 'resources', 'app');
    mkdirSync(app, { recursive: true });
    assert.equal(findRoot(app, '', null), null, 'FXServer.exe alone isn\'t CityHQ\'s server folder');
    assert.equal(findRoot(app, '', 'E:\\Chosen'), 'E:\\Chosen', 'so the Welcome screen\'s choice is used');
    // A folder setup made (or the Welcome screen connected) has qbcontrol.json, and that still counts.
    writeFileSync(path.join(root, 'qbcontrol.json'), '{}');
    assert.equal(findRoot(app, '', null), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- other people's servers: layouts, the Welcome screen, processes ----
/** A made-up disk for the Welcome screen's folder reading: { 'C:\\a\\b.txt': 'text' }. */
function fakeDisk(files) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const fileMap = new Map(Object.entries(files).map(([p, t]) => [norm(p), t]));
  const dirMap = new Map();
  for (const p of Object.keys(files)) {
    let dir = path.dirname(path.resolve(p));
    let child = path.basename(path.resolve(p));
    let isFile = true;
    while (true) {
      const entry = dirMap.get(norm(dir)) || { dirs: new Set(), files: new Set() };
      (isFile ? entry.files : entry.dirs).add(child);
      dirMap.set(norm(dir), entry);
      const up = path.dirname(dir);
      if (up === dir) break;
      child = path.basename(dir);
      dir = up;
      isFile = false;
    }
  }
  return {
    exists: (p) => fileMap.has(norm(p)) || dirMap.has(norm(p)),
    read: (p) => { if (!fileMap.has(norm(p))) throw new Error('ENOENT'); return fileMap.get(norm(p)); },
    dirs: (p) => { const e = dirMap.get(norm(p)); if (!e) throw new Error('ENOENT'); return [...e.dirs]; },
    files: (p) => { const e = dirMap.get(norm(p)); if (!e) throw new Error('ENOENT'); return [...e.files]; },
  };
}

const QB_CFG = [
  'endpoint_add_tcp "0.0.0.0:30120"',
  'endpoint_add_udp "0.0.0.0:30120"',
  'set mysql_connection_string "mysql://root@localhost/qbcore?charset=utf8mb4"',
  'ensure qb-core',
  '',
].join('\n');

test('layouts: setup\'s own folder needs no settings, and anyone else\'s says where its parts are', () => {
  const none = () => false;
  const own = layoutOf('D:\\QBCore-Server', {}, (p) => p.endsWith('mariadbd.exe'));
  assert.equal(own.fxserverDir, 'D:\\QBCore-Server\\server');
  assert.equal(own.txDataDir, 'D:\\QBCore-Server\\txData');
  assert.equal(own.profile, 'default');
  assert.equal(own.managedDb, true, 'setup\'s private database is CityHQ\'s to run');
  assert.equal(own.txDataIsDefault, true);
  const theirs = layoutOf('C:\\FXServer', { fxserverDir: 'artifacts', txDataDir: 'E:\\data\\txData', profile: 'main', database: 'external' }, none);
  assert.equal(theirs.fxserverDir, 'C:\\FXServer\\artifacts', 'relative folders are inside the server folder');
  assert.equal(theirs.txDataDir, 'E:\\data\\txData');
  assert.equal(theirs.profile, 'main');
  assert.equal(theirs.managedDb, false);
  assert.equal(theirs.txDataIsDefault, false, 'txAdmin has to be told where this txData is');
  assert.equal(layoutOf('C:\\X', { profile: '..\\evil' }, none).profile, 'default', 'a profile name is never a path');
  assert.equal(layoutOf('C:\\X', {}, none).managedDb, false, 'no private database folder means it is the owner\'s own');
});

test('the game port comes from server.cfg\'s endpoint line', () => {
  assert.equal(gamePortOf(QB_CFG), 30120);
  assert.equal(gamePortOf('endpoint_add_tcp 0.0.0.0:30125 # mine'), 30125);
  assert.equal(gamePortOf('# endpoint_add_tcp "0.0.0.0:30125"\nsv_maxclients 48'), null, 'a line switched off with # doesn\'t count');
  assert.equal(gamePortOf(''), null);
});

test('processes: only FXServer from this server\'s folder counts, and only CityHQ\'s own database', () => {
  const rows = [
    { Name: 'FXServer.exe', ProcessId: 10, ParentProcessId: 1, ExecutablePath: 'C:\\FXServer\\server\\FXServer.exe', CommandLine: 'FXServer.exe' },
    { Name: 'FXServer.exe', ProcessId: 11, ParentProcessId: 10, ExecutablePath: 'C:\\FXServer\\server\\FXServer.exe', CommandLine: 'FXServer.exe +exec server.cfg' },
    { Name: 'FXServer.exe', ProcessId: 20, ParentProcessId: 1, ExecutablePath: 'C:\\Other\\server\\FXServer.exe', CommandLine: 'FXServer.exe' },
    { Name: 'mariadbd.exe', ProcessId: 30, ParentProcessId: 1, ExecutablePath: 'C:\\xampp\\mysql\\bin\\mysqld.exe' },
    { Name: 'mariadbd.exe', ProcessId: 31, ParentProcessId: 1, ExecutablePath: 'C:\\FXServer\\db\\mariadb\\bin\\mariadbd.exe' },
  ];
  const theirs = ownProcesses(rows, { fxserverDir: 'C:\\FXServer\\server', dbHome: 'C:\\FXServer\\db\\mariadb', managedDb: false });
  assert.equal(theirs.monitor.ProcessId, 10);
  assert.equal(theirs.game.ProcessId, 11);
  assert.equal(theirs.db, null, 'someone\'s own database is never treated as CityHQ\'s');
  const managed = ownProcesses(rows, { fxserverDir: 'C:\\FXServer\\server', dbHome: 'C:\\FXServer\\db\\mariadb', managedDb: true });
  assert.equal(managed.db.ProcessId, 31);
  assert.equal(ownProcesses(rows, { fxserverDir: 'C:\\FXServer\\serv', dbHome: 'X:\\none', managedDb: false }).monitor, null, 'a folder name that only starts the same doesn\'t count');
});

test('welcome: a usual existing server (FXServer and txData side by side, XAMPP database)', () => {
  const disk = fakeDisk({
    'C:\\FXServer\\server\\FXServer.exe': '',
    'C:\\FXServer\\txData\\default\\config.json': JSON.stringify({ server: { dataPath: 'C:/FXServer/txData/QBCore_ABC123.base/', cfgPath: 'server.cfg' } }),
    'C:\\FXServer\\txData\\QBCore_ABC123.base\\server.cfg': QB_CFG,
    'C:\\FXServer\\start.bat': 'cd server\r\nset TXHOST_TXA_PORT=40121\r\nFXServer.exe',
  });
  for (const picked of ['C:\\FXServer', 'C:\\FXServer\\server', 'C:\\FXServer\\txData']) {
    const r = inspectServerFolder(picked, disk);
    assert.equal(r.found, true, picked);
    assert.equal(r.root, 'C:\\FXServer', `${picked}: the main folder holds both parts`);
    assert.equal(r.fxserverDir, 'C:\\FXServer\\server');
    assert.equal(r.txDataDir, 'C:\\FXServer\\txData');
    assert.equal(r.dataPath, 'C:\\FXServer\\txData\\QBCore_ABC123.base');
    assert.equal(r.gamePort, 30120);
    assert.equal(r.txAdminPort, 40121, 'read from the start script');
    assert.deepEqual(r.database, { host: 'localhost', port: 3306, user: 'root', name: 'qbcore', hasPassword: false, managed: false });
    assert.equal(r.qbcore, true);
    assert.equal(r.cityhqMade, false);
    assert.deepEqual(r.problems, []);
  }
});

test('welcome: parts apart, txAdmin 7 settings, and plain-English problems', () => {
  const v7 = fakeDisk({
    'D:\\Artifacts\\FXServer.exe': '',
    'D:\\Artifacts\\txData\\default\\admins.json': '[]',
    'D:\\Artifacts\\txData\\default\\config.json': JSON.stringify({ fxRunner: { serverDataPath: 'E:\\city', cfgPath: 'E:\\city\\server.cfg' } }),
    'E:\\city\\server.cfg': 'sv_hostname "x"\nset mysql_connection_string "server=127.0.0.1;uid=fivem;password=secret;database=city"\n',
  });
  const r = inspectServerFolder('D:\\Artifacts', v7);
  assert.equal(r.fxserverDir, 'D:\\Artifacts');
  assert.equal(r.txDataDir, 'D:\\Artifacts\\txData', 'older txAdmin kept txData inside the FiveM folder');
  assert.equal(r.cfgPath, 'E:\\city\\server.cfg');
  assert.equal(r.database.user, 'fivem');
  assert.equal(r.database.hasPassword, true);
  assert.equal(JSON.stringify(r).includes('secret'), false, 'the database password never leaves the PC\'s server side');
  assert.ok(r.problems.some((p) => /no endpoint_add_tcp line/.test(p.text)));
  assert.ok(r.problems.some((p) => /doesn't look like a QBCore server/.test(p.text)));

  const fresh = inspectServerFolder('C:\\New', fakeDisk({ 'C:\\New\\server\\FXServer.exe': '' }));
  assert.equal(fresh.found, true);
  assert.equal(fresh.dataPath, null);
  assert.ok(fresh.problems.some((p) => /txAdmin hasn't been set up/.test(p.text)));
  assert.equal(fresh.txDataDir, 'C:\\New\\txData', 'txAdmin will make its data folder next to FiveM\'s');

  const nothing = inspectServerFolder('C:\\Games', fakeDisk({ 'C:\\Games\\readme.txt': '' }));
  assert.equal(nothing.found, false);
  assert.match(nothing.problems[0].text, /no FXServer\.exe/);

  const noDb = inspectServerFolder('C:\\FX', fakeDisk({
    'C:\\FX\\server\\FXServer.exe': '',
    'C:\\FX\\txData\\default\\config.json': JSON.stringify({ server: { dataPath: 'C:\\FX\\txData\\a.base' } }),
    'C:\\FX\\txData\\a.base\\server.cfg': 'endpoint_add_tcp "0.0.0.0:30120"\nensure qb-core\n',
  }));
  assert.ok(noDb.problems.some((p) => p.level === 'bad' && /no mysql_connection_string/.test(p.text)));
});

test('welcome: txData one folder down, or wherever the start script says', () => {
  const nested = inspectServerFolder('C:\\City', fakeDisk({
    'C:\\City\\artifacts\\FXServer.exe': '',
    'C:\\City\\data\\txData\\default\\config.json': JSON.stringify({ server: { dataPath: 'C:\\City\\data\\txData\\c.base' } }),
    'C:\\City\\data\\txData\\c.base\\server.cfg': QB_CFG,
  }));
  assert.equal(nested.txDataDir, 'C:\\City\\data\\txData');
  assert.equal(nested.root, 'C:\\City');
  const scripted = inspectServerFolder('C:\\Srv', fakeDisk({
    'C:\\Srv\\FXServer.exe': '',
    'C:\\Srv\\run.bat': 'set TXHOST_DATA_PATH=E:\\keep\\txData\r\nFXServer.exe',
    'E:\\keep\\txData\\default\\config.json': JSON.stringify({ server: { dataPath: 'E:\\keep\\txData\\s.base' } }),
    'E:\\keep\\txData\\s.base\\server.cfg': QB_CFG,
  }));
  assert.equal(scripted.txDataDir, 'E:\\keep\\txData');
  assert.equal(scripted.cfgPath, 'E:\\keep\\txData\\s.base\\server.cfg');
});

test('welcome: a server CityHQ\'s setup made is recognised as its own', () => {
  const r = inspectServerFolder('D:\\QBCore-Server', fakeDisk({
    'D:\\QBCore-Server\\qbcontrol.json': JSON.stringify({ gamePort: 30121, txAdminPort: 40120, databasePort: 3308 }),
    'D:\\QBCore-Server\\server\\FXServer.exe': '',
    'D:\\QBCore-Server\\db\\mariadb\\bin\\mariadbd.exe': '',
    // Your real layout: txAdmin 8 keeps admins.json at the top of txData, not in the profile.
    'D:\\QBCore-Server\\txData\\admins.json': '[]',
    'D:\\QBCore-Server\\txData\\default\\config.json': JSON.stringify({ server: { dataPath: 'D:/QBCore-Server/txData/Q.base/' } }),
    'D:\\QBCore-Server\\txData\\Q.base\\server.cfg': 'set mysql_connection_string "mysql://root@127.0.0.1:3308/q"\nensure qb-core\n',
  }));
  assert.equal(r.cityhqMade, true);
  assert.equal(r.root, 'D:\\QBCore-Server');
  assert.equal(r.txDataDir, 'D:\\QBCore-Server\\txData');
  assert.equal(r.gamePort, 30121, 'CityHQ forces its own game port, so server.cfg\'s line isn\'t needed');
  assert.equal(r.database.managed, true);
  assert.deepEqual(r.problems, []);
});

test('welcome: servers are found in the usual places, and start scripts and PINs are read', () => {
  const disk = fakeDisk({
    'C:\\FXServer\\server\\FXServer.exe': '',
    'C:\\Users\\me\\Desktop\\city\\artifacts\\FXServer.exe': '',
    'C:\\Windows\\fivem\\FXServer.exe': '',
    'C:\\FXServer\\txData\\default\\data\\resources\\deep\\FXServer.exe': '',
  });
  const found = findServerFolders({ starts: ['C:\\', 'C:\\Users\\me\\Desktop'], io: disk }).map((f) => f.toLowerCase()).sort();
  assert.deepEqual(found, ['c:\\fxserver\\server', 'c:\\users\\me\\desktop\\city\\artifacts'], 'Windows\' own folders and txData are skipped');
  assert.equal(txAdminPortIn('set TXHOST_TXA_PORT=40150'), 40150);
  assert.equal(txAdminPortIn('FXServer.exe +set txAdminPort 40160'), 40160);
  assert.equal(txAdminPortIn('FXServer.exe'), null);
  assert.equal(txAdminPinIn('[txAdmin] Use the PIN below to register:\n[txAdmin]  ┃ 4821 ┃\nmore'), '4821');
  assert.equal(txAdminPinIn('no pin here'), null);
  assert.equal(suggestNewFolder((p) => p === 'D:\\' || p === 'D:\\QBCore-Server'), 'D:\\QBCore-Server-2');
  assert.equal(suggestNewFolder(() => false), 'C:\\QBCore-Server');
});

test('your real bug: an undone fix in "What changed" carries the time it was undone', async () => {
  const { listChanges, registerFixLog } = await import('./history.js');
  registerFixLog({
    list: async () => [{ id: '9', at: 1000, label: 'Switch that line off', message: 'done', title: 'a problem', undone: true, undoneAt: 2000, undoable: false }],
    undo: async () => ({}),
  });
  const fix = (await listChanges()).find((c) => c.id === 'fix:9');
  assert.equal(fix.undoneAt, 2000, 'without it the page showed "undone Invalid Date"');
});

test('database tools: the download is checked against MariaDB\'s published list', () => {
  const list = 'aaa111  mariadb-12.3.3-winx64.msi\nBBB222 *mariadb-12.3.3-winx64.zip\n';
  assert.equal(checksumFor(list, 'mariadb-12.3.3-winx64.zip'), 'bbb222');
  assert.equal(checksumFor(list, 'mariadb-12.3.3-winx64.zip.asc'), null);
});

test('ports fall back to the defaults unless a sensible one is saved', () => {
  assert.equal(portOr(30120, 30121), 30120);
  assert.equal(portOr('40130', 40120), 40130);
  for (const bad of [undefined, null, '', 'abc', 0, -1, 70000, 3308.5]) assert.equal(portOr(bad, 3308), 3308, String(bad));
});

test('a copied server folder: database settings follow it to the new place', () => {
  const ini = '[mysqld]\ndatadir=D:/QBCore-Server/db/data\nport=3308\nlog-error=D:/QBCore-Server/logs/mariadb.err\n\n[client]\nport=3308\n';
  const moved = relocateIni(ini, 'E:\\Games\\MyServer');
  assert.match(moved, /^datadir=E:\/Games\/MyServer\/db\/data$/m);
  assert.match(moved, /^log-error=E:\/Games\/MyServer\/logs\/mariadb\.err$/m);
  assert.match(moved, /^port=3308$/m);
  // Nothing is rewritten when the folder has not moved, whatever the slashes or letter case.
  assert.equal(relocateIni(ini, 'D:\\QBCore-Server'), null);
  assert.equal(relocateIni(ini, 'd:\\qbcore-server'), null);
});

test('a copied server folder: txAdmin is pointed at the copy, never at a guess', () => {
  const there = new Set(['E:\\New\\txData\\QBCoreFramework_F179B3.base\\server.cfg']);
  const exists = (p) => there.has(p);
  assert.equal(relocatedDataPath('D:/QBCore-Server/txData/QBCoreFramework_F179B3.base/', 'E:\\New\\txData', exists), 'E:/New/txData/QBCoreFramework_F179B3.base/');
  // The saved folder still exists: leave it alone.
  assert.equal(relocatedDataPath('D:/Old/x.base/', 'E:\\New\\txData', () => true), null);
  // Nothing of that name here: leave it alone.
  assert.equal(relocatedDataPath('D:/Old/Other.base/', 'E:\\New\\txData', exists), null);
  assert.equal(relocatedDataPath('', 'E:\\New\\txData', exists), null);
});

test('your real block: Smart App Control stopping the server from loading a file', () => {
  const lines = [
    String.raw`Code Integrity determined that a process (\Device\HarddiskVolume12\QBCore-Server\server\FXServer.exe) attempted to load \Device\HarddiskVolume12\QBCore-Server\server\libnode22.dll that did not meet the Enterprise signing level requirements.`,
    String.raw`Code Integrity determined that a process (\Device\HarddiskVolume12\QBCore-Server\server\FXServer.exe) attempted to load \Device\HarddiskVolume12\QBCore-Server\server\libnode22.dll that did not meet the Enterprise signing level requirements or violated code integrity policy (Policy ID:{0283ac0f-fff1-49ae-ada1-8a933130cad6}).`,
    'Signature information for another event. Match using the Correlation Id.',
    // Your other server, in another folder, must never be blamed on this one.
    String.raw`Code Integrity determined that a process (\Device\HarddiskVolume3\Servers\Another Server\runtime\FXServer.exe) attempted to load \Device\HarddiskVolume3\Servers\Another Server\runtime\citizen-other.dll that did not meet the Enterprise signing level requirements.`,
  ];
  // The server's own path is given here so this test passes wherever the code is checked out.
  const mine = '\\qbcore-server\\server\\fxserver.exe';
  assert.deepEqual(parseBlockedFiles(lines, mine), ['libnode22.dll']);
  assert.deepEqual(parseBlockedFiles(lines.slice(2), mine), []);
  assert.deepEqual(parseBlockedFiles([], mine), []);
});

test('a block is explained with the setting to change', () => {
  const sac = blockMessage({ files: ['libnode22.dll'], smartAppControl: true });
  assert.match(sac, /Smart App Control is blocking the server/);
  assert.match(sac, /libnode22\.dll/);
  assert.match(sac, /Windows Security.*App & browser control.*Smart App Control settings.*turn it off/);
  assert.match(sac, /press Start/);
  const other = blockMessage({ files: ['a.dll', 'b.dll'], smartAppControl: false });
  assert.match(other, /A Windows security policy is blocking the server: it won't let a\.dll and b\.dll load/);
  assert.doesNotMatch(other, /Smart App Control/);
});

const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);

const RUNNING = { monitor: 1, game: 2, db: 3 };
const NOTHING = { monitor: null, game: null, db: null };
const NOTHING_CHANGED = { serverDown: false, databaseStopped: false, gameClosed: false };

/** Feeds readings 5 seconds apart and returns only the ones where something changed. */
function feed(readings, { start = 1_000_000, quietMs } = {}) {
  const watch = createProcessWatch(quietMs);
  return readings.map((reading, i) => {
    const { busy = false, ...ids } = reading;
    return watch(ids, { busy, now: start + i * 5000 });
  }).filter((r) => r && (r.serverDown || r.databaseStopped || r.gameClosed));
}

test('watchdog: one bad reading never counts as a crash', () => {
  assert.deepEqual(feed([RUNNING, RUNNING, NOTHING, RUNNING, RUNNING, RUNNING]), []);
  // Windows short of memory could also return one reading with only some processes.
  assert.deepEqual(feed([RUNNING, RUNNING, { ...RUNNING, game: null }, RUNNING, RUNNING]), []);
});

test('watchdog: a real outage is reported once', () => {
  const found = feed([RUNNING, RUNNING, NOTHING, NOTHING, NOTHING, NOTHING]);
  assert.deepEqual(found, [{ serverDown: true, databaseStopped: true, gameClosed: false }]);
});

test('watchdog: only the database stopping leaves the server alone', () => {
  const found = feed([RUNNING, RUNNING, { ...RUNNING, db: null }, { ...RUNNING, db: null }]);
  assert.deepEqual(found, [{ serverDown: false, databaseStopped: true, gameClosed: false }]);
});

test('watchdog: the game restarting under txAdmin is noticed once, however fast', () => {
  const slow = feed([RUNNING, RUNNING, { ...RUNNING, game: null }, { ...RUNNING, game: null }, { ...RUNNING, game: 9 }, { ...RUNNING, game: 9 }]);
  assert.deepEqual(slow, [{ serverDown: false, databaseStopped: false, gameClosed: true }]);
  const fast = feed([RUNNING, RUNNING, { ...RUNNING, game: 9 }, { ...RUNNING, game: 9 }, { ...RUNNING, game: 9 }]);
  assert.deepEqual(fast, [{ serverDown: false, databaseStopped: false, gameClosed: true }]);
});

test('watchdog: pressing Stop is never treated as a crash', () => {
  // The last reading taken while busy can still show the server, because readings lag a little.
  const found = feed([RUNNING, RUNNING, { ...RUNNING, busy: true }, { ...RUNNING, busy: true }, RUNNING, NOTHING, NOTHING, NOTHING, NOTHING, NOTHING], { quietMs: 12000 });
  assert.deepEqual(found, []);
});

test('watchdog: Stop finishing between two readings is still not a crash', () => {
  // Found on the real server: with nobody online, Stop took under 5 seconds and was never seen as busy.
  const start = 1_000_000;
  const watch = createProcessWatch(10000);
  const results = [];
  const reading = (ids, i, controlledAt = 0) => results.push(watch(ids, { controlledAt, now: start + i * 5000 }));
  reading(RUNNING, 0);
  reading(RUNNING, 1);
  const stoppedAt = start + 8000;
  [2, 3, 4, 5, 6, 7, 8].forEach((i) => reading(NOTHING, i, stoppedAt));
  assert.deepEqual(results.filter((r) => r && r.serverDown), []);
});

test('watchdog: a crash long after pressing Start is still caught', () => {
  const start = 1_000_000;
  const watch = createProcessWatch(10000);
  const results = [];
  [0, 1, 2, 3, 4, 5].forEach((i) => results.push(watch(RUNNING, { controlledAt: start, now: start + i * 5000 })));
  [6, 7].forEach((i) => results.push(watch(NOTHING, { controlledAt: start, now: start + i * 5000 })));
  assert.equal(results.filter((r) => r && r.serverDown).length, 1);
});

test('watchdog: a crash after the quiet time is still caught', () => {
  const found = feed([RUNNING, { ...RUNNING, busy: true }, RUNNING, RUNNING, RUNNING, RUNNING, RUNNING, NOTHING, NOTHING], { quietMs: 12000 });
  assert.deepEqual(found, [{ serverDown: true, databaseStopped: true, gameClosed: false }]);
});

test('watchdog: nothing to report when nothing changed', () => {
  const watch = createProcessWatch();
  assert.equal(watch(RUNNING, { now: 1 }), null);
  assert.equal(watch(RUNNING, { now: 2 }), null);
  assert.deepEqual(watch(RUNNING, { now: 3 }), NOTHING_CHANGED);
});

test('next restart: later today, tomorrow, and the soonest of several', () => {
  assert.equal(nextOccurrence(['06:00'], at(2026, 11, 9, 5, 0)), at(2026, 11, 9, 6, 0).getTime());
  assert.equal(nextOccurrence(['06:00'], at(2026, 11, 9, 7, 0)), at(2026, 11, 10, 6, 0).getTime());
  assert.equal(nextOccurrence(['18:00', '06:00'], at(2026, 11, 9, 7, 0)), at(2026, 11, 9, 18, 0).getTime());
  assert.equal(nextOccurrence(['06:00'], at(2026, 11, 9, 6, 0)), at(2026, 11, 10, 6, 0).getTime());
  assert.equal(nextOccurrence([], at(2026, 11, 9, 7, 0)), null);
});

test('next restart crosses month and year ends', () => {
  assert.equal(nextOccurrence(['06:00'], at(2026, 12, 31, 7, 0)), at(2027, 1, 1, 6, 0).getTime());
});

test('nightly backup: most recent slot, including after the PC was off', () => {
  assert.equal(lastOccurrence('05:00', at(2026, 11, 9, 6, 0)), at(2026, 11, 9, 5, 0).getTime());
  assert.equal(lastOccurrence('05:00', at(2026, 11, 9, 4, 59)), at(2026, 11, 8, 5, 0).getTime());
  assert.equal(lastOccurrence('05:00', at(2026, 11, 9, 5, 0)), at(2026, 11, 9, 5, 0).getTime());
});

test('countdown warnings fire once, and missed ones are not repeated', () => {
  assert.equal(warningDue(16 * 60000, []), null);
  assert.deepEqual(warningDue(15 * 60000, []), { minutes: 15, marks: [15] });
  assert.equal(warningDue(14 * 60000, [15]), null);
  assert.deepEqual(warningDue(5 * 60000, [15]), { minutes: 5, marks: [5] });
  assert.deepEqual(warningDue(30000, [15, 5]), { minutes: 1, marks: [1] });
  // Starting a countdown at 3 minutes skips the earlier warnings in one go.
  assert.deepEqual(warningDue(3 * 60000, []), { minutes: 5, marks: [15, 5] });
  assert.equal(warningDue(30000, [15, 5, 1]), null);
});

test('time validation', () => {
  for (const good of ['00:00', '06:30', '23:59']) assert.equal(isValidTime(good), true, good);
  for (const bad of ['24:00', '6:30', '12:60', 'noon', '', null, 600]) assert.equal(isValidTime(bad), false, String(bad));
});

const ctx = {
  folderOf: (n) => ({ 'um-ronin-loadingscreen': 'resources/[added]/um-ronin-loadingscreen', amzn_admin: 'resources/[added]/amzn_admin', energy_dj: 'resources/[added]/energy_dj', 'energy-sound': 'resources/[added]/energy-sound', 'qb-core': 'resources/[qb]/qb-core', 'qb-banking': 'resources/[qb]/qb-banking' }[n] || null),
  isInstalled: (n) => ['qb-core', 'qb-banking', 'amzn_admin', 'energy_dj', 'energy-sound', 'um-ronin-loadingscreen'].includes(n),
  resolveName: (p) => ['um-ronin-loadingscreen', 'amzn_admin', 'energy_dj', 'energy-sound', 'qb-core', 'qb-banking'].find((n) => n.startsWith(p)) || null,
  cfgLineOf: (n) => (n === 'hardcap' ? 41 : null),
};
const explain = (...lines) => explainLogLines(lines, ctx);
const allUrls = (item) => item.links.map((l) => l.url);

test('your real error: a Windows path in a config', () => {
  const [item, ...rest] = explain(
    '[    c-scripting-core] Creating script environments for um-ronin-loadingscreen',
    "[script:um-ronin-load] Error parsing script @um-ronin-loadingscreen/config.lua in resource um-ronin-loadingscreen: @um-ronin-loadingscreen/config.lua:56: invalid escape sequence near '\"C:\\U'",
    '[    c-scripting-core] Failed to load script config.lua.',
  );
  assert.equal(rest.length, 0, 'the follow-up "Failed to load" line is not a second problem');
  assert.match(item.title, /um-ronin-loadingscreen has a mistake in config\.lua, line 56/);
  assert.match(item.what, /backslash/);
  assert.ok(item.fix.some((s) => s.includes('C:/Users')), 'says how to fix it');
  assert.deepEqual(item.actions[0], { kind: 'open-file', label: 'Open config.lua at line 56', path: 'resources/[added]/um-ronin-loadingscreen/config.lua', line: 56 });
});

test('your real error: a missing database table', () => {
  const [item] = explain(
    '[   script:amzn_admin] SCRIPT ERROR: amzn_admin was unable to execute a query!',
    '[   script:amzn_admin] Query: SELECT * FROM admin_map_overlays ORDER BY id ASC',
    '[   script:amzn_admin] []',
    "[   script:amzn_admin] Table 'qbcoreframework_f179b3.admin_map_overlays' doesn't exist",
    '[   script:amzn_admin] > new StackDumpError (D:\\QBCore-Server\\server\\citizen/scripting/v8/main.js:416)',
    '[   script:amzn_admin] > logError (@oxmysql/dist/build.js:26864)',
  );
  assert.match(item.title, /amzn_admin needs a database table/);
  assert.match(item.what, /admin_map_overlays/);
  assert.equal(item.needsSqlFor, 'amzn_admin', 'offers to run its SQL file');
});

test('stack trace lines are never reported as problems of their own', () => {
  assert.equal(explain('[   script:amzn_admin] > new StackDumpError (main.js:416)').length, 0);
});

test('your real error: a script written for another framework', () => {
  const [item] = explain(
    '[    c-scripting-core] Creating script environments for energy_dj',
    '[    c-scripting-core] Failed to load script @vrp/lib/Utils.lua.',
  );
  assert.equal(item.severity, 'warning');
  assert.equal(item.resource, 'energy_dj');
  assert.match(item.title, /vRP/);
  assert.equal(item.actions[0].path, 'resources/[added]/energy_dj/fxmanifest.lua');
});

test('a truly missing dependency offers an install when the source is known', () => {
  const [item] = explain('[ citizen-server-impl] Could not find dependency ox_lib for resource my-script.');
  assert.match(item.title, /my-script needs ox_lib/);
  const install = item.actions.find((a) => a.kind === 'install');
  assert.equal(install.url, 'https://github.com/overextended/ox_lib/releases/latest/download/ox_lib.zip');
});

test('an unknown dependency never invents a download', () => {
  const [item] = explain('[ citizen-server-impl] Could not find dependency some-paid-thing for resource my-script.');
  assert.equal(item.actions.find((a) => a.kind === 'install'), undefined);
  assert.ok(item.fix[0].includes('install notes'));
});

test('files listed but missing are grouped per resource', () => {
  const items = explain(
    '[resources:energy-sou] Warning: could not find server_script `server/api.lua` (defined in fxmanifest.lua:19)',
    '[resources:energy-sou] Warning: could not find file `a.meta` (defined in fxmanifest.lua:22)',
  );
  assert.equal(items.length, 1);
  assert.match(items[0].title, /energy-sound lists files.*2 found/);
  assert.equal(items[0].actions[0].line, 19);
});

test('runtime errors get specific hints and a link to the line', () => {
  const [qb] = explain("[script:qb-banking] SCRIPT ERROR: @qb-banking/server.lua:12: attempt to index a nil value (global 'QBCore')");
  assert.match(qb.what, /QBCore before it was available/);
  assert.equal(qb.actions[0].line, 12);
  assert.ok(allUrls(qb).includes('https://qbcore.org/docs/qb-core/core-object'));
  const [call] = explain("[script:qb-banking] SCRIPT ERROR: @qb-banking/server.lua:9: attempt to call a nil value (field 'GetThing')");
  assert.match(call.what, /GetThing/);
});

test('every problem has what, how to fix, a doc and a video search', () => {
  const samples = [
    "[script:x] Error parsing script @qb-core/a.lua in resource qb-core: @qb-core/a.lua:1: unexpected symbol near ','",
    '[c-scripting-core] Failed to load script @missing-thing/a.lua.',
    '[c-scripting-core] Failed to load script a.lua.',
    '[resources:qb-core] Warning: could not find file `a` (defined in fxmanifest.lua:1)',
    '[script:qb-core] SCRIPT ERROR: qb-core was unable to execute a query!',
    '[script:qb-core] No such export GetThing in resource other-thing',
    '[x] Could not find dependency zed for resource qb-core.',
    "[x] Couldn't start resource qb-core.",
    "[x] Couldn't find resource hardcap.",
    '[script:qb-core] You lack the required entitlement to use qb-core',
    '[script:oxmysql] connect ECONNREFUSED 127.0.0.1:3308',
    '[svadhesive] invalid license key',
    '[script:qb-core] SCRIPT ERROR: @qb-core/a.lua:1: something odd',
    '[script:qb-core] SCRIPT ERROR: some other failure',
    '[resources:qb-core] Asset qb-core/a.ydr uses 64.0 MiB of virtual memory. Oversized assets can and WILL lead to streaming issues',
  ];
  for (const line of samples) {
    const [item] = explain(line);
    assert.ok(item, `explains: ${line}`);
    assert.ok(item.title && item.what, line);
    assert.ok(item.fix.length > 0, `has fix steps: ${line}`);
    assert.ok(item.links.some((l) => l.kind === 'doc'), `has a doc: ${line}`);
    assert.ok(item.links.some((l) => l.kind === 'video' && l.url.startsWith('https://www.youtube.com/results?search_query=')), `has videos: ${line}`);
  }
});

test('search links never contain anything from the log itself', () => {
  const [item] = explain(
    '[script:x] SCRIPT ERROR: x was unable to execute a query!',
    "[script:x] Query: SELECT * FROM players WHERE license = 'license:SECRET123'",
    "[script:x] Table 'db.players' doesn't exist",
  );
  for (const url of allUrls(item)) assert.ok(!url.includes('SECRET123'), url);
  const [escapeItem] = explain("[script:x] Error parsing script @qb-core/a.lua in resource qb-core: @qb-core/a.lua:1: invalid escape sequence near '\"C:\\Users\\Private'");
  for (const url of allUrls(escapeItem)) assert.ok(!/Private|Users/.test(decodeURIComponent(url)), url);
});

test('a database error that later recovered is not reported', () => {
  assert.equal(explain(
    '[script:oxmysql] Error -4078: connect ECONNREFUSED 127.0.0.1:3308',
    '[script:oxmysql] [12.3.3-MariaDB] Database server connection established!',
  ).length, 0);
  assert.equal(explain('[script:oxmysql] Error -4078: connect ECONNREFUSED 127.0.0.1:3308')[0].rule, 'database-connect');
});

test('many oversized files become one card that names the resources', () => {
  const items = explain(
    '[resources:qb-core] Asset qb-core/a.ydr uses 64.0 MiB of virtual memory. Oversized assets',
    '[resources:qb-core] Asset qb-core/b.ydr uses 64.0 MiB of virtual memory. Oversized assets',
    '[resources:qb-banking] Asset qb-banking/c.ydr uses 64.0 MiB of virtual memory. Oversized assets',
  );
  assert.equal(items.length, 1);
  assert.match(items[0].title, /2 resources have very large game files/);
  assert.match(items[0].what, /qb-core, qb-banking/);
  assert.equal(items[0].count, 3);
});

test('a cut-off channel name is settled by the line that follows', () => {
  const ambiguous = { ...ctx, resolveName: () => null };
  const [item] = explainLogLines([
    '[resources:energy-sou] Warning: could not find server_script `server/api.lua` (defined in fxmanifest.lua:19)',
    '[resources] Started resource energy-sound (1 warning)',
  ], ambiguous);
  assert.equal(item.resource, 'energy-sound');
  assert.match(item.title, /^energy-sound lists files/);
});

test('normal lines are not problems', () => {
  for (const line of [
    '[resources] Started resource prison_main (1 warning)',
    '[citizen-server-impl] server thread hitch warning: timer interval of 167 milliseconds',
    '[script:um-ronin-mult] Warning: Webhook link is missing: playgame',
    '[script:oxmysql] [12.3.3-MariaDB] Database server connection established!',
  ]) assert.equal(explain(line).length, 0, line);
});

test('resource-level missing dependency uses the same format', () => {
  const item = explainMissingDependency('qb-core', 'qb-target', ctx);
  assert.equal(item.severity, 'error');
  assert.ok(item.actions.some((a) => a.kind === 'install'));
  assert.ok(item.links.some((l) => l.kind === 'video'));
});

test('Lua mistakes are explained plainly', () => {
  assert.match(luaPlain("unexpected symbol near ','"), /does not belong/);
  assert.match(luaPlain("'end' expected (to close 'function' at line 3) near <eof>"), /closing "end"/);
  assert.match(luaPlain('unfinished string near \'"abc\''), /quote/);
  assert.match(luaPlain('anything else'), /could not be understood/);
});

test('catalog only answers for known names, ignoring case', () => {
  assert.equal(findInstallSource('PolyZone').url, 'https://github.com/mkafrin/PolyZone');
  assert.equal(findInstallSource('require').resource, 'ox_lib');
  assert.equal(findInstallSource('made-up-thing'), null);
});

test('GitHub links, including latest-release downloads', () => {
  assert.equal(parseGithubUrl('https://github.com/overextended/ox_lib/releases/latest/download/ox_lib.zip').download, 'https://github.com/overextended/ox_lib/releases/latest/download/ox_lib.zip');
  assert.equal(parseGithubUrl('https://github.com/a/b/releases/download/v1/b.zip').download, 'https://github.com/a/b/releases/download/v1/b.zip');
  assert.equal(parseGithubUrl('https://github.com/a/b').download, 'https://codeload.github.com/a/b/zip/HEAD');
});


// ---- Built-in FiveM resources (chat, monitor, yarn, webpack) on the Resources page ----

const SYSTEM = [
  { name: 'chat', description: 'Provides baseline chat functionality using a NUI-based interface.', version: '', author: '' },
  { name: 'monitor', description: 'The official FiveM/RedM server web/in-game management platform.', version: '', author: '' },
  { name: 'yarn', description: 'Builds resources with yarn.', version: '', author: '' },
  { name: 'webpack', description: 'Builds resources with webpack.', version: '', author: '' },
];
const CHAT_ON = ['set resources_useSystemChat true', 'ensure chat', 'ensure some-chat-replacement', ''].join('\r\n');
const byName = (items) => Object.fromEntries(items.map((i) => [i.name, i]));

test('settings: the last line wins, quotes and comments are ignored, and case does not matter', () => {
  const cfg = ['set resources_useSystemChat true', 'sets sv_projectName "My City" # shown in the list', 'SET Resources_UseSystemChat false', '# set resources_useSystemChat true', ''].join('\n');
  assert.equal(readConvar(cfg, 'resources_useSystemChat'), 'false');
  assert.equal(readConvar(cfg, 'sv_projectName'), 'My City');
  assert.equal(readConvar(cfg, 'not_there'), null);
  assert.equal(convarOn('true'), true);
  assert.equal(convarOn('1'), true);
  assert.equal(convarOn('false'), false);
  assert.equal(convarOn(null), false);
});

test('settings: changing one keeps its line, set type and comment; a missing one goes in the app block', () => {
  const changed = setConvar(['setr resources_useSystemChat true # was on', 'ensure chat', ''].join('\r\n'), 'resources_useSystemChat', 'false');
  assert.equal(changed.split('\r\n')[0], 'setr resources_useSystemChat false # was on');
  assert.ok(changed.includes('\r\n'), 'Windows line endings are kept');
  const added = setConvar(CFG, 'resources_useSystemChat', 'true');
  const lines = added.split('\n');
  assert.ok(lines.indexOf('set resources_useSystemChat true') > lines.indexOf(BLOCK_START));
  assert.ok(lines.indexOf('set resources_useSystemChat true') < lines.indexOf(BLOCK_END));
  assert.equal(readConvar(added, 'resources_useSystemChat'), 'true');
});

test('built-in resources are listed in their own group, without a folder, and cannot be removed', () => {
  const items = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg: CHAT_ON, live: new Map([['chat', { state: 'started' }], ['monitor', { state: 'started' }]]) }));
  assert.deepEqual(Object.keys(items).sort(), ['chat', 'monitor', 'webpack', 'yarn']);
  for (const item of Object.values(items)) {
    assert.equal(item.category, BUILT_IN_CATEGORY);
    assert.equal(item.folder, null);
    assert.equal(item.canRemove, false);
    assert.equal(item.builtIn, true);
  }
  assert.equal(items.chat.state, 'started');
  assert.equal(items.yarn.state, 'stopped', 'not running is shown as stopped, not unknown');
  assert.equal(items.chat.boot.enabled, true);
  assert.deepEqual(items.chat.setting, { key: 'resources_useSystemChat', on: true });
  assert.equal(items.yarn.setting, null);
});

test('txAdmin (monitor) stays locked on and says why', () => {
  const { monitor } = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg: CHAT_ON, live: null }));
  assert.equal(monitor.canStop, false);
  assert.match(monitor.lockedReason, /txAdmin/);
  assert.equal(monitor.state, 'offline');
  assert.equal(monitor.boot.enabled, true, 'txAdmin always starts it, with no server.cfg line');
  assert.equal(monitor.boot.source, 'always');
});

test('built-in chat only starts at boot while resources_useSystemChat is on', () => {
  const off = CHAT_ON.replace('set resources_useSystemChat true', 'set resources_useSystemChat false');
  const { chat } = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg: off, live: new Map() }));
  assert.equal(chat.boot.enabled, false);
  assert.deepEqual(chat.setting, { key: 'resources_useSystemChat', on: false });
  assert.equal(chat.problem, null, 'off at boot and stopped is not a problem');
});

test('a running-at-boot built-in that is stopped is flagged', () => {
  const { chat } = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg: CHAT_ON, live: new Map() }));
  assert.equal(chat.problem, 'Should be running but is stopped');
});

test('a folder in resources/ with the same name replaces the built-in one', () => {
  const items = byName(builtInItems({ system: SYSTEM, diskNames: new Set(['chat']), cfg: CHAT_ON, live: null }));
  assert.equal(items.chat, undefined);
  assert.ok(items.yarn);
});

test('turning built-in chat off and on again restores the same server.cfg lines', () => {
  // Off: the start line is kept as an off-marker and the setting turns false.
  let cfg = setConvar(removeBootLine(CHAT_ON, 'chat'), 'resources_useSystemChat', 'false');
  let { chat } = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg, live: null }));
  assert.equal(chat.boot.enabled, false);
  assert.equal(chat.boot.turnedOffByApp, true);
  assert.equal(parseBoot(cfg).names.has('some-chat-replacement'), true, 'the replacement chat keeps starting');
  // On: the same line comes back in place, not a second copy in the app block.
  cfg = setConvar(addBootLine(cfg, 'chat'), 'resources_useSystemChat', 'true');
  assert.equal(cfg, CHAT_ON);
  ({ chat } = byName(builtInItems({ system: SYSTEM, diskNames: new Set(), cfg, live: null })));
  assert.equal(chat.boot.enabled, true);
});

test('built-in resources are read from FXServer\'s system_resources folder', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cityhq-system-'));
  try {
    mkdirSync(path.join(dir, 'chat'));
    writeFileSync(path.join(dir, 'chat', 'fxmanifest.lua'), "fx_version 'cerulean'\ndescription 'Provides baseline chat functionality.'\n");
    mkdirSync(path.join(dir, 'not-a-resource'));
    const found = await scanSystem(dir);
    assert.deepEqual(found.map((f) => f.name), ['chat']);
    assert.equal(found[0].description, 'Provides baseline chat functionality.');
    assert.deepEqual(await scanSystem(path.join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Resources another one stands in for (provides), like qb-clothing and um-clothing-qb ----

const DISK = [
  { name: 'qb-clothing', provides: [] },
  { name: 'um-clothing-qb', provides: ['illenium-appearance', 'qb-clothing'] },
  { name: 'qb-multicharacter', provides: [] },
  { name: 'um-ronin-multicharacter', provides: ['qb-multicharacter', 'um-multicharacter'] },
  { name: 'oxmysql', provides: ['mysql-async', 'ghmattimysql'] },
  { name: 'self-named', provides: ['self-named'] },
];

test('your real setup: qb-clothing is replaced by um-clothing-qb while it runs', () => {
  // FiveM reports qb-clothing as started because it answers for um-clothing-qb.
  const live = new Map([['qb-clothing', { state: 'started' }], ['um-clothing-qb', { state: 'started' }], ['oxmysql', { state: 'started' }]]);
  const map = replacementsOf(DISK, live);
  assert.equal(map.get('qb-clothing'), 'um-clothing-qb');
  assert.equal(map.get('mysql-async'), 'oxmysql');
  assert.equal(map.has('um-clothing-qb'), false);
});

test('a stand-in that is not running replaces nothing, so the original shows its own state', () => {
  const live = new Map([['qb-clothing', { state: 'started' }], ['um-clothing-qb', { state: 'stopped' }]]);
  assert.equal(replacementsOf(DISK, live).has('qb-clothing'), false);
  assert.equal(replacementsOf(DISK, live).has('qb-multicharacter'), false, 'um-ronin-multicharacter is not in the live list');
});

test('a resource that names itself in provides does not replace itself, and nothing is known offline', () => {
  const live = new Map([['self-named', { state: 'started' }]]);
  assert.equal(replacementsOf(DISK, live).has('self-named'), false);
  assert.equal(replacementsOf(DISK, null).size, 0);
});

// ---- Real documentation links for problem tips ----

const found = (...pairs) => pairs.map(([url, file]) => ({ url, file }));
const OTHERS = ['qb-core', 'qb-phone', 'qb-target', 'jg-advancedgarages', 'pma-voice', 'oxmysql'];

test('docs: a docs page that names the script wins', () => {
  const links = found(
    ['https://docs.jgscripts.com/advanced-garages/installation', 'README.md'],
    ['https://docs.jgscripts.com/advanced-garages/interaction-methods', 'config/config.lua'],
  );
  assert.equal(bestLink(links, 'jg-advancedgarages', OTHERS), 'https://docs.jgscripts.com/advanced-garages/installation');
});

test('docs: a readme that only links to other scripts it needs gives no docs', () => {
  const links = found(['https://github.com/qbcore-framework/qb-core', 'README.md'], ['https://github.com/qbcore-framework/qb-phone', 'README.md']);
  assert.equal(bestLink(links, 'qb-houses', OTHERS), null);
});

test('docs: a passing mention of another product does not count (pma-voice and vMenu)', () => {
  const links = found(['https://docs.vespura.com/vmenu/faq/#q-how-do-i-disable-voice-chat', 'README.md']);
  assert.equal(bestLink(links, 'pma-voice', OTHERS), null);
});

test('docs: a product docs site linked twice in the readme counts, even under another name', () => {
  const links = found(
    ['https://example-design.com/docs/some-admin-pro/getting-started/installation', 'README.md'],
    ['https://example-design.com/docs/some-admin-pro/getting-started/configuration', 'README.md'],
  );
  assert.equal(bestLink(links, 'abc_admin', OTHERS), 'https://example-design.com/docs/some-admin-pro/getting-started/installation');
});

test('docs: a link in a documentation file counts, and badges and downloads never do', () => {
  assert.equal(bestLink(found(['https://docs.example.org/scripts/animation-menu', 'documentation.md']), 'xy-animmenu', OTHERS), 'https://docs.example.org/scripts/animation-menu');
  assert.deepEqual(docLinksIn('see https://img.shields.io/github/downloads/a/oxmysql/total and https://github.com/a/b/releases/latest/download/b.zip'), []);
  assert.equal(bestLink(found(['https://github.com/someone/oxmysql.git', 'fxmanifest.lua']), 'oxmysql', OTHERS), 'https://github.com/someone/oxmysql.git');
});

test('docs: an author\'s GitBook site keeps its space name', () => {
  assert.equal(siteOf('https://prompt-studio.gitbook.io/prompt-studio/maps/sandy'), 'https://prompt-studio.gitbook.io/prompt-studio');
  assert.equal(siteOf('https://docs.picklemods.com/paid-resources/casinos/installation'), 'https://docs.picklemods.com/');
});

test('docs: the index uses own links, the author\'s site, and checked QBCore pages', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cityhq-docs-'));
  const make = (name, files = {}) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
    return { name, dir, provides: [], dependencies: [], categories: [] };
  };
  try {
    const disk = [
      make('studio_church', { 'readme.txt': 'Docs: https://studio-maps.gitbook.io/studio-maps' }),
      make('studio_beach'),
      make('glow_dj'),
      make('zz_glow_mapdata', { 'readme.txt': 'More: https://glow-fivem.gitbook.io/glow-mlos/maps' }),
      make('qb-realthing'),
      make('qb-made-up'),
      make('lonely-script'),
    ];
    const asked = [];
    const fetcher = async (url) => { asked.push(url); return { status: url.endsWith('/qb-realthing') ? 200 : 404 }; };
    const memory = new Map();
    const cache = { get: async (u) => memory.get(u), set: async (u, v) => { memory.set(u, v); } };
    const { index } = await buildDocIndex(disk, { fetcher, cache });
    assert.equal(index.get('studio_church').source, 'author', 'a general docs site that does not name the script is labelled as the author\'s');
    assert.equal(index.get('studio_church').url, 'https://studio-maps.gitbook.io/studio-maps');
    assert.equal(index.get('studio_beach').url, 'https://studio-maps.gitbook.io/studio-maps', 'learned from the author\'s other script');
    assert.equal(index.get('glow_dj').url, 'https://glow-fivem.gitbook.io/glow-mlos', 'matched by the site\'s own name');
    assert.equal(index.get('qb-realthing').url, 'https://qbcore.org/docs/qbcore-resources/qb-realthing');
    assert.equal(index.get('qb-made-up').url, QB_HOME, 'a page that does not exist falls back to the QBCore home');
    assert.equal(index.has('lonely-script'), false);
    const before = asked.length;
    await buildDocIndex(disk, { fetcher, cache });
    assert.equal(asked.length, before, 'each page is only checked once');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs: tips lead with the script\'s own docs, never YouTube, and search only when there are none', () => {
  const problem = {
    resource: 'some-script',
    raw: '[script:some-script] error',
    links: [
      { kind: 'doc', label: 'FiveM docs: the fxmanifest file', url: 'https://docs.fivem.net/a' },
      { kind: 'doc', label: 'FiveM docs: how resources work', url: 'https://docs.fivem.net/b' },
      { kind: 'video', label: 'Find videos on YouTube', url: 'https://www.youtube.com/results?search_query=x' },
      { kind: 'forum', label: 'Search the FiveM forum', url: 'https://forum.cfx.re/search?q=x' },
    ],
  };
  const withDocs = withDocLinks(problem, new Map([['some-script', { url: 'https://docs.example.com/some-script', label: 'some-script documentation' }]]));
  assert.deepEqual(withDocs.map((l) => l.url), ['https://docs.example.com/some-script', 'https://docs.fivem.net/a']);
  const without = withDocLinks(problem, new Map());
  assert.deepEqual(without.map((l) => l.kind), ['doc', 'doc', 'forum']);
  assert.equal(without[2].url, 'https://forum.cfx.re/search?q=some-script', 'the search uses only the script\'s name');
  assert.ok(!without.some((l) => l.kind === 'video'));
});

test('docs: a docs page named inside the error itself comes first', () => {
  const problem = {
    resource: 'phone-x',
    raw: '[script:phone-x] [ERROR] API keys are not set. Visit https://docs.example.net/phone/configure-apikeys#keys to get them',
    links: [{ kind: 'video', label: 'v', url: 'https://www.youtube.com/x' }],
  };
  const links = withDocLinks(problem, new Map());
  assert.equal(links[0].url, 'https://docs.example.net/phone/configure-apikeys#keys');
  assert.ok(!links.some((l) => l.kind === 'forum'), 'no search when the error names its own docs');
});

test('a missing script\'s GitHub page is found in the files of the script that needs it', () => {
  const links = found(['https://github.com/SomeDev/x_bridge', 'fxmanifest.lua'], ['https://github.com/overextended/ox_lib', 'fxmanifest.lua']);
  assert.equal(repoFor('x_bridge', links), 'https://github.com/SomeDev/x_bridge');
  assert.equal(repoFor('x_jobcore', links), null);
});

// ---- One-click fixes ----

const ORDER_CFG = [
  'ensure ox_lib',
  'ensure qb-core',
  'ensure [qb]',
  'ensure [standalone]',
  'ensure some-script',
  'ensure um-clothing-qb',
  'ensure codem-chat',
  '',
].join('\r\n');

test('your real fix: um-clothing-qb moves to just before [qb], and undo puts it back exactly', () => {
  const moved = startBefore(ORDER_CFG, 'um-clothing-qb', 'qb-houses', ['[qb]']);
  assert.equal(moved.changed, true);
  const lines = moved.text.split('\r\n');
  assert.deepEqual(lines.slice(1, 5), ['ensure qb-core', startBeforeNote('um-clothing-qb', 'qb-houses'), 'ensure um-clothing-qb', 'ensure [qb]']);
  assert.equal(lines.filter((l) => l === 'ensure um-clothing-qb').length, 1);
  assert.equal(moved.anchor, 'ensure some-script');
  assert.equal(undoStartBefore(moved.text, 'um-clothing-qb', 'qb-houses', moved.anchor), ORDER_CFG);
});

test('the start-order fix does nothing when the order is already right, and refuses missing lines', () => {
  assert.equal(startBefore(ORDER_CFG, 'qb-core', 'qb-houses', ['[qb]']).changed, false);
  assert.throws(() => startBefore(ORDER_CFG, 'not-there', 'qb-houses', ['[qb]']), /no line that starts not-there/);
  assert.throws(() => undoStartBefore(ORDER_CFG, 'um-clothing-qb', 'qb-houses', 'ensure some-script'), /can't be undone automatically/);
});

test('the SQL file that creates a missing table is picked first', () => {
  const files = [
    { file: 'sql/update.sql', text: 'ALTER TABLE player_outfits ADD COLUMN x INT;' },
    { file: 'sql/install.sql', text: 'CREATE TABLE IF NOT EXISTS `player_outfit_codes` (\n `id` int(11) NOT NULL\n);' },
  ];
  assert.deepEqual(sqlFilesCreating('player_outfit_codes', files), ['sql/install.sql']);
  assert.deepEqual(sqlFilesCreating('player_outfits', files), []);
});

const STATE_DISK = [
  { name: 'qb-houses', categories: ['[qb]'], dependencies: ['qb-clothing'], provides: [] },
  { name: 'qb-clothing', categories: ['[disabled]'], dependencies: [], provides: [] },
  { name: 'um-clothing-qb', categories: ['[added]'], dependencies: [], provides: ['qb-clothing'] },
  { name: 'some-script', categories: ['[added]'], dependencies: [], provides: [] },
  { name: 'off-script', categories: ['[added]'], dependencies: [], provides: [] },
];
const STATE_CFG = ['ensure [qb]', 'ensure um-clothing-qb', 'ensure some-script', ''].join('\n');

test('your real problem: qb-houses stopped at startup is explained, with the start-order fix', () => {
  const live = new Map([['qb-houses', { state: 'stopped' }], ['qb-clothing', { state: 'started' }], ['um-clothing-qb', { state: 'started' }], ['some-script', { state: 'started' }], ['off-script', { state: 'stopped' }]]);
  const items = stateProblems({ disk: STATE_DISK, cfg: STATE_CFG, live });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'stopped-by-replacement:qb-houses:qb-clothing');
  assert.deepEqual(items[0].actions[0].fix, { type: 'start-before', provider: 'um-clothing-qb', dependent: 'qb-houses', original: 'qb-clothing' });
});

test('a script set to start that isn\'t running gets a Start button, unless another problem already explains it', () => {
  const live = new Map([['qb-houses', { state: 'started' }], ['um-clothing-qb', { state: 'started' }], ['some-script', { state: 'stopped' }], ['off-script', { state: 'stopped' }]]);
  let items = stateProblems({ disk: STATE_DISK, cfg: STATE_CFG, live });
  assert.deepEqual(items.map((i) => i.id), ['not-running:some-script'], 'off-script is off at boot, so it is left alone');
  assert.deepEqual(items[0].actions[0].fix, { type: 'start', name: 'some-script' });
  items = stateProblems({ disk: STATE_DISK, cfg: STATE_CFG, live, existing: new Set(['start-failed:some-script']) });
  assert.equal(items.length, 0);
  assert.deepEqual(stateProblems({ disk: STATE_DISK, cfg: STATE_CFG, live: null }), [], 'nothing is guessed while the server is off');
});

// ---- Rebuilding an empty table made with another script's layout ----

const CLOTHING_SQL = [
  'CREATE TABLE IF NOT EXISTS `skins_x` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `citizenid` varchar(255) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=latin1;',
  '',
  'CREATE TABLE IF NOT EXISTS `outfits_x` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  "  `outfitname` varchar(50) NOT NULL DEFAULT '0',",
  '  `props` varchar(1000) DEFAULT NULL,',
  '  `components` varchar(1500) DEFAULT NULL,',
  '  PRIMARY KEY (`id`),',
  '  UNIQUE KEY `name_per_model` (`outfitname`,`props`),',
  '  KEY `outfitname` (`outfitname`)',
  ') ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;',
  '',
  'CREATE TABLE IF NOT EXISTS `outfit_codes_x` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `outfitid` int(11) NOT NULL,',
  "  `code` varchar(50) NOT NULL DEFAULT '',",
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB;',
].join('\n');

test('the CREATE TABLE for one table is cut out whole, up to its semicolon', () => {
  const statement = createStatementFor('outfits_x', CLOTHING_SQL);
  assert.ok(statement.startsWith('CREATE TABLE IF NOT EXISTS `outfits_x` ('));
  assert.ok(statement.endsWith('DEFAULT CHARSET=utf8mb4'));
  assert.ok(!statement.includes('outfit_codes_x'));
  assert.equal(createStatementFor('not_there', CLOTHING_SQL), null);
});

test('only real columns are read from it, not keys', () => {
  assert.deepEqual(columnsOf(createStatementFor('outfits_x', CLOTHING_SQL)), ['id', 'outfitname', 'props', 'components']);
});

test('your real error: "Unknown column components" leads to the table that defines it', () => {
  const files = [{ file: 'sql/install.sql', text: CLOTHING_SQL }];
  assert.deepEqual(tablesDefining('components', files, 'INSERT INTO outfits_x (citizenid, components) VALUES (?, ?)'), [{ table: 'outfits_x', file: 'sql/install.sql' }]);
  assert.deepEqual(tablesDefining('code', files).map((t) => t.table), ['outfit_codes_x'], 'po.code is read as the column "code"');
  // Two tables have "id": the one the failed query names wins.
  assert.deepEqual(tablesDefining('id', files, 'SELECT * FROM outfit_codes_x WHERE id = 1').map((t) => t.table), ['outfit_codes_x']);
  assert.equal(tablesDefining('id', files).length, 3, 'when the query names none, all are returned and no fix is offered');
});

// ---- Keeping the PC awake while the server runs ----

test('keep-awake: nothing is held while the server is off or the switch is off', () => {
  assert.equal(awakeMode({ enabled: true, screenOnBattery: true, serverRunning: false, onBattery: true }), 'off');
  assert.equal(awakeMode({ enabled: false, screenOnBattery: true, serverRunning: true, onBattery: true }), 'off');
});

test('keep-awake: plugged in, the PC stays awake and the screen may turn off', () => {
  assert.equal(awakeMode({ enabled: true, screenOnBattery: true, serverRunning: true, onBattery: false }), 'system');
});

test('keep-awake: on battery the screen stays on only when chosen', () => {
  assert.equal(awakeMode({ enabled: true, screenOnBattery: false, serverRunning: true, onBattery: true }), 'system');
  assert.equal(awakeMode({ enabled: true, screenOnBattery: true, serverRunning: true, onBattery: true }), 'display');
});

// ---- Health checks ----

test('health: Windows sleep timers are read from powercfg', () => {
  const out = 'Power Setting GUID: 29f6c1db\n    Current AC Power Setting Index: 0x0000012c\n    Current DC Power Setting Index: 0x000000b4\n';
  assert.equal(powercfgSeconds(out, 'AC'), 300);
  assert.equal(powercfgSeconds(out, 'DC'), 180);
  assert.equal(powercfgSeconds('nothing', 'AC'), null);
});

test('health: Smart App Control state is read from the registry output', () => {
  assert.equal(sacState('    VerifiedAndReputablePolicyState    REG_DWORD    0x0'), 0);
  assert.equal(sacState('    VerifiedAndReputablePolicyState    REG_DWORD    0x1'), 1);
  assert.equal(sacState('ERROR: not found'), null);
});

test('your real SQL: comments with commas in them are not read as columns (energy_dj)', () => {
  const sql = "CREATE TABLE IF NOT EXISTS `props_x` (\n  `id` INT NOT NULL,\n  `coords` JSON NOT NULL, -- {x,y,z}\n  `rotation` JSON NOT NULL, /* {x,y,z} */\n  # old: `heading`\n  `note` VARCHAR(20) DEFAULT '-- not a comment',\n  PRIMARY KEY (`id`)\n);";
  assert.deepEqual(columnsOf(createStatementFor('props_x', sql)), ['id', 'coords', 'rotation', 'note']);
  assert.ok(stripSqlComments(sql).includes("'-- not a comment'"), 'text inside quotes is kept');
});

const H_DISK = [
  { name: 'qb-houses', categories: ['[qb]'], dependencies: ['qb-clothing'], provides: [], dir: 'D:/s/resources/[qb]/qb-houses' },
  { name: 'qb-clothing', categories: ['[disabled]'], dependencies: [], provides: [], dir: 'D:/s/resources/[disabled]/qb-clothing' },
  { name: 'um-clothing-qb', categories: ['[added]'], dependencies: [], provides: ['qb-clothing'], dir: 'D:/s/resources/[added]/um-clothing-qb' },
];

test('health: the qb-houses trap is caught before it happens, and not once the order is right', () => {
  const late = ['ensure qb-core', 'ensure [qb]', 'ensure um-clothing-qb', ''].join('\n');
  const found = startOrderFindings(H_DISK, late);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, 'bad');
  assert.deepEqual(found[0].fix.fix, { type: 'start-before', provider: 'um-clothing-qb', dependent: 'qb-houses', original: 'qb-clothing' });
  const early = ['ensure qb-core', 'ensure um-clothing-qb', 'ensure [qb]', ''].join('\n');
  assert.equal(startOrderFindings(H_DISK, early).length, 0);
});

test('health: start lines for scripts that are not installed get a switch-off fix (not built-in ones)', () => {
  const cfg = ['ensure chat', 'ensure clothes_images', 'ensure um-clothing-qb', 'ensure qb-clothing', ''].join('\n');
  const found = missingStartFindings(H_DISK, cfg);
  assert.deepEqual(found.map((f) => f.id), ['missing-start:clothes_images']);
  assert.deepEqual(found[0].fix.fix, { type: 'cfg-off', name: 'clothes_images' });
});

test('health: the same script in two folders is pointed out', () => {
  const disk = [...H_DISK, { name: 'qb-houses', categories: ['[added]'], dependencies: [], provides: [], dir: 'D:/s/resources/[added]/qb-houses' }];
  const found = duplicateFindings(disk, 'D:/s');
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /resources\/\[qb\]\/qb-houses and resources\/\[added\]\/qb-houses/);
});

// ---- Startup doctor ----

const ADMIN = [
  '======== txAdmin v8.1.2 atop fxserver 38435 Starting - 11/10/2026, 5:23:22 PM',
  '[18:00:47][MONITOR] Restarting server: Resource "some_casino.pack" failed to start within the 1m30s time limit (P:37m11s|HB:--|HC:0s).',
  '[18:32:19][MONITOR] Restarting server: Server is not responding (HB:0s|HC:18m35s).',
  '[19:10:00][MONITOR] Restarting server: Server process close detected.',
];
const SERVER = [
  '[TXADMIN] ======== [19368] FXServer Starting - 11/10/2026, 5:23:36 PM',
  '[c-scripting-core] Creating script environments for some_casino.pack',
  '[script:some_casino] employees_server.lua loaded',
  '[citizen-server-impl] network thread hitch warning: timer interval of 1810397 milliseconds',
  '[citizen-server-impl] sync thread hitch warning: timer interval of 1810391 milliseconds',
  '[TXADMIN] ======== [12032] FXServer Starting - 11/10/2026, 6:00:53 PM',
  '[c-scripting-core] Creating script environments for slow_script',
  '[TXADMIN] ======== [222] FXServer Starting - 11/10/2026, 6:32:30 PM',
  '[script:qb-control] [qb-control] ready',
];

test('doctor: txAdmin restarts and server starts are read with their times', () => {
  const restarts = adminRestarts(ADMIN);
  assert.equal(restarts.length, 3);
  assert.equal(restarts[0].at.getHours(), 18);
  assert.equal(restarts[0].at.getMinutes(), 0);
  assert.equal(bootSegments(SERVER).length, 3);
});

test('your real restart: txAdmin blamed the casino, but the whole server was paused by sleep', () => {
  const [first] = adminRestarts(ADMIN);
  const [segment] = bootSegments(SERVER);
  assert.equal(wholePause(segment.lines), 1810391);
  const incident = explainRestart(first, segment, [{ from: first.at.getTime() - 1810000, to: first.at.getTime() - 3000 }]);
  assert.equal(incident.kind, 'paused');
  assert.match(incident.detail, /txAdmin named some_casino\.pack, but it was only the script loading/);
  assert.equal(incident.fix, undefined, 'a sleep never blames a script');
});

test('doctor: a hang while awake points at the script that was loading, with a turn-off fix', () => {
  const [, second] = adminRestarts(ADMIN);
  const segment = bootSegments(SERVER)[1];
  assert.deepEqual(lastActivity(segment.lines), { kind: 'resource', name: 'slow_script' });
  const incident = explainRestart(second, segment, []);
  assert.equal(incident.kind, 'hang');
  assert.deepEqual(incident.fix.fix, { type: 'boot-off', name: 'slow_script' });
});

test('doctor: a restart CityHQ made itself is planned, not a crash', () => {
  const third = adminRestarts(ADMIN)[2];
  const segment = bootSegments(SERVER)[2];
  assert.equal(explainRestart(third, segment, [], [{ state: 'restarting', at: third.at.getTime() - 60000 }]).kind, 'planned');
  const crash = explainRestart(third, segment, [], []);
  assert.equal(crash.kind, 'crash');
  assert.equal(crash.suspect, null, 'after a finished start, the last script loaded is not blamed');
});

// ---- Install check: which framework a script is written for ----

test('your real script: a config set to ESX is caught with the exact line', () => {
  const fit = frameworkFit({ manifest: "fx_version 'cerulean'", configs: [{ file: 'config.lua', text: 'Config = {}\nConfig.Framework = "esx" -- "qb" or "esx"\n' }], folders: [] });
  assert.equal(fit.status, 'bad');
  assert.deepEqual(fit.openFile, { file: 'config.lua', line: 2, label: 'Open config.lua at line 2' });
});

test('install check: ESX-only, QBCore and bridged scripts are told apart', () => {
  assert.equal(frameworkFit({ manifest: "shared_script '@es_extended/imports.lua'", configs: [], folders: [] }).status, 'bad');
  assert.equal(frameworkFit({ manifest: "shared_script '@es_extended/imports.lua'", configs: [], folders: [{ parent: 'bridge', name: 'qb' }] }).status, 'ok');
  assert.equal(frameworkFit({ manifest: "shared_script '@qb-core/shared/locale.lua'", configs: [], folders: [] }).status, 'ok');
  assert.equal(frameworkFit({ manifest: '', configs: [{ file: 'config.lua', text: "Config.Framework = 'auto'" }], folders: [] }).status, 'ok');
  assert.equal(frameworkFit({ manifest: "fx_version 'cerulean'", configs: [], folders: [] }).status, 'info', 'maps and cars need no framework');
});

// ---- Friends can't join ----

test('friends: the router and this PC\'s address are read from "route print"', () => {
  const text = 'IPv4 Route Table\n===\nActive Routes:\nNetwork Destination        Netmask          Gateway       Interface  Metric\n          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.50     35\n';
  assert.deepEqual(parseRoute(text), { gateway: '192.168.0.1', localIp: '192.168.0.50' });
  assert.equal(parseRoute('nothing'), null);
});

const RULES = parseFirewall([
  'Rule Name:                            Cfx.re Platform Server (FXServer)',
  '----------------------------------------------------------------------',
  'Enabled:                              Yes',
  'Direction:                            In',
  'Profiles:                             Public',
  'Protocol:                             UDP',
  'LocalPort:                            Any',
  'Program:                              D:\\qbcore-server\\server\\fxserver.exe',
  'Action:                               Allow',
  '',
  'Rule Name:                            Cfx.re Platform Server (FXServer)',
  'Enabled:                              Yes',
  'Profiles:                             Public',
  'Protocol:                             TCP',
  'LocalPort:                            Any',
  'Program:                              D:\\qbcore-server\\server\\fxserver.exe',
  'Action:                               Allow',
  '',
  'Rule Name:                            fxserver.exe',
  'Enabled:                              Yes',
  'Profiles:                             Private',
  'Protocol:                             TCP',
  'LocalPort:                            Any',
  'Program:                              C:\\users\\someone\\downloads\\other-server\\fxserver.exe',
  'Action:                               Allow',
].join('\r\n'));

test('your real firewall: rules for this server count, rules for other servers in Downloads don\'t', () => {
  assert.equal(RULES.length, 3);
  assert.deepEqual(firewallCovers(RULES, { program: 'D:\\QBCore-Server\\server\\FXServer.exe', port: 30121, profile: 'Public' }), { tcp: true, udp: true });
  assert.deepEqual(firewallCovers(RULES, { program: 'D:\\QBCore-Server\\server\\FXServer.exe', port: 30121, profile: 'Private' }), { tcp: false, udp: false }, 'a Public-only rule does not cover a Private network');
  assert.deepEqual(firewallCovers(RULES, { program: 'C:\\users\\someone\\downloads\\other-server\\fxserver.exe', port: 1, profile: 'Private' }), { tcp: true, udp: false });
});

test('friends: what FiveM\'s server list said, read with the time since the server started', () => {
  const start = (t) => `[TXADMIN] ======== [1] FXServer Starting - 11/10/2026, ${t}`;
  const fail = '[citizen-server-impl] Server list query returned an error: Cfx failed to reach the server at 203.0.113.7:30121 - check if the sv_listingIpOverride';
  const ready = '[script:qb-control] [qb-control] ready';
  const at = (h, m) => new Date(2026, 10, 10, h, m).getTime();
  assert.deepEqual(listingStatus([start('8:00:00 PM'), ready, fail], at(20, 30)), { status: 'blocked', publicIp: '203.0.113.7' });
  assert.equal(listingStatus([start('7:00:00 PM'), fail, start('8:00:00 PM'), ready], at(20, 2)).status, 'pending', 'too soon after a start to know');
  assert.equal(listingStatus([start('7:00:00 PM'), fail, start('8:00:00 PM'), ready], at(20, 2)).lastFailed, true);
  assert.equal(listingStatus([start('7:00:00 PM'), fail, start('8:00:00 PM'), ready], at(20, 10)).status, 'ok', 'no complaint for a while after starting means it worked');
});

// ---- Server profile ----

test('profile: player slots are read and changed in place, keeping the comment', () => {
  const cfg = ['sv_maxclients 10 # slots', 'sets sv_projectName "x"', ''].join('\r\n');
  assert.equal(readCommand(cfg, 'sv_maxclients'), '10');
  const changed = setCommand(cfg, 'sv_maxclients', '32');
  assert.equal(changed.split('\r\n')[0], 'sv_maxclients 32 # slots');
  assert.equal(readCommand(setCommand(CFG, 'sv_maxclients', '48'), 'sv_maxclients'), '48', 'added to the app block when missing');
  assert.equal(gameBuildName(3095), 'The Chop Shop');
  assert.equal(gameBuildName(1), null);
});

// ---- Waiting for a boot: progress, not a fixed clock ----

test('boot wait: a slow boot that keeps logging is never cut off at 3 minutes', () => {
  const start = 0;
  const min = 60000;
  assert.equal(bootVerdict({ now: 4 * min, startedAt: start, lastProgress: 4 * min - 5000 }), 'wait');
  assert.equal(bootVerdict({ now: 12 * min, startedAt: start, lastProgress: 11 * min }), 'wait');
});

test('boot wait: a boot with nothing new in its log for 5 minutes counts as stuck', () => {
  assert.equal(BOOT_STALL_MS, 5 * 60000);
  assert.equal(bootVerdict({ now: 9 * 60000, startedAt: 0, lastProgress: 3 * 60000 }), 'stalled');
});

test('boot wait: there is still a hard limit, and time the PC spent asleep does not count towards it', () => {
  const now = BOOT_MAX_MS + 60000;
  assert.equal(bootVerdict({ now, startedAt: 0, lastProgress: now - 1000 }), 'timeout');
  assert.equal(bootVerdict({ now, startedAt: 0, lastProgress: now - 1000, asleepMs: 30 * 60000 }), 'wait', 'a 30-minute sleep during the boot is not held against it');
});
// Updates: version order, the notes CityHQ shows, and what it takes from GitHub's answer.
test('isNewer compares plain version numbers only', async () => {
  const { isNewer } = await import('./updates.js');
  assert.equal(isNewer('1.2.0', '1.1.3'), true);
  assert.equal(isNewer('v1.10.0', '1.9.9'), true);
  assert.equal(isNewer('1.1.3', '1.1.3'), false);
  assert.equal(isNewer('1.1.2', '1.1.3'), false);
  assert.equal(isNewer('2.0.0-beta.1', '1.0.0'), false);
  assert.equal(isNewer('garbage', '1.0.0'), false);
});

test('whatsNew keeps only the What\'s new section of the release notes', async () => {
  const { whatsNew } = await import('./updates.js');
  const body = "## What's new\r\n\r\n- Updates itself.\r\n- Checks downloads.\r\n\r\n## Download\r\n\r\nDownload the zip.";
  assert.equal(whatsNew(body), '- Updates itself.\n- Checks downloads.');
  assert.equal(whatsNew("## What's new\n\n- Only this."), '- Only this.');
  assert.equal(whatsNew('## Download\n\nNo notes.'), '');
  assert.equal(whatsNew(null), '');
});

test('parseRelease takes the version, the zip and its checksum, and skips anything unusable', async () => {
  const { parseRelease } = await import('./updates.js');
  const hex = 'a'.repeat(64);
  const release = parseRelease({
    tag_name: 'v1.2.0', html_url: 'https://github.com/404hxlo/CityHQ/releases/tag/v1.2.0', body: "## What's new\n\n- New.\n\n## Download\nx", published_at: '2026-11-11T00:00:00Z',
    assets: [
      { name: 'CityHQ-windows.zip', browser_download_url: 'https://github.com/x/CityHQ-windows.zip', size: 104857600, digest: `sha256:${hex.toUpperCase()}` },
      { name: 'CityHQ-windows.zip.sha256', browser_download_url: 'https://github.com/x/CityHQ-windows.zip.sha256' },
    ],
  });
  assert.equal(release.version, '1.2.0');
  assert.equal(release.notes, '- New.');
  assert.equal(release.zip.digest, hex);
  assert.equal(release.zip.size, 104857600);
  assert.equal(release.sumsUrl, 'https://github.com/x/CityHQ-windows.zip.sha256');
  // A page link that isn't GitHub's falls back to the releases page.
  assert.equal(parseRelease({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x', assets: [] }).page, 'https://github.com/404hxlo/CityHQ/releases/latest');
  assert.equal(parseRelease({ tag_name: 'v1.2.0', assets: [] }).zip, null);
  assert.equal(parseRelease({ tag_name: 'v1.3.0', prerelease: true }), null);
  assert.equal(parseRelease({ tag_name: 'nightly' }), null);
  assert.equal(parseRelease(null), null);
});

test('the updater command line keeps folders with spaces in one piece, and odd folder names are refused', async () => {
  const { helperCommandLine, unsafeForCmd } = await import('./updates.js');
  const line = helperCommandLine(['-File', 'C:\\Users\\Sam\\AppData\\Local\\CityHQ\\updates\\update-helper.ps1', '-Install', 'D:\\my apps\\CityHQ', '-ArgsB64', 'W10=']);
  assert.equal(line, '/d /s /c "start "" /b powershell.exe -File C:\\Users\\Sam\\AppData\\Local\\CityHQ\\updates\\update-helper.ps1 -Install "D:\\my apps\\CityHQ" -ArgsB64 "W10=""');
  assert.equal(unsafeForCmd('D:\\100% games\\CityHQ'), true);
  assert.equal(unsafeForCmd('D:\\Games (x86)\\CityHQ & co'), false);
});

// Report a problem: what the privacy filter takes out, and the GitHub link.
test('redact takes keys, passwords, player IDs, addresses and the user folder out of a report', async () => {
  const { redact } = await import('./report.js');
  const opts = { home: 'C:\\Users\\Sam Doe', user: 'SamDoe', root: 'D:\\Games\\MyCity' };
  const out = redact([
    'sv_licenseKey cfxk_abcDEF123_xyz',
    'set mysql_connection_string "mysql://root:hunter2@127.0.0.1/qb"',
    'server=localhost;uid=root;password=s3cret;database=qb',
    'player license:0123456789abcdef0123456789abcdef01234567 steam:110000112345678 discord:123456789012345678',
    'joined from 203.0.113.45 and listening on 0.0.0.0:30120 and 127.0.0.1:40125',
    'mail sam.doe@example.com',
    'at file:///C:/Users/Sam%20Doe/Downloads/CityHQ/resources/app/server/app.js:10:5',
    'Error: EPERM, rename C:\\Users\\Sam Doe\\AppData\\x and D:\\Games\\MyCity\\txData\\default',
    'logged in as SamDoe; token=abcdef; https://discord.com/api/webhooks/123/abcDEF',
    'CityHQ 1.2.0, FXServer 38435, resource qb-core',
  ].join('\n'), opts);
  for (const secret of ['cfxk_abc', 'hunter2', 's3cret', '0123456789abcdef', '110000112345678', '123456789012345678', '203.0.113.45', 'sam.doe@', 'Sam Doe', 'Sam%20Doe', 'SamDoe', 'D:\\Games\\MyCity', 'webhooks/123', 'token=abcdef']) {
    assert.ok(!out.includes(secret), `${secret} should be gone:\n${out}`);
  }
  for (const kept of ['127.0.0.1:40125', '0.0.0.0:30120', '%USERPROFILE%/Downloads/CityHQ', '<server folder>\\txData\\default', 'CityHQ 1.2.0, FXServer 38435, resource qb-core', 'cfxk_(hidden)', 'license:(hidden)']) {
    assert.ok(out.includes(kept), `${kept} should stay:\n${out}`);
  }
});

test('buildReport needs a description, keeps a short title and falls back when the link is too long', async () => {
  const { buildReport, ISSUES_URL, MAX_URL } = await import('./report.js');
  const keep = (s) => s;
  assert.throws(() => buildReport({ what: '   ' }, keep), /Say what went wrong/);
  const short = buildReport({ what: 'Backups fail\nwith an error', doing: 'Pressed Back up now', details: { lines: ['CityHQ: 1.2.0'], log: 'line one' } }, keep);
  assert.equal(short.title, 'Backups fail');
  assert.equal(short.complete, true);
  assert.ok(short.url.startsWith(`${ISSUES_URL}?`));
  const params = new URL(short.url).searchParams;
  assert.equal(params.get('title'), 'Backups fail');
  assert.ok(params.get('body').includes('### What I was doing\nPressed Back up now'));
  assert.ok(params.get('body').includes('- CityHQ: 1.2.0'));
  assert.ok(params.get('body').includes('```\nline one\n```'));
  const long = buildReport({ what: 'x'.repeat(100), details: { lines: ['CityHQ: 1.2.0'], log: 'y'.repeat(9000) } }, keep);
  assert.equal(long.complete, false);
  assert.ok(long.url.length <= MAX_URL);
  assert.ok(long.body.includes('y'.repeat(9000)));
  assert.ok(buildReport({ what: 'z'.repeat(200) }, keep).title.endsWith('...'));
});
