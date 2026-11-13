// Hosted servers: a pretend Pterodactyl panel (HTTP and its console websocket) and a pretend SFTP
// server, both on this PC, so the real clients are tested end to end without a host.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, renameSync, unlinkSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import ssh2 from 'ssh2';
import {
  describeHosted, findHostedServer, hostPath, serverNameOf,
} from './remote/find.js';
import { helperAddress, joinLinkOf } from './remote/helper.js';
import {
  databaseAddress, databaseSummary, panelBase, panelClient, panelConsole, serverSummary,
} from './remote/panel.js';
import { categoriesOf } from './remote/resources.js';
import { remotePath, sftpClient } from './remote/sftp.js';
import {
  databaseNameFor, describeLeftOut, execFiles, keyOf, linesLeftOut, mergeCfgForHost, preflight, withLicenseOf,
} from './move/plan.js';
import {
  findMovedFrom, leftOutProblem, leftOutSource, pcLicenseAction, rememberMovedFrom, restoreLeftOut, usePcLicense,
} from './move/leftout.js';
import {
  askList, directAddressOf, hiddenByCfgProblem, isIpv4, joinCodeOf, listedNow, LISTING_GRACE_MS, listingSettled, notListedProblem,
  wrongAddressProblem,
} from './remote/listing.js';
import {
  addToManagedBlock, BLOCK_START, ensureManagedBlock, hideFromListAgain, hidesFromList, managedLines, removeFromManagedBlock,
  showOnList,
} from './cfg.js';
import { listingError } from './reach.js';
import { pageAnswers, txAdminFinding, txAdminOf } from './remote/txadmin.js';
import {
  crashProblem, explainCrash, isCrashReason, isHostCrashLine, reportCrash, reportRecovery, resolveCrash, restartReasonOf, sinceBoot,
} from './crashes.js';
import {
  discordMessage, discordStatus, forgetDiscordWebhook, isDiscordWebhook, sendDiscord, setDiscordWebhook,
} from './discord.js';
import { redact } from './report.js';

const KEY = 'ptlc_TestKey1234567890abcdefghij';

