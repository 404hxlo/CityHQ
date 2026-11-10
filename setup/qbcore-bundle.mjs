// Only needed if txAdmin's "QBCore Framework" recipe keeps failing with download errors.
// Builds a local copy of the official QBCore txAdmin recipe, retrying flaky GitHub
// downloads, then serves it to txAdmin from this PC only.
//
//   node qbcore-bundle.mjs build   download everything and create the bundle
//   node qbcore-bundle.mjs serve   serve the bundle on http://127.0.0.1:40199
//
// Then in txAdmin's setup choose "Remote URL Template" and enter
//   http://127.0.0.1:40199/qbcore.yaml
// Files are kept in <server folder>\downloads\qbcore-bundle.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const RECIPE_URL = 'https://raw.githubusercontent.com/qbcore-framework/txAdminRecipe/main/qbcore.yaml';
// This script lives in <server folder>\control-app\setup.
const SERVER_FOLDER = process.env.QBC_ROOT || path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(SERVER_FOLDER, 'downloads', 'qbcore-bundle');
const CACHE = path.join(OUT, 'cache');
const TREE = path.join(OUT, 'tree');
const BUNDLE = path.join(OUT, 'qbcore-bundle.zip');
const LOCAL_RECIPE = path.join(OUT, 'qbcore.yaml');
const PORT = 40199;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/** Parses the flat task list used by the recipe (keys are scalars, no nesting). */
function parseRecipe(text) {
  const header = {};
  const tasks = [];
  let current = null;
  let inTasks = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^tasks:\s*$/.test(line)) { inTasks = true; continue; }
    if (!inTasks) {
      const m = line.match(/^(\$?[\w]+):\s*(.*)$/);
      if (m) header[m[1]] = m[2].trim();
      continue;
    }
    const start = line.match(/^\s*-\s*action:\s*(\S+)/);
    if (start) { current = { action: start[1] }; tasks.push(current); continue; }
    const kv = line.match(/^\s+(\w+):\s*(.+)$/);
    if (kv && current) current[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { header, tasks };
}

/** Downloads with retries and confirms the result is a readable zip. */
async function download(url, dest) {
  if (existsSync(dest)) return 'cached';
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'qbcore-bundle' }, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await run('tar', ['-tf', tmp], { maxBuffer: 256 * 1024 * 1024 });
      await rename(tmp, dest);
      return attempt === 1 ? 'ok' : `ok after ${attempt} attempts`;
    } catch (err) {
      await rm(tmp, { force: true });
      if (attempt === MAX_ATTEMPTS) throw new Error(`${url}: ${err.message}`);
      const wait = Math.min(30_000, 2000 * 2 ** (attempt - 1));
      log(`  retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait / 1000}s: ${path.basename(dest)} (${err.message})`);
      await sleep(wait);
    }
  }
}

const safeName = (s) => s.replace(/[^\w.-]+/g, '_');
function urlFor(task) {
  if (task.action === 'download_file') return task.url;
  const m = task.src.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) throw new Error(`Unsupported GitHub source: ${task.src}`);
  return `https://codeload.github.com/${m[1]}/${m[2].replace(/\.git$/, '')}/zip/${task.ref || 'HEAD'}`;
}
const cacheFile = (task) => path.join(CACHE, `${safeName(urlFor(task).replace(/^https:\/\/[^/]+\//, ''))}.zip`);

/** Rejects absolute paths and anything that would climb out of the tree. */
function inTree(rel) {
  const full = path.resolve(TREE, rel);
  if (full !== TREE && !full.startsWith(TREE + path.sep)) throw new Error(`Unsafe recipe path: ${rel}`);
  return full;
}

