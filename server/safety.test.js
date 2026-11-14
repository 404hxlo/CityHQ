// The things that keep a server and CityHQ's own files safe: saving files, one change to
// server.cfg at a time, damaged settings, the scheduler, the helper's console guard, finishing a
// move, and checking updates. Every file these tests touch is in a temporary folder.
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Nothing here may reach a real server folder, whatever else these modules read at start.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'cityhq-safety-'));
process.env.QBC_ROOT = path.join(SCRATCH, 'server');
process.env.QBC_HOME = path.join(SCRATCH, 'home');
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const { replaceFile, replaceFileSync } = await import('./retry.js');
const { changeCfgFile, withFileLock } = await import('./cfg.js');
const { readSettingsFile } = await import('./settings.js');
const { createTicker, MISSED_AFTER_MS, restartDue } = await import('./scheduler.js');
const { helperRestartReason } = await import('./agent.js');
const { finishBlocker } = await import('./move/job.js');
const {
  checksumIn, expectedFrom, helperCommandLine, isNewer, parseRelease, unsafeForCmd, whatsNew,
} = await import('./updates.js');
const { bootSegments, dateShapeOf, parseBannerStamp } = await import('./doctor.js');
const { powercfgSeconds } = await import('./health.js');
const { firewallCovers, pickNetwork, rulesFromObjects } = await import('./reach.js');
const { blockedFromEventData } = await import('./startup.js');
const { describeOwner, ownProcesses, pickMonitor } = await import('./processes.js');

const folder = (name) => {
  const dir = path.join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const leftovers = (dir) => readdirSync(dir).filter((n) => n.endsWith('.qbctmp'));
const settle = () => new Promise((r) => { setImmediate(r); });

// ---------------------------------------------------------------- saving files
test('saves made at the same moment each land whole, and leave no temporary copies', async () => {
  const dir = folder('saves');
  const target = path.join(dir, 'server.cfg');
  writeFileSync(target, 'start');
  const texts = Array.from({ length: 25 }, (_, i) => `version ${i}\n${'x'.repeat(2000 + i)}`);
  await Promise.all(texts.map((t) => replaceFile(target, t)));
  assert.ok(texts.includes(readFileSync(target, 'utf8')), 'the file holds one complete save, never a mix');
  assert.deepEqual(leftovers(dir), []);
});

test('the quick save used for settings leaves no temporary copy either', () => {
  const dir = folder('sync-saves');
  const target = path.join(dir, 'settings.json');
  for (let i = 0; i < 5; i++) replaceFileSync(target, JSON.stringify({ i }));
  assert.equal(readFileSync(target, 'utf8'), '{"i":4}');
  assert.deepEqual(leftovers(dir), []);
});

// ---------------------------------------------------------------- one server.cfg change at a time
test('changes to server.cfg made at the same moment are all kept', async () => {
  const dir = folder('cfg');
  const cfg = path.join(dir, 'server.cfg');
  writeFileSync(cfg, 'sv_hostname "Test"\n');
  // Each change reads the file, waits a little (like a real one asking the server something), then
  // writes. Without the lock, most of these would overwrite each other.
  await Promise.all(Array.from({ length: 20 }, (_, i) => changeCfgFile(cfg, async (text) => {
    await new Promise((r) => { setTimeout(r, Math.random() * 10); });
    return `${text}ensure script-${i}\n`;
  })));
  const text = readFileSync(cfg, 'utf8');
  for (let i = 0; i < 20; i++) assert.ok(text.includes(`ensure script-${i}\n`), `script-${i} kept`);
  assert.deepEqual(leftovers(dir), []);
});

test('a change that calls another change to the same file carries on instead of waiting for itself', async () => {
  const cfg = path.join(folder('nested'), 'server.cfg');
  writeFileSync(cfg, 'a\n');
  const result = await withFileLock('nested', () => withFileLock('nested', async () => {
    await changeCfgFile(cfg, (t) => `${t}b\n`);
    return 'done';
  }));
  assert.equal(result, 'done');
  assert.equal(readFileSync(cfg, 'utf8'), 'a\nb\n');
});

test('a change that fails lets the next one through, and leaves the file as it was', async () => {
  const cfg = path.join(folder('failing'), 'server.cfg');
  writeFileSync(cfg, 'a\n');
  await assert.rejects(changeCfgFile(cfg, () => { throw new Error('nope'); }), /nope/);
  const { changed } = await changeCfgFile(cfg, (t) => `${t}b\n`);
  assert.equal(changed, true);
  assert.equal(readFileSync(cfg, 'utf8'), 'a\nb\n');
  // Returning the same text, or nothing, leaves the file alone.
  assert.equal((await changeCfgFile(cfg, (t) => t)).changed, false);
  assert.equal((await changeCfgFile(cfg, () => undefined)).changed, false);
});

// ---------------------------------------------------------------- damaged settings
test('settings: a good file is used, and a copy of it is kept for later', () => {
  const file = path.join(folder('settings-good'), 'settings.json');
  writeFileSync(file, JSON.stringify({ passcode: '12345678' }));
  const { loaded, source } = readSettingsFile(file);
  assert.equal(source, 'file');
  assert.equal(loaded.passcode, '12345678');
  assert.equal(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).passcode, '12345678');
});