// ---------------------------------------------------------------- a pretend panel
const sockets = new Set();
function fakePanel() {
  const files = new Map([['/server.cfg', 'endpoint_add_tcp "0.0.0.0:30120"\nensure qbx_core\n']]);
  const seen = { power: [], commands: [], origin: null };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname.includes('/html0001/')) return send(200, '<html>not a panel</html>', 'text/html');
    // The node's signed upload address: no API key, a token instead, like Wings.
    if (url.pathname === '/upload/file') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.upload = { directory: url.searchParams.get('directory'), token: url.searchParams.get('token'), body: Buffer.concat(chunks) };
        send(200, '');
      });
      return undefined;
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { errors: [{ detail: 'Unauthenticated.' }] });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = url.pathname;
      if (p === '/api/client') {
        const page = Number(url.searchParams.get('page'));
        const server = (n) => ({ attributes: { identifier: `abcd00${n}`, name: `City ${n}`, node: 'gs3', sftp_details: { ip: 'gs3.example.net', port: 2022 }, relationships: { allocations: { data: [{ attributes: { ip: '10.0.0.1', ip_alias: 'play.example.net', port: 30120, is_default: true } }] } } } });
        return send(200, { data: page === 1 ? [server(1)] : [server(2)], meta: { pagination: { total_pages: 2 } } });
      }
      if (p === '/api/client/servers/abcd001') return send(200, { attributes: { identifier: 'abcd001', name: 'City 1', limits: { disk: 148480, memory: 8192 }, feature_limits: { databases: 2, backups: 3 } } });
      if (p === '/api/client/servers/abcd001/resources') return send(200, { attributes: { current_state: 'running', resources: { cpu_absolute: 12.5, memory_bytes: 1024, uptime: 400000 } } });
      if (p === '/api/client/servers/abcd001/power') { seen.power.push(JSON.parse(body).signal); return send(204, ''); }
      if (p === '/api/client/servers/abcd001/command') { seen.commands.push(JSON.parse(body).command); return send(204, ''); }
      if (p === '/api/client/servers/abcd001/files/list') {
        const dir = url.searchParams.get('directory');
        const entries = [...files.keys()].filter((f) => path.posix.dirname(f) === dir).map((f) => ({ attributes: { name: path.posix.basename(f), is_file: true, size: files.get(f).length, modified_at: '2026-11-11T10:00:00Z' } }));
        return send(200, { data: entries });
      }
      if (p === '/api/client/servers/abcd001/files/contents') {
        const f = files.get(url.searchParams.get('file'));
        return f === undefined ? send(404, { errors: [{ detail: 'not found' }] }) : send(200, f, 'text/plain');
      }
      if (p === '/api/client/servers/abcd001/files/write') { files.set(url.searchParams.get('file'), body); return send(204, ''); }
      if (p === '/api/client/account') return send(200, { attributes: { username: 'mayor' } });
      if (p === '/api/client/servers/abcd001/backups' && req.method === 'GET') {
        return send(200, { data: [{ attributes: { uuid: 'bk-1111-2222', name: 'Nightly', bytes: 2048, is_successful: true, is_locked: false, created_at: '2026-11-12T01:00:00Z', completed_at: '2026-11-12T01:02:00Z' } }] });
      }
      if (p === '/api/client/servers/abcd001/backups' && req.method === 'POST') { seen.backup = JSON.parse(body); return send(200, { attributes: { uuid: 'bk-new' } }); }
      if (p === '/api/client/servers/abcd001/backups/bk-1111-2222/download') return send(200, { object: 'signed_url', attributes: { url: 'https://node.example.net/download/backup?token=x' } });
      if (p === '/api/client/servers/abcd001/backups/bk-1111-2222/restore') { seen.restore = JSON.parse(body); return send(204, ''); }
      if (p === '/api/client/servers/abcd001/files/upload') return send(200, { object: 'signed_url', attributes: { url: `http://127.0.0.1:${server.address().port}/upload/file?token=t1` } });
      if (p === '/api/client/servers/abcd001/files/decompress') { seen.decompress = JSON.parse(body); return send(204, ''); }
      if (p === '/api/client/servers/abcd001/databases' && req.method === 'GET') {
        return send(200, { data: [{ attributes: { id: 'db1', name: 's1_city', username: 'u1', host: { address: 'db.example.net', port: 3306 }, connections_from: '%', relationships: { password: { attributes: { password: 'pw1' } } } } }] });
      }
      if (p === '/api/client/servers/abcd001/databases' && req.method === 'POST') {
        const { database } = JSON.parse(body);
        return send(200, { attributes: { id: 'db2', name: `s1_${database}`, username: 'u2', host: { address: 'db.example.net', port: 3306 }, relationships: { password: { attributes: { password: 'pw2' } } } } });
      }
      if (p === '/api/client/servers/abcd001/websocket') return send(200, { data: { token: 'tok-1', socket: `ws://127.0.0.1:${server.address().port}/socket` } });
      return send(404, { errors: [{ detail: 'not found' }] });
    });
  });
  // The console websocket: just enough of the protocol for text frames.
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    seen.origin = req.headers.origin;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (text) => {
      const data = Buffer.from(text);
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      socket.write(Buffer.concat([head, data]));
    };
    socket.on('data', (buf) => {
      // Client frames are masked; read one small text frame, and ignore close and ping frames.
      if ((buf[0] & 0x0f) !== 1) return;
      const len = buf[1] & 0x7f;
      const offset = len === 126 ? 4 : 2;
      const size = len === 126 ? buf.readUInt16BE(2) : len;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + size).map((b, i) => b ^ mask[i % 4])).toString();
      const msg = JSON.parse(payload);
      if (msg.event === 'auth' && msg.args[0] === 'tok-1') frame(JSON.stringify({ event: 'auth success' }));
      if (msg.event === 'send logs') {
        frame(JSON.stringify({ event: 'console output', args: ['[    script:qbx_core] started'] }));
        frame(JSON.stringify({ event: 'console output', args: ['SCRIPT ERROR: @x/y.lua:1: oops'] }));
        frame(JSON.stringify({ event: 'status', args: ['running'] }));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, files, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const panel = await fakePanel();
after(() => {
  for (const s of sockets) s.destroy();
  panel.server.closeAllConnections();
  panel.server.close();
});

test('panel address: https only (plain http only to this PC), pasted page addresses are trimmed to the panel', () => {
  assert.equal(panelBase('panel.example.com/server/abcd'), 'https://panel.example.com');
  assert.equal(panelBase('https://panel.example.com/account/api'), 'https://panel.example.com');
  assert.throws(() => panelBase('http://panel.example.com'), /https/);
  assert.equal(panelBase('http://127.0.0.1:1234/x'), 'http://127.0.0.1:1234');
  assert.throws(() => panelBase(''), /address/);
});

test('panel: servers across pages, state and CPU, power and commands', async () => {
  const client = panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' });
  const servers = await client.listServers();
  assert.deepEqual(servers.map((s) => s.id), ['abcd001', 'abcd002']);
  assert.deepEqual(servers[0].address, { ip: 'play.example.net', port: 30120 }, 'the alias people connect to');
  const r = await client.resources();
  assert.equal(r.state, 'running');
  assert.equal(r.cpuPct, 12.5);
  await client.power('restart');
  await client.command('say hi');
  assert.deepEqual(panel.seen.power, ['restart']);
  assert.deepEqual(panel.seen.commands, ['say hi']);
});

test('panel: files are listed, read and written', async () => {
  const client = panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' });
  assert.deepEqual((await client.files.list('/')).map((f) => f.name), ['server.cfg']);
  assert.match(await client.files.read('/server.cfg'), /qbx_core/);
  await client.files.write('/resources/x.txt', 'hello');
  assert.equal(panel.files.get('/resources/x.txt'), 'hello');
  await assert.rejects(client.files.read('/missing.cfg'), (err) => err.status === 404);
});

test('panel: a wrong key and a page that isn\'t a panel are told apart in plain words', async () => {
  await assert.rejects(panelClient({ url: panel.url, key: 'ptlc_wrongwrongwrongwrongwrong', serverId: 'abcd001' }).resources(), /didn't accept that API key/);
  await assert.rejects(panelClient({ url: panel.url, key: KEY, serverId: 'zzzz999' }).resources(), (err) => err.status === 404);
  // An address that answers with a web page (a website, not the panel's API).
  await assert.rejects(panelClient({ url: panel.url, key: KEY, serverId: 'html0001' }).resources(), /not like a Pterodactyl-style panel/);
  await assert.rejects(panelClient({ url: panel.url, key: KEY }).resources(), /Choose a server/);
});

test('panel console: the websocket logs in with its token, sends the panel\'s Origin, and keeps lines', async () => {
  const client = panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' });
  let state = null;
  const live = panelConsole(client, panelBase(panel.url), { onState: (s) => { state = s; } });
  try {
    for (let i = 0; i < 50 && live.since(0).lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const { lines, next } = live.since(undefined);
    assert.deepEqual(lines, ['[    script:qbx_core] started', 'SCRIPT ERROR: @x/y.lua:1: oops']);
    assert.equal(next, 2);
    assert.deepEqual(live.since(2).lines, [], 'nothing new after the end');
    assert.equal(state, 'running');
    assert.equal(panel.seen.origin, panelBase(panel.url));
  } finally { live.close(); }
});

test('panel records: the default address, SFTP details and states', () => {
  const s = serverSummary({ identifier: 'a1b2c3d4', name: 'X', is_suspended: true, relationships: { allocations: { data: [{ attributes: { ip: '1.2.3.4', port: 30121 } }, { attributes: { ip: '1.2.3.4', port: 30120, is_default: true } }] } } });
  assert.deepEqual(s.address, { ip: '1.2.3.4', port: 30120 });
  assert.equal(s.suspended, true);
});

// ---------------------------------------------------------------- finding the server's files
function memoryFiles(map) {
  return {
    async list(dir) {
      const d = dir === '/' ? '' : dir;
      const names = new Map();
      for (const f of Object.keys(map)) {
        if (!f.startsWith(`${d}/`)) continue;
        const rest = f.slice(d.length + 1).split('/');
        names.set(rest[0], rest.length > 1);
      }
      return [...names].map(([name, dirFlag]) => ({ name, dir: dirFlag }));
    },
    async read(p) { if (!(p in map)) throw Object.assign(new Error('missing'), { status: 404 }); return map[p]; },
  };
}

test('finding server.cfg on a host: txAdmin\'s choice, the top folder, server-data, one folder down', async () => {
  const tx = await findHostedServer(memoryFiles({
    '/txData/default/config.json': JSON.stringify({ server: { dataPath: '/home/container/txData/QBCore_A1.base/', cfgPath: 'server.cfg' } }),
    '/txData/QBCore_A1.base/server.cfg': 'ensure qb-core',
    '/server.cfg': 'old one',
  }));
  assert.equal(tx.dataPath, '/txData/QBCore_A1.base');
  assert.equal(tx.cfgPath, '/txData/QBCore_A1.base/server.cfg');
  assert.equal(tx.txProfile, '/txData/default');

  const v7 = await findHostedServer(memoryFiles({
    '/txData/default/config.json': JSON.stringify({ fxRunner: { serverDataPath: '/home/container/server-data', cfgPath: '/home/container/server-data/server.cfg' } }),
    '/server-data/server.cfg': 'ensure qb-core',
  }));
  assert.equal(v7.cfgPath, '/server-data/server.cfg');

  assert.equal((await findHostedServer(memoryFiles({ '/server.cfg': 'x', '/alpine/x': '' }))).dataPath, '/');
  assert.equal((await findHostedServer(memoryFiles({ '/server-data/server.cfg': 'x' }))).dataPath, '/server-data');
  assert.equal((await findHostedServer(memoryFiles({ '/mycity/server.cfg': 'x' }))).cfgPath, '/mycity/server.cfg');
  assert.equal(await findHostedServer(memoryFiles({ '/readme.txt': 'x' })), null);
  assert.equal(hostPath('/home/container'), '/');
  assert.equal(hostPath('C:\\x\\..\\y'), '/C:/y');
});

test('what the Welcome screen says about a hosted server', () => {
  const qbx = describeHosted({ dataPath: '/', cfgPath: '/server.cfg', cfgText: 'endpoint_add_tcp "0.0.0.0:30125"\nsv_licenseKey "cfxk_x"\nensure qbx_core\nset mysql_connection_string "mysql://u:secret@db.host:3306/city"' }, {});
  assert.equal(qbx.framework, 'qbox');
  assert.equal(qbx.gamePort, 30125);
  assert.equal(qbx.database.hasPassword, true);
  assert.equal(JSON.stringify(qbx).includes('secret'), false, 'the database password never goes to the screen');
  assert.deepEqual(qbx.problems, []);
  const bare = describeHosted({ dataPath: '/', cfgPath: '/server.cfg', cfgText: 'ensure mapmanager', txProfile: null }, {});
  assert.ok(bare.problems.some((p) => /QBCore or Qbox/.test(p.text)));
  assert.ok(bare.problems.some((p) => /license key/.test(p.text)));
  assert.equal(describeHosted(null).found, false);
});

test('the helper\'s address is only ever a Cfx.re HTTPS address', () => {
  assert.equal(helperAddress('city-abc123.users.cfx.re'), 'https://city-abc123.users.cfx.re');
  assert.equal(helperAddress('https://city-abc123.users.cfx.re/'), 'https://city-abc123.users.cfx.re');
  assert.equal(helperAddress('http://city-abc123.users.cfx.re'), null, 'never plain http');
  assert.equal(helperAddress('https://evil.example.com'), null);
  assert.equal(helperAddress('https://x.users.cfx.re.evil.com'), null);
  assert.equal(helperAddress('https://x.users.cfx.re:8443'), null);
  assert.equal(helperAddress(''), null);
});

test('joining a hosted server: Cfx.re\'s join link from the helper\'s address', () => {
  assert.equal(joinLinkOf('https://harbor-abc123.users.cfx.re'), 'cfx.re/join/abc123');
  assert.equal(joinLinkOf('https://my-big-city-x9y8z7.users.cfx.re'), 'cfx.re/join/x9y8z7');
  assert.equal(joinLinkOf('https://abc123.users.cfx.re'), 'cfx.re/join/abc123');
  assert.equal(joinLinkOf(null), null);
});

test('a hosted server\'s own name: txAdmin\'s setting, then server.cfg', async () => {
  const files = memoryFiles({ '/txData/default/config.json': JSON.stringify({ general: { serverName: 'Harbor Town' } }) });
  assert.equal(await serverNameOf(files, { txProfile: '/txData/default', cfgText: '' }), 'Harbor Town');
  assert.equal(await serverNameOf(memoryFiles({}), { txProfile: null, cfgText: 'sets sv_projectName "^1Pine ^7Valley"' }), 'Pine Valley');
  assert.equal(await serverNameOf(memoryFiles({}), { txProfile: null, cfgText: 'sv_hostname "Coastline | Serious"' }), 'Coastline | Serious');
  assert.equal(await serverNameOf(memoryFiles({}), { txProfile: null, cfgText: 'ensure x' }), null);
});

test('resources on a host: categories from where the server says they are', () => {
  assert.deepEqual(categoriesOf('/home/container/txData/Q.base/resources/[qbx]/qbx_core', '/txData/Q.base'), { builtIn: false, categories: ['[qbx]'], folder: 'resources/[qbx]/qbx_core' });
  assert.equal(categoriesOf('/home/container/alpine/opt/cfx-server/citizen/system_resources/chat', '/').builtIn, true);
  assert.deepEqual(categoriesOf('/home/container/resources/[a]/[b]/x', '/').categories, ['[a]', '[b]']);
});

test('reports never carry a panel API key', () => {
  assert.equal(redact(`key ${KEY} and ptla_AdminKey99`), 'key ptlc_(hidden) and ptlc_(hidden)');
});

// ---------------------------------------------------------------- a pretend SFTP server
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'cityhq-sftp-'));
mkdirSync(path.join(ROOT, 'txData', 'default', 'logs'), { recursive: true });
writeFileSync(path.join(ROOT, 'server.cfg'), 'ensure qb-core\n');
writeFileSync(path.join(ROOT, 'txData', 'default', 'logs', 'fxserver.log'), 'line one\nline two\n');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { utils: { generateKeyPairSync, sftp: { STATUS_CODE, OPEN_MODE } } } = ssh2;
const hostKeys = [generateKeyPairSync('ed25519').private];

function sftpServer() {
  const server = new ssh2.Server({ hostKeys }, (client) => {
    client.on('authentication', (ctx) => ((ctx.method === 'password' && ctx.username === 'cityhq.abcd' && ctx.password === 'pw') ? ctx.accept() : ctx.reject()));
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const s = acceptSftp();
          const handles = new Map();
          let next = 0;
          const local = (p) => path.join(ROOT, ...String(p).split('/').filter(Boolean));
          const attrs = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 });
          const handle = (value) => { const h = Buffer.alloc(4); h.writeUInt32BE(next++); handles.set(h.toString('hex'), value); return h; };
          s.on('OPEN', (id, p, flags) => {
            try {
              // Only a new file or one opened to be emptied starts empty ('r+' keeps what's there).
              let exists = true;
              try { statSync(local(p)); } catch { exists = false; }
              if ((flags & OPEN_MODE.TRUNC) || ((flags & OPEN_MODE.CREAT) && !exists)) writeFileSync(local(p), '');
              statSync(local(p));
              s.handle(id, handle({ file: local(p) }));
            } catch { s.status(id, STATUS_CODE.NO_SUCH_FILE); }
          });
          s.on('READ', (id, h, offset, length) => {
            const data = readFileSync(handles.get(h.toString('hex')).file);
            if (offset >= data.length) return s.status(id, STATUS_CODE.EOF);
            return s.data(id, data.subarray(offset, offset + length));
          });
          s.on('WRITE', (id, h, offset, data) => {
            const f = handles.get(h.toString('hex')).file;
            const old = readFileSync(f);
            const out = Buffer.alloc(Math.max(old.length, offset + data.length));
            old.copy(out); data.copy(out, offset);
            writeFileSync(f, out);
            s.status(id, STATUS_CODE.OK);
          });
          s.on('FSTAT', (id, h) => s.attrs(id, attrs(statSync(handles.get(h.toString('hex')).file))));
          s.on('CLOSE', (id, h) => { handles.delete(h.toString('hex')); s.status(id, STATUS_CODE.OK); });
          s.on('OPENDIR', (id, p) => { try { s.handle(id, handle({ dir: local(p), done: false })); } catch { s.status(id, STATUS_CODE.NO_SUCH_FILE); } });
          s.on('READDIR', (id, h) => {
            const entry = handles.get(h.toString('hex'));
            if (entry.done) return s.status(id, STATUS_CODE.EOF);
            entry.done = true;
            let names;
            try { names = readdirSync(entry.dir); } catch { return s.status(id, STATUS_CODE.NO_SUCH_FILE); }
            return s.name(id, names.map((n) => ({ filename: n, longname: n, attrs: attrs(statSync(path.join(entry.dir, n))) })));
          });
          const statHandler = (id, p) => { try { s.attrs(id, attrs(statSync(local(p)))); } catch { s.status(id, STATUS_CODE.NO_SUCH_FILE); } };
          s.on('STAT', statHandler);
          s.on('LSTAT', statHandler);
          s.on('MKDIR', (id, p) => { try { mkdirSync(local(p)); s.status(id, STATUS_CODE.OK); } catch { s.status(id, STATUS_CODE.FAILURE); } });
          s.on('RENAME', (id, a, b) => { renameSync(local(a), local(b)); s.status(id, STATUS_CODE.OK); });
          s.on('REMOVE', (id, p) => { unlinkSync(local(p)); s.status(id, STATUS_CODE.OK); });
          s.on('REALPATH', (id, p) => s.name(id, [{ filename: path.posix.normalize(`/${p}`), longname: '', attrs: {} }]));
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sftpHost = await sftpServer();
after(() => sftpHost.close());
const login = { host: '127.0.0.1', port: sftpHost.address().port, username: 'cityhq.abcd', password: 'pw' };

test('sftp: list, read, write, rename and follow a log from where it was left', async () => {
  let fingerprint = null;
  const c = sftpClient({ ...login, onHostKey: (f) => { fingerprint = f; } });
  try {
    assert.deepEqual((await c.files.list('/')).map((e) => e.name).sort(), ['server.cfg', 'txData']);
    assert.equal(await c.files.read('/server.cfg'), 'ensure qb-core\n');
    await c.files.write('/new.cfg', 'hello');
    assert.equal(readFileSync(path.join(ROOT, 'new.cfg'), 'utf8'), 'hello');
    await c.files.rename('/', 'new.cfg', 'renamed.cfg');
    assert.equal(await c.files.exists('/renamed.cfg'), true);
    await c.files.remove('/', ['renamed.cfg']);
    assert.equal(await c.files.exists('/renamed.cfg'), false);
    const first = await c.readFrom('/txData/default/logs/fxserver.log', 0);
    assert.equal(first.data.toString(), 'line one\nline two\n');
    writeFileSync(path.join(ROOT, 'txData', 'default', 'logs', 'fxserver.log'), 'line one\nline two\nline three\n');
    const more = await c.readFrom('/txData/default/logs/fxserver.log', first.size);
    assert.equal(more.data.toString(), 'line three\n');
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
  } finally { c.close(); }
});

test('sftp: a wrong password, and a server whose identity changed, are refused in plain words', async () => {
  await assert.rejects(sftpClient({ ...login, password: 'nope' }).files.list('/'), /didn't accept that SFTP username or password/);
  await assert.rejects(sftpClient({ ...login, hostKey: 'a'.repeat(64) }).files.list('/'), /identity changed/);
  assert.equal(remotePath('a/../../b'), '/b');
  assert.equal(remotePath('\\txData\\x'), '/txData/x');
});

test('hosted secrets: a key only becomes a saved file locked by Windows (desktop app only)', async () => {
  const { canKeepSecrets, loadSecret, saveSecret } = await import('./remote/secret.js');
  const { setDesktopHooks } = await import('./desktop.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cityhq-secret-'));
  try {
    setDesktopHooks(null);
    assert.equal(canKeepSecrets(), false);
    assert.throws(() => saveSecret(dir, KEY), /desktop app/);
    // A stand-in for Windows' protection: what is saved must not be the key itself.
    const pad = randomBytes(16);
    setDesktopHooks({
      canProtect: () => true,
      protect: (t) => Buffer.from(Buffer.from(t).map((b, i) => b ^ pad[i % 16])).toString('base64'),
      unprotect: (s) => Buffer.from(Buffer.from(s, 'base64').map((b, i) => b ^ pad[i % 16])).toString(),
    });
    saveSecret(dir, KEY);
    assert.equal(readFileSync(path.join(dir, 'remote-secret.bin'), 'utf8').includes(KEY), false);
    assert.equal(loadSecret(dir), KEY);
  } finally {
    setDesktopHooks(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- moving to a host
test('panel: the account, plan limits, databases with their passwords, and unpacking on the host', async () => {
  const client = panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' });
  assert.equal((await client.account()).username, 'mayor');
  assert.deepEqual(await client.limits(), { diskMb: 148480, memoryMb: 8192, databases: 2, backups: 3 });
  const [db] = await client.databases.list();
  assert.deepEqual(db, { id: 'db1', name: 's1_city', username: 'u1', host: 'db.example.net', port: 3306, connectionsFrom: '%', password: 'pw1' });
  const made = await client.databases.create('midnight');
  assert.equal(made.name, 's1_midnight');
  assert.equal(made.password, 'pw2');
  await client.files.decompress('/', 'resources.zip');
  assert.deepEqual(panel.seen.decompress, { root: '/', file: 'resources.zip' });
});

test('sftp: a big upload cut off halfway continues from the last safe point, and ends identical', async () => {
  const big = path.join(ROOT, 'big-local.bin');
  const data = randomBytes(3 * 1024 * 1024 + 12345);
  writeFileSync(big, data);
  const c = sftpClient(login);
  try {
    const stopper = new AbortController();
    let safe = 0;
    await assert.rejects(c.uploadFile(big, '/big.bin', {
      chunk: 64 * 1024, parallel: 8, signal: stopper.signal,
      onProgress: (sent, total, s) => { safe = s; if (sent > total / 2) stopper.abort(); },
    }), (err) => err.status === 499 && Number.isInteger(err.safe) && (safe = err.safe, true));
    assert.ok(safe > 0 && safe < data.length, `stopped part way (${safe})`);
    const resumed = await c.uploadFile(big, '/big.bin', { from: safe, chunk: 64 * 1024 });
    assert.equal(resumed.resumedFrom, safe);
    assert.ok(readFileSync(path.join(ROOT, 'big.bin')).equals(data), 'the file on the host is byte for byte the same');
    const again = await c.uploadFile(big, '/big.bin');
    assert.equal(again.skipped, true, 'a finished upload isn\'t sent again');
    assert.equal(await c.sizeOf('/big.bin'), data.length);
    await c.mkdirs('/deep/er/folder');
    assert.equal(await c.files.exists('/deep/er/folder'), true);
  } finally { c.close(); }
});

test('the host\'s server.cfg: all of yours, your key and CityHQ\'s section too, with the host\'s ports and database', () => {
  const local = [
    'endpoint_add_tcp "0.0.0.0:30229"',
    'endpoint_add_udp "0.0.0.0:30229"',
    'sv_licenseKey "cfxk_LOCALKEY_abc"',
    'set mysql_connection_string "mysql://root@127.0.0.1:3319/city"',
    'sv_hostname "Harbor Town"',
    'ensure qb-core',
    'exec permissions.cfg',
    '# >>> CityHQ (managed by the app, edits here may be replaced)',
    'add_ace resource.qb-control command allow',
    'ensure qb-control',
    'ensure ps-dispatch',
    'add_principal identifier.fivem:1234 qbcore.god # Owner',
    '# <<< CityHQ',
  ].join('\n');
  const host = 'endpoint_add_tcp "0.0.0.0:30123"\nendpoint_add_udp "0.0.0.0:30123"\nsv_licenseKey "cfxk_HOSTKEY_xyz"\nensure qb-core\n';
  const out = mergeCfgForHost(local, host, { host: 'db.example.net', port: 3306, username: 'u@2', password: 'p:w', name: 's1_city' }, { when: new Date('2026-11-12T00:00:00Z') });
  assert.match(out, /endpoint_add_tcp "0\.0\.0\.0:30123"/);
  assert.doesNotMatch(out, /30229/);
  // The key stays yours: the server's name and list entry (Cfx.re Portal) and paid scripts go with it.
  assert.match(out, /^sv_licenseKey "cfxk_LOCALKEY_abc"$/m);
  assert.doesNotMatch(out, /HOSTKEY/);
  assert.match(out, /set mysql_connection_string "mysql:\/\/u%402:p%3Aw@db\.example\.net:3306\/s1_city\?charset=utf8mb4"/);
  assert.match(out, /sv_hostname "Harbor Town"/);
  assert.match(out, /exec permissions\.cfg/);
  // CityHQ's section comes along, once: scripts installed or switched on in CityHQ, and admins, live there.
  assert.match(out, /^ensure ps-dispatch$/m);
  assert.match(out, /^add_principal identifier\.fivem:1234 qbcore\.god # Owner$/m);
  assert.equal(out.split('\n').filter((l) => l === BLOCK_START).length, 1);
  // A byte-order mark at the start of either file doesn't end up partway down, spoiling a line.
  const marked = mergeCfgForHost('\uFEFFsv_hostname "Harbor Town"\nensure qb-core', '\uFEFFendpoint_add_tcp "0.0.0.0:30123"\n', null);
  assert.doesNotMatch(marked, /\uFEFF/);
  assert.match(marked, /^endpoint_add_tcp "0\.0\.0\.0:30123"$/m);
  assert.match(marked, /^sv_hostname "Harbor Town"$/m);
  // Without a key on the PC, the host's is used; with neither, there's none.
  const keyless = local.replace(/^sv_licenseKey .*\n/m, '');
  assert.match(mergeCfgForHost(keyless, host, null), /^sv_licenseKey "cfxk_HOSTKEY_xyz"$/m);
  assert.doesNotMatch(mergeCfgForHost(keyless, 'endpoint_add_tcp "0.0.0.0:30123"', null), /sv_licenseKey/);
  assert.deepEqual(execFiles('exec permissions.cfg\nexec "voice.cfg" # chat\nexec resources/[qb]/x.cfg\nexec ../secret.cfg\nexec @qb-core/a.cfg\n# exec old.cfg'), ['permissions.cfg', 'voice.cfg']);
  assert.equal(databaseNameFor('Midnight-Society DB'), 'midnight_society_db');
});

test('what an earlier move left out: CityHQ\'s section of the PC\'s server.cfg, minus what the host has', () => {
  const pc = [
    'sv_hostname "Harbor Town"',
    'ensure qb-core',
    '# >>> CityHQ (managed by the app, edits here may be replaced)',
    'add_ace resource.qb-control command allow',
    'ensure qb-control',
    'set mysql_connection_string "mysql://root@127.0.0.1:3319/city"',
    'endpoint_add_tcp "0.0.0.0:30229"',
    'ensure ps-dispatch',
    'ensure ps-dispatch',
    'ensure qb-radialmenu',
    'ensure qb-hud',
    'add_principal identifier.fivem:1234 qbcore.god # Owner',
    'add_principal identifier.license:abcdef12 qbcore.admin # Sam',
    'add_principal identifier.discord:5678 qbcore.mod',
    'sv_maxclients 64',
    'set chat_showJoins false',
    'add_ace group.admin command allow',
    '# a note',
    '',
    '# <<< CityHQ',
  ].join('\r\n');
  const host = [
    'endpoint_add_tcp "0.0.0.0:30123"',
    'ensure qb-core',
    'ensure qb-radialmenu',
    '# qb-control-off: ensure qb-hud',
    'sv_maxclients 48',
    'add_ace group.admin command allow',
    '# >>> CityHQ (managed by the app, edits here may be replaced)',
    'add_ace resource.qb-control command allow',
    'ensure qb-control',
    'add_principal identifier.license:ABCDEF12 qbcore.mod # Sam, set on the host',
    'set mysql_connection_string "mysql://u:p@db.example.net:3306/s1_city"',
    '# <<< CityHQ',
  ].join('\n');
  // Left alone: the helper's lines, the database and endpoint lines, a script already started or
  // switched off on the host, a player who's an admin there already, a setting the host has.
  const left = linesLeftOut(pc, host);
  assert.deepEqual(left, [
    'ensure ps-dispatch',
    'add_principal identifier.fivem:1234 qbcore.god # Owner',
    'add_principal identifier.discord:5678 qbcore.mod',
    'set chat_showJoins false',
  ]);
  assert.equal(describeLeftOut(left), '1 script (ps-dispatch), 2 admins (Owner and 1 without a name) and 1 setting (chat_showJoins)');
  assert.equal(describeLeftOut(['sv_maxclients 64', 'ensure a', 'ensure b', 'ensure c', 'ensure d', 'ensure e']), '5 scripts (a, b, c, d and 1 more) and 1 setting (player slots)');
  assert.deepEqual(linesLeftOut('ensure qb-core', host), [], 'no CityHQ section on the PC');
  // Put back into CityHQ's section, and taken out again by an undo.
  const back = addToManagedBlock(host, left);
  assert.ok(managedLines(back).includes('ensure ps-dispatch'));
  assert.deepEqual(linesLeftOut(pc, back), []);
  assert.equal(removeFromManagedBlock(back, left), ensureManagedBlock(host));
});

test('an earlier move\'s server on this PC is found, and what it left out is put back once', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'cityhq-leftout-'));
  const pcCfg = [
    'ensure qb-core',
    '# >>> CityHQ (managed by the app, edits here may be replaced)',
    'add_ace resource.qb-control command allow',
    'ensure qb-control',
    'ensure ps-dispatch',
    'add_principal identifier.fivem:1234 qbcore.god # Owner',
    '# <<< CityHQ',
  ].join('\n');
  const hostCfg = ensureManagedBlock('endpoint_add_tcp "0.0.0.0:30123"\nensure qb-core\n');
  const remote = { type: 'panel', panelUrl: 'https://panel.example.net', serverId: 'abcd001' };
  const serverFolder = (dir, target) => {
    for (const d of ['.qbcontrol', path.join('txData', 'default'), 'server-data']) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, 'qbcontrol.json'), '{}');
    writeFileSync(path.join(dir, '.qbcontrol', 'move.json'), JSON.stringify({ phase: 'done', target }));
    writeFileSync(path.join(dir, 'txData', 'default', 'config.json'), JSON.stringify({ server: { dataPath: path.join(dir, 'server-data'), cfgPath: 'server.cfg' } }));
    writeFileSync(path.join(dir, 'server-data', 'server.cfg'), pcCfg);
  };
  try {
    // One server folder moved somewhere else, and the one moved here, two levels down.
    const drive = path.join(base, 'drive');
    serverFolder(path.join(drive, 'Other-City'), { ...remote, serverId: 'zzzz999' });
    serverFolder(path.join(drive, 'Servers', 'Harbor-Town'), remote);
    const find = (r) => findMovedFrom(r, { starts: [drive] });
    const found = await find(remote);
    assert.equal(found.root, path.join(drive, 'Servers', 'Harbor-Town'));
    assert.equal(found.cfgPath, path.join(drive, 'Servers', 'Harbor-Town', 'server-data', 'server.cfg'));

    // The first check starts the search; the problem shows once it's done.
    const options = { remote, stateDir: path.join(base, 'hosted', '.qbcontrol'), find };
    assert.equal(await leftOutProblem(hostCfg, options), null);
    await leftOutSource({ ...options, wait: true });
    const problem = await leftOutProblem(hostCfg, options);
    assert.equal(problem.id, 'move-left-out');
    assert.equal(problem.severity, 'error');
    assert.equal(problem.title, 'The move left out 2 lines of your server.cfg');
    assert.equal(problem.actions[0].fix.type, 'restore-moved-lines');
    assert.equal(problem.raw, 'ensure ps-dispatch\nadd_principal identifier.fivem:1234 qbcore.god # Owner');

    // Put back the way server.cfg is always changed (a copy is kept first), then never shown again.
    let text = hostCfg;
    const changeCfg = async (mutate) => {
      const next = mutate(text);
      if (next === text) return null;
      text = next;
      return 'version-1';
    };
    const done = await restoreLeftOut(changeCfg, options);
    assert.equal(done.versionId, 'version-1');
    assert.deepEqual(done.undo, { type: 'remove-lines', lines: ['ensure ps-dispatch', 'add_principal identifier.fivem:1234 qbcore.god # Owner'] });
    assert.match(done.message, /^Added 1 script \(ps-dispatch\) and 1 admin \(Owner\) to server\.cfg/);
    assert.ok(managedLines(text).includes('ensure ps-dispatch'));
    assert.equal(await leftOutProblem(removeFromManagedBlock(text, done.undo.lines), options), null, 'an undo doesn\'t bring it back');

    // A move made by 1.8.4 or later kept CityHQ's lines, so nothing is looked for.
    rememberMovedFrom(path.join(base, 'newer'), found);
    const never = () => { throw new Error('searched'); };
    assert.equal(await leftOutSource({ remote, stateDir: path.join(base, 'newer', '.qbcontrol'), find: never, wait: true }), null);
    // Nothing found is remembered too, so it's only searched for once.
    let searches = 0;
    const nothing = { remote, stateDir: path.join(base, 'none', '.qbcontrol'), find: async () => { searches += 1; return null; } };
    assert.equal(await leftOutSource({ ...nothing, wait: true }), null);
    assert.equal(await leftOutSource({ ...nothing, wait: true }), null);
    assert.equal(searches, 1);
    // Not a hosted server: nothing to do.
    assert.equal(await leftOutSource({ remote: null, stateDir: options.stateDir, find: never }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the license key: read only to compare, and swapped in place', () => {
  const pc = 'endpoint_add_tcp "0.0.0.0:30229"\r\nsv_licenseKey "cfxk_PCKEY_abc" # from the Portal\r\nensure qb-core\r\n';
  const host = 'endpoint_add_tcp "0.0.0.0:30123"\nendpoint_add_udp "0.0.0.0:30123"\nset sv_licenseKey cfxk_HOSTKEY_xyz\nsv_hostname "x"\n';
  assert.equal(keyOf(pc), 'cfxk_PCKEY_abc');
  assert.equal(keyOf(host), 'cfxk_HOSTKEY_xyz');
  assert.equal(keyOf('ensure qb-core\n# sv_licenseKey "cfxk_OLD"'), null, 'a line switched off with # doesn\'t count');
  // In place of the host's own line, as the PC has it.
  const swapped = withLicenseOf(pc, host);
  assert.equal(swapped, 'endpoint_add_tcp "0.0.0.0:30123"\nendpoint_add_udp "0.0.0.0:30123"\nsv_licenseKey "cfxk_PCKEY_abc" # from the Portal\nsv_hostname "x"\n');
  // A host that keeps its key in its panel: the line goes after where the server listens.
  assert.equal(withLicenseOf(pc, 'endpoint_add_tcp "0.0.0.0:30123"\nensure qb-core'), 'endpoint_add_tcp "0.0.0.0:30123"\nsv_licenseKey "cfxk_PCKEY_abc" # from the Portal\nensure qb-core');
  // Undone from the copy kept before: the host's own line again, or none.
  assert.equal(withLicenseOf(host, swapped), host);
  assert.equal(withLicenseOf('ensure qb-core', swapped), 'endpoint_add_tcp "0.0.0.0:30123"\nendpoint_add_udp "0.0.0.0:30123"\nsv_hostname "x"\n');
});

test('a server moved before 1.8.5 can use the license key it had on the PC, chosen once', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'cityhq-key-'));
  try {
    const root = path.join(base, 'Harbor-Town');
    mkdirSync(path.join(root, 'server-data'), { recursive: true });
    const cfgPath = path.join(root, 'server-data', 'server.cfg');
    writeFileSync(cfgPath, 'sv_licenseKey "cfxk_PCKEY_abc"\nensure qb-core\n');
    const remote = { type: 'panel', panelUrl: 'https://panel.example.net', serverId: 'abcd001' };
    // Moved by 1.8.4: CityHQ's lines came along, the key didn't.
    const stateDir = path.join(base, 'hosted', '.qbcontrol');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'moved-from.json'), JSON.stringify({ root, cfgPath, keptCityHqLines: true }));
    const options = { remote, stateDir, find: () => { throw new Error('searched'); } };
    const hostCfg = 'endpoint_add_tcp "0.0.0.0:30123"\nsv_licenseKey "cfxk_HOSTKEY_xyz"\nensure qb-core\n';
    const action = await pcLicenseAction(hostCfg, options);
    assert.equal(action.fix.type, 'use-pc-license');
    assert.doesNotMatch(JSON.stringify(action), /cfxk_/, 'the key itself never goes to the screen');
    assert.equal(await pcLicenseAction(withLicenseOf(readFileSync(cfgPath, 'utf8'), hostCfg), options), null, 'nothing when the keys match');

    let text = hostCfg;
    const changeCfg = async (mutate) => {
      const next = mutate(text);
      if (next === text) return null;
      text = next;
      return '1700000000000';
    };
    const done = await usePcLicense(changeCfg, options);
    assert.equal(keyOf(text), 'cfxk_PCKEY_abc');
    assert.deepEqual(done.undo, { type: 'license-line', versionId: '1700000000000' });
    assert.doesNotMatch(JSON.stringify(done), /cfxk_/, 'nor into the list of fixes');
    assert.equal(await pcLicenseAction(hostCfg, options), null, 'chosen once, not offered again, even after an undo');
    // A move by 1.8.5 or later kept the key, so it's never offered.
    rememberMovedFrom(path.join(base, 'newer'), { root, cfgPath });
    assert.equal(await pcLicenseAction(hostCfg, { remote, stateDir: path.join(base, 'newer', '.qbcontrol') }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('FiveM\'s server list: asked every few minutes, and a server missing from it explained', async () => {
  assert.equal(joinCodeOf('cfx.re/join/Ab12cd'), 'ab12cd');
  assert.equal(joinCodeOf('203.0.113.7:30120'), null);
  assert.equal(directAddressOf({ address: { ip: '203.0.113.7', port: 30123 } }), '203.0.113.7:30123');
  assert.equal(directAddressOf({ address: null }), null);
  assert.equal(await askList('ab12cd', async () => ({ status: 404, ok: false })), false);
  assert.equal(await askList('ab12cd', async () => ({ status: 200, ok: true })), true);
  assert.equal(await askList('ab12cd', async () => ({ status: 503, ok: false })), null, 'a hiccup isn\'t an answer');
  assert.equal(await askList('ab12cd', async () => { throw new Error('offline'); }), null);

  const asked = [];
  const fakeFetch = async (url) => {
    asked.push(url);
    return asked.length === 1 ? { status: 404, ok: false } : { status: 200, ok: true };
  };
  const link = 'cfx.re/join/zz9yy8';
  const t = 1_800_000_000_000;
  // Not known at first: the answer arrives in the background, and isn't asked for on every look.
  assert.equal(listedNow(link, { now: t, fetchImpl: fakeFetch }), null);
  await listingSettled();
  assert.equal(listedNow(link, { now: t + 1000, fetchImpl: fakeFetch }), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/api\/servers\/single\/zz9yy8$/);

  // Things to fix: only once the server has been up long enough for the list to have it.
  const key = { kind: 'fix', label: 'Use your PC server\'s license key', confirm: 'x', fix: { type: 'use-pc-license' } };
  assert.equal(notListedProblem({ link, direct: '203.0.113.7:30123', uptimeMs: 60_000, now: t + 2000, fetchImpl: fakeFetch }), null);
  const problem = notListedProblem({ link, direct: '203.0.113.7:30123', uptimeMs: LISTING_GRACE_MS, keyAction: key, now: t + 2000, fetchImpl: fakeFetch });
  assert.equal(problem.id, 'not-listed');
  assert.match(problem.what, /connect 203\.0\.113\.7:30123/);
  assert.deepEqual(problem.actions, [key]);
  assert.match(problem.fix[0], /different license key/);
  assert.match(notListedProblem({ link, uptimeMs: LISTING_GRACE_MS, now: t + 2000, fetchImpl: fakeFetch }).fix[0], /^Sign in at the Cfx\.re Portal/);
  // Without the panel's uptime, it counts from when CityHQ first saw it missing.
  assert.equal(notListedProblem({ link, uptimeMs: null, now: t + 2000, fetchImpl: fakeFetch }), null);
  assert.equal(notListedProblem({ link, uptimeMs: null, now: t + LISTING_GRACE_MS, fetchImpl: fakeFetch })?.id, 'not-listed');
  // That look came minutes after the last check, so the list was asked again: listed now.
  await listingSettled();
  assert.equal(asked.length, 2);
  assert.equal(listedNow(link, { now: t + LISTING_GRACE_MS + 1, fetchImpl: fakeFetch }), true);
  assert.equal(notListedProblem({ link, uptimeMs: LISTING_GRACE_MS, now: t + LISTING_GRACE_MS + 2, fetchImpl: fakeFetch }), null);
});

test('kept off FiveM\'s list: server.cfg hiding the server, and the list checking the wrong address', async () => {
  // sv_master1 "" keeps a server off the list; a # in front, or a real address, doesn't.
  assert.equal(hidesFromList('ensure qb-core\nsv_master1 ""'), true);
  assert.equal(hidesFromList('set sv_master1 ""  # private'), true);
  assert.equal(hidesFromList('#sv_master1 ""\n// sv_master1 ""'), false);
  assert.equal(hidesFromList('sv_master1 "https://servers-ingress-live.fivem.net/ingress"'), false);
  assert.equal(hidesFromList(''), false);
  const cfg = 'endpoint_add_tcp "0.0.0.0:30123"\r\nsv_master1 ""\r\nensure qb-core\r\n';
  const shown = showOnList(cfg);
  assert.equal(shown, 'endpoint_add_tcp "0.0.0.0:30123"\r\n# qb-control-off: sv_master1 ""\r\nensure qb-core\r\n');
  assert.equal(hidesFromList(shown), false);
  assert.equal(hideFromListAgain(shown), cfg, 'an undo puts the line back as it was');
  assert.equal(hiddenByCfgProblem().actions[0].fix.type, 'show-on-list');

  // FiveM's complaint since the latest start, without its colour codes.
  const lines = [
    '[txAdmin] FXServer Starting - 11/13/2026, 9:50:12 PM',
    '[citizen-server-impl] ^1Server list query returned an error: Cfx failed to reach the server at 203.0.113.7:30123 - check if the sv_listingIpOverride is correct^7',
    '[txAdmin] FXServer Starting - 11/13/2026, 10:20:12 PM',
    '[citizen-server-impl] ^1Server list query returned an error: Cfx failed to reach the server at 10.10.0.5:30123 - check if the sv_listingIpOverride is correct^7',
  ];
  const error = listingError(lines);
  assert.equal(error.ip, '10.10.0.5');
  assert.equal(error.text, 'Cfx failed to reach the server at 10.10.0.5:30123 - check if the sv_listingIpOverride is correct');
  assert.equal(listingError([lines[0], '[script:qb-core] ready']), null, 'nothing since the latest start');

  // The list tried another address than the host's: one button gives it the host's.
  const wrong = wrongAddressProblem({ error, hostIp: '203.0.113.7', cfgText: 'ensure qb-core' });
  assert.equal(wrong.id, 'list-wrong-address');
  assert.deepEqual(wrong.actions[0].fix, { type: 'listing-ip', ip: '203.0.113.7' });
  assert.match(wrong.what, /at 10\.10\.0\.5, but players reach it at 203\.0\.113\.7/);
  // Not when it's the host's own address, server.cfg says so already, or the host gives a name.
  assert.equal(wrongAddressProblem({ error: { ...error, ip: '203.0.113.7' }, hostIp: '203.0.113.7', cfgText: '' }), null);
  assert.equal(wrongAddressProblem({ error, hostIp: '203.0.113.7', cfgText: 'set sv_listingIpOverride "203.0.113.7"' }), null);
  assert.equal(wrongAddressProblem({ error, hostIp: 'play.example.net', cfgText: '' }), null);
  assert.equal(wrongAddressProblem({ error: null, hostIp: '203.0.113.7', cfgText: '' }), null);
  assert.equal(isIpv4('203.0.113.7'), true);
  assert.equal(isIpv4('256.1.1.1'), false);

  // Its own address and still unreachable: the list's words, and ask the host.
  const link = 'cfx.re/join/qq7ww6';
  const t = 1_900_000_000_000;
  listedNow(link, { now: t, fetchImpl: async () => ({ status: 404, ok: false }) });
  await listingSettled();
  const atHost = { ...error, ip: '203.0.113.7' };
  const blocked = notListedProblem({ link, uptimeMs: LISTING_GRACE_MS, error: atHost, hostIp: '203.0.113.7', now: t + 1000 });
  assert.match(blocked.what, /FiveM's list said: "Cfx failed to reach the server at 10\.10\.0\.5/);
  assert.match(blocked.fix[0], /even at its own address, 203\.0\.113\.7/);
  assert.equal(blocked.raw, atHost.raw);
});

test('crashes: the cause in plain words, and a button only when switching something off fixes it', () => {
  // An inactive key, in FiveM's own words from a real log (inside txAdmin's box).
  const license = explainCrash({
    reason: 'Server boot timed out (P:45s|HB:--|HC:--)',
    lines: ['[           resources] Scanning resources.', '║              STDERR║ Fatal Error: Could not authenticate server license key. Your key is inactive.↩'],
  });
  assert.equal(license.kind, 'license');
  assert.match(license.title, /inactive/);
  assert.match(license.detail, /"Fatal Error: Could not authenticate server license key\. Your key is inactive\."/);
  assert.equal(license.fix, null);
  assert.match(license.steps[1], /Name, Tagline, Description and Language/);

  // Stuck or crashed while starting: the script loading then gets the blame, and a button.
  const boot = ['[           resources] Scanning resources.', '[    c-scripting-core] Creating script environments for qb-core', '[    c-scripting-core] Creating script environments for bad-mlo'];
  const stuck = explainCrash({ reason: 'Server boot timed out (P:45s|HB:--|HC:--)', lines: boot });
  assert.equal(stuck.kind, 'stuck');
  assert.equal(stuck.suspect, 'bad-mlo');
  assert.deepEqual(stuck.fix.fix, { type: 'boot-off', name: 'bad-mlo' });
  assert.equal(explainCrash({ reason: 'Server process close detected', lines: boot }).fix.fix.name, 'bad-mlo');

  // Once fully started, the last script loaded isn't blamed; an error just before is named.
  const running = [...boot, '[   script:qb-control] [qb-control] ready', '[  script:ps-dispatch] SCRIPT ERROR: @ps-dispatch/server/main.lua:12: attempt to index a nil value'];
  const crash = explainCrash({ reason: 'Server process close detected', lines: running });
  assert.equal(crash.kind, 'crash');
  assert.equal(crash.suspect, 'ps-dispatch');
  assert.equal(crash.fix, null);
  assert.match(crash.detail, /ps-dispatch showed an error/);
  assert.equal(explainCrash({ reason: 'Server hang detected', lines: running.slice(0, 4) }).kind, 'hang');

  // The host's own words when the whole process crashed: out of memory, or not.
  const host = ['[panel] ---------- Detected server process in a crashed state! ----------', '[panel] Exit code: 137'];
  assert.equal(explainCrash({ wentDown: true, hosted: true, lines: [...running.slice(0, 4), ...host, '[panel] Out of memory: true'] }).kind, 'memory');
  const down = explainCrash({ wentDown: true, hosted: true, lines: [...running.slice(0, 4), ...host, '[panel] Out of memory: false'] });
  assert.equal(down.kind, 'down');
  assert.match(down.detail, /whole server process crashed/);

  // txAdmin's lines: which restarts are crashes, and where each start begins.
  assert.equal(restartReasonOf('║             TXADMIN║ Restarting server: Server boot timed out (P:45s|HB:--|HC:--).'), 'Server boot timed out (P:45s|HB:--|HC:--)');
  assert.equal(isCrashReason('Server process close detected'), true);
  assert.equal(isCrashReason('Server boot timed out (P:45s|HB:--|HC:--)'), true);
  assert.equal(isCrashReason('scheduled restart at 06:00'), false);
  assert.equal(isCrashReason('Server restart requested by admin'), false);
  assert.equal(isHostCrashLine(host[0]), true);
  assert.deepEqual(sinceBoot(['old', '[           resources] Scanning resources.', 'new']), ['[           resources] Scanning resources.', 'new']);
});

test('crashes are kept, announced once per crash loop, and leave Things to fix once dealt with', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cityhq-crash-'));
  try {
    const sent = [];
    const recorded = [];
    const send = async (m) => { sent.push(m); return true; };
    const record = (e) => recorded.push(e);
    const at = (now) => ({ stateDir: dir, now, serverName: 'Harbor Town', after: 'txAdmin is starting it again.', send, record });
    const t = 1_900_000_000_000;
    const stuck = explainCrash({ reason: 'Server boot timed out', lines: ['[    c-scripting-core] Creating script environments for bad-mlo'] });
    const first = reportCrash(stuck, { ...at(t), raw: 'a log line' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].level, 'alert');
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /^Harbor Town: bad-mlo got stuck/);
    assert.match(sent[0].description, /What to do:\*\* Press "Turn bad-mlo off at boot"/);
    assert.doesNotMatch(sent[0].description, /a log line/, 'log lines never go to Discord');
    // The same again a minute later: a crash loop, counted, not announced again.
    reportCrash(stuck, at(t + 60_000));
    assert.equal(recorded.length, 1);
    assert.equal(sent.length, 1);
    const problem = crashProblem({ stateDir: dir, now: t + 61_000 });
    assert.equal(problem.id, `crash:${first.id}`);
    assert.match(problem.title, /\(2 times\)$/);
    assert.deepEqual(problem.actions[0].fix, { type: 'boot-off', name: 'bad-mlo' });
    // A different crash minutes later: Discord hears about it, and about the one it missed.
    const t2 = t + 5 * 60_000;
    reportCrash(explainCrash({ reason: 'Server hang detected', lines: ['[qb-control] ready'] }), at(t2));
    assert.equal(sent.length, 2);
    assert.match(sent[1].description, /went down 1 more time/);
    const latest = crashProblem({ stateDir: dir, now: t2 + 1000 });
    assert.match(latest.title, /froze/);
    assert.equal(latest.actions.length, 0, 'no button: steps only');
    // Running fine for half an hour since, or dealt with: gone from Things to fix.
    assert.equal(crashProblem({ stateDir: dir, now: t2 + 40 * 60_000, uptimeSec: 35 * 60 }), null);
    assert.ok(crashProblem({ stateDir: dir, now: t2 + 40 * 60_000, uptimeSec: 10 * 60 }));
    resolveCrash(latest.id.slice('crash:'.length), dir);
    assert.equal(crashProblem({ stateDir: dir, now: t2 + 2000 }), null, 'an older crash doesn\'t come back');
    // Back up again: good news, in green.
    reportRecovery({ ok: true, serverName: 'Harbor Town' }, { stateDir: dir, send, record });
    assert.equal(sent.at(-1).title, 'Harbor Town: The server is back up');
    assert.equal(recorded.at(-1).level, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Discord alerts: only a webhook link, locked like a host key, and only CityHQ\'s own words', async () => {
  const hook = `https://discord.com/api/webhooks/123456789012345678/${'a1B2-c3_'.repeat(9)}`;
  assert.equal(isDiscordWebhook(hook), true);
  assert.equal(isDiscordWebhook('https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(isDiscordWebhook(hook.replace('https:', 'http:')), false, 'only https');
  const message = discordMessage({ title: 'x'.repeat(300), description: 'Hello @everyone' }, new Date(0));
  assert.equal(message.embeds[0].title.length, 250);
  assert.deepEqual(message.allowed_mentions, { parse: [] }, 'it never pings anyone');
  const { setDesktopHooks } = await import('./desktop.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cityhq-discord-'));
  try {
    setDesktopHooks(null);
    assert.equal(await sendDiscord({ title: 't' }, { stateDir: dir }), false, 'nothing set up: nothing sent');
    assert.throws(() => setDiscordWebhook(hook, dir), /desktop app/);
    const pad = randomBytes(16);
    setDesktopHooks({
      canProtect: () => true,
      protect: (s) => Buffer.from(Buffer.from(s).map((b, i) => b ^ pad[i % 16])).toString('base64'),
      unprotect: (s) => Buffer.from(Buffer.from(s, 'base64').map((b, i) => b ^ pad[i % 16])).toString(),
    });
    assert.throws(() => setDiscordWebhook('https://example.com/x', dir), /isn't a Discord webhook link/);
    assert.equal(setDiscordWebhook(hook, dir).set, true);
    assert.equal(readFileSync(path.join(dir, 'discord-webhook.bin'), 'utf8').includes('webhooks'), false, 'locked, not plain text');
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; };
    assert.equal(await sendDiscord({ title: 'Harbor Town: The server crashed', description: 'Why, and what to do.' }, { stateDir: dir, fetchImpl }), true);
    assert.equal(posts[0].url, hook);
    assert.equal(posts[0].body.embeds[0].title, 'Harbor Town: The server crashed');
    // A deleted webhook is said plainly, for Settings; the test button gets the reason.
    const gone = async () => ({ ok: false, status: 404 });
    assert.equal(await sendDiscord({ title: 't' }, { stateDir: dir, fetchImpl: gone }), false);
    assert.match(discordStatus(dir).lastError, /no longer exists/);
    await assert.rejects(sendDiscord({ title: 't' }, { stateDir: dir, fetchImpl: gone, throwErrors: true }), /no longer exists/);
    assert.equal(forgetDiscordWebhook(dir).set, false);
  } finally {
    setDesktopHooks(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('txAdmin at a host: its port from the host\'s settings, whether that port is open, and what to do', async () => {
  const record = (variables, allocations, invocation = '') => ({
    invocation,
    relationships: {
      variables: { data: variables.map((attributes) => ({ attributes })) },
      allocations: { data: allocations.map((attributes) => ({ attributes })) },
    },
  });
  const game = { ip: '203.0.113.7', ip_alias: null, port: 30123, is_default: true };
  // The usual setup: a txAdmin port setting, but that port isn't one the host opened (like now).
  const closed = txAdminOf(record([
    { name: 'Enable txAdmin', env_variable: 'TXADMIN_ENABLE', server_value: '1' },
    { name: 'txAdmin Port', env_variable: 'TXADMIN_PORT', server_value: '40120' },
  ], [game]));
  assert.deepEqual([closed.port, closed.enabled, closed.open, closed.url], [40120, true, false, null]);
  const advice = txAdminFinding(closed);
  assert.equal(advice.status, 'warn');
  assert.match(advice.detail, /port 40120/);
  assert.match(advice.steps[0], /open Network and add a port/);
  // Opened: a button, at the host's name for that port when it has one.
  const opened = txAdminOf(record([{ env_variable: 'TXADMIN_PORT', server_value: '40121' }], [game, { ip: '203.0.113.7', ip_alias: 'play.example.net', port: 40121, is_default: false }]));
  assert.equal(opened.url, 'http://play.example.net:40121');
  assert.equal(txAdminFinding({ ...opened, answers: true }).status, 'ok');
  assert.match(txAdminFinding({ ...opened, answers: false }).title, /didn't answer/);
  // A host that only has a "txAdmin" switch: its one extra port is taken to be txAdmin's.
  const rocket = txAdminOf(record([{ name: 'txAdmin', env_variable: 'TXADMIN', server_value: 'true' }], [game, { ip: '203.0.113.7', port: 30124, is_default: false }]));
  assert.deepEqual([rocket.port, rocket.guessed, rocket.url], [30124, true, 'http://203.0.113.7:30124']);
  // From the start command, or a note on the port.
  assert.equal(txAdminOf(record([], [game], './run.sh +set txAdminPort 40150 +exec server.cfg')).port, 40150);
  assert.equal(txAdminOf(record([], [game, { ip: '203.0.113.7', port: 40200, notes: 'txAdmin', is_default: false }, { ip: '203.0.113.7', port: 40201, is_default: false }])).port, 40200);
  // Switched off: said so, and no port guessed.
  const off = txAdminOf(record([{ env_variable: 'TXADMIN_ENABLE', server_value: '0' }], [game, { ip: '203.0.113.7', port: 30124, is_default: false }]));
  assert.deepEqual([off.enabled, off.port], [false, null]);
  assert.equal(txAdminFinding(off).title, 'txAdmin is switched off');
  // Nothing to go on: nothing said.
  assert.equal(txAdminFinding(txAdminOf(record([], [game]))), null);
  assert.equal(await pageAnswers('http://203.0.113.7:40121', async () => ({ status: 302 })), true);
  assert.equal(await pageAnswers('http://203.0.113.7:40121', async () => { throw new Error('refused'); }), false);
});

test('checks before moving: space, an upload already there, the database', () => {
  const base = { localCfg: 'x', hostFound: true, resourcesBytes: 34 * 1024 ** 3, localFreeBytes: 500 * 1024 ** 3, database: { name: 's1_city', host: 'db', port: 3306, reachable: true, tables: 0 } };
  assert.equal(preflight({ ...base, hostDiskLimitBytes: 145 * 1024 ** 3, hostDiskUsedBytes: 1024 ** 3 }).ok, true);
  const tight = preflight({ ...base, hostDiskLimitBytes: 50 * 1024 ** 3, hostDiskUsedBytes: 0 });
  assert.equal(tight.ok, false, 'a zip plus its unpacked copy doesn\'t fit');
  assert.equal(preflight({ ...base, hostDiskLimitBytes: 50 * 1024 ** 3, alreadyUploaded: true }).ok, true, 'with the zip already there it fits');
  assert.ok(preflight({ ...base, alreadyUploaded: true }).items.some((i) => /already on your host/.test(i.text)));
  assert.equal(preflight({ ...base, database: { ...base.database, reachable: false } }).ok, false);
  assert.equal(preflight({ ...base, localFreeBytes: 10 * 1024 ** 3 }).ok, false, 'no room on this PC to pack');
  assert.equal(preflight({ ...base, localFreeBytes: 10 * 1024 ** 3, localZipReady: true }).ok, true, 'unless a zip is ready');
  assert.equal(preflight({ ...base, hostFound: false }).ok, false);
  assert.ok(preflight({ ...base, localMemoryBytes: 7 * 1024 ** 3, hostMemoryLimitBytes: 8 * 1024 ** 3 }).items.some((i) => /run out of memory/.test(i.text)));
  // The license key goes along; without one on the PC, the host's needs its Portal details.
  assert.ok(preflight({ ...base, localCfg: 'sv_licenseKey "cfxk_PCKEY_abc"' }).items.some((i) => i.level === 'ok' && /keeps its license key/.test(i.text)));
  assert.ok(preflight(base).items.some((i) => i.level === 'warn' && /no license key/.test(i.text)));
});

// ---------------------------------------------------------------- hosted servers, part 2
test('panel: the host\'s backups, a download link, a restore, and an upload through the node', async () => {
  const client = panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' });
  const [b] = await client.backups.list();
  assert.equal(b.id, 'bk-1111-2222');
  assert.equal(b.done, true);
  assert.equal(b.ok, true);
  assert.equal(await client.backups.downloadUrl('bk-1111-2222'), 'https://node.example.net/download/backup?token=x');
  await client.backups.create('CityHQ test');
  assert.equal(panel.seen.backup.name, 'CityHQ test');
  await client.backups.restore('bk-1111-2222');
  assert.deepEqual(panel.seen.restore, { truncate: false }, 'files are put back without wiping new ones first');
  await client.files.upload('/resources/[added]/x', 'cityhq-install.zip', Buffer.from('PKzip-bytes'));
  assert.equal(panel.seen.upload.directory, '/resources/[added]/x');
  assert.equal(panel.seen.upload.token, 't1');
  assert.ok(panel.seen.upload.body.includes(Buffer.from('PKzip-bytes')), 'the file is in the form');
  assert.ok(panel.seen.upload.body.includes(Buffer.from('name="files"')), 'under the field the panel expects');
});

test('a hosted server\'s scripts, from what the running server says (helper meta)', async () => {
  const { diskFromMeta } = await import('./remote/resources.js');
  const { disk, system } = diskFromMeta([
    { name: 'qb-core', path: '/home/container/txData/Q.base/resources/[qb]/qb-core', dependencies: ['oxmysql'], provides: [] },
    { name: 'my-shop', path: '/home/container/txData/Q.base/resources/[added]/my-shop', dependencies: ['qb-target'] },
    { name: 'chat', path: '/home/container/alpine/opt/cfx-server/citizen/system_resources/chat' },
    { name: 'elsewhere', path: '/somewhere/else/x' },
  ], '/txData/Q.base');
  assert.deepEqual(disk.map((r) => [r.name, r.dir, r.categories]), [
    ['qb-core', '/txData/Q.base/resources/[qb]/qb-core', ['[qb]']],
    ['my-shop', '/txData/Q.base/resources/[added]/my-shop', ['[added]']],
  ]);
  assert.deepEqual(system.map((s) => s.name), ['chat']);
  assert.deepEqual(disk[1].dependencies, ['qb-target']);
});

test('hosted health: the plan\'s disk and memory, in plain words', async () => {
  const { limitFinding } = await import('./remote/health.js');
  const GB = 1024 ** 3;
  const words = { full: 'full', near: 'near', ok: 'ok' };
  assert.equal(limitFinding('d', 10 * GB, 100 * GB, 'used', words).status, 'ok');
  assert.equal(limitFinding('d', 85 * GB, 100 * GB, 'used', words).status, 'warn');
  assert.equal(limitFinding('d', 99 * GB, 100 * GB, 'used', words).status, 'bad');
  assert.equal(limitFinding('d', 5 * GB, null, 'used', words), null, 'no limit, no finding');
  assert.match(limitFinding('d', 10 * GB, 100 * GB, 'used', words).detail, /10\.0 GB of 100\.0 GB used/);
});

test('a panel database\'s address: Pterodactyl\'s field, other panels\' fields, or none at all', () => {
  assert.deepEqual(databaseAddress('abc123.db.example-host.com:3319'), { host: 'abc123.db.example-host.com', port: 3319 });
  assert.deepEqual(databaseAddress(' mysql://u1:p@ss~w0rd@abc123.db.example-host.com:3319/s1_city '), { host: 'abc123.db.example-host.com', port: 3319 });
  assert.deepEqual(databaseAddress('db.example.net'), { host: 'db.example.net', port: null });
  assert.equal(databaseAddress('DB-ASH-01'), null, 'a label is not an address');
  assert.equal(databaseAddress(''), null);

  const pterodactyl = databaseSummary({ id: 'a', name: 's1_city', host: { address: 'db.example.net', port: 3306 } });
  assert.equal(pterodactyl.host, 'db.example.net');
  // A panel that names its database server but leaves the address out: the port is still known.
  const labelOnly = databaseSummary({ id: 'b', name: 's1_city', host: { name: 'DB-EX-01', port: 3319 } });
  assert.equal(labelOnly.host, null);
  assert.equal(labelOnly.port, 3319);
  const elsewhere = databaseSummary({ id: 'c', name: 's1_city', host: { port: 3319 }, endpoint: 'abc123.db.example-host.com:3319' });
  assert.deepEqual([elsewhere.host, elsewhere.port], ['abc123.db.example-host.com', 3319]);
});

test('checks before moving: a database address to type in, and a new database that can\'t be reached', () => {
  const base = { localCfg: 'x', hostFound: true, resourcesBytes: 1, alreadyUploaded: true, localZipReady: true };
  const typeIt = preflight({ ...base, database: { create: 'city', name: 'city', host: null, needsAddress: true } });
  assert.equal(typeIt.ok, false);
  assert.match(typeIt.items.find((i) => i.level === 'bad').text, /Endpoint/);
  assert.doesNotMatch(JSON.stringify(typeIt.items), /null:/, 'never shows an empty address');
  const closed = preflight({ ...base, database: { create: 'city', name: 'city', host: 'db.example.net', port: 3319, reachable: false } });
  assert.match(closed.items.find((i) => i.level === 'bad').text, /can't reach your host's database server \(db\.example\.net:3319\)/);
  const fine = preflight({ ...base, database: { create: 'city', name: 'city', host: 'db.example.net', port: 3319, reachable: true } });
  assert.equal(fine.ok, true);
  assert.match(fine.items.map((i) => i.text).join(' '), /A new database, "city", is made on your host when the move starts/);
});

test('a host\'s database: the password to type in, the database\'s own error, and encryption when it\'s required', async () => {
  const base = { localCfg: 'x', hostFound: true, resourcesBytes: 1, alreadyUploaded: true, localZipReady: true };
  const db = { name: 's1_city', host: 'db.example.net', port: 3319 };
  const noPassword = preflight({ ...base, database: { ...db, passwordMissing: true, reachable: false } });
  assert.match(noPassword.items.find((i) => i.level === 'bad').text, /didn't give CityHQ the password for "s1_city"/);
  const denied = preflight({ ...base, database: { ...db, reachable: false, signInError: 'ERROR 1045 (28000): Access denied for user \'u1\'@\'10.0.0.9\' (using password: YES)' } });
  const deniedText = denied.items.find((i) => i.level === 'bad').text;
  assert.match(deniedText, /The database said: ERROR 1045/);
  assert.match(deniedText, /type its password below/);

  const { connectionLine } = await import('./move/plan.js');
  const plain = connectionLine({ ...db, username: 'u1', password: 'p w' });
  assert.equal(plain, 'mysql://u1:p%20w@db.example.net:3319/s1_city?charset=utf8mb4');
  const encrypted = connectionLine({ ...db, username: 'u1', password: 'pw', sslRequired: true });
  assert.equal(new URL(encrypted).searchParams.get('ssl'), '{"rejectUnauthorized":false}');

  const { clientArgs } = await import('./dbtools.js');
  assert.ok(clientArgs({ host: 'h', port: 1, user: 'u' }).includes('--skip-ssl'), 'this PC\'s own database: unencrypted');
  const sslArgs = clientArgs({ host: 'h', port: 1, user: 'u', ssl: true });
  assert.ok(sslArgs.includes('--ssl') && !sslArgs.includes('--skip-ssl'));
});

// Your real error: finishing a move stopped with "The host didn't accept that SFTP username or
// password" while copying txAdmin's records, after the database and server.cfg had moved.
test('txAdmin\'s player records still reach the host when SFTP turns the password down', async () => {
  const { copyPlayersDb } = await import('./move/job.js');
  const file = path.join(ROOT, 'playersDB-local.json');
  writeFileSync(file, '{"version":5,"players":[{"license":"abc","playTime":12}]}');
  const target = { type: 'panel', txProfile: '/txData/default', sftp: { host: '127.0.0.1', port: sftpHost.address().port, username: 'cityhq.abcd' } };
  const conn = { panel: panelClient({ url: panel.url, key: KEY, serverId: 'abcd001' }) };
  // The panel password saved when the move started no longer works: the panel's upload takes over.
  assert.equal(await copyPlayersDb(target, { key: KEY, sftpPassword: 'changed-since' }, conn, file), 'panel');
  assert.equal(panel.seen.upload.directory, '/txData/default/data');
  assert.ok(panel.seen.upload.body.includes(Buffer.from('"playTime":12')));
  // With the right one it goes over SFTP, into the profile's data folder.
  assert.equal(await copyPlayersDb(target, { key: KEY, sftpPassword: 'pw' }, conn, file), 'sftp');
  assert.equal(readFileSync(path.join(ROOT, 'txData', 'default', 'data', 'playersDB.json'), 'utf8'), readFileSync(file, 'utf8'));
  // Neither way working is reported, for the move to finish with a note rather than stop.
  await assert.rejects(copyPlayersDb(target, { key: KEY, sftpPassword: 'changed-since' }, { panel: panelClient({ url: panel.url, key: KEY, serverId: 'zzzz999' }) }, file));
});

test('the helper goes onto a host with its in-game page, its token and its server.cfg line', async () => {
  const { installRemoteHelper } = await import('./remote/helper.js');
  mkdirSync(path.join(ROOT, 'resources'), { recursive: true });
  const c = sftpClient(login);
  try {
    const result = await installRemoteHelper(c, { dataPath: '/', cfgPath: '/server.cfg', token: 'test-token' });
    assert.equal(result.installed, true);
    const folder = path.join(ROOT, 'resources', '[local]', 'qb-control');
    const source = path.join(import.meta.dirname, '..', 'agent-resource', 'qb-control');
    for (const name of ['fxmanifest.lua', 'server.lua', 'client.lua', path.join('html', 'index.html')]) {
      assert.equal(readFileSync(path.join(folder, name), 'utf8'), readFileSync(path.join(source, name), 'utf8'), name);
    }
    assert.equal(readFileSync(path.join(folder, 'token.txt'), 'utf8'), 'test-token');
    assert.match(readFileSync(path.join(ROOT, 'server.cfg'), 'utf8'), /ensure qb-control/);
    // A second time (an update) finds the folders already there.
    await installRemoteHelper(c, { dataPath: '/', cfgPath: '/server.cfg', token: 'test-token' });
  } finally { c.close(); }
});
