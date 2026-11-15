// Changing files from the Files page: replacing, adding, new folders, renaming and deleting, and
// undoing each. Everything happens in a temporary server folder; the helper port in it is unused,
// so nothing here can reach a real server.
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'cityhq-files-'));
const ROOT = path.join(SCRATCH, 'server');
const DATA = path.join(ROOT, 'txData', 'test.base');
const RES = path.join(DATA, 'resources');
const HELPER = path.join(RES, '[local]', 'qb-control');
const LOADING = path.join(RES, '[standalone]', 'my-loading');
const PICS = 'resources/[standalone]/my-loading/images';

mkdirSync(HELPER, { recursive: true });
mkdirSync(path.join(LOADING, 'images'), { recursive: true });
mkdirSync(path.join(RES, '[cars]', 'fast-car', 'stream'), { recursive: true });
writeFileSync(path.join(ROOT, 'qbcontrol.json'), JSON.stringify({ gamePort: 30997, txAdminPort: 40997, database: 'external' }));
writeFileSync(path.join(DATA, 'server.cfg'), 'endpoint_add_tcp "0.0.0.0:30997"\nendpoint_add_udp "0.0.0.0:30997"\nensure my-loading\nensure fast-car\n');
writeFileSync(path.join(HELPER, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
writeFileSync(path.join(HELPER, 'token.txt'), 'not-a-real-token');
writeFileSync(path.join(LOADING, 'fxmanifest.lua'), "fx_version 'cerulean'\nloadscreen 'index.html'\n");
writeFileSync(path.join(LOADING, 'config.cfg'), 'set something "x"\n');
writeFileSync(path.join(LOADING, 'images', 'bg1.webp'), 'old picture');
writeFileSync(path.join(LOADING, 'images', 'music1.mp3'), 'ID3 0123456789 sound');
writeFileSync(path.join(RES, '[cars]', 'fast-car', 'fxmanifest.lua'), "fx_version 'cerulean'\n");
writeFileSync(path.join(RES, '[cars]', 'fast-car', 'stream', 'car.yft'), 'model');
process.env.QBC_ROOT = ROOT;
process.env.QBC_HOME = path.join(SCRATCH, 'home');
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const changes = await import('./filechanges.js');
const {
  addFromUpload, checkUploads, contentLength, deleteItem, FILE_PAGE_UNDO, KEPT_DIR, LOCKS, lockFor, makeFolder, nameProblem, placeOf,
  pruneKept, realKey, renameItem, replaceFromUpload,
} = changes;
const { browseFolder, fileDetails, sendRaw } = await import('./browser.js');
const { listChanges, registerUndo, undoChange } = await import('./history.js');
const { TRASH_DIR } = await import('./paths.js');
for (const [type, undo] of Object.entries(FILE_PAGE_UNDO)) registerUndo(type, undo);

const body = (text) => Readable.from([Buffer.from(text)]);
const replaceWith = (rel, text) => replaceFromUpload(body(text), rel, Buffer.byteLength(text));
const addWith = (folder, name, text) => addFromUpload(body(text), folder, name, Buffer.byteLength(text));
const at = (rel) => path.join(DATA, ...rel.split('/'));
const read = (rel) => readFileSync(at(rel), 'utf8');
const leftovers = (rel) => readdirSync(at(rel)).filter((n) => n.endsWith('.qbctmp'));
const refused = async (promise, status) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, err.message);
    return true;
  });
};

