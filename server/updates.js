// Keeps CityHQ up to date from its GitHub Releases. It checks now and then (it can be turned off in
// Settings), and installs only when someone on this PC presses Update. The download is checked
// against the checksum GitHub publishes for it. Only the ready-made app updates itself: a copy built
// from the source code, or one in a folder it can't write to, says where to get the new version.
import { execFile, spawn } from 'node:child_process';
import {
  existsSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import {
  copyFile, mkdir, readFile, rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { download, sha256 } from './dbtools.js';
import { desktop, isSecondary } from './desktop.js';
import { recordEvent } from './events.js';
import { APP_DIR, HOME_DIR, HttpError } from './paths.js';
import { getSettings, updateSettings } from './settings.js';

const exec = promisify(execFile);
const CURL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
export const RELEASES_PAGE = 'https://github.com/404hxlo/CityHQ/releases/latest';
// QBC_UPDATE_FEED points a test copy at a pretend release.
const FEED = process.env.QBC_UPDATE_FEED || 'https://api.github.com/repos/404hxlo/CityHQ/releases/latest';
const ASSET = 'CityHQ-windows.zip';
export const UPDATES_DIR = path.join(HOME_DIR, 'updates');
const LOG = path.join(UPDATES_DIR, 'update.log');
const CHECK_EVERY = 6 * 60 * 60 * 1000;

export const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();

/** Plain version numbers only (1.2.0); anything else counts as not newer. */
export function isNewer(candidate, current) {
  const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim()) || []).slice(1).map(Number);
  const a = parse(candidate);
  const b = parse(current);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The "What's new" part of the release notes; the rest is download steps for new people. */
export function whatsNew(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const match = /^##\s*What's new\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text);
  return match ? match[1].trim() : '';
}

/** The parts of GitHub's release description CityHQ uses. */
export function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const version = String(json.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const zip = assets.find((a) => a?.name === ASSET);
  const sums = assets.find((a) => a?.name === `${ASSET}.sha256`);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(zip?.digest || ''))?.[1]?.toLowerCase() || null;
  return {
    version,
    notes: whatsNew(json.body),
    page: typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : RELEASES_PAGE,
    publishedAt: json.published_at || null,
    zip: zip?.browser_download_url ? { url: zip.browser_download_url, size: Number(zip.size) || null, digest } : null,
    sumsUrl: sums?.browser_download_url || null,
  };
}

let latest = null;
let checkedAt = null;
let checkError = null;
let checking = null;
let job = null;
let timer = null;

const installFolder = () => desktop()?.installFolder?.() || null;

/** Why this copy can't update itself, or null when it can. */
function cantInstall(release) {
  if (!desktop()) return 'Updates are installed from the CityHQ window on the PC.';
  if (!installFolder()) return 'This copy was built from the source code. Update it with git pull, then npm run package.';
  if (!release?.zip) return 'This version has no ready-made download yet. Try again in a few minutes.';
  if (!release.zip.digest && !release.sumsUrl) return 'This version can\'t be checked before installing, so download it from GitHub instead.';
  if (unsafeForCmd(installFolder()) || unsafeForCmd(UPDATES_DIR)) return 'CityHQ can\'t update itself from a folder whose name has a % sign or quotes in it. Download the new version from GitHub instead.';
  return null;
}

function lastLogLine() {
  try {
    const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/);
    return lines[lines.length - 1] || null;
  } catch { return null; }
}

/** Everything the Settings card and the update notice show. */
export function updateStatus() {
  const available = Boolean(latest && isNewer(latest.version, APP_VERSION));
  return {
    current: APP_VERSION,
    available,
    latest: latest ? { version: latest.version, notes: latest.notes, page: latest.page, publishedAt: latest.publishedAt, sizeMb: latest.zip?.size ? Math.round(latest.zip.size / 1048576) : null } : null,
    checking: Boolean(checking),
    checkedAt,
    error: checkError,
    autoCheck: getSettings().autoUpdateCheck !== false,
    cantInstall: available ? cantInstall(latest) : null,
    job,
    lastLog: lastLogLine(),
  };
}

/** Only the version, for the notice at the top of every page. */
export const updateNotice = () => (latest && isNewer(latest.version, APP_VERSION) ? { version: latest.version } : null);

