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

// ---- console commands the helper must never run ----
// A resource that stops or restarts itself from its own code crashes the whole server, and console
// commands typed in CityHQ run inside the helper. These start, stop or restart a resource; exec
// runs a .cfg file, and server.cfg (like most) starts the helper again.
const HELPER = 'qb-control';
const HELPER_FOLDERS = ['[local]'];
const RESTART_WORDS = ['restart', 'stop', 'ensure', 'start'];
const NAME_CHAR = /[\w.-]/;

/** True when word appears in text on its own, not as part of a longer name. */
function hasWord(text, word) {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    if (!NAME_CHAR.test(text[i - 1] || '') && !NAME_CHAR.test(text[i + word.length] || '')) return true;
  }
  return false;
}

/**
 * Why a console command can't be run through the helper: 'exec' (a .cfg file can start the helper
 * again), 'restart' (it stops, starts or restarts the helper, or the folder it's in), or null.
 */
export function helperRestartReason(command) {
  const text = String(command ?? '').toLowerCase();
  if (hasWord(text, 'exec')) return 'exec';
  if (!RESTART_WORDS.some((w) => hasWord(text, w))) return null;
  return [HELPER, ...HELPER_FOLDERS].some((n) => hasWord(text, n)) ? 'restart' : null;
}

export const HELPER_RESTART_MESSAGES = {
  exec: 'exec can\'t run from CityHQ: the .cfg file would start CityHQ\'s helper again from inside the helper itself, which crashes the whole server. To load changes to server.cfg, restart the server.',
  restart: 'That would make CityHQ\'s helper (qb-control) stop or restart itself, which crashes the whole server. Restart the whole server from Home instead.',
};

export async function agentRequest(route, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  if (route === '/command') {
    const reason = helperRestartReason(body?.command);
    if (reason) throw new HttpError(400, HELPER_RESTART_MESSAGES[reason]);
  }
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
