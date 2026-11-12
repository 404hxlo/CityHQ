// Which roleplay framework a server runs: QBCore, or Qbox (a QBCore fork that runs most QBCore
// scripts through its built-in bridge). Read from server.cfg and the resources folder.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseBoot, readConvar } from './cfg.js';
import { findServerData, readConfig, REMOTE } from './paths.js';

export const FRAMEWORK_NAMES = { qbcore: 'QBCore', qbox: 'Qbox' };

/** 'qbox', 'qbcore' or null, from server.cfg's start lines and the usual resource folders. */
export function frameworkOf(cfgText, dataPath, exists = existsSync) {
  const boot = parseBoot(String(cfgText || ''));
  if (boot.names.has('qbx_core')) return 'qbox';
  if (boot.names.has('qb-core')) return 'qbcore';
  const has = (...parts) => Boolean(dataPath) && exists(path.join(dataPath, 'resources', ...parts));
  if (has('[qbx]', 'qbx_core')) return 'qbox';
  if (has('[qb]', 'qb-core')) return 'qbcore';
  return null;
}

/** True when server.cfg turns off Qbox's QBCore bridge, so scripts written for QBCore can't load it. */
export const qbxBridgeOff = (cfgText) => /^(false|0|off|no)$/i.test((readConvar(String(cfgText || ''), 'qbx:enablebridge') ?? '').trim());

let cache = { key: null, value: null };
// A hosted server's server.cfg can't be read here synchronously; it is noted each time it is read.
let hosted = null;
export const noteHostedCfg = (text) => { hosted = { framework: frameworkOf(text, null), bridgeOff: qbxBridgeOff(text) }; };

/** The current server's framework and bridge setting, re-read only when server.cfg changes. */
export function serverFramework() {
  if (REMOTE) return hosted || { framework: null, bridgeOff: false };
  try {
    const server = findServerData();
    if (!server) return { framework: null, bridgeOff: false };
    const key = `${server.cfgPath}|${statSync(server.cfgPath).mtimeMs}`;
    if (cache.key !== key) {
      const text = readFileSync(server.cfgPath, 'utf8');
      cache = { key, value: { framework: frameworkOf(text, server.dataPath), bridgeOff: qbxBridgeOff(text) } };
    }
    return cache.value;
  } catch {
    return { framework: null, bridgeOff: false };
  }
}

/**
 * The server's framework, or for a new server txAdmin hasn't deployed yet, the one chosen when it
 * was built (saved in qbcontrol.json), so the setup steps can name the right recipe.
 */
export function currentFramework() {
  const found = serverFramework().framework;
  if (found) return found;
  const planned = readConfig().framework;
  return planned in FRAMEWORK_NAMES ? planned : null;
}

/** "Qbox" or "QBCore" for messages; QBCore when it isn't known, as before. */
export const frameworkName = (framework = serverFramework().framework) => FRAMEWORK_NAMES[framework] || 'QBCore';
