// Finding a hosted server's files: where server.cfg is, read through the host's panel or SFTP.
// Panels show the server's own folder as "/" (on the machine it is /home/container).
import path from 'node:path';
import {
  connectionStringOf, gamePortOf, parseConnection, readCommand, readConvar,
} from '../cfg.js';
import { frameworkOf, qbxBridgeOff } from '../framework.js';

const CONTAINER_ROOTS = ['/home/container', '/home/container/'];

/** A path txAdmin saved on the host, as the panel shows it. */
export function hostPath(p) {
  let value = String(p || '').replaceAll('\\', '/');
  for (const root of CONTAINER_ROOTS) {
    if (value === root.replace(/\/$/, '')) return '/';
    if (value.startsWith(root)) { value = `/${value.slice(root.length)}`; break; }
  }
  if (!value.startsWith('/')) value = `/${value}`;
  return path.posix.normalize(value).replace(/(.)\/$/, '$1');
}

const tryRead = async (files, p) => { try { return await files.read(p); } catch { return null; } };
const tryList = async (files, p) => { try { return await files.list(p); } catch { return []; } };

/**
 * Where the server's files are: txAdmin's choice first, then server.cfg at the top, in
 * server-data, or one folder down. Returns { dataPath, cfgPath, cfgText, txProfile } or null.
 */
export async function findHostedServer(files) {
  const top = await tryList(files, '/');
  const dirs = top.filter((e) => e.dir).map((e) => e.name);

  if (dirs.includes('txData')) {
    const tx = await tryList(files, '/txData');
    for (const profile of tx.filter((e) => e.dir && !e.name.endsWith('.base')).map((e) => e.name)) {
      const text = await tryRead(files, `/txData/${profile}/config.json`);
      if (!text) continue;
      let config;
      try { config = JSON.parse(text); } catch { continue; }
      const dataPath = config?.server?.dataPath || config?.fxRunner?.serverDataPath;
      if (!dataPath) continue;
      const dir = hostPath(dataPath);
      const cfgName = config?.server?.cfgPath || config?.fxRunner?.cfgPath || 'server.cfg';
      // txAdmin 8 saves it relative to dataPath; txAdmin 7 saved the full path.
      const name = String(cfgName).replaceAll('\\', '/');
      const cfgPath = name.startsWith('/') ? hostPath(name) : path.posix.join(dir, name);
      const cfgText = await tryRead(files, cfgPath);
      if (cfgText !== null) return { dataPath: dir, cfgPath, cfgText, txProfile: `/txData/${profile}` };
    }
    for (const base of tx.filter((e) => e.dir && e.name.endsWith('.base')).map((e) => e.name)) {
      const cfgPath = `/txData/${base}/server.cfg`;
      const cfgText = await tryRead(files, cfgPath);
      if (cfgText !== null) return { dataPath: `/txData/${base}`, cfgPath, cfgText, txProfile: '/txData/default' };
    }
  }
  for (const dir of ['/', '/server-data', ...dirs.filter((d) => !['txData', 'server-data', 'alpine', 'cache', 'logs'].includes(d)).map((d) => `/${d}`)]) {
    const cfgPath = path.posix.join(dir, 'server.cfg');
    const cfgText = await tryRead(files, cfgPath);
    if (cfgText !== null) return { dataPath: dir, cfgPath, cfgText, txProfile: dirs.includes('txData') ? '/txData/default' : null };
  }
  return null;
}

/** What the Welcome screen shows about a hosted server before connecting. */
export function describeHosted(found, { address } = {}) {
  const problems = [];
  if (!found) {
    problems.push({ level: 'bad', text: 'CityHQ couldn\'t find server.cfg on this server. If txAdmin hasn\'t been set up there yet, finish its setup first (your host\'s panel shows a txAdmin link or PIN in the console).' });
    return { found: false, problems };
  }
  const cfg = found.cfgText;
  const framework = frameworkOf(cfg, null);
  if (!framework) problems.push({ level: 'warn', text: 'This doesn\'t look like a QBCore or Qbox server. Power, console and files work, but the player tools are made for QBCore and Qbox.' });
  if (framework === 'qbox' && qbxBridgeOff(cfg)) problems.push({ level: 'warn', text: 'server.cfg turns off Qbox\'s QBCore bridge, so scripts written for QBCore won\'t work.' });
  const conn = parseConnection(connectionStringOf(cfg));
  // txAdmin keeps the key in its own settings, so only a server without txAdmin needs the line.
  if (!found.txProfile && !readConvar(cfg, 'sv_licenseKey') && !readCommand(cfg, 'sv_licenseKey')) {
    problems.push({ level: 'warn', text: 'server.cfg has no license key line. A server needs one to get the Cfx.re address CityHQ uses to reach it.' });
  }
  return {
    found: true,
    dataPath: found.dataPath,
    cfgPath: found.cfgPath,
    txProfile: found.txProfile,
    framework,
    gamePort: gamePortOf(cfg) || address?.port || 30120,
    address: address || null,
    database: conn ? { host: conn.host, port: Number(conn.port), user: conn.user, name: conn.database, hasPassword: Boolean(conn.password) } : null,
    problems,
  };
}
