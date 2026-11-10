import assert from 'node:assert/strict';
import {
  existsSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findInstallSource } from './catalog.js';
import { explainLogLines, explainMissingDependency, luaPlain } from './explain.js';
import { parseGithubUrl } from './resources.js';
import {
  createProcessWatch, isValidTime, lastOccurrence, nextOccurrence, warningDue,
} from './scheduler.js';
import { BLOCK_END, BLOCK_START, ensureManagedBlock } from './cfg.js';
import { findRoot, portOr } from './paths.js';

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
  assert.equal(findRoot('C:\\Windows\\System32', ''), null);
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
