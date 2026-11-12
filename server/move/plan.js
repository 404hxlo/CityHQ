// Moving a server from this PC to a host: the checks before anything changes, and the server.cfg
// the host gets. Everything here is plain text and numbers, so it can be tested on its own.
import path from 'node:path';
import { removeManagedBlock, setConvar } from '../cfg.js';

const GB = 1024 ** 3;
const ENDPOINT = /^\s*endpoint_add_(tcp|udp)\s/i;
const LICENSE = /^\s*(?:set[sra]?\s+)?sv_licenseKey\s/i;

const quoted = (v) => `"${String(v).replace(/"/g, '')}"`;

/** The database line oxmysql reads, for the host's database. */
export function connectionLine({ host, port, username, password, name }) {
  const user = encodeURIComponent(username);
  const pass = password ? `:${encodeURIComponent(password)}` : '';
  return `mysql://${user}${pass}@${host}:${port || 3306}/${name}?charset=utf8mb4`;
}

/**
 * The server.cfg for the host: yours (scripts, settings, admins), with the host's own lines for
 * where the server listens and its license key, and the host's database. CityHQ's own block is
 * left out; it is added back for the host when the helper is put there.
 */
export function mergeCfgForHost(localCfg, hostCfg, db, { when = new Date() } = {}) {
  const eol = localCfg.includes('\r\n') ? '\r\n' : '\n';
  const hostLines = String(hostCfg || '').split(/\r?\n/);
  const hostEndpoints = hostLines.filter((l) => ENDPOINT.test(l));
  const hostLicense = hostLines.filter((l) => LICENSE.test(l));
  let lines = removeManagedBlock(localCfg).split(/\r?\n/);
  // Where the server listens and its key belong to the host: theirs replace yours.
  lines = lines.filter((l) => !ENDPOINT.test(l) && !LICENSE.test(l));
  const head = [
    `# Moved here from your PC by CityHQ on ${when.toISOString().slice(0, 10)}. The host's own lines come first.`,
    ...hostEndpoints,
    ...hostLicense,
    '',
  ];
  let text = [...head, ...lines].join(eol);
  if (db) text = setConvar(text, 'mysql_connection_string', quoted(connectionLine(db)));
  return text.replace(/(\r?\n){3,}/g, `${eol}${eol}`);
}

/**
 * Files server.cfg runs with "exec" that live next to it rather than inside resources (which are
 * moved anyway), so they go up too. Paths only inside the server's folder.
 */
export function execFiles(cfgText) {
  const out = new Set();
  for (const raw of String(cfgText || '').split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').match(/^\s*exec\s+["']?([^"'\s]+)["']?/i);
    if (!m) continue;
    const rel = path.posix.normalize(m[1].replaceAll('\\', '/'));
    if (rel.startsWith('..') || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.startsWith('@') || /^resources\//i.test(rel)) continue;
    out.add(rel);
  }
  return [...out];
}

/** A name for the host's new database: yours, made safe for a panel. */
export const databaseNameFor = (local) => (String(local || 'city').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 40) || 'city');

/**
 * What CityHQ checks before moving, in plain words. facts: the sizes and settings it found.
 * Returns { ok, items: [{ level: 'ok'|'warn'|'bad', text }] }; ok is false when something must be
 * fixed first.
 */
export function preflight(f) {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

  if (!f.localCfg) add('bad', 'CityHQ couldn\'t read your server.cfg on this PC.');
  if (!f.hostFound) add('bad', 'CityHQ couldn\'t find where the server lives on your host (no server.cfg). Install a framework there first, or start it once so txAdmin sets it up.');

  // Space on the host for the zip and its unpacked copy, unless the zip is already there.
  const needOnHost = f.alreadyUploaded ? f.resourcesBytes : f.resourcesBytes * 2;
  if (f.hostDiskLimitBytes) {
    const free = f.hostDiskLimitBytes - (f.hostDiskUsedBytes || 0);
    if (free < needOnHost) add('bad', `Your host has ${gb(free)} free, but the move needs about ${gb(needOnHost)} (your ${gb(f.resourcesBytes)} of resources${f.alreadyUploaded ? '' : ', zipped and unpacked'}). Free some space or ask your host for a bigger plan.`);
    else add('ok', `Room on your host: ${gb(free)} free, about ${gb(needOnHost)} needed.`);
  } else {
    add('ok', `Your resources are ${gb(f.resourcesBytes)}. Your host doesn't set a disk limit.`);
  }
  // Space on this PC for the zip, unless one is ready.
  if (!f.localZipReady && f.localFreeBytes !== null && f.localFreeBytes !== undefined) {
    if (f.localFreeBytes < f.resourcesBytes * 1.05) add('bad', `This PC needs about ${gb(f.resourcesBytes)} free on the server's drive to pack your resources, and has ${gb(f.localFreeBytes)}.`);
  }
  if (f.alreadyUploaded) add('ok', 'Your resources.zip is already on your host at full size, so it won\'t be uploaded again.');
  else if (f.partlyUploaded) add('ok', `Part of resources.zip is already on your host (${gb(f.partlyUploaded)}); the upload continues from there.`);
  else if (f.localZipReady) add('ok', 'A resources.zip of your server is ready on this PC; CityHQ uses it instead of packing again.');

  if (!f.database) add('bad', 'Choose the database on your host for your data.');
  else if (f.database.needsAddress) add('bad', 'Your host\'s panel doesn\'t tell CityHQ where its databases are. Type the address below: in your panel\'s Databases tab, open a database (the eye button) and copy its Endpoint, such as abc.db.yourhost.com:3306.');
  else if (f.database.reachable === false && f.database.create) add('bad', `This PC can't reach your host's database server (${f.database.host}:${f.database.port}). Check the address, or ask your host whether databases can be reached from outside.`);
  else if (f.database.reachable === false) add('bad', `This PC can't sign in to the host's database "${f.database.name}" (${f.database.host}:${f.database.port}). In your host's panel, allow connections to it from anywhere (often "Connections from: %"), or ask your host.`);
  else if (f.database.create) add('ok', `A new database, "${f.database.name}", is made on your host when the move starts, open to this PC so your data can be copied in.`);
  else if (f.database.tables > 0) add('warn', `The host's database "${f.database.name}" already has ${f.database.tables} tables. They'll be replaced by yours.`);
  else add('ok', `Your data goes into the host's database "${f.database.name}".`);

  if (f.hostHasResources) add('ok', 'The host\'s current resources folder is kept as resources-before-move, and its server.cfg as server.cfg.before-move.');
  if (f.hostMemoryLimitBytes && f.localMemoryBytes && f.localMemoryBytes > f.hostMemoryLimitBytes * 0.8) {
    add('warn', `Your server uses about ${gb(f.localMemoryBytes)} of memory here, and your host's plan allows ${gb(f.hostMemoryLimitBytes)}. It may run out of memory there.`);
  }
  add('warn', 'Your host\'s license key must come from the same Cfx.re account as this one, or paid (escrow) scripts won\'t load there.');
  return { ok: !items.some((i) => i.level === 'bad'), items };
}
