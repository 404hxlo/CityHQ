import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gamePortOf } from './cfg.js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_NAME = 'qbcontrol.json';

/**
 * CityHQ's own folder on this PC, apart from any server: which server it manages (for a copy
 * downloaded on its own), database tools it downloaded, and its settings before a server is
 * chosen. QBC_HOME points it somewhere else, such as a test copy's own folder.
 */
export const HOME_DIR = process.env.QBC_HOME
  ? path.resolve(process.env.QBC_HOME)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CityHQ');
export const POINTER_FILE = path.join(HOME_DIR, 'cityhq.json');
export const TOOLS_DIR = path.join(HOME_DIR, 'tools');

/** The server folder chosen on the Welcome screen, if it is still there. */
export function readSavedRoot(file = POINTER_FILE) {
  try {
    const root = JSON.parse(readFileSync(file, 'utf8'))?.serverRoot;
    return root && existsSync(path.join(root, CONFIG_NAME)) ? path.resolve(root) : null;
  } catch { return null; }
}

/**
 * Finds the server folder. When the app lives inside one (<folder>\control-app\...), that folder,
 * found by looking upwards for the settings file setup writes or FiveM's server. Otherwise the one
 * chosen on the Welcome screen. Set QBC_ROOT to point somewhere else.
 */
export function findRoot(from = APP_DIR, env = process.env.QBC_ROOT, saved = readSavedRoot()) {
  if (env) return path.resolve(env);
  return folderAbove(from) || saved || null;
}

