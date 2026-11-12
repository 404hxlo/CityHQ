// One way to reach a hosted server, whichever the host offers: its panel's API (files, power,
// live console, CPU and memory) or SFTP (files only; the console then comes from txAdmin's log).
import path from 'node:path';
import { clean, classify } from '../console.js';
import { HttpError, REMOTE, STATE_DIR } from '../paths.js';
import { replaceFileSync } from '../retry.js';
import { panelBase, panelClient, panelConsole } from './panel.js';
import { loadSecret } from './secret.js';
import { remotePath, sftpClient } from './sftp.js';

const LOG_FIRST_BYTES = 128 * 1024;

/** Builds the connection for a saved hosted server and its secret. */
export function makeConnection(remote, secret, { onHostKey } = {}) {
  if (!remote) throw new HttpError(409, 'No hosted server is connected');
  if (!secret) throw new HttpError(409, 'CityHQ can\'t unlock the key for your hosted server on this Windows account. Connect it again from Settings, Change server.');
  if (remote.type === 'panel') return panelConnection(remote, secret);
  if (remote.type === 'sftp') return sftpConnection(remote, secret, onHostKey);
  throw new HttpError(409, 'Unknown kind of hosted server');
}

function existsVia(list) {
  return async (p) => {
    const full = remotePath(p);
    try {
      const entries = await list(path.posix.dirname(full));
      return entries.some((e) => e.name === path.posix.basename(full));
    } catch { return false; }
  };
}

function panelConnection(remote, key) {
  const client = panelClient({ url: remote.panelUrl, key, serverId: remote.serverId });
  let live = null;
  const consoleStream = () => (live ||= panelConsole(client, panelBase(remote.panelUrl)));
  return {
    type: 'panel',
    label: remote.serverName || 'Hosted server',
    capabilities: { power: true, stats: true, liveConsole: true },
    files: { ...client.files, exists: existsVia(client.files.list) },
    power: (signal) => client.power(signal),
    stats: () => client.resources(),
    command: (command) => client.command(command),
    /** The same shape as the local console: { offset, lines: [{ text, level }], reset }. */
    async readConsole(since) {
      const { lines, next } = consoleStream().since(Number.isFinite(since) ? since : undefined);
      const reset = Number.isFinite(since) && since > next;
      const text = clean(lines.join('\n'));
      return {
        offset: next,
        reset,
        lines: text.split('\n').filter((l) => l.trim()).map((l) => ({ text: l, level: classify(l) })),
      };
    },
    close: () => live?.close(),
  };
}

function sftpConnection(remote, password, onHostKey) {
  const client = sftpClient({
    host: remote.host, port: remote.port, username: remote.username, password, hostKey: remote.hostKey || null, onHostKey,
  });
  const logPath = remote.logPath || null;
  return {
    type: 'sftp',
    label: remote.serverName || remote.host,
    capabilities: { power: false, stats: false, liveConsole: Boolean(logPath) },
    files: client.files,
    readFrom: client.readFrom,
    power: () => { throw new HttpError(409, 'Your host only gives CityHQ its files (SFTP), so start and stop the server from your host\'s panel.'); },
    stats: async () => null,
    command: null,
    /** Follows txAdmin's log file over SFTP, like the local console follows it on disk. */
    async readConsole(since) {
      if (!logPath) return { offset: 0, lines: [], reset: false };
      let first = !Number.isFinite(since);
      let { size, start, data } = await client.readFrom(logPath, first ? 0 : since, 1);
      let reset = false;
      if (!first && since > size) { reset = true; first = true; }
      const from = first ? Math.max(0, size - LOG_FIRST_BYTES) : since;
      ({ start, data } = await client.readFrom(logPath, from));
      let text = data.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return { offset: start, lines: [], reset };
      const end = start + Buffer.byteLength(text.slice(0, lastNl + 1));
      text = text.slice(0, lastNl);
      let raw = clean(text).split('\n');
      if (first && start > 0) raw = raw.slice(1);
      return { offset: end, reset, lines: raw.filter((l) => l.trim()).map((l) => ({ text: l, level: classify(l) })) };
    },
    close: () => client.close(),
  };
}

let current = null;

/** Saves what CityHQ knows about the hosted server (never its secret) for the next start. */
export function saveRemote() {
  try {
    const file = path.join(path.dirname(STATE_DIR), 'qbcontrol.json');
    replaceFileSync(file, `${JSON.stringify({ remote: REMOTE }, null, 2)}\n`);
  } catch { /* remembered for this run */ }
}

/** The running app's connection to its hosted server (made on first use). */
export function connection() {
  if (!REMOTE) throw new HttpError(409, 'This CityHQ manages a server on this PC');
  if (!current) {
    current = makeConnection(REMOTE, loadSecret(STATE_DIR), {
      // The first SFTP connection remembers the server's identity for later ones.
      onHostKey: (fingerprint) => {
        if (REMOTE.hostKey) return;
        REMOTE.hostKey = fingerprint;
        saveRemote();
      },
    });
  }
  return current;
}

export function closeConnection() {
  try { current?.close(); } catch { /* ignore */ }
  current = null;
}
