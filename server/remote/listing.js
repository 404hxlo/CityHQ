// Whether FiveM's server list has a hosted server. Players only find a server there, and its
// cfx.re/join link only opens while it's listed. Since October 2026, FiveM lists a server only once
// its license key has the server's details (name, tagline, description, language) on the Cfx.re
// Portal, so a server can run fine and still be missing. Asked of the list's public address, the
// way FiveM itself asks, every few minutes.
import { readCommand, readConvar } from '../cfg.js';
import { APP_VERSION } from '../updates.js';

const LIST_URL = 'https://servers-frontend.fivem.net/api/servers/single/';
const EVERY_MS = 5 * 60 * 1000;
/** FiveM's list can take up to 8 minutes to show a server after it starts. */
export const LISTING_GRACE_MS = 10 * 60 * 1000;
const PORTAL_URL = 'https://portal.cfx.re/servers';
const LIST_HELP_URL = 'https://docs.fivem.net/docs/support/server-issues/';

let last = { code: null, listed: null, at: 0, missingSince: null };
let checking = null;

export const joinCodeOf = (link) => String(link || '').match(/cfx\.re\/join\/([a-z0-9]+)$/i)?.[1].toLowerCase() || null;

export const isIpv4 = (text) => /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(String(text || ''));

/** The host's own address for the server (ip:port), which works whether or not it's listed. */
export const directAddressOf = (remote) => (remote?.address?.ip ? `${remote.address.ip}:${remote.address.port}` : null);