test('settings: a damaged file is set aside and the copy from the last start is used', () => {
  const dir = folder('settings-damaged');
  const file = path.join(dir, 'settings.json');
  writeFileSync(`${file}.bak`, JSON.stringify({ passcode: '87654321', agentToken: 'a'.repeat(64) }));
  writeFileSync(file, '{"passcode": "1234');
  const { loaded, source, aside } = readSettingsFile(file);
  assert.equal(source, 'backup');
  assert.equal(loaded.passcode, '87654321');
  assert.equal(readFileSync(aside, 'utf8'), '{"passcode": "1234', 'the damaged file is kept as it was');
  assert.match(path.basename(aside), /^settings\.json\.damaged-\d+$/);
});

test('settings: an empty file (a power cut while saving) counts as damaged too', () => {
  const file = path.join(folder('settings-empty'), 'settings.json');
  writeFileSync(file, '');
  const { source, aside } = readSettingsFile(file);
  assert.equal(source, 'damaged');
  assert.ok(existsSync(aside));
});

test('settings: no file yet means a new setup, not a damaged one', () => {
  const { loaded, source } = readSettingsFile(path.join(folder('settings-new'), 'settings.json'));
  assert.equal(source, 'new');
  assert.deepEqual(loaded, {});
});

// ---------------------------------------------------------------- the scheduler
test('a slow backup never holds up crash watching or restart warnings', async () => {
  let quick = 0;
  let started = 0;
  let finish;
  const tick = createTicker({
    quick: async () => { quick += 1; },
    slow: () => { started += 1; return new Promise((r) => { finish = r; }); },
  });
  await tick();
  await tick();
  await tick();
  assert.equal(quick, 3, 'the quick checks ran every time');
  assert.equal(started, 1, 'the backup started once and was not started again while it ran');
  finish();
  await settle();
  await tick();
  assert.equal(started, 2, 'once it finished, the next one can start');
});

test('the scheduler keeps going after either part fails', async () => {
  const errors = [];
  let quickRuns = 0;
  let slowRuns = 0;
  const tick = createTicker({
    quick: async () => { quickRuns += 1; throw new Error('quick failed'); },
    slow: async () => { slowRuns += 1; throw new Error('slow failed'); },
    onError: (err) => errors.push(err.message),
  });
  await tick();
  await settle();
  await tick();
  await settle();
  assert.equal(quickRuns, 2);
  assert.equal(slowRuns, 2);
  assert.deepEqual(errors, ['quick failed', 'slow failed', 'quick failed', 'slow failed']);
});

test('a planned restart the PC slept through is skipped, not run late without warning', () => {
  assert.equal(restartDue(60000), 'wait');
  assert.equal(restartDue(0), 'now');
  assert.equal(restartDue(-30000), 'now', 'a few seconds late (a busy moment) still restarts');
  assert.equal(restartDue(-MISSED_AFTER_MS - 1), 'missed');
  assert.equal(restartDue(-3 * 3600 * 1000), 'missed', 'hours late, after the PC woke up');
});

