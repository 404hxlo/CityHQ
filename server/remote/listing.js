// Whether FiveM's server list has a hosted server. Players only find a server there, and its
// cfx.re/join link only opens while it's listed. Since October 2026, FiveM lists a server only once
// its license key has the server's details (name, tagline, description, language) on the Cfx.re
// Portal, so a server can run fine and still be missing. Asked of the list's public address, the
// way FiveM itself asks, every few minutes.
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
  link, direct = null, uptimeMs = null, keyAction = null, now = Date.now(), fetchImpl,
}) {
  if (listedNow(link, { now, fetchImpl }) !== false) return null;
  const upLongEnough = uptimeMs !== null && uptimeMs !== undefined
    ? uptimeMs >= LISTING_GRACE_MS
    : last.missingSince !== null && now - last.missingSince >= LISTING_GRACE_MS;
  if (!upLongEnough) return null;
  const portal = 'sign in at the Cfx.re Portal with the account your license key comes from. Open Servers, then Server Registration Keys, open the key this server uses, and choose Edit Server Details.';
  return {
    id: 'not-listed',
    rule: 'not-listed',
    severity: 'error',
    resource: null,
    count: 1,
    title: 'Your server isn\'t on FiveM\'s server list',
    what: `Players can't find it in FiveM, and its join link (${link}) doesn't open.${direct ? ` They can still join with "connect ${direct}" in FiveM's F8 console.` : ''} Since October 2026, FiveM lists a server only once its license key has the server's details on the Cfx.re Portal.`,
    fix: [
      ...(keyAction
        ? ['Your server on your PC used a different license key, and the name and list entry you set up belong to that key. Press the button to use it here, then restart the server.', `Or, to keep this key, ${portal}`]
        : [`${portal[0].toUpperCase()}${portal.slice(1)}`]),
      'Fill in Name, Tagline, Description and Language, then save. The list can take up to an hour to show the change.',
      'Still missing after that? Open the Console page and search for "Server list query returned an error".',
    ],
    actions: keyAction ? [keyAction] : [],
    links: [
      { kind: 'doc', label: 'Cfx.re Portal: your servers', url: PORTAL_URL },
      { kind: 'doc', label: 'FiveM help: a server missing from the list', url: LIST_HELP_URL },
    ],
    raw: `FiveM's server list has nothing under ${link}.`,
  };
}
