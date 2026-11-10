// The HTTP API and web UI. Always listens on this PC; listens on the home network only
// after phone access is turned on.
import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { agentRequest, installAgent } from './agent.js';
import {
  clearSessionCookie, createPairingToken, createSession, destroySession, isLocalRequest, isValidSession, lanAddresses,
  loginWithPairing, loginWithPasscode, readCookie, requestGuard, requireSession, setSessionCookie,
} from './auth.js';
import {
  BACKUP_DIR_ROOT, backupStatus, createBackup, deleteBackup, isValidBackupId, listBackups, VALID_PARTS,
} from './backups.js';
import {
  browseFolder, fileDetails, searchFiles, sendRaw,
} from './browser.js';
import { readConsole } from './console.js';
import {
  getOverview, restartServer, restoreServer, startServer, startStatusPolling, stopServer, stopStatusPolling,
} from './control.js';
import { desktop } from './desktop.js';
import {
  listEvents, markSeen, recordEvent, unseenAlerts,
} from './events.js';
import { currentProblems, restartChecked } from './problems.js';
import {
  cancelPendingRestart, getPendingRestart, isValidTime, nextBackupTime, nextScheduledRestart, scheduleRestart, startScheduler, stopScheduler,
} from './scheduler.js';
import {
  listFiles, listVersions, readEditable, restoreVersion, saveContent, saveFields,
} from './files.js';
import {
  APP_DIR, APP_PORT, FXSERVER_DIR, GAME_PORT, findServerData, HttpError, ROOT, ROOT_FOUND, TXADMIN_PORT,
} from './paths.js';
import { repairMovedFolder } from './relocate.js';
import { startProbe, stopProbe } from './processes.js';
import {
  activateInstalled, ensureCfgBlock, getInstallStatus, installFromGithub, installFromLocalPath, installFromUpload, isValidName, listResources, listSqlFiles, listTrash,
  refreshResources, removeResource, resourceAction, restoreFromTrash, runSql, setBoot,
} from './resources.js';
import { getSettings, regeneratePasscode, updateSettings } from './settings.js';