// ---------------------------------------------------------------- the helper's console
test('commands that would make the helper restart itself are refused', () => {
  for (const command of [
    'restart qb-control', 'ensure qb-control', 'stop qb-control', 'START QB-CONTROL', 'refresh; restart qb-control',
    'ensure [local]', 'restart [local]', 'alias again "restart qb-control"',
  ]) assert.equal(helperRestartReason(command), 'restart', command);
  for (const command of ['exec server.cfg', 'exec resources/[cars]/cars.cfg', 'refresh;exec server.cfg', 'alias again "exec server.cfg"']) {
    assert.equal(helperRestartReason(command), 'exec', command);
  }
});

test('ordinary commands still run, including ones that merely look similar', () => {
  for (const command of [
    'restart qb-phone', 'ensure qb-control-extras', 'stop my-qb-control', 'say stop the car', 'refresh', 'status',
    'execute', 'say qb-control is great', 'txaEvent "announcement" "{}"', 'ensure [cars]', '',
  ]) assert.equal(helperRestartReason(command), null, command);
  assert.equal(helperRestartReason(undefined), null);
});

// ---------------------------------------------------------------- finishing a move
test('finishing a move waits while anyone is, or might be, playing on the server here', () => {
  assert.equal(finishBlocker({ serverUp: true, players: [] }), null, 'nobody on');
  assert.equal(finishBlocker({ serverUp: false, players: null }), null, 'the server here is already stopped');
  const someone = finishBlocker({ serverUp: true, players: [{ id: 1 }] });
  assert.equal(someone.status, 409);
  assert.match(someone.message, /1 player is on your server/);
  const unknown = finishBlocker({ serverUp: true, players: null });
  assert.equal(unknown.status, 409);
  assert.match(unknown.message, /couldn't check whether anyone is playing/);
  assert.equal(finishBlocker({ serverUp: true, players: null, playersOk: true }), null, 'the owner said go ahead');
  assert.equal(finishBlocker({ serverUp: true, players: [{ id: 1 }], stopLocal: false }), null, 'not stopping the server here');
});

// ---------------------------------------------------------------- updates
test('updates: only a plain higher version counts as newer', () => {
  assert.equal(isNewer('1.9.2', '1.9.1'), true);
  assert.equal(isNewer('v1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.9.1', '1.9.1'), false);
  assert.equal(isNewer('1.9.0', '1.9.1'), false);
  for (const odd of ['1.9.2-beta', '1.9', 'latest', '', null]) assert.equal(isNewer(odd, '1.9.1'), false, String(odd));
});

test('updates: the release notes shown are only the "What\'s new" part', () => {
  const body = "## What's new\r\n\r\n- A fix.\r\n- Another.\r\n\r\n## Download\r\n\r\nSteps for new people.";
  assert.equal(whatsNew(body), '- A fix.\n- Another.');
  assert.equal(whatsNew('No headings at all'), '');
});

const zipAsset = (extra = {}) => ({
  name: 'CityHQ-windows.zip', browser_download_url: 'https://github.com/x/y/releases/download/v1.9.2/CityHQ-windows.zip', size: 157 * 1048576, ...extra,
});

test('updates: a release is only used when it has a plain version and its download', () => {
  const ok = parseRelease({
    tag_name: 'v1.9.2', body: "## What's new\n\n- A fix.", html_url: 'https://github.com/x/y/releases/tag/v1.9.2',
    assets: [zipAsset({ digest: `sha256:${'A'.repeat(64)}` }), { name: 'CityHQ-windows.zip.sha256', browser_download_url: 'https://github.com/x/y/sums' }],
  });
  assert.equal(ok.version, '1.9.2');
  assert.equal(ok.zip.digest, 'a'.repeat(64));
  assert.equal(ok.sumsUrl, 'https://github.com/x/y/sums');
  assert.equal(ok.notes, '- A fix.');
  assert.equal(parseRelease({ tag_name: 'v1.9.2', draft: true, assets: [zipAsset()] }), null);
  assert.equal(parseRelease({ tag_name: 'v1.9.2', prerelease: true, assets: [zipAsset()] }), null);
  assert.equal(parseRelease({ tag_name: 'nightly', assets: [zipAsset()] }), null);
  assert.equal(parseRelease(null), null);
  // A release page that isn't on GitHub is never opened.
  assert.equal(parseRelease({ tag_name: 'v1.9.2', html_url: 'https://evil.example/', assets: [zipAsset()] }).page, 'https://github.com/404hxlo/CityHQ/releases/latest');
  assert.equal(parseRelease({ tag_name: 'v1.9.2', assets: [] }).zip, null);
});

test('updates: the two published checksums must agree, and one is needed', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.equal(checksumIn(`${a.toUpperCase()}  CityHQ-windows.zip\n`), a);
  assert.equal(checksumIn('not a checksum'), null);
  assert.equal(expectedFrom(a, a), a);
  assert.equal(expectedFrom(a, null), a);
  assert.equal(expectedFrom(null, b), b);
  assert.throws(() => expectedFrom(a, b), (err) => err.status === 502 && /disagree/.test(err.message));
  assert.throws(() => expectedFrom(null, null), (err) => err.status === 502 && /no checksum/.test(err.message));
});

