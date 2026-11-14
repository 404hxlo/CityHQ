// Signing in and the checks in front of the local API: what stops other websites, DNS tricks and
// guessed passcodes from driving the server, and recovering damaged settings at start. Everything
// is kept in a temporary folder, never a real server's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'cityhq-auth-'));
const ROOT = path.join(SCRATCH, 'server');
const STATE = path.join(ROOT, '.qbcontrol');
process.env.QBC_ROOT = ROOT;
process.env.QBC_HOME = path.join(SCRATCH, 'home');
process.env.QBC_PORT = '40999';
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// The settings file is damaged before CityHQ starts (a power cut while saving), with a good copy
// from the last start beside it.
mkdirSync(STATE, { recursive: true });
const SAVED = { passcode: '24681357', agentToken: 'c'.repeat(64), lanEnabled: true, sessions: {} };
writeFileSync(path.join(STATE, 'settings.json.bak'), JSON.stringify(SAVED));
writeFileSync(path.join(STATE, 'settings.json'), '{"passcode": "246');

const { getSettings, regeneratePasscode } = await import('./settings.js');
const auth = await import('./auth.js');
const { listEvents } = await import('./events.js');

test('damaged settings at start: the last good copy is used, the damaged file kept, and you are told', () => {
  const s = getSettings();
  assert.equal(s.passcode, SAVED.passcode, 'phones keep the same passcode');
  assert.equal(s.agentToken, SAVED.agentToken, 'the helper keeps working without a server restart');
  assert.equal(s.lanEnabled, true);
  assert.equal(JSON.parse(readFileSync(path.join(STATE, 'settings.json'), 'utf8')).passcode, SAVED.passcode, 'saved again in good shape');
  const damaged = readdirSync(STATE).filter((n) => n.startsWith('settings.json.damaged-'));
  assert.equal(damaged.length, 1);
  assert.equal(readFileSync(path.join(STATE, damaged[0]), 'utf8'), '{"passcode": "246');
  const alert = listEvents().find((e) => e.title === 'CityHQ\'s settings file was damaged');
  assert.equal(alert?.level, 'alert');
});

// ---------------------------------------------------------------- the request guard
function guard(req) {
  const out = { status: null, body: null, next: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  auth.requestGuard({ method: 'GET', ...req, headers: { ...req.headers } }, res, () => { out.next = true; });
  return out;
}

test('requests for this app by its own address get through', () => {
  assert.equal(guard({ headers: { host: '127.0.0.1:40999' } }).next, true);
  assert.equal(guard({ headers: { host: 'localhost:40999' } }).next, true);
  assert.equal(guard({ method: 'POST', headers: { host: '127.0.0.1:40999', origin: 'http://127.0.0.1:40999', 'x-qbc-client': '1' } }).next, true);
});

test('a website pointing its own name at this PC (DNS rebinding) is refused', () => {
  for (const host of ['evil.example:40999', 'evil.example', '127.0.0.1:80', '127.0.0.1', '[::1]:40999', '']) {
    const out = guard({ headers: { host } });
    assert.equal(out.next, false, host);
    assert.equal(out.status, 403, host);
    assert.equal(out.body.error, 'Forbidden host');
  }
});

test('requests made by another website in the same browser are refused', () => {
  const fromOtherSite = guard({ method: 'POST', headers: { host: '127.0.0.1:40999', origin: 'https://evil.example', 'x-qbc-client': '1' } });
  assert.equal(fromOtherSite.status, 403);
  assert.equal(fromOtherSite.body.error, 'Forbidden origin');
  assert.equal(guard({ headers: { host: '127.0.0.1:40999', origin: 'null' } }).status, 403, 'a sandboxed page or file says null');
  // A plain form post can't add CityHQ's own header, so changes without it are refused.
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const out = guard({ method, headers: { host: '127.0.0.1:40999' } });
    assert.equal(out.status, 403, method);
    assert.equal(out.body.error, 'Missing client header');
  }
});

