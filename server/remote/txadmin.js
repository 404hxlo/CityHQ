// txAdmin's web page on a hosted server. The host runs txAdmin inside the server, on a port of its
// own: CityHQ reads which one from the host's settings for the server, checks the host opened
// that port to the internet (one of the server's "allocations"), and that the page answers.
import { REMOTE } from '../paths.js';
import { connection } from './connection.js';

const portOf = (value) => {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};
const ON = /^(1|true|yes|on|enabled?)$/i;
const OFF = /^(0|false|no|off|disabled?)$/i;
const TX = /tx.?admin|txa\b|txhost_txa/i;

/**
 * From a panel's record of the server: txAdmin's port, whether it's switched on (null when the
 * host's settings don't say), the server's open ports, and txAdmin's address when its port is one
 * of them. A host that doesn't name txAdmin's port but gives the server exactly one extra port is
 * taken to use that one for it (guessed).
 */
export function txAdminOf(attrs = {}) {
  const allocations = (attrs.relationships?.allocations?.data || []).map((x) => x.attributes || {});
  const variables = (attrs.relationships?.variables?.data || []).map((x) => x.attributes || {});
  const valueOf = (v) => String(v.server_value ?? v.default_value ?? '').trim();
  const about = (v) => `${v.env_variable || ''} ${v.name || ''}`;
  const tx = variables.filter((v) => TX.test(about(v)));
  let enabled = null;
  for (const v of tx.filter((x) => !/port/i.test(about(x)))) {
    if (ON.test(valueOf(v))) enabled = true;
    else if (OFF.test(valueOf(v))) enabled = false;
  }
  const command = String(attrs.invocation || '');
  let port = tx.filter((v) => /port/i.test(about(v))).map((v) => portOf(valueOf(v))).find(Boolean)
    || tx.map((v) => portOf(valueOf(v))).find((p) => p && p >= 1024)
    || portOf(command.match(/txAdminPort\s+"?(\d{2,5})/i)?.[1])
    || portOf(command.match(/TXHOST_TXA_PORT\s*=\s*"?(\d{2,5})/i)?.[1])
    || portOf(allocations.find((a) => TX.test(a.notes || ''))?.port)
    || null;
  let guessed = false;
  const extra = allocations.filter((a) => !a.is_default);
  if (!port && enabled !== false && extra.length === 1) {
    port = extra[0].port;
    guessed = true;
  }
  const open = allocations.find((a) => port && a.port === port) || null;
  const main = allocations.find((a) => a.is_default) || allocations[0] || null;
  const at = open || main;
  const host = at ? at.ip_alias || at.ip : null;
  return {
    port, enabled, guessed, open: Boolean(open), ports: allocations.map((a) => a.port), host, url: open && host ? `http://${host}:${port}` : null,
  };
}

/** Whether a web page answers at all (any reply counts), within a few seconds. */
export async function pageAnswers(url, fetchImpl = fetch) {
  try {
    await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * What Health says about it: { status, title, detail, steps }, or null when there's nothing to
 * say (the host's settings don't show txAdmin's port at all).
 */
export function txAdminFinding(t) {
  if (!t) return null;
  if (t.enabled === false) {
    return {
      status: 'warn',
      title: 'txAdmin is switched off',
      detail: 'Your host\'s settings for the server have txAdmin turned off, so it has no txAdmin page.',
      steps: ['In your host\'s panel, open Startup and turn txAdmin on.', 'Restart the server.'],
    };
  }
  if (!t.port) return null;
  if (!t.open) {
    return {
      status: 'warn',
      title: 'txAdmin\'s page can\'t be reached',
      detail: `txAdmin uses port ${t.port}, but your host hasn't opened that port for your server, so its page can't be reached from the internet.`,
      steps: [
        'In your host\'s panel, open Network and add a port (create an allocation). Note its number.',
        'Open Startup and set txAdmin\'s port to that number. On some hosts, you turn txAdmin on there and it uses the new port by itself.',
        'Restart the server, then open txAdmin from Settings in CityHQ.',
      ],
    };
  }
  if (t.answers === false) {
    return {
      status: 'warn',
      title: 'txAdmin\'s page didn\'t answer',
      detail: `It should be at ${t.url}. txAdmin starts with the server.`,
      steps: ['If the server is running, restart it.', 'If it still doesn\'t answer, check txAdmin is turned on in your host\'s panel (Startup).'],
    };
  }
  return { status: 'ok', title: 'txAdmin\'s page is reachable', detail: `Open it from Settings, or go to ${t.url}.`, steps: [] };
}

let cached = { at: 0, value: null };

/** txAdmin on this hosted server, asked of its panel at most once a minute (fresh: now). */
export async function hostedTxAdmin({ fresh = false } = {}) {
  if (!REMOTE) return null;
  if (REMOTE.type !== 'panel') return { sftp: true, port: null, open: false, url: null };
  if (!fresh && cached.value && Date.now() - cached.at < 60000) return cached.value;
  const t = txAdminOf(await connection().panel.record());
  const value = { ...t, answers: t.url ? await pageAnswers(t.url) : null };
  cached = { at: Date.now(), value };
  return value;
}
