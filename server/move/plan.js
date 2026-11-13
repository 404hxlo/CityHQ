// Moving a server from this PC to a host: the checks before anything changes, and the server.cfg
// the host gets. Everything here is plain text and numbers, so it can be tested on its own.
import path from 'node:path';
import {
  isHelperLine, managedLines, parseBoot, readCommand, readConvar, setConvar, splitComment,
} from '../cfg.js';

const GB = 1024 ** 3;
const ENDPOINT = /^\s*endpoint_add_(tcp|udp)\s/i;
const LICENSE = /^\s*(?:set[sra]?\s+)?sv_licenseKey\s/i;
// A byte-order mark is only allowed at the very start of a file. Lower down, it spoils the line.
const withoutBom = (text) => String(text || '').replace(/^\uFEFF/, '');

const quoted = (v) => `"${String(v).replace(/"/g, '')}"`;

/** The database line oxmysql reads, for the host's database. */
export function connectionLine({
  host, port, username, password, name, sslRequired,
}) {
  const user = encodeURIComponent(username);
  const pass = password ? `:${encodeURIComponent(password)}` : '';
  // A database server that only takes encrypted connections: oxmysql reads ssl as JSON.
  const ssl = sslRequired ? `&ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}` : '';
  return `mysql://${user}${pass}@${host}:${port || 3306}/${name}?charset=utf8mb4${ssl}`;
}

/**
 * The server.cfg for the host: all of yours, with the host's own lines for where the server
 * listens and its license key, and the host's database. That includes CityHQ's own section, which
 * holds scripts installed or switched on in CityHQ, admins, and settings changed there.
 */
export function mergeCfgForHost(localCfg, hostCfg, db, { when = new Date() } = {}) {
  const local = withoutBom(localCfg);
  const eol = local.includes('\r\n') ? '\r\n' : '\n';
  const hostLines = withoutBom(hostCfg).split(/\r?\n/);
  const hostEndpoints = hostLines.filter((l) => ENDPOINT.test(l));
  const hostLicense = hostLines.filter((l) => LICENSE.test(l));
  // Where the server listens and its key belong to the host: theirs replace yours.
  const lines = local.split(/\r?\n/).filter((l) => !ENDPOINT.test(l) && !LICENSE.test(l));
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

const BOOT_LINE = /^(?:ensure|start|restart)\s+["']?([^"'\s]+)["']?$/i;
const ADMIN_LINE = /^add_principal\s+(identifier\.\S+)\s+\S/i;
const CONVAR_LINE = /^set[rsa]?\s+(\S+)\s+\S/i;
const COMMAND_LINE = /^(\S+)\s+\S/;
// Lines that add to a list (permissions, files to run): only the same line counts as there.
const LIST_LINE = /^(?:add_ace|remove_ace|add_principal|remove_principal|exec|load_server_icon)\s/i;
const SETTING_WORDS = { sv_maxclients: 'player slots' };
const codeOf = (line) => splitComment(String(line))[0].trim();
const sameLine = (code) => code.replace(/\s+/g, ' ').toLowerCase();
/** The setting a line sets ("sv_maxclients 64", "set foo bar"), or null for scripts and lists. */
const settingOf = (code) => (BOOT_LINE.test(code) || LIST_LINE.test(code) ? null : (code.match(CONVAR_LINE) || code.match(COMMAND_LINE))?.[1] || null);

/**
 * What a move before CityHQ 1.8.4 left out: the lines of CityHQ's own section in your PC's
 * server.cfg that the host's doesn't have, such as scripts installed or switched on in CityHQ,
 * admins and settings. Left alone: the helper's own lines, the database line, where the server
 * listens and its key, scripts the host has switched off, players who are admins there already,
 * and settings the host sets its own way.
 */
export function linesLeftOut(localCfg, hostCfg) {
  const host = withoutBom(hostCfg);
  const codes = host.split(/\r?\n/).map(codeOf).filter(Boolean);
  const there = new Set(codes.map(sameLine));
  const admins = new Set(codes.map((c) => c.match(ADMIN_LINE)?.[1].toLowerCase()).filter(Boolean));
  const boot = parseBoot(host);
  const out = [];
  for (const raw of managedLines(withoutBom(localCfg))) {
    const code = codeOf(raw);
    if (!code || isHelperLine(code) || there.has(sameLine(code)) || ENDPOINT.test(code) || LICENSE.test(code)) continue;
    const script = code.match(BOOT_LINE)?.[1];
    if (script && (boot.names.has(script) || boot.turnedOff.has(script))) continue;
    const admin = code.match(ADMIN_LINE)?.[1].toLowerCase();
    if (admin && admins.has(admin)) continue;
    const setting = settingOf(code);
    if (setting && (/^mysql_connection_string$/i.test(setting) || readConvar(host, setting) !== null || readCommand(host, setting) !== null)) continue;
    there.add(sameLine(code));
    if (admin) admins.add(admin);
    out.push(raw.trim());
  }
  return out;
}

/** Up to four names, then how many more: "a, b and c". */
function namesOf(names) {
  const shown = names.slice(0, 4);
  if (names.length > shown.length) shown.push(`${names.length - shown.length} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0] || '';
}
const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Lines from linesLeftOut in plain words: "2 scripts (a and b), 1 admin (Sam) and 1 setting (player slots)". */
export function describeLeftOut(lines) {
  const scripts = [];
  const named = [];
  const settings = [];
  let unnamed = 0;
  let other = 0;
  for (const line of lines) {
    const [code, comment] = splitComment(line).map((s) => s.trim());
    const script = code.match(BOOT_LINE)?.[1];
    const setting = settingOf(code);
    if (script) scripts.push(script);
    else if (ADMIN_LINE.test(code)) {
      const name = comment.replace(/^(?:#|\/\/)\s*/, '');
      if (name) named.push(name); else unnamed += 1;
    } else if (setting) settings.push(SETTING_WORDS[setting.toLowerCase()] || setting);
    else other += 1;
  }
  const admins = unnamed ? [...named, `${unnamed} without a name`] : named;
  const parts = [];
  if (scripts.length) parts.push(`${counted(scripts.length, 'script', 'scripts')} (${namesOf(scripts)})`);
  if (admins.length) parts.push(`${counted(named.length + unnamed, 'admin', 'admins')} (${namesOf(admins)})`);
  if (settings.length) parts.push(`${counted(settings.length, 'setting', 'settings')} (${namesOf(settings)})`);
  if (other) parts.push(counted(other, 'other line', 'other lines'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'nothing';
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
  else if (f.database.passwordMissing) add('bad', `Your host's panel didn't give CityHQ the password for "${f.database.name}". Type it below: in your panel's Databases tab, the eye button shows it.`);
  else if (f.database.reachable === false) {
    const said = f.database.signInError ? ` The database said: ${f.database.signInError}` : '';
    const hint = /access denied/i.test(f.database.signInError || '')
      ? ' Check that it allows connections from anywhere ("Connections from: %") in your host\'s panel. If it does, type its password below (the eye button there shows it) and check again.'
      : ' In your host\'s panel, allow connections to it from anywhere (often "Connections from: %"), or ask your host.';
    add('bad', `This PC can't sign in to the host's database "${f.database.name}" (${f.database.host}:${f.database.port}).${said}${hint}`);
  }
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
