// Talks to the qb-control resource inside the running server, and installs it.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, findServerData, GAME_PORT, HttpError } from './paths.js';
import { getSettings } from './settings.js';

const AGENT_SOURCE = process.env.QBC_AGENT_SOURCE || path.join(APP_DIR, 'agent-resource', 'qb-control');
const BASE = `http://127.0.0.1:${GAME_PORT}/qb-control`;

// A hosted server's helper is reached at its HTTPS address (remote/runtime.js sets this).
let hostedBase = null;
export const setAgentBase = (fn) => { hostedBase = fn; };

export async function agentRequest(route, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  const base = hostedBase ? `${await hostedBase()}/qb-control` : BASE;
  // Over the internet things take longer than on this PC.
  if (hostedBase) timeoutMs = Math.max(timeoutMs, 10000);
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: { 'x-qbc-token': getSettings().agentToken, 'Content-Type': 'application/json' },
      // FXServer only signals a POST body once data arrives, so always send one.
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(503, 'The server is not answering right now. It may be starting or stopped.');
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !payload?.ok) {
    if (res.status === 404 && !payload) {
      throw new HttpError(503, 'The server is running but the qb-control resource is not started yet.');
    }
    if (res.status === 404 && payload?.error === 'Not found') {
      throw new HttpError(409, 'This needs the newer CityHQ helper, which loads when the server restarts. Restart the server once to turn it on.');
    }
    throw new HttpError(res.status === 401 ? 503 : 400, payload?.error || `The server replied with an error (${res.status})`);
  }
  return payload.data;
}

/** The helper version on disk, to tell whether the running one needs a server restart. */
export const installedAgentVersion = () => versionOf(AGENT_SOURCE);

const versionOf = (dir) => {
  try {
    return readFileSync(path.join(dir, 'fxmanifest.lua'), 'utf8').match(/^version\s+['"]([^'"]+)/m)?.[1] || null;
  } catch { return null; }
};

/** Copies the resource into the server if it is missing or outdated. True when it changed. */
export async function installAgent() {
  // A hosted server's helper is put in place through the host (remote/helper.js).
  if (hostedBase) return { installed: true, changed: false };
  const server = findServerData();
  if (!server) return { installed: false, reason: 'Server is not deployed yet' };
  const target = path.join(server.dataPath, 'resources', '[local]', 'qb-control');
  const tokenFile = path.join(target, 'token.txt');
  const token = getSettings().agentToken;

  const sameVersion = versionOf(target) === versionOf(AGENT_SOURCE);
  const sameToken = existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim() === token;
  const sameFile = (name) => existsSync(path.join(target, name))
    && readFileSync(path.join(target, name), 'utf8') === readFileSync(path.join(AGENT_SOURCE, name), 'utf8');
  const sameCode = sameVersion && sameFile('server.lua') && sameFile('client.lua') && sameFile('html/index.html');
  if (sameCode && sameToken) return { installed: true, changed: false };

  mkdirSync(path.dirname(target), { recursive: true });
  await cp(AGENT_SOURCE, target, { recursive: true, force: true });
  await writeFile(tokenFile, token);
  return { installed: true, changed: true };
}