/** The server folder the app is installed inside, looking upwards, or null. */
function folderAbove(from) {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, CONFIG_NAME)) || existsSync(path.join(dir, 'server', 'FXServer.exe'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const foundRoot = findRoot();
/** False when no server has been chosen yet, so the Welcome screen shows instead. */
export const ROOT_FOUND = Boolean(foundRoot);
/**
 * How the server folder was found: 'folder' (the app is installed inside it), 'saved' (chosen on
 * the Welcome screen, so it can be changed), 'env' (QBC_ROOT) or null (none yet).
 */
export const ROOT_SOURCE = !foundRoot ? null : process.env.QBC_ROOT ? 'env' : folderAbove(APP_DIR) ? 'folder' : 'saved';
export const ROOT = foundRoot || HOME_DIR;

/** Ports, folders and other choices for the server folder. Missing values use defaults. */
export function readConfig(root = ROOT) {
  try {
    const config = JSON.parse(readFileSync(path.join(root, CONFIG_NAME), 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch { return {}; }
}

export function portOr(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const VALID_PROFILE = /^[\w.-]+$/;

/**
 * Where everything is for a server folder. Setup's own layout (server\, txData\, db\) is the
 * default; a server CityHQ didn't make says where its parts are in qbcontrol.json. The database
 * is CityHQ's own ("managed") only when setup made it, and otherwise belongs to the server's owner.
 */
export function layoutOf(root, config = {}, exists = existsSync) {
  const at = (p, fallback) => (typeof p === 'string' && p.trim() ? path.resolve(root, p) : fallback);
  const fxserverDir = at(config.fxserverDir, path.join(root, 'server'));
  const txDataDir = at(config.txDataDir, path.join(root, 'txData'));
  const profile = VALID_PROFILE.test(config.profile || '') ? config.profile : 'default';
  const dbHome = path.join(root, 'db', 'mariadb');
  const managedDb = config.database === 'managed' || config.database === 'external'
    ? config.database === 'managed'
    : exists(path.join(dbHome, 'bin', 'mariadbd.exe'));
  // txAdmin keeps its data next to FiveM's server folder unless told otherwise.
  const defaultTxData = path.resolve(fxserverDir, '..', 'txData');
  return {
    root, fxserverDir, txDataDir, profile, dbHome, managedDb,
    txDataIsDefault: txDataDir.toLowerCase() === defaultTxData.toLowerCase(),
  };
}

const config = readConfig();
const LAYOUT = layoutOf(ROOT, config);
export const FXSERVER_DIR = LAYOUT.fxserverDir;
export const FXSERVER_EXE = path.join(FXSERVER_DIR, 'FXServer.exe');
export const TXDATA = LAYOUT.txDataDir;
export const TX_PROFILE = path.join(TXDATA, LAYOUT.profile);
export const FXSERVER_LOG = path.join(TX_PROFILE, 'logs', 'fxserver.log');
export const LOG_DIR = ROOT_FOUND ? path.join(ROOT, 'logs') : path.join(HOME_DIR, 'logs');
export const STATE_DIR = ROOT_FOUND ? path.join(ROOT, '.qbcontrol') : path.join(HOME_DIR, 'state');
export const BACKUP_DIR = path.join(STATE_DIR, 'backups');
export const TRASH_DIR = path.join(STATE_DIR, 'trash');
export const TMP_DIR = path.join(STATE_DIR, 'tmp');
/** True when CityHQ runs the database itself (a server setup made); false for the owner's own MySQL. */
export const MANAGED_DB = LAYOUT.managedDb;
export const DB_HOME = LAYOUT.dbHome;
export const DB_EXE = path.join(DB_HOME, 'bin', 'mariadbd.exe');
export const DB_INI = path.join(ROOT, 'db', 'my.ini');

/** Finds the deployed server folder: txAdmin's setting first, then the newest good deploy. */
export function findServerData(txProfile = TX_PROFILE, txData = TXDATA) {
  try {
    const tx = JSON.parse(readFileSync(path.join(txProfile, 'config.json'), 'utf8'));
    // txAdmin 8 keeps it under server, txAdmin 7 under fxRunner.
    const dataPath = tx?.server?.dataPath || tx?.fxRunner?.serverDataPath;
    const cfgPath = tx?.server?.cfgPath || tx?.fxRunner?.cfgPath || 'server.cfg';
    if (dataPath && existsSync(path.resolve(dataPath, cfgPath))) {
      return { dataPath: path.normalize(dataPath), cfgPath: path.resolve(dataPath, cfgPath) };
    }
  } catch { /* fall through to scanning */ }

  try {
    const candidates = readdirSync(txData, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith('.base'))
      .map((e) => path.join(txData, e.name))
      .filter((p) => existsSync(path.join(p, 'server.cfg')) && !existsSync(path.join(p, '_DEPLOY_FAILED_DO_NOT_USE')));
    if (candidates.length === 1) {
      return { dataPath: candidates[0], cfgPath: path.join(candidates[0], 'server.cfg') };
    }
  } catch { /* not deployed yet */ }
  return null;
}

/** The game port: forced by CityHQ for a server setup made, otherwise whatever server.cfg says. */
function gamePort() {
  if (MANAGED_DB) return portOr(config.gamePort, 30121);
  try {
    const server = findServerData();
    const fromCfg = server ? gamePortOf(readFileSync(server.cfgPath, 'utf8')) : null;
    if (fromCfg) return fromCfg;
  } catch { /* use the saved one */ }
  return portOr(config.gamePort, 30120);
}

export const DB_PORT = portOr(config.databasePort, 3308);
export const GAME_PORT = gamePort();
export const TXADMIN_PORT = portOr(config.txAdminPort, 40120);
export const APP_PORT = portOr(process.env.QBC_PORT, portOr(config.appPort, 40125));

/**
 * What txAdmin is started with. For a server setup made, CityHQ chose the ports and runs the
 * database, so it says so. For anyone else's server, only the txAdmin port (and where its data
 * is, when that isn't the usual place) are passed, so their own settings stay in charge.
 */
export const TX_ENV = MANAGED_DB
  ? {
    TXHOST_FXS_PORT: String(GAME_PORT),
    TXHOST_TXA_PORT: String(TXADMIN_PORT),
    // The server's output is already kept in txData's logs; don't also pile it up in ours.
    TXHOST_QUIET_MODE: 'true',
    TXHOST_DEFAULT_DBHOST: '127.0.0.1',
    TXHOST_DEFAULT_DBPORT: String(DB_PORT),
    TXHOST_DEFAULT_DBUSER: 'root',
  }
  : {
    TXHOST_TXA_PORT: String(TXADMIN_PORT),
    TXHOST_QUIET_MODE: 'true',
    ...(LAYOUT.txDataIsDefault ? {} : { TXHOST_DATA_PATH: TXDATA }),
  };

/** Resolves rel inside base, refusing anything that escapes it (including through links). */
export function resolveInside(base, rel = '') {
  const normalizedBase = path.resolve(base);
  const target = path.resolve(normalizedBase, rel);
  const inside = (p, b) => p === b || p.startsWith(b + path.sep);
  if (!inside(target, normalizedBase)) throw new HttpError(400, 'That path is outside the allowed folder');
  if (existsSync(target)) {
    const realBase = realpathSync(normalizedBase);
    if (!inside(realpathSync(target), realBase)) throw new HttpError(400, 'That path is outside the allowed folder');
  }
  return target;
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
