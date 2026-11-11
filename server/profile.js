// The server profile: what server.cfg still controls (player slots) and, read-only, the game
// version. The server-list name, description, tags, icon and banners now live on the Cfx.re Portal,
// which FiveM says server.cfg can no longer set, so the app links there instead of pretending.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readCfg, readCommand, readConvar, setCommand, writeCfg,
} from './cfg.js';
import { keepVersion, SERVER_SCOPE } from './files.js';
import { recordChange } from './history.js';
import { HttpError, TX_PROFILE } from './paths.js';
import { serverData } from './resources.js';

// GTA V updates FiveM can lock the server to, newest first (sv_enforceGameBuild).
const GAME_BUILDS = [
  [3570, 'Money Fronts'], [3407, 'Agents of Sabotage'], [3258, 'Bottom Dollar Bounties'], [3095, 'The Chop Shop'],
  [2944, 'San Andreas Mercenaries'], [2802, 'Los Santos Drug Wars'], [2699, 'The Criminal Enterprises'],
  [2612, 'Expanded and Enhanced'], [2545, 'The Contract'], [2372, 'Los Santos Tuners'], [2189, 'Cayo Perico Heist'],
  [2060, 'Los Santos Summer Special'], [1868, 'Diamond Casino & Resort'], [1604, 'Arena War'],
];
export const MAX_SLOTS = 2048;
// FiveM's slot limit for each OneSync setting: off allows 48, legacy 64, on 2048.
const ONESYNC_SLOTS = { off: 48, legacy: 64, on: MAX_SLOTS };

/**
 * The OneSync setting the server starts with. txAdmin turns it on unless its own settings say
 * otherwise, and a "set onesync" line in server.cfg comes after that.
 */
export function oneSyncMode(cfg, txConfig = null) {
  const value = String(readConvar(cfg, 'onesync') ?? txConfig?.server?.onesync ?? 'on').trim().toLowerCase();
  if (/^(off|false|0)$/.test(value)) return 'off';
  if (value === 'legacy') return 'legacy';
  return 'on';
}

function txConfig() {
  try { return JSON.parse(readFileSync(path.join(TX_PROFILE, 'config.json'), 'utf8')); } catch { return null; }
}

export function gameBuildName(build) {
  return GAME_BUILDS.find(([b]) => b === build)?.[1] || null;
}

export async function readProfile() {
  const { cfgPath } = serverData();
  const cfg = await readCfg(cfgPath);
  const slots = Number(readCommand(cfg, 'sv_maxclients'));
  const build = Number(readCommand(cfg, 'sv_enforceGameBuild'));
  return {
    maxClients: Number.isFinite(slots) && slots > 0 ? slots : null,
    gameBuild: Number.isFinite(build) && build > 0 ? build : null,
    gameBuildName: gameBuildName(build),
    portalUrl: 'https://portal.cfx.re/servers',
  };
}

/** Player slots, saved to server.cfg with a copy kept, noted in the history. Applies at the next restart. */
export async function setMaxClients(value) {
  const slots = Number(value);
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw new HttpError(400, `Choose between 1 and ${MAX_SLOTS} player slots.`);
  const { cfgPath } = serverData();
  const before = await readCfg(cfgPath);
  const onesync = oneSyncMode(before, txConfig());
  if (slots > ONESYNC_SLOTS[onesync]) {
    throw new HttpError(400, `With OneSync ${onesync === 'off' ? 'off' : 'set to legacy'}, FiveM allows at most ${ONESYNC_SLOTS[onesync]} player slots. Turn OneSync on in txAdmin's settings (or server.cfg) for more.`);
  }
  const old = Number(readCommand(before, 'sv_maxclients')) || null;
  if (old === slots) return readProfile();
  const versionId = await keepVersion(SERVER_SCOPE, 'server.cfg');
  await writeCfg(cfgPath, setCommand(before, 'sv_maxclients', String(slots)));
  recordChange({
    kind: 'file',
    title: `Player slots changed${old ? ` from ${old}` : ''} to ${slots}`,
    undo: { type: 'file-version', scope: SERVER_SCOPE, rel: 'server.cfg', versionId },
    undoHint: 'server.cfg goes back to how it was just before this change. Later changes to server.cfg are undone too.',
  });
  return readProfile();
}
