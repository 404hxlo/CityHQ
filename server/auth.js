// Sessions, the passcode, one-time phone pairing, and request checks that stop other
// websites or devices from driving the server through this app.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { APP_PORT, HttpError } from './paths.js';
import { getSettings, updateSettings } from './settings.js';

export const COOKIE = 'qbc_session';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// Phones sign in over the home network, where the connection isn't encrypted, so for less long.
export const PHONE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const PAIR_MS = 5 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const TOUCH_SAVE_MS = 60 * 1000;

const hash = (token) => createHash('sha256').update(token).digest('hex');
const attempts = new Map();
let pairing = null;
let touchSavedAt = 0;

/** How long a new sign-in lasts: a phone's on the home network, or one on this PC. */
export const sessionLifetime = (local) => (local ? SESSION_MS : PHONE_SESSION_MS);

/**
 * A saved sign-in: { expires, kind, device, createdAt, lastUsed }. kind is 'desktop' (CityHQ's own
 * window), 'browser' (a browser on this PC), 'phone' (a device on the home network) or 'unknown'
 * (signed in before CityHQ kept these details, when only the expiry was saved).
 */
export function sessionRecord(value) {
  if (typeof value === 'number') return { expires: value, kind: 'unknown', device: null, createdAt: null, lastUsed: null };
  return value && typeof value === 'object' && Number.isFinite(value.expires) ? value : null;
}

/**
 * Names a device from its browser's description: "Android phone · Chrome", "iPhone · Safari". Only
 * this short name is kept, never the whole description.
 */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  let device = 'A device';
  if (/iPad/.test(ua)) device = 'iPad';
  else if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/CrOS/.test(ua)) device = 'Chromebook';
  else if (/Windows/.test(ua)) device = 'Windows PC';
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux computer';
  let browser = null;
  if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/EdgA?\/|EdgiOS/.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${device} · ${browser}` : device;
}

export function createSession({ kind = 'desktop', device = null } = {}) {
  const token = randomBytes(32).toString('hex');
  const settings = getSettings();
  const now = Date.now();
  const sessions = Object.fromEntries(Object.entries(settings.sessions).filter(([, value]) => (sessionRecord(value)?.expires || 0) > now));
  sessions[hash(token)] = {
    expires: now + (kind === 'phone' ? PHONE_SESSION_MS : SESSION_MS), kind, device, createdAt: now, lastUsed: now,
  };
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
  const record = sessionRecord(getSettings().sessions[hash(token)]);
  return Boolean(record && record.expires > Date.now());
}

/** Notes when a sign-in was last used. Saved at most once a minute, since phones ask every few seconds. */
export function touchSession(token, now = Date.now()) {
  if (!token) return;
  const { sessions } = getSettings();
  const key = hash(token);
  const record = sessionRecord(sessions[key]);
  if (!record || typeof sessions[key] !== 'object') return;
  record.lastUsed = now;
  if (now - touchSavedAt >= TOUCH_SAVE_MS) {
    touchSavedAt = now;
    updateSettings({ sessions });
  }
}

/** A short id for a sign-in, safe to show and send: the start of its hash, never the token. */
const shortId = (key) => key.slice(0, 16);

/**
 * The phones signed in over the home network, newest first, and how many sign-ins from before
 * CityHQ kept these details are still valid. current: the sign-in asking, which is never listed.
 */
export function listPhones(currentToken, now = Date.now()) {
  const current = currentToken ? hash(currentToken) : null;
  const phones = [];
  let older = 0;
  for (const [key, value] of Object.entries(getSettings().sessions)) {
    const record = sessionRecord(value);
    if (!record || record.expires <= now || key === current) continue;
    if (record.kind === 'phone') {
      phones.push({
        id: shortId(key), device: record.device || 'A device', createdAt: record.createdAt, lastUsed: record.lastUsed, expires: record.expires,
      });
    } else if (record.kind === 'unknown') older += 1;
  }
  return { phones: phones.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)), older };
}

/** Signs out one phone, by the id listPhones gave it. */
export function signOutPhone(id) {
  const { sessions } = getSettings();
  const key = Object.keys(sessions).find((k) => shortId(k) === String(id));
  if (!key || sessionRecord(sessions[key])?.kind !== 'phone') throw new HttpError(404, 'That phone isn\'t signed in any more.');
  delete sessions[key];
  updateSettings({ sessions });
  return { signedOut: 1 };
}

/**
 * Signs out every phone, and any sign-in from before CityHQ kept details (which could be a phone).
 * The sign-in asking, and CityHQ's own window and browsers on this PC, stay signed in.
 */
export function signOutPhones(currentToken) {
  const current = currentToken ? hash(currentToken) : null;
  const { sessions } = getSettings();
  let signedOut = 0;
  for (const [key, value] of Object.entries(sessions)) {
    const kind = sessionRecord(value)?.kind;
    if (key !== current && (kind === 'phone' || kind === 'unknown')) {
      delete sessions[key];
      signedOut += 1;
    }
  }
  updateSettings({ sessions });
  return { signedOut };
}

export function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export function setSessionCookie(res, token, lifetimeMs = SESSION_MS) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(lifetimeMs / 1000)}`);
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

/** What a sign-in from a request is: a phone on the home network, or a browser on this PC. */
const signInKind = ({ local = false, userAgent = '' } = {}) => ({ kind: local ? 'browser' : 'phone', device: deviceLabel(userAgent) });

export function loginWithPasscode(ip, passcode, from = {}) {
  guard(ip);
  if (!safeEqual(String(passcode ?? '').replace(/\D/g, ''), getSettings().passcode)) {
    recordFail(ip);
    throw new HttpError(401, 'That passcode is not right.');
  }
  attempts.delete(ip);
  return createSession(signInKind(from));
}

export function createPairingToken() {
  pairing = { token: randomBytes(24).toString('hex'), expires: Date.now() + PAIR_MS };
  return pairing.token;
}

export function loginWithPairing(ip, token, from = {}) {
  guard(ip);
  const valid = pairing && pairing.expires > Date.now() && safeEqual(token ?? '', pairing.token);
  if (!valid) {
    recordFail(ip);
    throw new HttpError(401, 'That code has expired. Show a new QR code in the app.');
  }
  pairing = null;
  attempts.delete(ip);
  return createSession(signInKind(from));
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
  const token = readCookie(req);
  if (!isValidSession(token)) return res.status(401).json({ error: 'Please sign in' });
  touchSession(token);
  return next();
}

/** The real listening address tells us whether the request came from this PC. */
export const isLocalRequest = (req) => req.socket.localAddress === '127.0.0.1' || req.socket.localAddress === '::ffff:127.0.0.1';