// ---------------------------------------------------------------- names and what is protected
test('names Windows or CityHQ would trip over are refused, with the reason', () => {
  for (const ok of ['bg7.webp', 'New folder', 'music (2).mp3', '[cars]', 'qb-core', 'résumé.txt']) assert.equal(nameProblem(ok), null, ok);
  assert.match(nameProblem(''), /Type a name/);
  assert.match(nameProblem(' bg.webp'), /space/);
  assert.match(nameProblem('bg.webp '), /space/);
  assert.match(nameProblem('a/b'), /can't have/);
  assert.match(nameProblem('what?.txt'), /can't have/);
  assert.match(nameProblem('ends.'), /dot/);
  assert.match(nameProblem('CON'), /Windows keeps the name CON/);
  assert.match(nameProblem('nul.txt'), /Windows keeps the name NUL/);
  assert.match(nameProblem('lpt1.log'), /LPT1/);
  assert.match(nameProblem('half.webp.qbctmp'), /qbctmp/);
  assert.equal(nameProblem('console.lua'), null, 'only the exact device names are reserved');
});

test('the server folder, the helper, the folders holding them, and .cfg files are protected', () => {
  const place = placeOf(DATA, path.join(DATA, 'server.cfg'));
  assert.equal(lockFor(realKey(DATA), true, place), 'root');
  assert.equal(lockFor(realKey(HELPER), true, place), 'helper');
  assert.equal(lockFor(realKey(path.join(HELPER, 'fxmanifest.lua')), false, place), 'helper');
  assert.equal(lockFor(realKey(RES), true, place), 'holds-helper');
  assert.equal(lockFor(realKey(path.join(RES, '[local]')), true, place), 'holds-helper');
  assert.equal(lockFor(realKey(path.join(DATA, 'server.cfg')), false, place), 'cfg');
  assert.equal(lockFor(realKey(path.join(DATA, 'server.cfg.bkp')), false, place), 'cfg');
  assert.equal(lockFor(realKey(path.join(LOADING, 'config.cfg')), false, place), 'cfg');
  assert.equal(lockFor(realKey(LOADING), true, place), null);
  assert.equal(lockFor(realKey(path.join(LOADING, 'images', 'bg1.webp')), false, place), null);
  assert.ok(LOCKS.cfg.includes('editor'));
});

// ---------------------------------------------------------------- replacing
test('a replaced file keeps its name, the old one is kept, and Undo puts it back', async () => {
  const result = await replaceWith(`${PICS}/bg1.webp`, 'new picture');
  assert.equal(read(`${PICS}/bg1.webp`), 'new picture');
  assert.equal(result.path, `${PICS}/bg1.webp`);
  assert.ok(result.change?.id, 'there is an Undo for it');
  assert.equal(result.script?.name, 'my-loading');
  assert.equal(result.script?.loadscreen, true, 'a loading screen applies at the next join');
  assert.equal(result.script?.state, 'offline');
  assert.deepEqual(leftovers(PICS), []);

  const record = (await listChanges()).find((c) => c.id === result.change.id);
  assert.equal(record.title, 'Replaced bg1.webp');
  assert.match(record.detail, /my-loading\/images/);
  assert.equal(record.undoable, true);

  await undoChange(result.change.id);
  assert.equal(read(`${PICS}/bg1.webp`), 'old picture');
  // Putting it back is a change too, and can itself be undone.
  const putBack = (await listChanges()).find((c) => c.title === 'Put back the earlier bg1.webp');
  assert.ok(putBack?.undoable);
  await undoChange(putBack.id);
  assert.equal(read(`${PICS}/bg1.webp`), 'new picture');
  assert.deepEqual(leftovers(PICS), []);
});

test('.cfg files and the helper\'s files are never replaced from the Files page', async () => {
  await refused(replaceWith('resources/[standalone]/my-loading/config.cfg', 'set something "y"'), 403);
  assert.equal(read('resources/[standalone]/my-loading/config.cfg'), 'set something "x"\n');
  await refused(replaceWith('server.cfg', 'x'), 403);
  await refused(replaceWith('resources/[local]/qb-control/fxmanifest.lua', 'x'), 403);
  await refused(replaceWith('resources/[local]/qb-control/token.txt', 'x'), 403);
  assert.equal(readFileSync(path.join(HELPER, 'token.txt'), 'utf8'), 'not-a-real-token');
  await refused(replaceWith('../outside.txt', 'x'), 400);
  await refused(replaceWith('resources/[standalone]/my-loading/images', 'x'), 400);
});

test('an upload that stops early changes nothing and leaves nothing behind', async () => {
  const before = read(`${PICS}/music1.mp3`);
  await refused(replaceFromUpload(body('only part'), `${PICS}/music1.mp3`, 5000), 400);
  assert.equal(read(`${PICS}/music1.mp3`), before);
  await refused(addFromUpload(body('only part'), PICS, 'half.webp', 5000), 400);
  assert.equal(existsSync(at(`${PICS}/half.webp`)), false);
  assert.deepEqual(leftovers(PICS), []);
  await refused(replaceFromUpload(body('x'), `${PICS}/music1.mp3`, Number.NaN), 411);
});

test('the upload size comes from the request, and an odd one counts as missing', () => {
  assert.equal(contentLength({ headers: { 'content-length': '1234' } }), 1234);
  assert.equal(contentLength({ headers: { 'content-length': '0' } }), 0);
  assert.ok(Number.isNaN(contentLength({ headers: {} })));
  assert.ok(Number.isNaN(contentLength({ headers: { 'content-length': '-5' } })));
  assert.ok(Number.isNaN(contentLength({ headers: { 'content-length': '12abc' } })));
});

// ---------------------------------------------------------------- adding
test('new files are added, a taken name is refused, and Undo deletes the new one again', async () => {
  const result = await addWith(PICS, 'bg3.webp', 'third picture');
  assert.equal(read(`${PICS}/bg3.webp`), 'third picture');
  assert.equal(result.script?.name, 'my-loading');
  await refused(addWith(PICS, 'bg3.webp', 'again'), 409);
  await refused(addWith(PICS, 'BG3.webp', 'again'), 409);
  await refused(addWith(PICS, 'bad|name.webp', 'x'), 400);
  await refused(addWith('resources/[local]/qb-control', 'extra.lua', 'x'), 403);
  assert.equal(existsSync(path.join(HELPER, 'extra.lua')), false);

  await undoChange(result.change.id);
  assert.equal(existsSync(at(`${PICS}/bg3.webp`)), false);
  assert.ok(readdirSync(KEPT_DIR).length > 0, 'it is kept, not gone');
});

test('a file can be added to the server folder itself and to a folder holding the helper', async () => {
  await addWith('', 'myLogo.png', 'logo');
  assert.equal(read('myLogo.png'), 'logo');
  await addWith('resources/[local]', 'notes.txt', 'notes');
  assert.equal(read('resources/[local]/notes.txt'), 'notes');
});

test('before sending, the check says which files are already there and which can\'t be added', async () => {
  const check = await checkUploads(PICS, [
    { name: 'BG1.webp', size: 10 },
    { name: 'bg9.webp', size: 10 },
    { name: 'what?.webp', size: 10 },
    { name: 'huge.webm', size: 5 * 1024 ** 3 },
  ]);
  assert.equal(check.files[0].existing, 'bg1.webp', 'matched however it is spelled');
  assert.equal(check.files[0].problem, null);
  assert.equal(check.files[1].existing, null);
  assert.equal(check.files[1].problem, null);
  assert.match(check.files[2].problem, /can't have/);
  assert.match(check.files[3].problem, /4 GB/);

  const cfg = await checkUploads('resources/[standalone]/my-loading', [{ name: 'config.cfg', size: 3 }, { name: 'images', size: 3 }]);
  assert.match(cfg.files[0].problem, /\.cfg/);
  assert.match(cfg.files[1].problem, /folder named images/);
  await refused(checkUploads('resources/[local]/qb-control', [{ name: 'a.lua', size: 1 }]), 403);
  await refused(checkUploads(PICS, []), 400);
});

// ---------------------------------------------------------------- folders, renaming, deleting
test('a new folder is made, a taken name is refused, and Undo removes it again', async () => {
  const result = await makeFolder(PICS, 'night');
  assert.ok(existsSync(at(`${PICS}/night`)));
  await refused(makeFolder(PICS, 'night'), 409);
  await refused(makeFolder(PICS, 'CON'), 400);
  await undoChange(result.change.id);
  assert.equal(existsSync(at(`${PICS}/night`)), false);
});

test('renaming works, a case-only rename too, and Undo gives the old name back', async () => {
  await addWith(PICS, 'music.mp3', 'sound');
  const result = await renameItem(`${PICS}/music.mp3`, 'music2.mp3');
  assert.equal(result.path, `${PICS}/music2.mp3`);
  assert.equal(read(`${PICS}/music2.mp3`), 'sound');
  await refused(renameItem(`${PICS}/music2.mp3`, 'bg1.webp'), 409);
  const cased = await renameItem(`${PICS}/music2.mp3`, 'Music2.mp3');
  assert.ok(readdirSync(at(PICS)).includes('Music2.mp3'));
  await undoChange(cased.change.id);
  await undoChange(result.change.id);
  assert.ok(readdirSync(at(PICS)).includes('music.mp3'));

  await refused(renameItem('resources/[standalone]/my-loading/config.cfg', 'config.txt'), 403);
  await refused(renameItem('server.cfg', 'old.cfg'), 403);
  await refused(renameItem('resources', 'scripts'), 403);
  await refused(renameItem('', 'x'), 403);
});

test('renaming a script\'s folder says what server.cfg needs', async () => {
  const result = await renameItem('resources/[cars]/fast-car', 'quick-car');
  assert.match(result.note, /ensure fast-car/);
  assert.match(result.note, /ensure quick-car/);
  await undoChange(result.change.id);
  assert.ok(existsSync(path.join(RES, '[cars]', 'fast-car', 'stream', 'car.yft')));
});

test('a deleted file is kept, and Undo brings it back unless something took its place', async () => {
  await addWith(PICS, 'bg5.webp', 'temporary');
  const result = await deleteItem(`${PICS}/bg5.webp`);
  assert.equal(existsSync(at(`${PICS}/bg5.webp`)), false);
  assert.equal(result.script?.name, 'my-loading');
  await undoChange(result.change.id);
  assert.equal(read(`${PICS}/bg5.webp`), 'temporary');

  const again = await deleteItem(`${PICS}/bg5.webp`);
  await addWith(PICS, 'bg5.webp', 'a different one');
  await refused(undoChange(again.change.id), 409);
  assert.equal(read(`${PICS}/bg5.webp`), 'a different one', 'the new file is left alone');
});

test('a deleted folder comes back whole', async () => {
  await makeFolder(PICS, 'old');
  await addWith(`${PICS}/old`, 'a.webp', 'one');
  await addWith(`${PICS}/old`, 'b.webp', 'two');
  const result = await deleteItem(`${PICS}/old`);
  assert.equal(existsSync(at(`${PICS}/old`)), false);
  await undoChange(result.change.id);
  assert.deepEqual(readdirSync(at(`${PICS}/old`)).sort(), ['a.webp', 'b.webp']);
});

test('the server folder, the helper, folders holding them and .cfg files can\'t be deleted', async () => {
  await refused(deleteItem(''), 403);
  await refused(deleteItem('.'), 403);
  await refused(deleteItem('resources'), 403);
  await refused(deleteItem('resources/[local]'), 403);
  await refused(deleteItem('resources/[local]/qb-control'), 403);
  await refused(deleteItem('resources/[local]/qb-control/token.txt'), 403);
  await refused(deleteItem('server.cfg'), 403);
  await refused(deleteItem('resources/[standalone]/my-loading/config.cfg'), 403);
  assert.ok(existsSync(path.join(HELPER, 'token.txt')));
  assert.ok(existsSync(path.join(DATA, 'server.cfg')));
});

test('a folder of scripts is deleted with a note about the lines server.cfg still has', async () => {
  const result = await deleteItem('resources/[cars]');
  assert.match(result.note, /fast-car/);
  await undoChange(result.change.id);
  assert.ok(existsSync(path.join(RES, '[cars]', 'fast-car', 'fxmanifest.lua')));
});

test('deleting a script\'s own folder removes the script the way the Resources page does', async () => {
  const extra = path.join(RES, '[standalone]', 'old-script');
  mkdirSync(extra, { recursive: true });
  writeFileSync(path.join(extra, 'fxmanifest.lua'), "fx_version 'cerulean'\n");
  const result = await deleteItem('resources/[standalone]/old-script');
  assert.equal(result.removedScript, 'old-script');
  assert.equal(existsSync(extra), false);
  assert.ok(readdirSync(TRASH_DIR).some((n) => n.endsWith('-old-script')), 'it is in Recently removed');
  assert.ok(result.change?.id);
});

test('kept copies older than 30 days are cleared away', async () => {
  const old = `${Date.now() - 31 * 24 * 60 * 60 * 1000}-abcdef`;
  mkdirSync(path.join(KEPT_DIR, old), { recursive: true });
  writeFileSync(path.join(KEPT_DIR, `${old}.json`), '{}');
  const fresh = `${Date.now()}-123456`;
  mkdirSync(path.join(KEPT_DIR, fresh), { recursive: true });
  await pruneKept(Date.now(), { force: true });
  assert.equal(existsSync(path.join(KEPT_DIR, old)), false);
  assert.equal(existsSync(path.join(KEPT_DIR, `${old}.json`)), false);
  assert.ok(existsSync(path.join(KEPT_DIR, fresh)));
});

// ---------------------------------------------------------------- what the Files page shows
test('the folder list hides files still being saved and says what may be changed', async () => {
  writeFileSync(at(`${PICS}/bg1.webp.123-abcd.qbctmp`), 'half');
  utimesSync(at(`${PICS}/bg1.webp.123-abcd.qbctmp`), new Date(), new Date());
  const pics = await browseFolder(PICS);
  assert.equal(pics.canChange, true);
  assert.equal(pics.lock, null);
  assert.ok(!pics.entries.some((e) => e.name.endsWith('.qbctmp')));
  assert.equal(pics.entries.find((e) => e.name === 'music1.mp3').kind, 'audio');

  const top = await browseFolder('');
  assert.equal(top.lock, 'root');
  assert.equal(top.entries.find((e) => e.name === 'server.cfg').lock, 'cfg');
  assert.equal(top.entries.find((e) => e.name === 'resources').lock, 'holds-helper');

  const script = await browseFolder('resources/[standalone]/my-loading');
  assert.equal(script.resource, true);
  const standalone = await browseFolder('resources/[standalone]');
  assert.equal(standalone.entries.find((e) => e.name === 'my-loading').resource, true);
  assert.equal((await browseFolder('resources/[local]/qb-control')).lock, 'helper');

  const details = await fileDetails(`${PICS}/music1.mp3`);
  assert.equal(details.kind, 'audio');
  assert.equal(details.lock, null);
  assert.equal((await fileDetails('server.cfg')).lock, 'cfg');
});

test('sounds play from any point: the player gets just the part it asks for', async () => {
  const { default: express } = await import('express');
  const app = express();
  app.get('/raw', async (req, res) => {
    try { await sendRaw(res, req.query.path, false); } catch (err) { res.status(err.status || 500).end(); }
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/raw?path=${encodeURIComponent(`${PICS}/music1.mp3`)}`;
    const part = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await part.text(), 'ID3 ');
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('cache-control'), 'no-store');
    assert.equal(await whole.text(), 'ID3 0123456789 sound');
  } finally {
    server.close();
  }
});
