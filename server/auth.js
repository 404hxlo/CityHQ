// Sessions, the passcode, one-time phone pairing, and request checks that stop other
// websites or devices from driving the server through this app.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { APP_PORT, HttpError } from './paths.js';
import { getSettings, updateSettings } from './settings.js';

export const COOKIE = 'qbc_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PAIR_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

const hash = (token) => createHash('sha256').update(token).digest('hex');
const attempts = new Map();
let pairing = null;

export function createSession() {
  const token = randomBytes(32).toString('hex');
  const settings = getSettings();
  const now = Date.now();
  const sessions = Object.fromEntries(Object.entries(settings.sessions).filter(([, exp]) => exp > now));
  sessions[hash(token)] = now + SESSION_MS;
  updateSettings({ sessions });
  return token;
}

export function destroySession(token) {
  if (!token) return;
  const { sessions } = getSettings();
  delete sessions[hash(token)];
  updateSettings({ sessions });
}

export function isValidSession(token) {
  if (!token) return false;
  const expires = getSettings().sessions[hash(token)];
  return Boolean(expires && expires > Date.now());
}

export function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function safeEqual(a, b) {
  const x = Buffer.from(hash(String(a)));
  const y = Buffer.from(hash(String(b)));
  return timingSafeEqual(x, y);
}

/** Five wrong tries from one address locks it out for a minute. */
function guard(ip) {
  const entry = attempts.get(ip);
  if (entry?.lockedUntil > Date.now()) {
    throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil((entry.lockedUntil - Date.now()) / 1000)} seconds.`);
  }
}
function recordFail(ip) {
  const entry = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= MAX_FAILS) {
    entry.fails = 0;
    entry.lockedUntil = Date.now() + LOCK_MS;
  }
  attempts.set(ip, entry);
}

export function loginWithPasscode(ip, passcode) {
  guard(ip);
  if (!safeEqual(String(passcode ?? '').replace(/\D/g, ''), getSettings().passcode)) {
    recordFail(ip);
    throw new HttpError(401, 'That passcode is not right.');
  }
  attempts.delete(ip);
  return createSession();
}

export function createPairingToken() {
  pairing = { token: randomBytes(24).toString('hex'), expires: Date.now() + PAIR_MS };
  return pairing.token;
}

export function loginWithPairing(ip, token) {
  guard(ip);
  const valid = pairing && pairing.expires > Date.now() && safeEqual(token ?? '', pairing.token);
  if (!valid) {
    recordFail(ip);
    throw new HttpError(401, 'That code has expired. Show a new QR code in the app.');
  }
  pairing = null;
  attempts.delete(ip);
  return createSession();
}

/** Private home-network IPv4 addresses of this PC. Public addresses are never included. */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/virtual|vmware|vbox|hyper-v|wsl|vethernet|loopback|bluetooth/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

const allowedHosts = () => {
  const set = new Set([`127.0.0.1:${APP_PORT}`, `localhost:${APP_PORT}`]);
  for (const ip of lanAddresses()) set.add(`${ip}:${APP_PORT}`);
  return set;
};

/** Blocks DNS-rebinding and requests made by other websites in the same browser. */
export function requestGuard(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();
  if (!allowedHosts().has(host)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* treated as a mismatch */ }
    if (originHost !== host) return res.status(403).json({ error: 'Forbidden origin' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-qbc-client'] !== '1') {
    return res.status(403).json({ error: 'Missing client header' });
  }
  return next();
}

export function requireSession(req, res, next) {
  if (!isValidSession(readCookie(req))) return res.status(401).json({ error: 'Please sign in' });
  return next();
}

/** The real listening address tells us whether the request came from this PC. */
export const isLocalRequest = (req) => req.socket.localAddress === '127.0.0.1' || req.socket.localAddress === '::ffff:127.0.0.1';
