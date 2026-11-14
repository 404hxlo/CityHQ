// Installing and removing scripts on a hosted server. The download, unpacking and checks happen on
// this PC exactly as for a server here (resources.js); only the last step, putting the folder in
// place, goes to the host. Removed scripts are moved aside on the host, never deleted.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  addBootLine, changeCfgFile, forgetBootLines, parseBoot, readCfg, withCfg, writeCfg,
} from '../cfg.js';
import { recordChange } from '../history.js';
import { findServerData, HttpError, TMP_DIR } from '../paths.js';
import { agentRequest } from '../agent.js';
import { connection } from './connection.js';
import { forgetResourceMeta, hostedDisk } from './resources.js';

const exec = promisify(execFile);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const ADDED = '[added]';
export const REMOVED = '[cityhq-removed]';
const PANEL_UPLOAD_LIMIT = 90 * 1024 * 1024;

const dataPath = () => {
  const s = findServerData();
  if (!s) throw new HttpError(409, 'CityHQ doesn\'t know where your hosted server\'s files are yet.');
  return s.dataPath;
};

async function ensureFolder(files, parent, name) {
  const there = await files.list(parent).catch(() => []);
  if (!there.some((e) => e.dir && e.name === name)) await files.mkdir(parent, name);
}

/** Every file in a folder, skipping .git and node_modules, as uploads that keep going on a cut. */
async function uploadTree(sftp, from, to) {
  await sftp.mkdirs(to);
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const a = path.join(from, e.name);
    const b = path.posix.join(to, e.name);
    if (e.isDirectory()) await uploadTree(sftp, a, b);
    else if (e.isFile()) await sftp.uploadFile(a, b, { resume: false });
  }
}

/** Puts an unpacked resource folder from this PC into resources/[added]/<name> on the host. */
export async function placeOnHost(localDir, name) {
  const conn = connection();
  const resources = path.posix.join(dataPath(), 'resources');
  const dest = path.posix.join(resources, ADDED, name);
  if (conn.type === 'sftp') {
    await uploadTree(conn.sftp, localDir, dest);
  } else {
    await ensureFolder(conn.files, resources, ADDED);
    await ensureFolder(conn.files, path.posix.join(resources, ADDED), name);
    await mkdir(TMP_DIR, { recursive: true });
    const zip = path.join(TMP_DIR, `to-host-${Date.now()}.zip`);
    try {
      await exec(TAR, ['-a', '-cf', zip, '--exclude=.git', '--exclude=node_modules', '-C', localDir, '.'], { windowsHide: true, timeout: 1800_000, maxBuffer: 64 * 1024 * 1024 });
      const { size } = await stat(zip);
      if (size > PANEL_UPLOAD_LIMIT) {
        throw new HttpError(413, `${name} is ${Math.round(size / 1024 / 1024)} MB packed, more than your host's panel takes in one upload. Upload its folder to resources/[added] with WinSCP, then press Refresh on the Resources page.`);
      }
      await conn.panel.files.upload(dest, 'cityhq-install.zip', await readFile(zip));
      await conn.panel.files.decompress(dest, 'cityhq-install.zip');
      await conn.files.remove(dest, ['cityhq-install.zip']).catch(() => {});
    } finally {
      await rm(zip, { force: true }).catch(() => {});
    }
  }
  forgetResourceMeta();
  await agentRequest('/refresh', { method: 'POST', timeoutMs: 15000 }).catch(() => null);
}

/** Moves a script aside on the host (resources/[cityhq-removed]) and out of server.cfg. */
export async function removeFromHost(name, { record = true } = {}) {
  const resource = (await hostedDisk()).find((r) => r.name === name);
  if (!resource) throw new HttpError(404, 'That resource wasn\'t found on the running server. Start the server and try again.');
  const conn = connection();
  await agentRequest('/resources/action', { method: 'POST', body: { name, action: 'stop' }, timeoutMs: 15000 }).catch(() => null);
  const resources = path.posix.join(dataPath(), 'resources');
  await ensureFolder(conn.files, resources, REMOVED);
  const from = path.posix.relative(resources, resource.dir);
  const spare = `${name}-${Date.now()}`;
  await conn.files.rename(resources, from, `${REMOVED}/${spare}`);
  const { cfgPath } = findServerData();
  const startedAtBoot = await withCfg(cfgPath, async () => {
    const cfg = await readCfg(cfgPath);
    const boot = parseBoot(cfg);
    const next = forgetBootLines(cfg, name);
    if (next !== cfg) await writeCfg(cfgPath, next);
    return boot.names.has(name) || resource.categories.some((c) => boot.categories.has(c));
  });
  forgetResourceMeta();
  await agentRequest('/refresh', { method: 'POST', timeoutMs: 15000 }).catch(() => null);
  if (record) {
    recordChange({
      kind: 'remove',
      title: `Removed ${name}`,
      undo: { type: 'hosted-restore', name, from, spare, boot: startedAtBoot },
      undoHint: `${name} goes back where it was on your host${startedAtBoot ? ' and starts with the server again' : ''}.`,
    });
  }
  return { removed: name };
}

/** Undo of a removal: the folder goes back where it was. */
export async function restoreOnHost({ name, from, spare, boot }) {
  const conn = connection();
  const resources = path.posix.join(dataPath(), 'resources');
  await conn.files.rename(resources, `${REMOVED}/${spare}`, from);
  if (boot) {
    const { cfgPath } = findServerData();
    await changeCfgFile(cfgPath, (cfg) => (parseBoot(cfg).names.has(name) ? cfg : addBootLine(cfg, name)));
  }
  forgetResourceMeta();
  await agentRequest('/refresh', { method: 'POST', timeoutMs: 15000 }).catch(() => null);
  return `${name} is back on your host${boot ? ' and starts with the server again' : ''}.`;
}
