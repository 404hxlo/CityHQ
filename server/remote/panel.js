// A small client for Pterodactyl-style game panels (Pterodactyl, Pelican and the many hosts built
// on them, RocketNode among them): the "client API" a panel's own web page uses, with a key the
// owner makes under Account, API Credentials. https://<panel>/api/client/...
import { HttpError } from '../paths.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/** The panel's address as https://host[/path], or an error saying what's wrong with it. */
export function panelBase(input) {
  let text = String(input || '').trim();
  if (!text) throw new HttpError(400, 'Enter your panel\'s address, like https://panel.yourhost.com');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'That doesn\'t look like a web address. Copy it from your browser while the panel is open.'); }
  // The key must never travel unencrypted. Plain http is only allowed to this PC (tests).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOST.test(url.hostname))) {
    throw new HttpError(400, 'The panel address must start with https://');
  }
  // People paste the address of whatever page they were on; the API lives at the panel's root.
  return `${url.origin}`;
}

/** A Pterodactyl client-API key (ptlc_...) or an older one: letters, digits, _ and -. */
export const looksLikeKey = (key) => /^[A-Za-z0-9_.-]{20,200}$/.test(String(key || '').trim());

export function panelClient({ url, key, serverId, timeoutMs = 15000 }) {
  const base = `${panelBase(url)}/api/client`;
  const auth = { Authorization: `Bearer ${String(key || '').trim()}`, Accept: 'application/json' };
  const server = (route = '') => {
    if (!/^[A-Za-z0-9-]{4,40}$/.test(String(serverId || ''))) throw new HttpError(400, 'Choose a server first');
    return `/servers/${serverId}${route}`;
  };

  async function call(method, route, { json, text, query, raw = false, timeout = timeoutMs } = {}) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    let res;
    try {
      res = await fetch(`${base}${route}${qs}`, {
        method,
        headers: { ...auth, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(text !== undefined ? { 'Content-Type': 'text/plain' } : {}) },
        body: json ? JSON.stringify(json) : text,
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new HttpError(504, 'The panel didn\'t answer in time. Try again in a moment.');
      throw new HttpError(502, 'CityHQ couldn\'t reach the panel. Check its address and your internet connection.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(400, 'The panel didn\'t accept that API key. Make a new one under Account, API Credentials, and paste it here.');
    }
    if (res.status === 404) throw new HttpError(404, 'The panel couldn\'t find that. The server may have been removed, or the address is wrong.');
    if (res.status === 409) throw new HttpError(409, await reason(res) || 'The panel says the server is busy right now (installing, suspended or being moved).');
    if (res.status === 429) throw new HttpError(429, 'The panel asked CityHQ to slow down. Try again in a minute.');
    if (!res.ok) throw new HttpError(502, await reason(res) || `The panel answered with an error (${res.status}).`);
    if (raw === 'bytes') return Buffer.from(await res.arrayBuffer());
    if (raw) return res.text();
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw new HttpError(502, 'That address answered, but not like a Pterodactyl-style panel. Check it\'s your host\'s game panel.');
    return res.json();
  }

  const reason = async (res) => {
    try { return (await res.json())?.errors?.[0]?.detail || null; } catch { return null; }
  };

  return {
    /** Every server this key can manage. */
    async listServers() {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const r = await call('GET', '', { query: { page: String(page), per_page: '50' } });
        if (!Array.isArray(r?.data)) throw new HttpError(502, 'That address answered, but not like a Pterodactyl-style panel.');
        for (const s of r.data) out.push(serverSummary(s.attributes || {}));
        if (!r.meta?.pagination || page >= r.meta.pagination.total_pages) break;
      }
      return out;
    },
    async details() { return serverSummary((await call('GET', server()))?.attributes || {}); },
    /** The panel's whole record of the server: its ports (allocations), startup settings and command. */
    async record() { return (await call('GET', server()))?.attributes || {}; },
    /** 'running', 'starting', 'stopping' or 'offline', with CPU, memory and disk use. */
    async resources() {
      const a = (await call('GET', server('/resources'), { timeout: 8000 }))?.attributes || {};
      const r = a.resources || {};
      return {
        state: a.current_state || 'offline', suspended: Boolean(a.is_suspended),
        cpuPct: typeof r.cpu_absolute === 'number' ? r.cpu_absolute : null,
        memBytes: r.memory_bytes ?? null, diskBytes: r.disk_bytes ?? null, uptimeMs: r.uptime ?? null,
      };
    },
    power: (signal) => call('POST', server('/power'), { json: { signal } }),
    command: (command) => call('POST', server('/command'), { json: { command } }),
    websocket: async () => (await call('GET', server('/websocket')))?.data || {},
    files: {
      async list(dir) {
        const r = await call('GET', server('/files/list'), { query: { directory: dir || '/' } });
        return (r?.data || []).map(({ attributes: f }) => ({
          name: f.name, dir: !f.is_file, size: f.size, modified: Date.parse(f.modified_at) || null, link: Boolean(f.is_symlink),
        }));
      },
      read: (file) => call('GET', server('/files/contents'), { query: { file }, raw: true, timeout: 30000 }),
      readBytes: (file) => call('GET', server('/files/contents'), { query: { file }, raw: 'bytes', timeout: 30000 }),
      write: (file, content) => call('POST', server('/files/write'), { query: { file }, text: content, timeout: 30000 }),
      mkdir: (root, name) => call('POST', server('/files/create-folder'), { json: { root, name } }),
      remove: (root, files) => call('POST', server('/files/delete'), { json: { root, files } }),
      rename: (root, from, to) => call('PUT', server('/files/rename'), { json: { root, files: [{ from, to }] } }),
      /**
       * Uploads one file into a folder through the panel (the same way its file manager does).
       * Hosts limit the size of these uploads, often to 100 MB.
       */
      async upload(dir, name, bytes) {
        const url = (await call('GET', server('/files/upload')))?.attributes?.url;
        if (!url) throw new HttpError(502, 'The panel didn\'t give an upload address.');
        const form = new FormData();
        form.append('files', new Blob([bytes]), name);
        let res;
        try {
          res = await fetch(`${url}&directory=${encodeURIComponent(dir)}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60000) });
        } catch { throw new HttpError(502, 'The upload to your host didn\'t go through. Try again.'); }
        if (res.status === 413) throw new HttpError(413, 'That\'s bigger than your host lets the panel take in one go. Upload it with WinSCP instead.');
        if (!res.ok) throw new HttpError(502, `Your host refused the upload (${res.status}).`);
      },
      /** Unpacks an archive on the host itself, so big uploads don't come back down. */
      decompress: (root, file) => call('POST', server('/files/decompress'), { json: { root, file }, timeout: 15 * 60000 }),
      compress: (root, files) => call('POST', server('/files/compress'), { json: { root, files }, timeout: 15 * 60000 }),
    },
    /** The account the key belongs to: its SFTP username is <username>.<server id>. */
    async account() { return (await call('GET', '/account'))?.attributes || {}; },
    /** Disk and memory the plan allows (MB, 0 = no limit) and how many databases and backups. */
    async limits() {
      const a = (await call('GET', server()))?.attributes || {};
      return {
        diskMb: a.limits?.disk ?? null,
        memoryMb: a.limits?.memory ?? null,
        databases: a.feature_limits?.databases ?? null,
        backups: a.feature_limits?.backups ?? null,
      };
    },
    databases: {
      /** The server's databases with their passwords (the panel only shows them to the owner). */
      async list() {
        const r = await call('GET', server('/databases'), { query: { include: 'password' } });
        return (r?.data || []).map(({ attributes: d }) => databaseSummary(d));
      },
      async create(name, remote = '%') {
        return databaseSummary((await call('POST', server('/databases'), { json: { database: name, remote } }))?.attributes || {});
      },
    },
    backups: {
      async list() {
        const r = await call('GET', server('/backups'), { query: { per_page: '50' } });
        return (r?.data || []).map(({ attributes: b }) => ({
          id: b.uuid, name: b.name, bytes: b.bytes ?? 0, done: Boolean(b.completed_at), ok: b.is_successful !== false,
          locked: Boolean(b.is_locked), createdAt: Date.parse(b.created_at) || null, completedAt: Date.parse(b.completed_at) || null,
        }));
      },
      create: (name) => call('POST', server('/backups'), { json: { name, ignored: '', is_locked: false } }),
      async downloadUrl(id) { return (await call('GET', server(`/backups/${encodeURIComponent(id)}/download`)))?.attributes?.url || null; },
      restore: (id) => call('POST', server(`/backups/${encodeURIComponent(id)}/restore`), { json: { truncate: false } }),
      remove: (id) => call('DELETE', server(`/backups/${encodeURIComponent(id)}`)),
    },
  };
}

/** A panel database: where it is, its name, login and who may connect (% means anywhere). */
/** "name:port" or "mysql://user:pass@name:port/db" as { host, port }; null when it isn't one. */
export function databaseAddress(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  // The address follows the last @ (a password may contain @ too).
  const m = value.match(/^(?:[a-z]+:\/\/(?:.*@)?)?([a-z0-9.-]+)(?::(\d{1,5}))?(?:\/[^@]*)?$/i);
  if (!m || !m[1].includes('.')) return null;
  return { host: m[1], port: Number(m[2]) || null };
}

export function databaseSummary(d = {}) {
  const password = d.relationships?.password?.attributes?.password ?? d.relationships?.database_password?.attributes?.password ?? null;
  // Pterodactyl gives host.address; some panels built on it (Apollo, for one) leave that out
  // and give the address in another field, or only on their own page.
  const host = typeof d.host === 'object' && d.host ? d.host : {};
  const found = [host.address, host.hostname, host.host, host.endpoint, d.endpoint, d.address, d.hostname,
    d.connection_string, d.connectionString, typeof d.host === 'string' ? d.host : null]
    .map(databaseAddress).find(Boolean);
  return {
    id: d.id || null,
    name: d.name || null,
    username: d.username || null,
    host: found?.host || null,
    port: Number(host.port) || found?.port || 3306,
    connectionsFrom: d.connections_from || null,
    password,
  };
}

/** What the screens need from a panel's server record. */
export function serverSummary(a) {
  const allocations = (a.relationships?.allocations?.data || []).map((x) => x.attributes || {});
  const main = allocations.find((x) => x.is_default) || allocations[0] || null;
  return {
    id: a.identifier || null,
    name: a.name || 'Server',
    description: a.description || '',
    node: a.node || null,
    address: main ? { ip: main.ip_alias || main.ip, port: main.port } : null,
    sftp: a.sftp_details ? { host: a.sftp_details.ip, port: a.sftp_details.port } : null,
    suspended: Boolean(a.is_suspended),
    installing: Boolean(a.is_installing),
  };
}

/**
 * The panel's live console: one websocket kept open, the newest lines kept in memory, and the
 * short-lived token renewed before it runs out. Wings checks the Origin header, so it is sent as
 * the panel's own address.
 */
export function panelConsole(client, origin, { keep = 2000, onState } = {}) {
  let ws = null;
  let lines = [];
  let total = 0;
  let stopped = false;
  let retry = null;
  let state = null;

  const add = (text) => {
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      lines.push(line);
      total += 1;
    }
    if (lines.length > keep) lines = lines.slice(-keep);
  };
  const send = (event, args = [null]) => { try { ws?.send(JSON.stringify({ event, args })); } catch { /* reconnects */ } };

  async function connect() {
    if (stopped) return;
    let info;
    try { info = await client.websocket(); } catch { return later(); }
    if (!info.socket || !info.token) return later();
    try {
      ws = new WebSocket(info.socket, { headers: { Origin: origin } });
    } catch { return later(); }
    ws.onopen = () => send('auth', [info.token]);
    ws.onmessage = async (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.event === 'auth success') { lines = []; send('send logs'); }
      else if (msg.event === 'console output' || msg.event === 'install output') add(msg.args?.[0] ?? '');
      else if (msg.event === 'daemon message') add(`[panel] ${msg.args?.[0] ?? ''}`);
      else if (msg.event === 'status') { state = msg.args?.[0] || state; onState?.(state); }
      else if (msg.event === 'token expiring') {
        try { send('auth', [(await client.websocket()).token]); } catch { /* the close reconnects */ }
      } else if (msg.event === 'token expired' || msg.event === 'jwt error') { try { ws.close(); } catch { /* ignore */ } }
    };
    ws.onclose = () => { ws = null; later(); };
    ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
  }
  function later() {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, 5000);
  }

  connect();
  return {
    /** Lines after a position, the same way the local console is read: { lines, next }. */
    since(position) {
      const first = total - lines.length;
      const from = Number.isInteger(position) && position >= first ? position : first;
      return { lines: lines.slice(from - first), next: total, connected: Boolean(ws && ws.readyState === 1) };
    },
    state: () => state,
    close() { stopped = true; clearTimeout(retry); try { ws?.close(); } catch { /* ignore */ } },
  };
}