test('updates: the updater is started with every path quoted, and odd folders are refused', () => {
  const line = helperCommandLine(['-File', 'C:\\Users\\Jo Ann\\AppData\\Local\\CityHQ\\updates\\update-helper.ps1', '-Install', 'D:\\Games & Tools\\CityHQ', '-ArgsB64', '']);
  assert.equal(line, '/d /s /c "start "" /b powershell.exe -File "C:\\Users\\Jo Ann\\AppData\\Local\\CityHQ\\updates\\update-helper.ps1" -Install "D:\\Games & Tools\\CityHQ" -ArgsB64 """');
  assert.equal(unsafeForCmd('D:\\100% Games\\CityHQ'), true);
  assert.equal(unsafeForCmd('D:\\"quoted"\\CityHQ'), true);
  assert.equal(unsafeForCmd('D:\\Games & Tools\\CityHQ'), false);
});

// ---------------------------------------------------------------- PCs not set to US English
// txAdmin writes its start time with toLocaleString(), in the PC's own format.
const LOCALES = [
  'en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'es-MX', 'nl-NL', 'pl-PL', 'ru-RU', 'tr-TR', 'it-IT', 'pt-BR',
  'sv-SE', 'ja-JP', 'zh-CN', 'ko-KR', 'ar-EG', 'en-IN', 'th-TH',
];

test('txAdmin\'s start time is read in every common date format, digits and AM/PM words included', () => {
  const moments = [new Date(2026, 10, 14, 1, 5, 9), new Date(2026, 10, 14, 13, 5, 9), new Date(2026, 2, 3, 0, 30, 0), new Date(2026, 11, 31, 12, 0, 59)];
  for (const locale of LOCALES) {
    const shape = dateShapeOf(locale);
    for (const when of moments) {
      const written = when.toLocaleString(locale);
      const read = parseBannerStamp(written, shape);
      assert.equal(read?.getTime(), when.getTime(), `${locale}: "${written}"`);
    }
  }
});

test('a calendar with other months (Persian) is left unread rather than read wrongly', () => {
  const shape = dateShapeOf('fa-IR');
  assert.equal(parseBannerStamp(new Date(2026, 10, 14, 13, 5, 9).toLocaleString('fa-IR'), shape), null);
});

test('server starts are found in a German log', () => {
  const de = dateShapeOf('de-DE');
  const lines = [
    `[TXADMIN] ======== [1] FXServer Starting - ${new Date(2026, 10, 3, 17, 23, 36).toLocaleString('de-DE')}`,
    '[c-scripting-core] Creating script environments for slow_script',
    `[TXADMIN] ======== [2] FXServer Starting - ${new Date(2026, 10, 14, 9, 0, 0).toLocaleString('de-DE')}       `,
  ];
  const segments = bootSegments(lines, de);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start.getTime(), new Date(2026, 10, 3, 17, 23, 36).getTime(), '3 November, not 11 March');
  assert.deepEqual(segments[0].lines, ['[c-scripting-core] Creating script environments for slow_script']);
});

