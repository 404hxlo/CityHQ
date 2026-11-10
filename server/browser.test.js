import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snippetAround } from './browser.js';
import { assertSafeRel, looksLikeText } from './files.js';
import { parseManifest } from './resources.js';

test('paths Windows would quietly treat as another file are refused', () => {
  for (const bad of ['server.cfg.', 'server.cfg ', 'server.cfg::$DATA', 'resources/x./y.lua', 'C:\\Windows\\win.ini', 'a\0b', ['server.cfg'], undefined]) {
    assert.throws(() => assertSafeRel(bad), /Invalid path/, `should refuse ${String(bad)}`);
  }
});

test('normal server paths are allowed', () => {
  for (const good of ['', 'server.cfg', 'resources/[qb]/qb-core/config.lua', 'resources/[standalone]/.gitignore', 'a b/c.d/e.lua', '../outside.lua']) {
    assert.doesNotThrow(() => assertSafeRel(good), `should allow ${good}`);
  }
});

test('text and binary files are told apart', () => {
  assert.equal(looksLikeText(Buffer.from('local x = 1\r\nprint(x)\n\ttabbed')), true);
  assert.equal(looksLikeText(Buffer.from('héllo wörld, ünïcode ✓')), true);
  assert.equal(looksLikeText(Buffer.alloc(0)), true);
  assert.equal(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), false);
  assert.equal(looksLikeText(Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : 65)))), false);
});

test('manifests report what a resource provides and needs', () => {
  const one = parseManifest("fx_version 'cerulean'\nprovide 'require'\ndependency 'ox_lib'\n");
  assert.deepEqual(one.provides, ['require']);
  assert.deepEqual(one.dependencies, ['ox_lib']);
  const many = parseManifest("provides {\n  'mysql-async',\n  'ghmattimysql',\n}\ndependencies {\n  '/server:7290',\n  'require',\n}\n");
  assert.deepEqual(many.provides, ['mysql-async', 'ghmattimysql']);
  assert.deepEqual(many.dependencies, ['require']);
  assert.deepEqual(parseManifest("name 'x'\n").provides, []);
});

test('search snippets stay short on huge lines', () => {
  const line = `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}`;
  const snippet = snippetAround(line, 5000, 6);
  assert.ok(snippet.includes('NEEDLE'));
  assert.ok(snippet.length < 200);
  assert.ok(snippet.startsWith('...') && snippet.endsWith('...'));
  assert.equal(snippetAround('    Config.Enabled = true', 4, 6), 'Config.Enabled = true');
});
