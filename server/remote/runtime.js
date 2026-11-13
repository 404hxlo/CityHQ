// Starts CityHQ for a hosted server: everything that would reach this PC's disk, processes or
// 127.0.0.1 is pointed at the host instead.
import { setAgentBase } from '../agent.js';
import { setCfgIo } from '../cfg.js';
import { setConsoleSource } from '../console.js';
import { setHostedControl } from '../control.js';
import { recordEvent } from '../events.js';
import { noteHostedCfg } from '../framework.js';
import { HttpError, REMOTE } from '../paths.js';
import { setHostedKeepVersion } from '../files.js';
import { setHostedHealthChecks } from '../health.js';
import { setHostedResources } from '../resources.js';
import { keepHostedVersion } from './files.js';
import { hostedHealthChecks } from './health.js';
import { placeOnHost, removeFromHost } from './install.js';
import {
  hostedDisk, hostedResourceAction, hostedSystem, setHostedBoot,
} from './resources.js';
import { closeConnection, connection, saveRemote } from './connection.js';
import { serverNameOf } from './find.js';
import {
  helperState, installRemoteHelper, joinLinkOf, lastHelperAddress, NO_ADDRESS, readHelperAddress,
} from './helper.js';
import { directAddressOf, listedNow } from './listing.js';

let problem = null;

/** Why the hosted server can't be reached at all (a key that can't be unlocked, say), or null. */
export const hostedProblem = () => problem;

/**
 * What players type after F8 "connect": the Cfx.re join link once the helper has said its address
 * and FiveM's server list has it (the link only opens then), otherwise the address the panel
 * gives, otherwise (SFTP only) the host's name with the game port, which is right for most hosts.
 * listed says whether the list has the server (null: not known). Null when CityHQ can't tell.
 */
function joinAddress() {
  const link = joinLinkOf(lastHelperAddress());
  const direct = directAddressOf(REMOTE);
  const listed = link ? listedNow(link) : null;
  if (link && !(listed === false && direct)) return { text: link, sure: true, listed, link };
  if (direct) return { text: direct, sure: true, listed, link };
  if (REMOTE.type === 'sftp' && REMOTE.host) return { text: `${REMOTE.host}:${REMOTE.gamePort || 30120}`, sure: false, listed, link };
  return null;
}

export function describeHosted() {
  return {
    type: REMOTE.type,
    label: REMOTE.serverName || REMOTE.host || 'Hosted server',
    panelUrl: REMOTE.type === 'panel' ? REMOTE.panelUrl : null,
    host: REMOTE.type === 'sftp' ? REMOTE.host : null,
    address: REMOTE.address || null,
    join: joinAddress(),
    capabilities: problem ? { power: false, stats: false, liveConsole: false } : connection().capabilities,
    problem,
  };
}

export async function startRemote() {
  let conn = null;
  try { conn = connection(); } catch (err) { problem = err.message; }

  setCfgIo({
    async read(p) {
      if (!conn) throw new HttpError(409, problem);
      const text = await conn.files.read(p);
      if (p === REMOTE.cfgPath) noteHostedCfg(text);
      return text;
    },
    async write(p, text) {
      if (!conn) throw new HttpError(409, problem);
      await conn.files.write(p, text);
      if (p === REMOTE.cfgPath) noteHostedCfg(text);
    },
  });
  setConsoleSource(async (since) => {
    if (!conn) return { offset: 0, lines: [{ text: problem, level: 'error' }], reset: false };
    return conn.readConsole(since);
  });
  setAgentBase(async () => {
    if (!conn) throw new HttpError(409, problem);
    const address = await readHelperAddress(conn, REMOTE.dataPath);
    if (!address) throw NO_ADDRESS;
    return address;
  });
  setHostedResources({
    disk: hostedDisk,
    system: hostedSystem,
    action: hostedResourceAction,
    setBoot: setHostedBoot,
    place: placeOnHost,
    remove: removeFromHost,
  });
  setHostedKeepVersion(keepHostedVersion);
  setHostedHealthChecks(hostedHealthChecks);
  setHostedControl({
    label: REMOTE.serverName || REMOTE.host || 'Hosted server',
    capabilities: conn ? conn.capabilities : { power: false, stats: false, liveConsole: false },
    stats: () => conn.stats(),
    power: (signal) => {
      if (!conn) throw new HttpError(409, problem);
      return conn.power(signal);
    },
    describe: describeHosted,
  });
  if (!conn) return;

  // What the server runs (QBCore or Qbox) is read from server.cfg once now. A server connected
  // over SFTP by an earlier version was named after the SFTP address: give it its own name.
  conn.files.read(REMOTE.cfgPath).then(async (cfgText) => {
    noteHostedCfg(cfgText);
    if (REMOTE.type === 'sftp' && (!REMOTE.serverName || REMOTE.serverName === REMOTE.host)) {
      const name = await serverNameOf(conn.files, { txProfile: REMOTE.txProfile, cfgText });
      if (name) { REMOTE.serverName = name; saveRemote(); }
    }
  }).catch(() => {});
  // A newer CityHQ brings a newer helper: put it in place now; it loads at the next restart.
  try {
    const state = await helperState(conn, REMOTE.dataPath);
    if (state.installed && !state.current) {
      await installRemoteHelper(conn, { dataPath: REMOTE.dataPath, cfgPath: REMOTE.cfgPath });
      recordEvent({ title: 'CityHQ\'s helper was updated on your hosted server', detail: 'It loads the next time the server restarts.' });
    }
  } catch { /* tried again next start */ }
}

export function stopRemote() {
  closeConnection();
}