test('the PC\'s sleep timers are read when Windows is in another language', () => {
  const german = [
    'Energieschema-GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Ausbalanciert)',
    '  GUID des Untergebiets: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Energie sparen nach)',
    '    GUID der Energieeinstellung: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Standbymodus nach)',
    '      Minimaler möglicher Wert: 0x00000000',
    '      Maximaler möglicher Wert: 0xffffffff',
    '      Mögliche Einstellungen - Inkrement: 0x00000001',
    '      Mögliche Einstellungen - Einheiten: Sekunden',
    '    Aktueller Wechselstrom-Einstellungsindex: 0x00000708',
    '    Aktueller Gleichstrom-Einstellungsindex: 0x00000384',
  ].join('\r\n');
  assert.equal(powercfgSeconds(german, 'AC'), 1800);
  assert.equal(powercfgSeconds(german, 'DC'), 900);
  assert.equal(powercfgSeconds('Zugriff verweigert.', 'AC'), null, 'an error is not a timer');
  assert.equal(powercfgSeconds('    Current AC Power Setting Index: 0x0000012c\r\n    Current DC Power Setting Index: 0x000000b4', 'DC'), 180);
});

test('firewall rules read from PowerShell\'s objects count the same as before', () => {
  const rules = rulesFromObjects([
    { name: 'FiveM server (CityHQ) TCP', profile: 0, program: 'D:\\Server\\server\\FXServer.exe', protocol: 'TCP', localPort: 'Any' },
    { name: 'FiveM server (CityHQ) UDP', profile: 0, program: 'D:\\Server\\server\\FXServer.exe', protocol: 'UDP', localPort: 'Any' },
    { name: 'Game port, home only', profile: 2, program: '', protocol: 'TCP', localPort: '30120,30200-30300' },
  ]);
  assert.equal(rules[0].profiles, 'Any');
  assert.equal(rules[2].profiles, 'Private');
  assert.equal(rulesFromObjects({ name: 'one', profile: 6 })[0].profiles, 'Private,Public', 'a single rule comes as an object');
  assert.deepEqual(firewallCovers(rules, { program: 'd:\\server\\server\\fxserver.exe', port: 30120, profile: 'Public' }), { tcp: true, udp: true });
  assert.deepEqual(firewallCovers(rules.slice(2), { program: 'x', port: 30250, profile: 'Private' }), { tcp: true, udp: false });
  assert.deepEqual(firewallCovers(rules.slice(2), { program: 'x', port: 30250, profile: 'Public' }), { tcp: false, udp: false });
  // A work network is "DomainAuthenticated" to Windows, and its rules say "Domain".
  assert.deepEqual(firewallCovers(rulesFromObjects([{ profile: 1, program: 'x', protocol: 'Any' }]), { program: 'x', port: 1, profile: 'DomainAuthenticated' }), { tcp: true, udp: true });
});

test('Smart App Control\'s blocks are read from the event\'s data, whatever language its text is in', () => {
  const tail = '\\qbcore-server\\server\\fxserver.exe';
  const events = [
    { text: 'Codeintegrität hat festgestellt, dass ein Prozess ...', data: ['67', '\\Device\\HarddiskVolume3\\QBCore-Server\\server\\libnode22.dll', '61', '\\Device\\HarddiskVolume3\\QBCore-Server\\server\\FXServer.exe', '4', '1', '-1073740760'] },
    { text: 'another program', data: ['\\Device\\HarddiskVolume3\\Games\\other.dll', '\\Device\\HarddiskVolume3\\Games\\other.exe'] },
  ];
  assert.deepEqual(blockedFromEventData(events, tail), ['libnode22.dll']);
  assert.deepEqual(blockedFromEventData({ data: '\\Device\\x\\FXServer.exe' }, tail), [], 'no file named, nothing invented');
});

