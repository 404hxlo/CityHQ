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
import {
  awakeStatus, refreshAwake, startAwakeWatch, stopAwakeWatch,
} from './awake.js';
import { desktop } from './desktop.js';
import {
  listEvents, markSeen, recordEvent, unseenAlerts,
} from './events.js';
import {
  parseAdmins, removeAdmin, ROLES, setAdmin, VALID_IDENTIFIER,
} from './admins.js';
import { readCfg, writeCfg } from './cfg.js';
import { knownPlayers, nameFor } from './people.js';
import { startupDoctor } from './doctor.js';
import {
  listFixes, recordFix, runFix, undoFix,
} from './fixes.js';
import { healthChecks } from './health.js';
import { inspectResource } from './inspect.js';
import { readProfile, setMaxClients } from './profile.js';
import { askFirewallRules, firewallCommand, reachReport } from './reach.js';
import {
  listChanges, recordChange, registerFixLog, registerUndo, undoChange,
} from './history.js';
import { currentProblems, fixProblem, restartChecked } from './problems.js';
import {
  dayKey, pushWhitelist, startStats, statsView, stopStats,
} from './stats.js';
import {
  cancelPendingRestart, getPendingRestart, isValidTime, nextBackupTime, nextOccurrence, nextScheduledRestart, scheduleRestart, startScheduler, stopScheduler,
} from './scheduler.js';
import {
  listFiles, listVersions, readEditable, restoreVersion, saveContent, saveFields,
} from './files.js';
import {
  APP_DIR, APP_PORT, FXSERVER_DIR, GAME_PORT, findServerData, HttpError, LOG_DIR, MANAGED_DB, ROOT, ROOT_FOUND, ROOT_SOURCE, TXADMIN_PORT,
} from './paths.js';
import { repairMovedFolder } from './relocate.js';
import {
  ensureDatabase, getProcessState, isPortOpen, startProbe, startTxAdmin, stopProbe,
} from './processes.js';
import {
  dbToolsProgress, dbToolsReady, dbToolsState, installDbTools,
} from './dbtools.js';
import {
  checkServerFolder, forgetServer, newServerJob, readTxAdminPin, scanForServers, startNewServer, suggestNewFolder, useServer,
} from './welcome.js';
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
    if (!ROOT_FOUND) return { folderFound: false, rootSource: null };
    return {
      ...overview,
      folderFound: ROOT_FOUND,
      rootSource: ROOT_SOURCE,
      dbTools: MANAGED_DB ? null : { ready: dbToolsReady(), progress: dbToolsProgress() },
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
  // One-click fixes: the server re-plans the fix from the problem id; nothing else is taken from the request.
  api.post('/problems/fix', json, handler((req) => fixProblem(String(req.body?.id || ''))));
  api.get('/problems/fixes', handler(() => listFixes()));

  // Health page: checks, and the startup doctor. Fixes are re-planned on the server from the id.
  api.get('/health', handler(() => healthChecks()));
  api.get('/health/doctor', handler(() => startupDoctor()));
  const runPlannedFix = async (list, id, prefix) => {
    const item = list.find((x) => x.id === id);
    if (!item) throw new HttpError(404, 'That is no longer listed. It may already be fixed.');
    if (!item.fix) throw new HttpError(400, 'There\'s no one-click fix for this.');
    const result = await runFix(item.fix.fix);
    const record = await recordFix({
      problemId: `${prefix}:${id}`, boot: null, title: item.title, label: item.fix.label, message: result.message, undo: result.undo, versionId: result.versionId,
    });
    return { message: result.message, fixId: record.id, undoable: Boolean(result.undo) };
  };
  api.post('/health/fix', json, handler(async (req) => runPlannedFix(await healthChecks(), String(req.body?.id || ''), 'health')));
  api.post('/health/doctor/fix', json, handler(async (req) => runPlannedFix((await startupDoctor()).incidents, String(req.body?.id || ''), 'doctor')));
  // Server profile: player slots (server.cfg) and the game version; the listing lives on the Cfx.re Portal.
  api.get('/profile', handler(() => readProfile()));
  api.put('/profile/slots', json, handler((req) => setMaxClients(req.body?.maxClients)));
  // Friends can't join? What stands between the server and players outside the home network.
  api.get('/reach', handler(async (req) => ({ ...(await reachReport()), firewallCommand: firewallCommand(), local: isLocalRequest(req) })));
  api.post('/reach/firewall', handler((req) => {
    if (!isLocalRequest(req)) throw new HttpError(403, 'This can only be done on the PC running the server.');
    return askFirewallRules();
  }));
  // Install check for one script, with fixes planned again from the id.
  api.get('/resources/:name/check', handler((req) => inspectResource(named(req))));
  api.post('/resources/:name/check/fix', json, handler(async (req) => {
    const name = named(req);
    return runPlannedFix((await inspectResource(name)).checks, String(req.body?.id || ''), `check:${name}`);
  }));
  api.post('/problems/fixes/:id/undo', handler((req) => undoFix(req.params.id)));
  api.get('/events', handler(() => listEvents()));
  api.post('/events/seen', json, handler((req) => {
    markSeen(typeof req.body?.id === 'string' ? req.body.id : undefined);
    return { ok: true };
  }));
  // Welcome screen: connect CityHQ to a server, or build a new one. Only on the PC itself.
  const relaunchSoon = () => {
    const hooks = desktop();
    if (!hooks?.relaunch) return false;
    setTimeout(() => hooks.relaunch(), 400);
    return true;
  };
  api.get('/welcome', localOnly, handler(() => ({
    folderFound: ROOT_FOUND, rootSource: ROOT_SOURCE, root: ROOT_FOUND ? ROOT : null, desktop: Boolean(desktop()), suggestedNewFolder: suggestNewFolder(),
  })));
  api.get('/welcome/scan', localOnly, handler(() => scanForServers()));
  api.post('/welcome/check', localOnly, json, handler((req) => checkServerFolder(req.body?.folder)));
  api.post('/welcome/pick', localOnly, handler(async () => {
    if (!desktop()?.pickInstallSource) throw new HttpError(400, 'Type the folder\'s path instead.');
    const folder = await desktop().pickInstallSource('server');
    return folder ? { folder } : { cancelled: true };
  }));
  api.post('/welcome/use', localOnly, json, handler(async (req) => {
    const saved = await useServer(req.body?.folder, { txAdminPort: req.body?.txAdminPort });
    return { ...saved, needsTools: saved.external };
  }));
  // Database tools for someone's own MySQL: downloaded here, before CityHQ restarts on that server.
  // Before a server is chosen there is no managed database, so this fetches the shared tools. It
  // runs in the background (a 100 MB download takes a while); the screen polls /welcome/progress.
  api.post('/welcome/tools', localOnly, handler(() => {
    installDbTools().catch(() => { /* kept in dbToolsState().error */ });
    return dbToolsState();
  }));
  api.get('/welcome/progress', localOnly, handler(() => ({ tools: dbToolsState(), newServer: newServerJob() })));
  api.post('/welcome/new', localOnly, json, handler((req) => startNewServer(req.body?.folder)));
  api.post('/welcome/relaunch', localOnly, handler(() => ({ relaunching: relaunchSoon() })));
  api.post('/welcome/forget', localOnly, handler(async () => {
    if (ROOT_SOURCE !== 'saved') throw new HttpError(409, 'This copy of CityHQ is installed inside its server folder, so it always manages that one.');
    await forgetServer();
    return { relaunching: relaunchSoon() };
  }));
  // A new server's first start: txAdmin only, so its setup page and PIN can be used.
  api.post('/server/start-panel', localOnly, handler(async () => {
    if (getProcessState().monitor || await isPortOpen(TXADMIN_PORT)) return { alreadyRunning: true, pin: readTxAdminPin(LOG_DIR) };
    await ensureDatabase();
    await startTxAdmin();
    return { started: true };
  }));
  api.get('/server/pin', localOnly, handler(async () => ({ pin: readTxAdminPin(LOG_DIR), panelUp: await isPortOpen(TXADMIN_PORT) })));

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
      keepAwake: { ...s.keepAwake, ...awakeStatus() },
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
    if (body.keepAwake && typeof body.keepAwake === 'object') {
      const { enabled = s.keepAwake.enabled, screenOnBattery = s.keepAwake.screenOnBattery } = body.keepAwake;
      patch.keepAwake = { enabled: Boolean(enabled), screenOnBattery: Boolean(screenOnBattery) };
    }
    if (typeof body.openAtLogin === 'boolean') {
      if (!isLocalRequest(req)) throw new HttpError(403, 'This can only be changed on the PC running the server.');
      if (!desktop()) throw new HttpError(409, 'This only works in the desktop app.');
      desktop().setOpenAtLogin(body.openAtLogin);
    }
    updateSettings(patch);
    if (patch.keepAwake) refreshAwake();
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

  // Dashboard: how busy the server has been, what is coming up, and what happened when.
  api.get('/dashboard', handler(async () => {
    const s = getSettings();
    const now = Date.now();
    const upcoming = [];
    const pending = getPendingRestart();
    if (pending) upcoming.push({ kind: 'countdown', at: pending.at, title: pending.reason === 'scheduled' ? 'Scheduled restart' : 'Restart', detail: 'Players are being warned' });
    if (s.restarts.enabled && s.restarts.times.length) {
      let cursor = now;
      for (let i = 0; i < 3; i++) {
        const at = nextOccurrence(s.restarts.times, new Date(cursor));
        if (!at) break;
        if (!pending || Math.abs(at - pending.at) > 60000) upcoming.push({ kind: 'restart', at, title: 'Scheduled restart', detail: 'Warnings at 15, 5 and 1 minutes' });
        cursor = at;
      }
    }
    const backupAt = s.backups.enabled ? nextBackupTime() : null;
    if (backupAt) upcoming.push({ kind: 'backup', at: backupAt, title: 'Nightly backup', detail: 'Players stay connected' });
    upcoming.sort((a, b) => a.at - b.at);

    const history = {};
    const mark = (ms, kind) => {
      const day = dayKey(ms);
      history[day] = history[day] || {};
      history[day][kind] = (history[day][kind] || 0) + 1;
    };
    for (const b of await listBackups().catch(() => [])) mark(b.createdAt, 'backup');
    for (const e of listEvents(500)) {
      if (/crash|stopped unexpectedly|went down/i.test(e.title)) mark(e.at, 'crash');
      else if (/restart/i.test(e.title)) mark(e.at, 'restart');
    }
    return {
      ...statsView(),
      upcoming: upcoming.slice(0, 6),
      history,
      schedule: { restarts: s.restarts.enabled ? s.restarts.times : [], backup: s.backups.enabled ? s.backups.time : null },
      greetingName: s.greetingName,
    };
  }));
  api.put('/settings/greeting', json, handler((req) => {
    const name = String(req.body?.name ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 40);
    updateSettings({ greetingName: name });
    return { greetingName: name };
  }));

  // The city: weather and time, events for everyone, and who may join.
  const WORLD_KEYS = ['weather', 'hour', 'minute', 'blackout', 'timeFrozen', 'dynamicWeather'];
  api.get('/city/world', handler(() => agentRequest('/world')));
  api.post('/city/world', json, handler((req) => agentRequest('/world', {
    method: 'POST', body: Object.fromEntries(WORLD_KEYS.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]])),
  })));
  api.post('/city/banner', json, handler((req) => agentRequest('/events/banner', {
    method: 'POST',
    body: { title: req.body?.title, message: req.body?.message, seconds: Number(req.body?.seconds) || 10, countdown: req.body?.countdown === true },
  })));
  api.post('/city/revive-all', handler(() => agentRequest('/events/revive-all', { method: 'POST' })));
  api.post('/city/clear-vehicles', json, handler((req) => agentRequest('/events/clear-vehicles', {
    method: 'POST', body: { seconds: Math.max(0, Math.min(600, Number(req.body?.seconds) || 0)) },
  })));
  api.get('/city/whitelist', handler(async () => {
    const { whitelist } = getSettings();
    let live = null;
    try { live = await agentRequest('/whitelist', { timeoutMs: 2500 }); } catch { /* server off or older helper */ }
    return { enabled: whitelist.enabled, entries: whitelist.entries, live: live ? { enabled: live.enabled === true } : null };
  }));
  api.put('/city/whitelist', json, handler(async (req) => {
    const { whitelist } = getSettings();
    let entries = [...whitelist.entries];
    const add = req.body?.add;
    if (add) {
      if (!VALID_IDENTIFIER.test(add.id || '')) throw new HttpError(400, 'That is not a valid player ID');
      if (!entries.some((e) => e.id === add.id)) entries.push({ id: add.id, name: String(add.name || '').slice(0, 60) });
    }
    if (typeof req.body?.remove === 'string') entries = entries.filter((e) => e.id !== req.body.remove);
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : whitelist.enabled;
    updateSettings({ whitelist: { enabled, entries } });
    let applied = false;
    try { await pushWhitelist(); applied = true; } catch { /* sent the next time the server starts */ }
    return { enabled, entries, applied };
  }));

  // Admins: kept in server.cfg, and applied to the running server straight away.
  const serverCfg = () => {
    const server = findServerData();
    if (!server) throw new HttpError(409, 'Finish the txAdmin setup first.');
    return server.cfgPath;
  };
  const applyLive = async (steps) => {
    try {
      for (const body of steps) await agentRequest('/admins/apply', { method: 'POST', body });
      return true;
    } catch { return false; }
  };
  /** Gives a player a role (or none), live too, and notes it in the history with the way back. */
  const changeAdmin = async (identifier, role, name, { record = true } = {}) => {
    const cfgPath = serverCfg();
    const before = parseAdmins(await readCfg(cfgPath)).find((a) => a.identifier === identifier) || null;
    let result;
    if (role) {
      const { text, removed } = setAdmin(await readCfg(cfgPath), identifier, role, name);
      await writeCfg(cfgPath, text);
      const live = await applyLive([
        ...removed.map((principal) => ({ identifier, role: principal, remove: true })),
        { identifier, role: ROLES[role].principal },
      ]);
      result = { saved: true, live };
    } else {
      const { text, removed } = removeAdmin(await readCfg(cfgPath), identifier);
      if (!removed.length) throw new HttpError(404, 'That player is not an admin');
      await writeCfg(cfgPath, text);
      result = { removed: removed.length, live: await applyLive(removed.map((principal) => ({ identifier, role: principal, remove: true }))) };
    }
    if (getSettings().whitelist.enabled) await pushWhitelist().catch(() => {});
    if (record) {
      const who = name || before?.label || 'A player';
      recordChange({
        kind: 'admin',
        title: role ? `${who} is now ${ROLES[role].label}` : `${who} is no longer an admin`,
        undo: { type: 'admin', identifier, role: before?.role || null, name: who },
        undoHint: before?.role ? `${who} goes back to ${ROLES[before.role]?.label || before.role}.` : `${who} is no longer an admin.`,
      });
    }
    return result;
  };
  api.get('/known-players', handler(async () => (await knownPlayers()).slice(0, 500)));
  api.get('/admins', handler(async () => {
    const admins = parseAdmins(await readCfg(serverCfg()));
    let players = [];
    let playersError = null;
    try { players = await knownPlayers(); } catch { playersError = 'The player list could not be read from the database. Is the database running?'; }
    return {
      admins: admins.map((a) => ({ ...a, name: nameFor(a.identifier, players) })),
      roles: ROLES,
      players: players.slice(0, 500),
      playersError,
    };
  }));
  api.post('/admins', json, handler(async (req) => {
    const { identifier, role, name } = req.body || {};
    if (!VALID_IDENTIFIER.test(identifier || '')) throw new HttpError(400, 'Choose a player first');
    if (!ROLES[role]) throw new HttpError(400, 'Choose Owner, Admin or Moderator');
    return changeAdmin(identifier, role, name);
  }));
  api.delete('/admins/:identifier', handler(async (req) => {
    const { identifier } = req.params;
    if (!VALID_IDENTIFIER.test(identifier || '')) throw new HttpError(400, 'That is not a valid player ID');
    return changeAdmin(identifier, null);
  }));

  // Change history: one timeline with Undo. Each kind of change says how it is undone.
  registerFixLog({ list: listFixes, undo: undoFix });
  registerUndo('file-version', async ({ scope, rel, versionId }) => { await restoreVersion(scope, rel, versionId); return `${rel} is back to how it was before that change.`; });
  registerUndo('boot', async ({ name, enabled }) => { await setBoot(name, enabled); return enabled ? `${name} starts with the server again.` : `${name} no longer starts with the server.`; });
  registerUndo('remove', async ({ name }) => { await removeResource(name); return `${name} was moved to Recently removed.`; });
  registerUndo('restore-trash', async ({ id, name, boot }) => {
    await restoreFromTrash(id);
    if (boot) await setBoot(name, true, { record: false });
    return `${name} is back${boot ? ' and starts with the server again' : ''}.`;
  });
  registerUndo('restore-db', async ({ backupId }) => {
    // Like a restore from Backups: a scheduled restart must not fire in the middle of it.
    cancelPendingRestart();
    await restoreServer(backupId, ['database']);
    return `The database is back to backup ${backupId}.`;
  });
  registerUndo('admin', async ({ identifier, role, name }) => {
    await changeAdmin(identifier, role, name);
    return role ? `${name} is ${ROLES[role]?.label || role} again.` : `${name} is no longer an admin.`;
  });
  api.get('/history', handler(() => listChanges()));
  api.post('/history/:id/undo', handler((req) => undoChange(req.params.id)));

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
      // 'saved' means the server was chosen on the Welcome screen, so Settings can change it.
      rootSource: ROOT_SOURCE,
      databaseManaged: MANAGED_DB,
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
  // No server chosen yet: only the Welcome screen runs. Nothing to watch, back up or restart.
  if (!ROOT_FOUND) {
    mainServer = await listen(appInstance, '127.0.0.1');
    return { port: APP_PORT, url: `http://127.0.0.1:${APP_PORT}` };
  }
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
  startStats();
  startAwakeWatch();
  // Someone's own database needs CityHQ's database tools; fetch them if a first try didn't finish.
  if (!MANAGED_DB && !dbToolsReady()) {
    installDbTools().catch((err) => recordEvent({ level: 'alert', title: 'CityHQ could not get its database tools', detail: `${err.message} Backups and SQL files need them. CityHQ tries again the next time it starts.` }));
  }
  return { port: APP_PORT, url: `http://127.0.0.1:${APP_PORT}` };
}

export async function stopApp() {
  stopScheduler();
  stopStats();
  stopAwakeWatch();
  stopStatusPolling();
  stopProbe();
  await Promise.all([mainServer, ...lanServers].filter(Boolean).map((s) => new Promise((r) => {
    s.close(() => r());
    s.closeAllConnections?.();
  })));
}