const handler = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result ?? {});
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[cityhq] ${req.method} ${req.path}:`, err);
    if (!res.headersSent) {
      res.status(status).json({
        ...(err instanceof HttpError ? err.extra : null),
        error: err instanceof HttpError ? err.message : 'Something went wrong in the app. See its log for details.',
      });
    }
  }
};

const localOnly = (req, res, next) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'This can only be done on the PC running the server.' });
  return next();
};

const ip = (req) => req.socket.remoteAddress || 'unknown';

let countsCache = { at: 0, value: null };
async function resourceCounts() {
  if (countsCache.value && Date.now() - countsCache.at < 6000) return countsCache.value;
  const { resources } = await listResources();
  countsCache = {
    at: Date.now(),
    value: { resourcesStarted: resources.filter((r) => r.state === 'started').length, resourcesTotal: resources.length },
  };
  return countsCache.value;
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.use(requestGuard);

  const api = express.Router();
  const json = express.json({ limit: '4mb' });

  api.get('/session', (req, res) => {
    res.json({ authed: isValidSession(readCookie(req)), local: isLocalRequest(req) });
  });
  api.post('/login', json, handler((req, res) => {
    setSessionCookie(res, loginWithPasscode(ip(req), req.body?.passcode));
    return { ok: true };
  }));
  api.post('/pair', json, handler((req, res) => {
    setSessionCookie(res, loginWithPairing(ip(req), req.body?.token));
    return { ok: true };
  }));
  api.post('/logout', handler((req, res) => {
    destroySession(readCookie(req));
    clearSessionCookie(res);
    return { ok: true };
  }));

  api.use(requireSession);

  // Overview and server power
  api.get('/overview', handler(async () => {
    const overview = getOverview();
    // Count the same resources the Resources page lists, not FXServer's internal ones.
    if (overview.status) {
      const counts = await resourceCounts().catch(() => null);
      if (counts) Object.assign(overview.status, counts);
    }
    return {
      ...overview,
      folderFound: ROOT_FOUND,
      problems: await currentProblems().catch(() => []),
      alerts: unseenAlerts().slice(0, 5),
      schedule: {
        pendingRestart: getPendingRestart(),
        nextRestart: nextScheduledRestart(),
        nextBackup: nextBackupTime(),
        backupRunning: backupStatus(),
      },
    };
  }));
  api.get('/problems', handler((req) => currentProblems({ fresh: req.query.fresh === '1' })));
  api.get('/events', handler(() => listEvents()));
  api.post('/events/seen', json, handler((req) => {
    markSeen(typeof req.body?.id === 'string' ? req.body.id : undefined);
    return { ok: true };
  }));
  api.post('/server/start', handler(() => startServer()));
  api.post('/server/stop', json, handler((req) => {
    cancelPendingRestart();
    return stopServer(req.body?.reason);
  }));
  api.post('/server/restart', json, handler((req) => {
    cancelPendingRestart();
    return restartServer(req.body?.reason);
  }));
  api.post('/server/restart-later', json, handler((req) => {
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new HttpError(400, 'Choose between 1 and 120 minutes.');
    return scheduleRestart(minutes);
  }));
  api.delete('/server/restart-later', handler(() => cancelPendingRestart()));

  // Backups
  api.get('/backups', handler(async (req) => ({
    backups: await listBackups(),
    running: backupStatus(),
    folder: isLocalRequest(req) ? BACKUP_DIR_ROOT : null,
    canOpenFolder: isLocalRequest(req) && Boolean(desktop()),
  })));
  api.post('/backups', handler(() => createBackup('manual')));
  api.post('/backups/open-folder', localOnly, handler(async () => {
    if (!desktop()) throw new HttpError(409, 'This only works in the desktop app.');
    await mkdir(BACKUP_DIR_ROOT, { recursive: true });
    await desktop().openFolder(BACKUP_DIR_ROOT);
    return { ok: true };
  }));
  api.post('/backups/:id/restore', json, handler((req) => {
    if (!isValidBackupId(req.params.id)) throw new HttpError(400, 'Invalid backup');
    const parts = Array.isArray(req.body?.parts) ? req.body.parts.filter((p) => VALID_PARTS.includes(p)) : [];
    if (!parts.length) throw new HttpError(400, 'Choose at least one thing to restore.');
    cancelPendingRestart();
    return restoreServer(req.params.id, parts);
  }));
  api.delete('/backups/:id', handler((req) => deleteBackup(req.params.id)));

  // Automation
  const automationView = (req) => {
    const s = getSettings();
    const local = isLocalRequest(req);
    return {
      backups: { enabled: s.backups.enabled, time: s.backups.time, keep: s.backups.keep, lastAuto: s.backups.lastAuto },
      restarts: s.restarts,
      autoStartServer: s.autoStartServer,
      autoRecover: s.autoRecover,
      openAtLogin: local && desktop() ? desktop().getOpenAtLogin() : null,
    };
  };
  api.get('/automation', handler((req) => automationView(req)));
  api.put('/automation', json, handler((req) => {
    const body = req.body || {};
    const s = getSettings();
    const patch = {};
    if (body.backups) {
      const { enabled = s.backups.enabled, time = s.backups.time, keep = s.backups.keep } = body.backups;
      if (!isValidTime(time)) throw new HttpError(400, 'That backup time is not valid.');
      if (!Number.isInteger(keep) || keep < 1 || keep > 90) throw new HttpError(400, 'Keep between 1 and 90 backups.');
      patch.backups = { ...s.backups, enabled: Boolean(enabled), time, keep };
    }
    if (body.restarts) {
      const { enabled = s.restarts.enabled, times = s.restarts.times } = body.restarts;
      if (!Array.isArray(times) || times.length > 6 || !times.every(isValidTime)) throw new HttpError(400, 'Restart times are not valid.');
      patch.restarts = { enabled: Boolean(enabled), times: [...new Set(times)].sort() };
    }
    if (typeof body.autoStartServer === 'boolean') patch.autoStartServer = body.autoStartServer;
    if (typeof body.autoRecover === 'boolean') patch.autoRecover = body.autoRecover;
    if (typeof body.openAtLogin === 'boolean') {
      if (!isLocalRequest(req)) throw new HttpError(403, 'This can only be changed on the PC running the server.');
      if (!desktop()) throw new HttpError(409, 'This only works in the desktop app.');
      desktop().setOpenAtLogin(body.openAtLogin);
    }
    updateSettings(patch);
    return automationView(req);
  }));
  api.post('/announce', json, handler((req) => agentRequest('/announce', { method: 'POST', body: { message: req.body?.message } })));

  // Console
  api.get('/console', handler((req) => {
    const since = req.query.since === undefined ? undefined : Number(req.query.since);
    return readConsole(since);
  }));
  api.post('/console/command', json, handler((req) => agentRequest('/command', { method: 'POST', body: { command: req.body?.command } })));

  // Resources
  api.get('/resources', handler(() => listResources()));
  api.post('/resources/refresh', handler(async () => {
    await refreshResources();
    return listResources();
  }));
  api.post('/resources/install/github', json, handler((req) => installFromGithub(req.body?.url)));
  api.get('/resources/install/status', handler(() => getInstallStatus() || { phase: null }));
  api.post('/resources/install/upload', handler((req) => {
    if (!/zip|rar|7z|octet-stream/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Upload a .zip, .rar or .7z file.');
    return installFromUpload(req, req.query.filename, Number(req.headers['content-length']) || 0);
  }));
  // Reads straight from this PC, so even huge resources don't need uploading.
  api.post('/resources/install/pick', localOnly, json, handler(async (req) => {
    if (!desktop()) throw new HttpError(409, 'This only works in the desktop app.');
    const source = await desktop().pickInstallSource(req.body?.type === 'folder' ? 'folder' : 'file');
    if (!source) return { cancelled: true };
    return installFromLocalPath(source);
  }));
  api.get('/trash', handler(() => listTrash()));
  api.post('/trash/:id/restore', handler((req) => restoreFromTrash(req.params.id)));

  const named = (req) => {
    if (!isValidName(req.params.name)) throw new HttpError(400, 'Invalid resource name');
    return req.params.name;
  };
  api.post('/resources/:name/action', json, handler((req) => resourceAction(named(req), req.body?.action)));
  api.post('/resources/:name/restart-checked', handler((req) => restartChecked(named(req))));
  api.get('/resources/:name/sql-files', handler((req) => listSqlFiles(named(req))));
  api.post('/resources/:name/boot', json, handler((req) => setBoot(named(req), Boolean(req.body?.enabled))));
  api.post('/resources/:name/activate', json, handler((req) => activateInstalled(named(req), {
    boot: Boolean(req.body?.boot), start: Boolean(req.body?.start),
  })));
  api.post('/resources/:name/sql', json, handler((req) => runSql(named(req), req.body?.file)));
  api.delete('/resources/:name', handler((req) => removeResource(named(req))));

  // Files
  const fileArgs = (source) => {
    const { scope, path: rel } = source;
    if (typeof scope !== 'string' || !scope) throw new HttpError(400, 'Missing scope');
    if (rel !== undefined && typeof rel !== 'string') throw new HttpError(400, 'Invalid path');
    return { scope, rel };
  };
  api.get('/files', handler((req) => listFiles(fileArgs(req.query).scope)));
  api.get('/file', handler((req) => {
    const { scope, rel } = fileArgs(req.query);
    return readEditable(scope, rel);
  }));
  api.put('/file', json, handler((req) => {
    const { scope, rel } = fileArgs(req.body);
    return saveContent(scope, rel, req.body.content, req.body.etag, { force: req.body.force === true });
  }));
  api.put('/file/fields', json, handler((req) => {
    const { scope, rel } = fileArgs(req.body);
    return saveFields(scope, rel, req.body.changes, req.body.etag, { force: req.body.force === true });
  }));
  api.get('/file/versions', handler((req) => {
    const { scope, rel } = fileArgs(req.query);
    return listVersions(scope, rel);
  }));
  api.post('/file/restore', json, handler((req) => {
    const { scope, rel } = fileArgs(req.body);
    return restoreVersion(scope, rel, req.body.id);
  }));

  // Files page
  api.get('/browse', handler((req) => browseFolder(req.query.path ?? '')));
  api.get('/browse/info', handler((req) => fileDetails(req.query.path)));
  api.get('/browse/search', handler((req) => searchFiles(req.query.q, req.query.mode, req.query.path ?? '')));
  api.get('/browse/raw', handler((req, res) => sendRaw(res, req.query.path, req.query.download === '1')));

  // Players
  api.get('/players', handler(() => agentRequest('/players')));
  api.get('/shared', handler(() => agentRequest('/shared', { timeoutMs: 8000 })));
  api.get('/players/:id/inventory', handler((req) => agentRequest('/players/inventory', {
    method: 'POST', body: { id: Number(req.params.id) },
  })));
  api.post('/players/:id/action', json, handler((req) => agentRequest('/players/action', {
    method: 'POST', body: { ...req.body, id: Number(req.params.id) }, timeoutMs: 8000,
  })));
  api.get('/bans', handler(() => agentRequest('/bans')));
  api.delete('/bans/:id', handler((req) => agentRequest('/bans/remove', { method: 'POST', body: { id: Number(req.params.id) } })));

  // Settings
  api.get('/settings', handler((req) => {
    const local = isLocalRequest(req);
    const server = findServerData();
    return {
      local,
      lanEnabled: getSettings().lanEnabled,
      lanListening: lanServers.length > 0,
      appPort: APP_PORT,
      paths: local ? { root: ROOT, fxserver: FXSERVER_DIR, serverData: server?.dataPath || null } : null,
      desktop: local && Boolean(desktop()),
      gamePort: GAME_PORT,
      txAdminPort: TXADMIN_PORT,
      urls: lanAddresses().map((a) => `http://${a}:${APP_PORT}`),
      passcode: local ? getSettings().passcode : null,
    };
  }));
  api.post('/settings/lan', localOnly, json, handler(async (req) => {
    const enabled = Boolean(req.body?.enabled);
    updateSettings({ lanEnabled: enabled });
    await applyLanSetting();
    return { lanEnabled: enabled, lanListening: lanServers.length > 0, errors: lastLanErrors };
  }));
  api.post('/settings/passcode', localOnly, handler((req, res) => {
    // A new passcode signs out every device, so keep this one signed in.
    const passcode = regeneratePasscode();
    setSessionCookie(res, createSession());
    return { passcode };
  }));
  api.post('/settings/pairing', localOnly, json, handler(async (req) => {
    const urls = lanAddresses().map((a) => `http://${a}:${APP_PORT}`);
    const base = urls.includes(req.body?.url) ? req.body.url : urls[0];
    if (!base) throw new HttpError(409, 'This PC does not seem to be on a home network.');
    const url = `${base}/#p=${createPairingToken()}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, svg };
  }));

  app.use('/api', api);

  const dist = path.join(APP_DIR, 'dist');
  if (existsSync(dist)) {
    // Asset names contain a content hash, so they can be cached forever. The page that
    // points at them must always be fresh, or an updated app keeps showing the old version.
    app.use(express.static(dist, {
      index: 'index.html',
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }
  return app;
}

let appInstance = null;
let mainServer = null;
let lanServers = [];
let lastLanErrors = [];

const listen = (app, host) => new Promise((resolve, reject) => {
  const server = http.createServer(app);
  // Node gives up on a request after 5 minutes by default, which would cut off a large upload
  // from a phone. Everything that takes long sits behind sign-in.
  server.requestTimeout = 0;
  server.once('error', reject);
  server.listen(APP_PORT, host, () => {
    server.removeListener('error', reject);
    resolve(server);
  });
});

export async function applyLanSetting() {
  await Promise.all(lanServers.map((s) => new Promise((r) => {
    s.close(() => r());
    s.closeAllConnections?.();
  })));
  lanServers = [];
  lastLanErrors = [];
  if (!getSettings().lanEnabled) return;
  for (const address of lanAddresses()) {
    try {
      lanServers.push(await listen(appInstance, address));
    } catch (err) {
      lastLanErrors.push(`${address}: ${err.message}`);
    }
  }
}

export async function startApp() {
  appInstance = buildApp();
  // If the whole folder was copied to another drive or PC, point its settings at the new place.
  const moved = await repairMovedFolder();
  if (moved.length) recordEvent({ title: 'The server folder has moved', detail: `Updated the ${moved.join(' and ')} to match its new location.` });
  startProbe();
  startStatusPolling();
  // A newer helper takes effect at the next server restart. Never reload it live: a resource
  // restarting itself from inside its own code crashes the server.
  await installAgent().catch((err) => console.error('[cityhq] agent install:', err));
  await ensureCfgBlock().catch((err) => console.error('[cityhq] cfg setup:', err));
  mainServer = await listen(appInstance, '127.0.0.1');
  await applyLanSetting();
  startScheduler();
  return { port: APP_PORT, url: `http://127.0.0.1:${APP_PORT}` };
}

export async function stopApp() {
  stopScheduler();
  stopStatusPolling();
  stopProbe();
  await Promise.all([mainServer, ...lanServers].filter(Boolean).map((s) => new Promise((r) => {
    s.close(() => r());
    s.closeAllConnections?.();
  })));
}