// ---------------------------------------------------------------- ports and shared FiveM folders
const row = (pid, parent, ports, extra = {}) => ({
  ProcessId: pid, ParentProcessId: parent, Name: 'FXServer.exe', ExecutablePath: 'D:\\FiveM\\server\\FXServer.exe', CommandLine: 'FXServer.exe', ...(ports === undefined ? {} : { Ports: ports }), ...extra,
});

test('two servers started from one FiveM folder: this one is the txAdmin on its own port', () => {
  const rows = [
    row(10, 1, [40120]), row(11, 10, [30120]),
    row(20, 1, [40121]), row(21, 20, [30121]),
  ];
  const mine = ownProcesses(rows, { fxserverDir: 'D:\\FiveM\\server', dbHome: 'D:\\none', managedDb: false, txAdminPort: 40121 });
  assert.equal(mine.monitor.ProcessId, 20);
  assert.equal(mine.game.ProcessId, 21);
  const theirs = ownProcesses(rows, { fxserverDir: 'D:\\FiveM\\server', dbHome: 'D:\\none', managedDb: false, txAdminPort: 40120 });
  assert.equal(theirs.monitor.ProcessId, 10);
  // Only the other server runs: this one is off, and Stop can never reach the other one.
  const onlyOther = ownProcesses(rows.slice(0, 2).concat(row(30, 1, [40122])), { fxserverDir: 'D:\\FiveM\\server', dbHome: 'D:\\none', managedDb: false, txAdminPort: 40121 });
  assert.equal(onlyOther.monitor, null);
  assert.equal(onlyOther.game, null);
});

test('one server, or no port details: the same choice as before', () => {
  assert.equal(pickMonitor([row(10, 1, [40120])], 40999).ProcessId, 10, 'a single txAdmin is this server\'s, whatever its port');
  assert.equal(pickMonitor([row(10, 1), row(20, 1)], 40121).ProcessId, 10, 'without port details, the first, as before');
  assert.equal(pickMonitor([row(10, 1, 40121), row(20, 1, [])], 40121).ProcessId, 10, 'one port can come as a plain number');
  assert.equal(pickMonitor([], 40120), null);
});

test('a program holding a port is named in plain words', () => {
  assert.equal(describeOwner({ pid: 812, name: 'FXServer.exe', path: 'D:\\Other-Server\\server\\FXServer.exe' }), 'FXServer.exe (D:\\Other-Server\\server)');
  assert.equal(describeOwner({ pid: 4, name: 'System', path: '' }), 'Windows itself');
  assert.equal(describeOwner({ pid: 9000, name: 'svchost.exe', path: '' }), 'svchost.exe');
  assert.equal(describeOwner(null), 'another program');
});
// ---------------------------------------------------------------- the network phone access is on
test('phone access knows when Windows calls its network Public', () => {
  const adapters = {
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.29.0.1' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  };
  assert.deepEqual(pickNetwork({ alias: 'Wi-Fi', name: 'Home', category: 'Public' }, adapters), { category: 'Public', name: 'Home', page: 'wifi' });
  assert.deepEqual(pickNetwork([{ alias: 'Ethernet', name: 'Office', category: 'DomainAuthenticated' }], { Ethernet: [{ family: 'IPv4', address: '10.0.0.5' }] }), { category: 'Work', name: 'Office', page: 'ethernet' });
  // Several networks: phone access listens on all of them, so the least private one counts.
  const both = { ...adapters, Ethernet: [{ family: 'IPv4', internal: false, address: '10.1.1.2' }] };
  assert.equal(pickNetwork([{ alias: 'Ethernet', category: 'Private' }, { alias: 'Wi-Fi', category: 'Public' }], both).category, 'Public');
  // A network without a home address on this PC (a VPN, say) doesn't count when one with one exists.
  assert.equal(pickNetwork([{ alias: 'Wi-Fi', category: 'Private' }, { alias: 'Corp VPN', category: 'Public' }], adapters).category, 'Private');
  assert.equal(pickNetwork([], adapters), null);
});