async function build() {
  await mkdir(CACHE, { recursive: true });
  const res = await fetch(RECIPE_URL);
  if (!res.ok) throw new Error(`Recipe fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const { header, tasks } = parseRecipe(text);
  const fetchTasks = tasks.filter((t) => t.action === 'download_github' || t.action === 'download_file');
  log(`Recipe ${header.name} ${header.version}: ${tasks.length} tasks, ${fetchTasks.length} downloads`);

  let done = 0;
  const failures = [];
  const queue = [...fetchTasks];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const status = await download(urlFor(t), cacheFile(t));
        log(`(${++done}/${fetchTasks.length}) ${status}: ${urlFor(t)}`);
      } catch (err) { failures.push(err.message); log(`FAILED ${err.message}`); }
    }
  }));
  if (failures.length) throw new Error(`${failures.length} download(s) failed:\n${failures.join('\n')}`);

  log('Applying recipe steps...');
  await rm(TREE, { recursive: true, force: true });
  await mkdir(TREE, { recursive: true });
  let sqlFile = null;
  for (const t of tasks) {
    switch (t.action) {
      case 'download_github': {
        const dest = inTree(t.dest);
        const tmp = path.join(OUT, 'x', safeName(t.src));
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true });
        await run('tar', ['-xf', cacheFile(t), '--strip-components=1', '-C', tmp], { maxBuffer: 256 * 1024 * 1024 });
        const from = t.subpath ? path.join(tmp, t.subpath) : tmp;
        await mkdir(path.dirname(dest), { recursive: true });
        await cp(from, dest, { recursive: true, force: true });
        await rm(tmp, { recursive: true, force: true });
        break;
      }
      case 'download_file': {
        const dest = inTree(t.path);
        await mkdir(path.dirname(dest), { recursive: true });
        await cp(cacheFile(t), dest);
        break;
      }
      case 'unzip': {
        const dest = inTree(t.dest);
        await mkdir(dest, { recursive: true });
        await run('tar', ['-xf', inTree(t.src), '-C', dest], { maxBuffer: 256 * 1024 * 1024 });
        break;
      }
      case 'move_path': {
        const dest = inTree(t.dest);
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(inTree(t.src), dest);
        break;
      }
      case 'remove_path':
        await rm(inTree(t.path), { recursive: true, force: true });
        break;
      case 'query_database':
        // Keep the SQL for txAdmin to run; the recipe deletes ./tmp at the end.
        sqlFile = path.join(OUT, 'qbcore.sql');
        await cp(inTree(t.file), sqlFile);
        break;
      case 'connect_database':
      case 'waste_time':
        break;
      default:
        throw new Error(`Unhandled recipe action: ${t.action}`);
    }
  }
  if (!sqlFile) throw new Error('Recipe contained no database step');
  await cp(sqlFile, path.join(TREE, 'qbcore.sql'));
  await rm(path.join(OUT, 'x'), { recursive: true, force: true });

  log('Creating bundle...');
  await rm(BUNDLE, { force: true });
  await run('tar', ['-a', '-cf', BUNDLE, '-C', TREE, 'resources', 'server.cfg', 'myLogo.png', 'qbcore.sql'], { maxBuffer: 256 * 1024 * 1024 });
  const size = (await stat(BUNDLE)).size;
  const hash = createHash('sha256');
  await pipeline(createReadStream(BUNDLE), hash);

  await writeFile(LOCAL_RECIPE, [
    '$engine: 3',
    `$onesync: ${header.$onesync || 'on'}`,
    `name: ${header.name}`,
    `version: ${header.version}`,
    `author: ${header.author}`,
    `description: ${header.description} (installed from a local copy of the official recipe)`,
    '',
    'tasks:',
    '  - action: download_file',
    `    url: http://127.0.0.1:${PORT}/qbcore-bundle.zip`,
    '    path: ./tmp/qbcore-bundle.zip',
    '    timeoutSeconds: 900',
    '  - action: unzip',
    '    src: ./tmp/qbcore-bundle.zip',
    '    dest: ./tmp/bundle',
    '    timeoutSeconds: 900',
    '  - action: move_path',
    '    src: ./tmp/bundle/resources',
    '    dest: ./resources',
    '    timeoutSeconds: 300',
    '  - action: move_path',
    '    src: ./tmp/bundle/server.cfg',
    '    dest: ./server.cfg',
    '  - action: move_path',
    '    src: ./tmp/bundle/myLogo.png',
    '    dest: ./myLogo.png',
    '  - action: connect_database',
    '  - action: query_database',
    '    file: ./tmp/bundle/qbcore.sql',
    '  - action: remove_path',
    '    path: ./tmp',
    '    timeoutSeconds: 120',
    '',
  ].join('\n'));
  log(`Bundle ready: ${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${hash.digest('hex')}`);
}

async function serve() {
  const files = {
    '/qbcore.yaml': [LOCAL_RECIPE, 'text/yaml; charset=utf-8'],
    '/qbcore-bundle.zip': [BUNDLE, 'application/zip'],
  };
  const server = http.createServer(async (req, res) => {
    const entry = files[req.url];
    if (!entry) { res.writeHead(404).end('Not found'); return; }
    const { size } = await stat(entry[0]);
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': size });
    log(`${req.method} ${req.url}`);
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(createReadStream(entry[0]), res).catch((e) => log(`stream error: ${e.message}`));
  });
  server.listen(PORT, '127.0.0.1', () => log(`Serving on http://127.0.0.1:${PORT}/qbcore.yaml`));
  await readFile(LOCAL_RECIPE);
}

const mode = process.argv[2];
if (mode === 'build') await build();
else if (mode === 'serve') await serve();
else { console.error('Usage: qbcore-bundle.mjs build|serve'); process.exit(2); }
