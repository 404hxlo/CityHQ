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
import { describeHosted, findHostedServer, hostPath } from './remote/find.js';
import { helperAddress } from './remote/helper.js';
import { panelBase, panelClient, panelConsole, serverSummary } from './remote/panel.js';
import { categoriesOf } from './remote/resources.js';
import { remotePath, sftpClient } from './remote/sftp.js';
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
      if (p === '/api/client/servers/abcd001') return send(200, { attributes: { identifier: 'abcd001', name: 'City 1' } });
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
              if (flags & OPEN_MODE.WRITE) writeFileSync(local(p), '');
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
          s.on('MKDIR', (id, p) => { mkdirSync(local(p)); s.status(id, STATUS_CODE.OK); });
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
