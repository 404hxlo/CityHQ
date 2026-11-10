import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_NAME = 'qbcontrol.json';

/**
 * Finds the server folder. The app lives inside it (<folder>\control-app\...), so this looks
 * upwards from where the app is installed for the folder that holds FiveM's server or the
 * settings file the setup script writes. Set QBC_ROOT to point somewhere else.
 */
export function findRoot(from = APP_DIR, env = process.env.QBC_ROOT) {
  if (env) return path.resolve(env);
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
/** False when the app was started outside a server folder, so there is nothing for it to manage. */
export const ROOT_FOUND = Boolean(foundRoot);
export const ROOT = foundRoot || path.resolve(APP_DIR, '..');

/** Ports and other choices made when the server folder was set up. Missing values use defaults. */
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

const config = readConfig();
export const FXSERVER_DIR = path.join(ROOT, 'server');
export const FXSERVER_EXE = path.join(FXSERVER_DIR, 'FXServer.exe');
export const TXDATA = path.join(ROOT, 'txData');
export const TX_PROFILE = path.join(TXDATA, 'default');
export const FXSERVER_LOG = path.join(TX_PROFILE, 'logs', 'fxserver.log');
export const LOG_DIR = path.join(ROOT, 'logs');
export const STATE_DIR = path.join(ROOT, '.qbcontrol');
export const BACKUP_DIR = path.join(STATE_DIR, 'backups');
export const TRASH_DIR = path.join(STATE_DIR, 'trash');
export const TMP_DIR = path.join(STATE_DIR, 'tmp');
export const DB_EXE = path.join(ROOT, 'db', 'mariadb', 'bin', 'mariadbd.exe');
export const DB_CLI = path.join(ROOT, 'db', 'mariadb', 'bin', 'mariadb.exe');
export const DB_INI = path.join(ROOT, 'db', 'my.ini');

export const DB_PORT = portOr(config.databasePort, 3308);
export const GAME_PORT = portOr(config.gamePort, 30121);
export const TXADMIN_PORT = portOr(config.txAdminPort, 40120);
export const APP_PORT = portOr(process.env.QBC_PORT, portOr(config.appPort, 40125));

export const TX_ENV = {
  TXHOST_FXS_PORT: String(GAME_PORT),
  TXHOST_TXA_PORT: String(TXADMIN_PORT),
  // The server's output is already kept in txData's logs; don't also pile it up in ours.
  TXHOST_QUIET_MODE: 'true',
  TXHOST_DEFAULT_DBHOST: '127.0.0.1',
  TXHOST_DEFAULT_DBPORT: String(DB_PORT),
  TXHOST_DEFAULT_DBUSER: 'root',
};

/** Finds the deployed server folder: txAdmin's setting first, then the newest good deploy. */
export function findServerData() {
  try {
    const config = JSON.parse(readFileSync(path.join(TX_PROFILE, 'config.json'), 'utf8'));
    const dataPath = config?.server?.dataPath;
    if (dataPath && existsSync(path.join(dataPath, 'server.cfg'))) {
      return {
        dataPath: path.normalize(dataPath),
        cfgPath: path.resolve(dataPath, config.server.cfgPath || 'server.cfg'),
      };
    }
  } catch { /* fall through to scanning */ }

  try {
    const candidates = readdirSync(TXDATA, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith('.base'))
      .map((e) => path.join(TXDATA, e.name))
      .filter((p) => existsSync(path.join(p, 'server.cfg')) && !existsSync(path.join(p, '_DEPLOY_FAILED_DO_NOT_USE')));
    if (candidates.length === 1) {
      return { dataPath: candidates[0], cfgPath: path.join(candidates[0], 'server.cfg') };
    }
  } catch { /* not deployed yet */ }
  return null;
}

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
