import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addBootLine, ensureManagedBlock, forgetBootLines, maskSecrets, parseBoot, parseConnection, removeBootLine, restoreSecrets, SECRET_MASK,
} from './cfg.js';
import { applyFieldChanges, parseCfgFields, parseLuaFields } from './fields.js';

const LUA = `QBCore = {}
QBCore.Config = {}

QBCore.Config.MaxPlayers = GetConvarInt('sv_maxclients', 48) -- not a simple value
QBCore.Config.UpdateInterval = 5 -- how often to update
QBCore.Config.Name = "Los Santos" -- server name
Config = {
    -- Turns the thing on
    Enabled = true,
    Price = 12.5,
    ['Odd Key'] = 'x',
    Nested = {
        Deep = false, -- deep comment
    },
    Locations = {
        { coords = 1, label = "skip me" },
        {
            label = "skip me too",
        },
    },
}
--[[ Commented = true ]]
local Hidden = 1
function Foo()
    Config.Inner = true
    local a = 1
end
Config.After = 3 -- still seen
`;

test('parses simple Lua settings with paths, types and help', () => {
  const byKey = Object.fromEntries(parseLuaFields(LUA).map((f) => [f.key, f]));
  assert.equal(byKey['QBCore.Config.UpdateInterval'].value, 5);
  assert.equal(byKey['QBCore.Config.UpdateInterval'].help, 'how often to update');
  assert.equal(byKey['QBCore.Config.Name'].value, 'Los Santos');
  assert.equal(byKey['Config.Enabled'].value, true);
  assert.equal(byKey['Config.Enabled'].help, 'Turns the thing on');
  assert.equal(byKey['Config.Price'].value, 12.5);
  assert.equal(byKey['Config.Odd Key'].value, 'x');
  assert.equal(byKey['Config.Nested.Deep'].value, false);
  assert.equal(byKey['Config.After'].value, 3);
});

test('skips calculated values, lists, comments, locals and function bodies', () => {
  const keys = parseLuaFields(LUA).map((f) => f.key);
  assert.ok(!keys.includes('QBCore.Config.MaxPlayers'));
  assert.ok(!keys.some((k) => k.includes('label') || k.includes('coords')));
  assert.ok(!keys.includes('Commented'));
  assert.ok(!keys.includes('Hidden'));
  assert.ok(!keys.includes('Config.Inner'));
});

test('writes only the changed values and keeps comments and line endings', () => {
  const crlf = LUA.replace(/\n/g, '\r\n');
  const fields = parseLuaFields(crlf);
  const id = (key) => fields.find((f) => f.key === key).id;
  const out = applyFieldChanges(crlf, 'lua', [
    { id: id('QBCore.Config.UpdateInterval'), value: 10 },
    { id: id('QBCore.Config.Name'), value: 'New "City"' },
    { id: id('Config.Enabled'), value: false },
    { id: id('Config.Nested.Deep'), value: true },
  ]);
  assert.ok(out.includes('QBCore.Config.UpdateInterval = 10 -- how often to update\r\n'));
  assert.ok(out.includes('QBCore.Config.Name = "New \\"City\\"" -- server name'));
  assert.ok(out.includes('    Enabled = false,\r\n'));
  assert.ok(out.includes('Deep = true, -- deep comment'));
  assert.equal(out.split('\r\n').length, crlf.split('\r\n').length);
});

test('rejects bad values and stale edits', () => {
  const field = parseLuaFields(LUA).find((f) => f.key === 'Config.Price');
  assert.throws(() => applyFieldChanges(LUA, 'lua', [{ id: field.id, value: 'abc' }]), /must be a number/);
  assert.throws(() => applyFieldChanges(LUA, 'lua', [{ id: '999:Nope', value: 1 }]), /changed since/);
  const str = parseLuaFields(LUA).find((f) => f.key === 'QBCore.Config.Name');
  assert.throws(() => applyFieldChanges(LUA, 'lua', [{ id: str.id, value: 'a\nb' }]), /line breaks/);
});

const CFG = `# header
sv_licenseKey "cfxk_secret_value"
sv_maxclients 48
set mysql_connection_string "mysql://root:pw@127.0.0.1:3308/qb?charset=utf8mb4"
setr voice_defaultVolume 0.3
setr UseTarget false # toggle target
set steam_webApiKey "none"
ensure mapmanager
ensure qb-core
ensure [qb]
# ensure commented
add_ace group.admin command allow
`;

test('server.cfg settings never include secrets or commands', () => {
  const keys = parseCfgFields(CFG).map((f) => f.key);
  assert.deepEqual(keys, ['sv_maxclients', 'voice_defaultVolume', 'UseTarget']);
  const target = parseCfgFields(CFG).find((f) => f.key === 'UseTarget');
  assert.equal(target.value, false);
  assert.equal(target.help, 'toggle target');
  const out = applyFieldChanges(CFG, 'cfg', [{ id: target.id, value: true }]);
  assert.ok(out.includes('setr UseTarget true # toggle target'));
});

test('secrets are masked and restored exactly', () => {
  const masked = maskSecrets(CFG);
  assert.ok(!masked.includes('cfxk_secret_value'));
  assert.ok(!masked.includes('mysql://root:pw'));
  assert.ok(masked.includes(SECRET_MASK));
  assert.ok(masked.includes('sv_maxclients 48'));
  const edited = masked.replace('sv_maxclients 48', 'sv_maxclients 64');
  const restored = restoreSecrets(edited, CFG);
  assert.equal(restored, CFG.replace('sv_maxclients 48', 'sv_maxclients 64'));
});

test('boot parsing and editing', () => {
  const boot = parseBoot(CFG);
  assert.ok(boot.names.has('qb-core'));
  assert.ok(boot.categories.has('[qb]'));
  assert.ok(!boot.names.has('commented'));

  const off = removeBootLine(CFG, 'mapmanager');
  assert.ok(!parseBoot(off).names.has('mapmanager'));
  assert.ok(parseBoot(off).turnedOff.has('mapmanager'));
  const on = addBootLine(off, 'mapmanager');
  assert.equal(on, CFG);

  const added = addBootLine(CFG, 'my-script');
  assert.ok(parseBoot(added).names.has('my-script'));
  assert.ok(parseBoot(added).names.has('qb-control'));
  assert.ok(added.includes('add_ace resource.qb-control command allow'));
  assert.equal(addBootLine(added, 'my-script'), added);
  assert.ok(!parseBoot(forgetBootLines(added, 'my-script')).names.has('my-script'));
  assert.equal(ensureManagedBlock(ensureManagedBlock(CFG)), ensureManagedBlock(CFG));
});

test('names are matched exactly when editing boot lines', () => {
  const cfg = 'ensure qb-core\nensure qb-core-extra\n';
  const out = removeBootLine(cfg, 'qb-core');
  assert.ok(parseBoot(out).names.has('qb-core-extra'));
  assert.ok(!parseBoot(out).names.has('qb-core'));
});

test('connection strings in both forms', () => {
  assert.deepEqual(parseConnection('mysql://root@127.0.0.1:3308/qb?charset=utf8mb4'), {
    host: '127.0.0.1', port: '3308', user: 'root', password: '', database: 'qb',
  });
  assert.deepEqual(parseConnection('server=127.0.0.1;uid=root;password=x;database=qb;port=3307'), {
    host: '127.0.0.1', port: '3307', user: 'root', password: 'x', database: 'qb',
  });
});
