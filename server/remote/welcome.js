// Connecting a hosted server on the Welcome screen: check the panel key (or SFTP login), pick the
// server, look at what's there, then save it and put CityHQ's helper on it.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HttpError, POINTER_FILE, REMOTE_HOME } from '../paths.js';
import { replaceFileSync } from '../retry.js';
import { makeConnection } from './connection.js';
import { describeHosted, findHostedServer, serverNameOf } from './find.js';
import { installRemoteHelper } from './helper.js';
import { looksLikeKey, panelBase, panelClient } from './panel.js';
import { canKeepSecrets, saveSecret } from './secret.js';

const text = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The panel login, checked: its servers. */
export async function listPanelServers(body) {
  const url = panelBase(body?.url);
  const key = text(body?.key, 400);
  if (!looksLikeKey(key)) throw new HttpError(400, 'Paste the whole API key. It\'s a long line of letters and numbers, often starting with ptlc_.');
  const servers = await panelClient({ url, key }).listServers();
  if (!servers.length) throw new HttpError(404, 'That key works, but it can\'t see any servers. Make the key while logged in as the account that owns the server.');
  return { url, servers };
}

/** What the connection would be, from what the screen sent. Secrets stay on the PC side. */
export function remoteFrom(body) {
  if (body?.type === 'panel') {
    const serverId = text(body.serverId, 40);
    if (!/^[A-Za-z0-9-]{4,40}$/.test(serverId)) throw new HttpError(400, 'Choose a server first');
    return { remote: { type: 'panel', panelUrl: panelBase(body.url), serverId }, secret: text(body.key, 400) };
  }
  if (body?.type === 'sftp') {
    const host = text(body.host, 200).replace(/^sftp:\/\//i, '');
    const port = Number(body.port) || 22;
    const username = text(body.username, 200);
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new HttpError(400, 'Enter the SFTP address your host shows, like gs3.yourhost.net');
    if (!username) throw new HttpError(400, 'Enter the SFTP username your host shows');
    if (!(port > 0 && port < 65536)) throw new HttpError(400, 'Enter the SFTP port (often 2022 or 22)');
    return { remote: { type: 'sftp', host, port, username }, secret: typeof body.password === 'string' ? body.password : '' };
  }
  throw new HttpError(400, 'Choose how to connect');
}

async function inspect(body) {
  const { remote, secret } = remoteFrom(body);
  let hostKey = null;
  const conn = makeConnection(remote, secret, { onHostKey: (f) => { hostKey ||= f; } });
  try {
    let summary = null;
    if (remote.type === 'panel') {
      summary = await panelClient({ url: remote.panelUrl, key: secret, serverId: remote.serverId }).details();
      if (summary.suspended) throw new HttpError(409, 'Your host says this server is suspended.');
    }
    const found = await findHostedServer(conn.files);
    const report = describeHosted(found, { address: summary?.address || null });
    // The panel knows the name it was given; over SFTP, the server's own settings say it.
    const ownName = found ? await serverNameOf(conn.files, found) : null;
    if (remote.type === 'sftp' && found?.txProfile && await conn.files.exists(`${found.txProfile}/logs/fxserver.log`)) {
      remote.logPath = `${found.txProfile}/logs/fxserver.log`;
    }
    if (remote.type === 'sftp' && !remote.logPath) {
      report.problems.push({ level: 'info', text: 'Without your host\'s panel API, CityHQ can\'t start or stop the server, and the console shows only once txAdmin has written its log.' });
    }
    return {
      remote: { ...remote, hostKey, serverName: summary?.name || ownName || remote.host, address: summary?.address || null },
      secret, found, report, conn,
    };
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** What CityHQ finds on the chosen server, before anything is changed. */
export async function checkHosted(body) {
  const { report, remote, conn } = await inspect(body);
  conn.close();
  return { ...report, serverName: remote.serverName, type: remote.type, canKeepSecrets: canKeepSecrets() };
}

const slugOf = (remote) => (remote.type === 'panel' ? `panel-${remote.serverId}` : `sftp-${remote.username}-${remote.host}`)
  .toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 80);

/**
 * Saves the hosted server, its secret (locked) and puts CityHQ's helper on it. The app then
 * starts again on it. The helper loads at the server's next restart.
 */
/**
 * The helper's token for a hosted server's folder: the one already in its settings (connecting the
 * same server again), or a new one written there, which CityHQ then uses once it starts on it.
 */
function tokenFor(stateDir) {
  const file = path.join(stateDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { /* new */ }
  if (typeof settings.agentToken === 'string' && /^[a-f0-9]{64}$/.test(settings.agentToken)) return settings.agentToken;
  settings.agentToken = randomBytes(32).toString('hex');
  replaceFileSync(file, JSON.stringify(settings, null, 2));
  return settings.agentToken;
}

export async function useHosted(body) {
  if (!canKeepSecrets()) throw new HttpError(409, 'Hosted servers need the CityHQ desktop app, which can lock your key with Windows\' own protection.');
  const { remote, secret, found, report, conn } = await inspect(body);
  try {
    if (!found) throw new HttpError(409, report.problems[0]?.text || 'CityHQ couldn\'t find server.cfg on this server.');
    const root = path.join(REMOTE_HOME, slugOf(remote));
    const saved = {
      ...remote,
      dataPath: found.dataPath,
      cfgPath: found.cfgPath,
      txProfile: found.txProfile || null,
      gamePort: report.gamePort,
      connectedAt: new Date().toISOString(),
    };
    mkdirSync(path.join(root, '.qbcontrol'), { recursive: true });
    saveSecret(path.join(root, '.qbcontrol'), secret);
    replaceFileSync(path.join(root, 'qbcontrol.json'), `${JSON.stringify({ remote: saved }, null, 2)}\n`);
    // The helper needs the token CityHQ will use for this server, kept in the new folder's settings.
    const token = tokenFor(path.join(root, '.qbcontrol'));
    const helper = await installRemoteHelper(conn, { dataPath: found.dataPath, cfgPath: found.cfgPath, token });
    mkdirSync(path.dirname(POINTER_FILE), { recursive: true });
    replaceFileSync(POINTER_FILE, JSON.stringify({ serverRoot: root, chosenAt: new Date().toISOString() }, null, 2));
    return { root, helper };
  } finally {
    conn.close();
  }
}