/** Asks the list about a join code: true when listed, false when it isn't, null when it couldn't tell. */
export async function askList(code, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${LIST_URL}${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json', 'User-Agent': `CityHQ/${APP_VERSION}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

/**
 * Whether the list had this join link at the last check: true, false, or null when that isn't
 * known yet. Asks again in the background once the last answer is a few minutes old.
 */
export function listedNow(link, { now = Date.now(), fetchImpl } = {}) {
  const code = joinCodeOf(link);
  if (!code) return null;
  if (last.code !== code) last = { code, listed: null, at: 0, missingSince: null };
  if (!checking && now - last.at >= EVERY_MS) {
    last.at = now;
    checking = askList(code, fetchImpl).then((listed) => {
      // A check that couldn't tell keeps the last answer.
      if (last.code !== code || listed === null) return;
      last.listed = listed;
      last.missingSince = listed ? null : (last.missingSince ?? now);
    }).finally(() => { checking = null; });
  }
  return last.listed;
}

/** Waits for a check that's under way (for tests). */
export const listingSettled = () => checking || Promise.resolve();

/**
 * For Things to fix: the server has been up long enough for FiveM's list to show it, and the list
 * doesn't. uptimeMs comes from the host's panel (null without one: then it counts from when CityHQ
 * first saw it missing). keyAction is the button that uses the PC server's license key, for a
 * server moved here with an older CityHQ.
 */
export function notListedProblem({
  link, direct = null, uptimeMs = null, keyAction = null, error = null, hostIp = null, now = Date.now(), fetchImpl,
}) {
  if (listedNow(link, { now, fetchImpl }) !== false) return null;
  const upLongEnough = uptimeMs !== null && uptimeMs !== undefined
    ? uptimeMs >= LISTING_GRACE_MS
    : last.missingSince !== null && now - last.missingSince >= LISTING_GRACE_MS;
  if (!upLongEnough) return null;
  const portal = 'sign in at the Cfx.re Portal with the account your license key comes from. Open Servers, then Server Registration Keys, open the key this server uses, and choose Edit Server Details.';
  // The list tried the host's own address and still couldn't reach it: something at the host blocks it.
  const blockedAtHost = Boolean(error?.ip && error.ip === hostIp);
  return {
    id: 'not-listed',
    rule: 'not-listed',
    severity: 'error',
    resource: null,
    count: 1,
    title: 'Your server isn\'t on FiveM\'s server list',
    what: `Players can't find it in FiveM (or see it as private), and its join link (${link}) doesn't open.${direct ? ` They can still join with "connect ${direct}" in FiveM's F8 console.` : ''}${error?.text ? ` FiveM's list said: "${error.text}"` : ' Since October 2026, FiveM lists a server only once its license key has the server\'s details on the Cfx.re Portal.'}`,
    fix: [
      ...(blockedAtHost ? [`FiveM's list couldn't reach your server even at its own address, ${hostIp}. Ask your host whether their firewall or attack protection blocks FiveM's server list (Cfx.re), and show them the message above.`] : []),
      ...(keyAction
        ? ['Your server on your PC used a different license key, and the name and list entry you set up belong to that key. Press the button to use it here, then restart the server.', `Or, to keep this key, ${portal}`]
        : [`${blockedAtHost ? 'Also check its details: s' : 'S'}${portal.slice(1)}`]),
      'Fill in Name, Tagline, Description and Language, then save. The list can take up to an hour to show the change.',
      ...(error ? [] : ['Still missing after that? Open the Console page and search for "Server list query returned an error".']),
    ],
    actions: keyAction ? [keyAction] : [],
    links: [
      { kind: 'doc', label: 'Cfx.re Portal: your servers', url: PORTAL_URL },
      { kind: 'doc', label: 'FiveM help: a server missing from the list', url: LIST_HELP_URL },
    ],
    raw: error?.raw || `FiveM's server list has nothing under ${link}.`,
  };
}

/** Things to fix: server.cfg's sv_master1 "" keeps the server off FiveM's list, so it shows as private. */
export function hiddenByCfgProblem() {
  return {
    id: 'list-hidden',
    rule: 'list-hidden',
    severity: 'error',
    resource: null,
    count: 1,
    title: 'server.cfg keeps your server off FiveM\'s server list',
    what: 'The line sv_master1 "" tells your server not to report to FiveM\'s server list, so players see it as private and its connect button is greyed out. FiveM\'s help says to switch that line off.',
    fix: ['Press the button. The line stays in server.cfg, switched off, so you can undo it.', 'Restart the server. FiveM\'s list can take up to 10 minutes to show it.'],
    actions: [{
      kind: 'fix',
      label: 'Switch that line off',
      confirm: 'server.cfg keeps the sv_master1 line but switches it off, so your server reports to FiveM\'s server list again. A copy of server.cfg is saved first, and you can undo this. It takes effect when the server restarts.',
      fix: { type: 'show-on-list' },
    }],
    links: [{ kind: 'doc', label: 'FiveM help: a server shown as private', url: LIST_HELP_URL }],
    raw: 'sv_master1 ""',
  };
}

/**
 * Things to fix: FiveM's list tried to reach the server at an address that isn't the one the host
 * gives it. Some hosts' servers go out to the internet from another address than players use, and
 * telling the list the host's address (sv_listingIpOverride) fixes that. Null when the console has
 * no such complaint, the addresses match, or server.cfg says so already.
 */
export function wrongAddressProblem({ error, hostIp, cfgText }) {
  if (!error?.ip || !isIpv4(hostIp) || error.ip === hostIp) return null;
  const cfg = String(cfgText || '');
  if ((readConvar(cfg, 'sv_listingIpOverride') ?? readCommand(cfg, 'sv_listingIpOverride')) === hostIp) return null;
  return {
    id: 'list-wrong-address',
    rule: 'list-wrong-address',
    severity: 'error',
    resource: null,
    count: 1,
    title: 'FiveM\'s server list checks your server at the wrong address',
    what: `FiveM's list tried to reach your server at ${error.ip}, but players reach it at ${hostIp}, the address your host gives it. So the list can't confirm your server, and leaves it off or shows it as private.`,
    fix: ['Press the button: server.cfg tells FiveM\'s list your host\'s address.', 'Restart the server. FiveM\'s list can take up to 10 minutes to show it.'],
    actions: [{
      kind: 'fix',
      label: 'Give FiveM\'s list your host\'s address',
      confirm: `server.cfg gets the line set sv_listingIpOverride "${hostIp}", so FiveM's list checks your server where players reach it. A copy of server.cfg is saved first, and you can undo this. It takes effect when the server restarts.`,
      fix: { type: 'listing-ip', ip: hostIp },
    }],
    links: [{ kind: 'doc', label: 'FiveM help: a server missing from the list', url: LIST_HELP_URL }],
    raw: error.raw,
  };
}
