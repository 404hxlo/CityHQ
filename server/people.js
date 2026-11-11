// Everyone who has played on the server, so admins and the whitelist can be picked by name.
// Characters come from the QBCore database; the other IDs a player has (FiveM, Discord, Steam)
// are remembered as they join, so hand-written admin lines using those can be named too.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { VALID_IDENTIFIER } from './admins.js';
import { connectionStringOf, parseConnection, readCfg } from './cfg.js';
import { clientArgs, clientEnv, dbClient } from './dbtools.js';
import { findServerData, STATE_DIR } from './paths.js';
import { replaceFileSync } from './retry.js';

const exec = promisify(execFile);
const FILE = path.join(STATE_DIR, 'people.json');
const SAFE_DB = /^[\w$-]+$/;
let seen = null;

function load() {
  if (seen) return seen;
  seen = {};
  try { if (existsSync(FILE)) seen = JSON.parse(readFileSync(FILE, 'utf8')) || {}; } catch { seen = {}; }
  return seen;
}

/** Remembers the IDs of players who are online now: [{ name, identifiers: [...] }]. */
export function rememberIdentifiers(list) {
  load();
  let changed = false;
  for (const entry of list || []) {
    const ids = (entry.identifiers || []).filter((id) => VALID_IDENTIFIER.test(id));
    const license = ids.find((id) => id.startsWith('license:'));
    if (!license) continue;
    seen[license] = { name: String(entry.name || '').slice(0, 60), ids, lastSeen: Date.now() };
    changed = true;
  }
  if (changed) {
    try { replaceFileSync(FILE, JSON.stringify(seen)); } catch { /* best effort */ }
  }
}

/** Splits mariadb --batch output, which escapes tabs and newlines inside values. */
export function parseBatch(stdout) {
  // One pass, so an escaped backslash followed by "t" or "n" stays a backslash and a letter.
  const ESCAPES = { t: '\t', n: '\n', '0': '\0', '\\': '\\' };
  const unescape = (v) => (v === 'NULL' ? null : v.replace(/\\(.)/g, (_, c) => ESCAPES[c] ?? c));
  return stdout.split('\n').filter((l) => l.length).map((l) => l.split('\t').map(unescape));
}

async function query(sql) {
  const server = findServerData();
  if (!server) return [];
  const conn = parseConnection(connectionStringOf(await readCfg(server.cfgPath)));
  if (!conn?.database || !SAFE_DB.test(conn.database)) return [];
  const { stdout } = await exec(dbClient(), [
    ...clientArgs(conn), '--batch', '--skip-column-names', `--execute=${sql}`, conn.database,
  ], { env: clientEnv(conn), windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  return parseBatch(stdout);
}

/** Groups character rows by the player's license, newest first. */
export function groupPlayers(rows, remembered = {}) {
  const byLicense = new Map();
  for (const [license, name, citizenid, first, last, updated] of rows) {
    if (!license || !VALID_IDENTIFIER.test(license)) continue;
    let player = byLicense.get(license);
    if (!player) {
      player = { license, name: name || 'Unknown', characters: [], lastSeen: 0, ids: [license] };
      byLicense.set(license, player);
    }
    const character = [first, last].filter(Boolean).join(' ').trim();
    if (character || citizenid) player.characters.push({ citizenid, name: character || citizenid });
    player.lastSeen = Math.max(player.lastSeen, Number(updated) * 1000 || 0);
  }
  for (const [license, info] of Object.entries(remembered)) {
    const player = byLicense.get(license);
    if (player) {
      player.ids = [...new Set([...player.ids, ...(info.ids || [])])];
      if (info.name) player.name = info.name;
      player.lastSeen = Math.max(player.lastSeen, info.lastSeen || 0);
    } else if (VALID_IDENTIFIER.test(license)) {
      byLicense.set(license, { license, name: info.name || 'Unknown', characters: [], lastSeen: info.lastSeen || 0, ids: info.ids || [license] });
    }
  }
  return [...byLicense.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Everyone who has joined, by license, with their characters. */
export async function knownPlayers() {
  const rows = await query(
    "SELECT license, name, citizenid, JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.firstname')), "
    + "JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.lastname')), UNIX_TIMESTAMP(last_updated) "
    + 'FROM players ORDER BY last_updated DESC LIMIT 3000',
  );
  return groupPlayers(rows, load());
}

/** The best name for any player ID, using everyone known. */
export function nameFor(identifier, players) {
  const id = identifier.toLowerCase();
  const match = players.find((p) => p.ids.some((x) => x.toLowerCase() === id));
  return match ? match.name : null;
}