test('only a request to the PC\'s own address counts as being on the PC', () => {
  assert.equal(auth.isLocalRequest({ socket: { localAddress: '127.0.0.1' } }), true);
  assert.equal(auth.isLocalRequest({ socket: { localAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(auth.isLocalRequest({ socket: { localAddress: '192.168.1.20' } }), false);
  // A header saying otherwise doesn't count.
  assert.equal(auth.isLocalRequest({ socket: { localAddress: '192.168.1.20' }, headers: { 'x-forwarded-for': '127.0.0.1', host: '127.0.0.1:40999' } }), false);
});

// ---------------------------------------------------------------- sessions and the passcode
const hashOf = (token) => createHash('sha256').update(token).digest('hex');

test('a session works until it is signed out, and is stored only as a hash', () => {
  const token = auth.createSession();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(auth.isValidSession(token), true);
  const saved = readFileSync(path.join(STATE, 'settings.json'), 'utf8');
  assert.equal(saved.includes(token), false, 'the token itself is never saved');
  assert.ok(saved.includes(hashOf(token)));
  auth.destroySession(token);
  assert.equal(auth.isValidSession(token), false);
  assert.equal(auth.isValidSession(''), false);
  assert.equal(auth.isValidSession('not-a-token'), false);
});

test('an expired session no longer works', () => {
  const token = auth.createSession();
  getSettings().sessions[hashOf(token)] = Date.now() - 1000;
  assert.equal(auth.isValidSession(token), false);
});

test('the session cookie can only be read by CityHQ, and only sent by its own pages', () => {
  const headers = {};
  auth.setSessionCookie({ setHeader: (k, v) => { headers[k] = v; } }, 'abc');
  assert.match(headers['Set-Cookie'], /^qbc_session=abc; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
  assert.equal(auth.readCookie({ headers: { cookie: 'other=1; qbc_session=abc; more=2' } }), 'abc');
  assert.equal(auth.readCookie({ headers: {} }), null);
});

test('the right passcode signs in, with or without spaces', () => {
  assert.match(auth.loginWithPasscode('10.0.0.5', SAVED.passcode), /^[a-f0-9]{64}$/);
  assert.match(auth.loginWithPasscode('10.0.0.5', ' 2468 1357 '), /^[a-f0-9]{64}$/);
});

test('five wrong passcodes from one address lock it out for a minute; others can still sign in', () => {
  for (let i = 0; i < 5; i++) {
    assert.throws(() => auth.loginWithPasscode('10.0.0.66', '00000000'), (err) => err.status === 401);
  }
  assert.throws(() => auth.loginWithPasscode('10.0.0.66', SAVED.passcode), (err) => err.status === 429 && /Wait \d+ seconds/.test(err.message));
  assert.match(auth.loginWithPasscode('10.0.0.67', SAVED.passcode), /^[a-f0-9]{64}$/);
});

test('a phone pairing code works once, and not after five minutes', () => {
  const code = auth.createPairingToken();
  assert.match(auth.loginWithPairing('10.0.0.8', code), /^[a-f0-9]{64}$/);
  assert.throws(() => auth.loginWithPairing('10.0.0.8', code), (err) => err.status === 401);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const late = auth.createPairingToken();
    mock.timers.tick(5 * 60 * 1000 + 1);
    assert.throws(() => auth.loginWithPairing('10.0.0.9', late), (err) => err.status === 401);
  } finally {
    mock.timers.reset();
  }
});

test('a new passcode signs every device out', () => {
  const token = auth.createSession();
  const before = getSettings().passcode;
  const next = regeneratePasscode();
  assert.match(next, /^\d{8}$/);
  assert.notEqual(next, before);
  assert.equal(auth.isValidSession(token), false);
  assert.throws(() => auth.loginWithPasscode('10.0.0.70', before), (err) => err.status === 401);
});
