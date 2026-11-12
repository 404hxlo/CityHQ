// Files on a hosted server over SFTP: works with almost any host (Pterodactyl panels serve it on
// port 2022 with the panel login). One connection, opened when needed and closed after a quiet
// minute. Every path is the host's, with / separators, and stays inside the login's folder.
import { open as fsOpen, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'ssh2';
import { HttpError } from '../paths.js';

const IDLE_MS = 60000;

/** A clean absolute path on the host. Refuses anything that climbs out with "..". */
export function remotePath(p) {
  const joined = path.posix.normalize(`/${String(p || '').replaceAll('\\', '/')}`);
  if (joined.split('/').includes('..')) throw new HttpError(400, 'That path is outside the allowed folder');
  return joined;
}

/**
 * hostKey: the server's key fingerprint remembered from the first connection. A different key
 * later means something is in the way (or the host moved the server), so CityHQ refuses to log in.
 * onHostKey gets the fingerprint seen, so the first one can be remembered.
 */
export function sftpClient({ host, port = 22, username, password, hostKey = null, onHostKey, timeoutMs = 20000 }) {
  let keyMismatch = false;
  let conn = null;
  let sftp = null;
  let opening = null;
  let idle = null;

  const close = () => {
    clearTimeout(idle);
    try { conn?.end(); } catch { /* ignore */ }
    conn = null; sftp = null; opening = null;
  };
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { if (!busy) close(); }, IDLE_MS); };

  function open() {
    if (sftp) { touch(); return Promise.resolve(sftp); }
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const c = new Client();
      const fail = (err) => {
        close();
        const text = String(err?.message || err);
        if (keyMismatch) reject(new HttpError(409, 'The SFTP server\'s identity changed since CityHQ first connected. If your host moved your server, connect it again from Settings, Change server. Otherwise someone may be in the way, so CityHQ didn\'t send your password.'));
        else if (/authentication|auth/i.test(text)) reject(new HttpError(400, 'The host didn\'t accept that SFTP username or password. On most panels the password is your panel password.'));
        else if (/timed out|timeout/i.test(text)) reject(new HttpError(504, 'The SFTP server didn\'t answer in time. Check the address and port.'));
        else reject(new HttpError(502, `CityHQ couldn't connect over SFTP: ${text}`));
      };
      c.on('ready', () => {
        c.sftp((err, s) => {
          if (err) return fail(err);
          conn = c; sftp = s; opening = null; touch();
          c.on('close', () => { if (conn === c) close(); });
          resolve(s);
        });
      });
      c.on('error', fail);
      c.connect({
        host, port: Number(port) || 22, username, password, readyTimeout: timeoutMs, keepaliveInterval: 15000,
        hostHash: 'sha256',
        hostVerifier: (fingerprint) => {
          onHostKey?.(fingerprint);
          if (hostKey && fingerprint !== hostKey) { keyMismatch = true; return false; }
          return true;
        },
      });
    });
    return opening;
  }

  const wrap = (fn) => async (...args) => {
    const s = await open();
    return new Promise((resolve, reject) => fn(s, ...args, (err, value) => {
      if (err) {
        const code = err.code;
        if (code === 2) reject(new HttpError(404, 'That file or folder isn\'t on the server'));
        else if (code === 3) reject(new HttpError(403, 'The host doesn\'t allow that file to be changed'));
        else reject(new HttpError(502, `SFTP: ${err.message}`));
      } else resolve(value);
    }));
  };
  const readdir = wrap((s, p, cb) => s.readdir(p, cb));
  const stat = wrap((s, p, cb) => s.stat(p, cb));

  async function readFile(p) {
    const s = await open();
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = s.createReadStream(remotePath(p));
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', (err) => reject(err.code === 2 ? new HttpError(404, 'That file isn\'t on the server') : new HttpError(502, `SFTP: ${err.message}`)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async function writeFile(p, content) {
    const s = await open();
    return new Promise((resolve, reject) => {
      const stream = s.createWriteStream(remotePath(p));
      stream.on('error', (err) => reject(new HttpError(502, `SFTP: ${err.message}`)));
      stream.on('close', resolve);
      stream.end(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    });
  }

  /** Bytes from offset onwards (for following a log file), at most maxBytes. */
  async function readFrom(p, offset, maxBytes = 512 * 1024) {
    const s = await open();
    const handle = await new Promise((resolve, reject) => s.open(remotePath(p), 'r', (err, h) => (err ? reject(err.code === 2 ? new HttpError(404, 'That file isn\'t on the server') : err) : resolve(h))));
    try {
      const size = await new Promise((resolve, reject) => s.fstat(handle, (err, st) => (err ? reject(err) : resolve(st.size))));
      const start = Math.max(0, Math.min(offset, size));
      const length = Math.min(maxBytes, size - start);
      if (length <= 0) return { size, start, data: Buffer.alloc(0) };
      const data = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = await new Promise((resolve, reject) => s.read(handle, data, done, length - done, start + done, (err, bytes) => (err ? reject(err) : resolve(bytes))));
        if (!n) break;
        done += n;
      }
      return { size, start, data: data.subarray(0, done) };
    } finally {
      s.close(handle, () => {});
    }
  }

  // A long upload must not be cut by the idle timer.
  let busy = 0;
  const hold = () => { busy += 1; clearTimeout(idle); };
  const release = () => { busy -= 1; if (!busy) touch(); };

  const call = (s, method, ...args) => new Promise((resolve, reject) => s[method](...args, (err, value) => (err ? reject(err) : resolve(value))));

  /**
   * Sends a local file, continuing from what is already on the host when resume is on (same as
   * WinSCP's resume), with several chunks in flight at once like ssh2's own fastPut.
   * onProgress(sent, total) is called as it goes; signal stops it (it can be continued later).
   */
  async function uploadFile(local, remote, {
    resume = true, from = null, onProgress, signal, chunk = 256 * 1024, parallel = 16,
  } = {}) {
    const target = remotePath(remote);
    const total = (await fsStat(local)).size;
    const s = await open();
    hold();
    let input = null;
    let handle = null;
    try {
      // Where to continue: a point CityHQ knows everything before was written (from), else the
      // size on the host, which is safe for uploads written in order (like WinSCP's).
      let start = 0;
      if (resume) {
        let onHost = 0;
        try { onHost = (await call(s, 'stat', target)).size; } catch { onHost = 0; }
        start = Number.isInteger(from) ? Math.min(from, onHost) : onHost;
        if (start > total) start = 0;
      }
      onProgress?.(start, total, start);
      if (start === total && total > 0) return { sent: total, total, resumedFrom: start, skipped: true };
      handle = await call(s, 'open', target, start > 0 ? 'r+' : 'w');
      input = await fsOpen(local, 'r');
      let position = start;
      let sent = start;
      let failure = null;
      const inFlight = new Map();
      let failedAt = Infinity;
      // Everything before the oldest chunk still on its way (or the first that failed) has
      // arrived: a safe place to resume.
      const safe = () => Math.min(failedAt, position, ...inFlight.values());
      while (position < total && !failure) {
        if (signal?.aborted) { await Promise.all(inFlight.keys()); throw Object.assign(new HttpError(499, 'Paused'), { safe: safe() }); }
        const length = Math.min(chunk, total - position);
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await input.read(buf, 0, length, position);
        if (!bytesRead) break;
        const at = position;
        position += bytesRead;
        const job = call(s, 'write', handle, buf, 0, bytesRead, at)
          .then(() => { inFlight.delete(job); sent += bytesRead; onProgress?.(sent, total, safe()); })
          .catch((err) => { inFlight.delete(job); failedAt = Math.min(failedAt, at); failure ||= err; });
        inFlight.set(job, at);
        if (inFlight.size >= parallel) await Promise.race(inFlight.keys());
      }
      await Promise.all(inFlight.keys());
      if (failure) throw Object.assign(new HttpError(502, `The upload stopped: ${failure.message}. Start it again to continue where it left off.`), { safe: safe() });
      return { sent, total, resumedFrom: start, skipped: false };
    } finally {
      await input?.close().catch(() => {});
      if (handle) await call(s, 'close', handle).catch(() => {});
      release();
    }
  }

  /** The size of a file on the host, or null when it isn't there. */
  async function sizeOf(p) {
    try { return (await stat(remotePath(p))).size; } catch { return null; }
  }

  /** Makes a folder and any missing folders above it. */
  async function mkdirs(p) {
    const parts = remotePath(p).split('/').filter(Boolean);
    let at = '';
    for (const part of parts) {
      at += `/${part}`;
      try { await stat(at); } catch { await wrap((s, x, cb) => s.mkdir(x, cb))(at); }
    }
  }

  return {
    close,
    uploadFile,
    sizeOf,
    mkdirs,
    files: {
      async list(dir) {
        const entries = await readdir(remotePath(dir));
        return entries.map((e) => ({
          name: e.filename, dir: e.attrs.isDirectory(), size: e.attrs.size, modified: e.attrs.mtime * 1000, link: e.attrs.isSymbolicLink(),
        }));
      },
      read: async (file) => (await readFile(file)).toString('utf8'),
      readBytes: readFile,
      write: (file, content) => writeFile(file, content),
      mkdir: async (root, name) => wrap((s, p, cb) => s.mkdir(p, cb))(remotePath(`${root}/${name}`)),
      async remove(root, names) {
        for (const name of names) {
          const p = remotePath(`${root}/${name}`);
          const st = await stat(p);
          if (st.isDirectory()) throw new HttpError(400, 'Folders are removed from the host\'s own file manager');
          await wrap((s, x, cb) => s.unlink(x, cb))(p);
        }
      },
      rename: (root, from, to) => wrap((s, a, b, cb) => s.rename(a, b, cb))(remotePath(`${root}/${from}`), remotePath(`${root}/${to}`)),
      exists: async (p) => { try { await stat(remotePath(p)); return true; } catch { return false; } },
    },
    readFrom,
    /** Checks the login works by listing the top folder. */
    test: async () => { await readdir('/'); },
  };
}