async function fetchJson(url) {
  const { stdout } = await exec(CURL, [
    '--location', '--fail', '--silent', '--show-error', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '60',
    '--header', 'Accept: application/vnd.github+json', '--user-agent', 'CityHQ-updater', url,
  ], { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Asks GitHub for the newest release. Calls made meanwhile share one request. */
export function checkForUpdate() {
  if (!checking) {
    checking = (async () => {
      try {
        const release = parseRelease(await fetchJson(FEED));
        if (!release) throw new Error('GitHub\'s answer had no usable version.');
        latest = release;
        checkError = null;
        // Said once per version, not at every start.
        if (isNewer(release.version, APP_VERSION) && getSettings().updateAnnounced !== release.version) {
          updateSettings({ updateAnnounced: release.version });
          recordEvent({ title: `CityHQ ${release.version} is available`, detail: 'Update it from Settings, or from the notice at the top of the page.' });
        }
      } catch (err) {
        checkError = `Couldn't check for updates: ${String(err.stderr || err.message || err).trim().split('\n').pop()}`;
      } finally {
        checkedAt = Date.now();
        checking = null;
      }
      return updateStatus();
    })();
  }
  return checking;
}

export function setAutoUpdateCheck(enabled) {
  updateSettings({ autoUpdateCheck: Boolean(enabled) });
  return updateStatus();
}

/** Checks a little after start and every six hours, unless turned off. A test copy only checks when asked. */
export function startUpdateChecks() {
  if (timer || (isSecondary() && !process.env.QBC_UPDATE_FEED)) return;
  const tick = () => { if (getSettings().autoUpdateCheck !== false) checkForUpdate(); };
  setTimeout(tick, 20_000).unref?.();
  timer = setInterval(tick, CHECK_EVERY);
  timer.unref?.();
}
export function stopUpdateChecks() {
  clearInterval(timer);
  timer = null;
}

/** The checksum in a .sha256 file ("<64 hex characters>  CityHQ-windows.zip"), or null. */
export const checksumIn = (text) => /^([0-9a-f]{64})\b/i.exec(String(text ?? '').trim())?.[1]?.toLowerCase() || null;

/**
 * The SHA-256 the download must have: GitHub's own digest and the .sha256 file. When both are
 * there they must agree, and with neither there is nothing to check against, so nothing installs.
 */
export function expectedFrom(digest, fromFile) {
  if (digest && fromFile && digest !== fromFile) throw new HttpError(502, 'The update\'s two published checksums disagree, so nothing was installed.');
  const expected = digest || fromFile;
  if (!expected) throw new HttpError(502, 'The update has no checksum to check it against, so nothing was installed.');
  return expected;
}

async function expectedChecksum(release) {
  let fromFile = null;
  if (release.sumsUrl) {
    const file = path.join(UPDATES_DIR, `${ASSET}.sha256`);
    await download(release.sumsUrl, file, null, 'the update\'s checksum');
    fromFile = checksumIn(await readFile(file, 'utf8'));
  }
  return expectedFrom(release.zip.digest, fromFile);
}

async function prepare(release, install) {
  // Unpacked next to the app, on the same drive, so it can be moved into place in one step.
  const staging = path.join(path.dirname(install), `.${path.basename(install)}-update`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
  } catch {
    throw new HttpError(409, `CityHQ can't write to the folder it's in (${path.dirname(install)}). Download the new version from GitHub and unzip it into a folder of your own, such as Documents.`);
  }
  await mkdir(UPDATES_DIR, { recursive: true });
  const zip = path.join(UPDATES_DIR, `CityHQ-${release.version}-windows.zip`);
  const totalMb = release.zip.size ? Math.round(release.zip.size / 1048576) : null;
  job = { step: 'Downloading', mb: 0, totalMb, error: null, done: false };
  const expected = await expectedChecksum(release);
  if (!existsSync(zip) || await sha256(zip) !== expected) {
    await download(release.zip.url, zip, (bytes) => { job = { ...job, mb: Math.round(bytes / 1048576) }; }, 'the update');
  }
  job = { ...job, step: 'Checking the download' };
  if (await sha256(zip) !== expected) {
    await rm(zip, { force: true });
    throw new HttpError(502, 'The download didn\'t match its published checksum, so nothing was installed. Try again.');
  }
  job = { ...job, step: 'Unpacking' };
  await exec(TAR, ['-xf', zip, '-C', staging], { windowsHide: true, timeout: 600_000 });
  const folder = path.join(staging, 'CityHQ');
  let version = null;
  try { version = JSON.parse(await readFile(path.join(folder, 'resources', 'app', 'package.json'), 'utf8')).version; } catch { /* checked below */ }
  if (!existsSync(path.join(folder, 'CityHQ.exe')) || version !== release.version) {
    await rm(staging, { recursive: true, force: true });
    throw new HttpError(502, 'The download unpacked, but it isn\'t the CityHQ version it should be, so nothing was installed.');
  }
  await rm(zip, { force: true });
  return folder;
}

const logSize = () => { try { return statSync(LOG).size; } catch { return 0; } };
/** True once the helper has written its first line after `from` (the log's size before it started). */
function helperRunning(from) {
  try { return readFileSync(LOG).subarray(from).toString('utf8').includes('Updating CityHQ in'); } catch { return false; }
}

/** A folder name cmd.exe would misread: quotes end the quoted path, and % starts a variable. */
export const unsafeForCmd = (arg) => /["%\r\n]/.test(String(arg));

/** The command line that starts the helper; with /s, cmd runs what is inside the outer quotes as it is. */
export function helperCommandLine(psArgs) {
  const quoted = psArgs.map((a) => (/[\s&^()<>|!,;=]/.test(a) || a === '' ? `"${a}"` : a)).join(' ');
  return `/d /s /c "start "" /b powershell.exe ${quoted}"`;
}

/**
 * Starts the helper so it outlives CityHQ. Started directly, a detached PowerShell never ran, and
 * an attached one is closed along with the app; going through cmd's start gives it a life of its
 * own and keeps CityHQ's environment, which a test copy depends on.
 */
function startHelper(psArgs) {
  const child = spawn(process.env.ComSpec || 'cmd.exe', [helperCommandLine(psArgs)], {
    cwd: UPDATES_DIR, detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true,
  });
  child.on('error', (err) => { job = { ...job, error: `Couldn't start the updater: ${err.message}`, done: false }; });
  child.unref();
}

/**
 * Downloads, checks and unpacks the new version, then closes CityHQ so the helper can swap the
 * folders and open the new one. Runs in the background; the screen polls updateStatus().
 */
export function installUpdate() {
  const reason = !latest || !isNewer(latest.version, APP_VERSION) ? 'There is no newer version to install.' : cantInstall(latest);
  if (reason) throw new HttpError(409, reason);
  if (job && !job.error) return updateStatus();
  const release = latest;
  const install = installFolder();
  job = { step: 'Starting', mb: 0, totalMb: null, error: null, done: false };
  (async () => {
    const folder = await prepare(release, install);
    job = { ...job, step: 'Closing CityHQ to finish', done: true };
    const helper = path.join(UPDATES_DIR, 'update-helper.ps1');
    await copyFile(path.join(APP_DIR, 'server', 'update-helper.ps1'), helper);
    const marker = path.join(UPDATES_DIR, `started-${release.version}.ok`);
    await rm(marker, { force: true });
    const logBefore = logSize();
    const args = Buffer.from(JSON.stringify(desktop().launchArgs?.() || []), 'utf8').toString('base64');
    startHelper([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-WaitPid', String(process.pid), '-Install', install, '-New', folder, '-ExeName', path.basename(process.execPath),
      '-Marker', marker, '-Log', LOG, '-ArgsB64', args,
    ]);
    // Close only once the helper is running; otherwise CityHQ would close and nothing would reopen it.
    const startedAt = Date.now();
    while (!helperRunning(logBefore)) {
      if (Date.now() - startedAt > 20_000) throw new Error('The updater didn\'t start, so CityHQ stayed open. Try again, or download the new version from GitHub.');
      await new Promise((r) => setTimeout(r, 300));
    }
    recordEvent({ title: `Updating CityHQ to ${release.version}`, detail: 'CityHQ closed and opened again. The game server kept running.' });
    setTimeout(() => desktop().exit(), 600);
  })().catch((err) => {
    job = { ...job, error: err.message || String(err), done: false };
  });
  return updateStatus();
}

/** Called once the window is up: tells the helper this version works, so it keeps it. */
export function markStarted() {
  const marker = process.env.QBC_UPDATE_MARKER;
  if (!marker) return;
  delete process.env.QBC_UPDATE_MARKER;
  try {
    writeFileSync(marker, APP_VERSION);
    recordEvent({ title: `CityHQ was updated to ${APP_VERSION}`, detail: 'See what changed under Settings, Updates.' });
  } catch (err) { console.error('[cityhq] update marker:', err); }
}
