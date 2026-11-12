// CityHQ's in-game helper on a hosted server: put in place through the host's files, and reached
// over HTTPS at the address Cfx.re gives the server (never over plain HTTP, which would show the
// helper's token to anyone in between).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureManagedBlock } from '../cfg.js';
import { APP_DIR, HttpError } from '../paths.js';
import { getSettings } from '../settings.js';

const SOURCE = process.env.QBC_AGENT_SOURCE || path.join(APP_DIR, 'agent-resource', 'qb-control');
const FILES = ['fxmanifest.lua', 'server.lua', 'client.lua'];
const versionOf = (text) => String(text || '').match(/^version\s+['"]([^'"]+)/m)?.[1] || null;

export const helperFolder = (dataPath) => path.posix.join(dataPath || '/', 'resources', '[local]', 'qb-control');

/** Only Cfx.re's own HTTPS addresses for servers are trusted: https://<name>.users.cfx.re */
export function helperAddress(text) {
  let value = String(text || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.users\.cfx\.re$/i.test(url.hostname) || url.port) return null;
    return url.origin;
  } catch { return null; }
}

/** What's installed on the host, and whether it matches this CityHQ. */
export async function helperState(conn, dataPath) {
  const folder = helperFolder(dataPath);
  let manifest = null;
  try { manifest = await conn.files.read(path.posix.join(folder, 'fxmanifest.lua')); } catch { /* not there */ }
  const wanted = versionOf(readFileSync(path.join(SOURCE, 'fxmanifest.lua'), 'utf8'));
  return { installed: Boolean(manifest), version: versionOf(manifest), wanted, current: versionOf(manifest) === wanted };
}

/**
 * Puts the helper on the host in hosted mode (remote.txt), with this CityHQ's token, and its start
 * line in server.cfg. It loads at the server's next restart. Returns what changed.
 */
export async function installRemoteHelper(conn, { dataPath, cfgPath, token = getSettings().agentToken }) {
  const folder = helperFolder(dataPath);
  const resources = path.posix.join(dataPath || '/', 'resources');
  if (!(await conn.files.exists(path.posix.join(resources, '[local]')))) await conn.files.mkdir(resources, '[local]');
  if (!(await conn.files.exists(folder))) await conn.files.mkdir(path.posix.join(resources, '[local]'), 'qb-control');
  for (const name of FILES) await conn.files.write(path.posix.join(folder, name), readFileSync(path.join(SOURCE, name), 'utf8'));
  await conn.files.write(path.posix.join(folder, 'token.txt'), token);
  await conn.files.write(path.posix.join(folder, 'remote.txt'), 'CityHQ connects to this server over the internet. Delete this file to allow only this machine.\n');
  const cfg = await conn.files.read(cfgPath);
  const next = ensureManagedBlock(cfg);
  const cfgChanged = next !== cfg;
  if (cfgChanged) await conn.files.write(cfgPath, next);
  return { installed: true, cfgChanged };
}

let cached = { address: null, at: 0 };

/** The helper's HTTPS address, read from the file it writes when it starts. Cached for a minute. */
export async function readHelperAddress(conn, dataPath, { fresh = false } = {}) {
  if (!fresh && cached.address && Date.now() - cached.at < 60000) return cached.address;
  let text = null;
  try { text = await conn.files.read(path.posix.join(helperFolder(dataPath), 'address.txt')); } catch { /* not started yet */ }
  const address = helperAddress(text);
  cached = { address, at: Date.now() };
  return address;
}

export function forgetHelperAddress() { cached = { address: null, at: 0 }; }

export const NO_ADDRESS = new HttpError(503, 'CityHQ\'s helper hasn\'t answered from your hosted server yet. It starts when the server restarts; if it has, the server may not have a Cfx.re address yet (it needs a license key and a minute after starting).');
