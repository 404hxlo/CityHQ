// Reads and edits server.cfg: which resources start at boot, the app's own managed
// block, and masking of secrets so they never reach the browser.
import { readFile } from 'node:fs/promises';
import { replaceFile } from './retry.js';

export const BLOCK_START = '# >>> CityHQ (managed by the app, edits here may be replaced)';
export const BLOCK_END = '# <<< CityHQ';
// Earlier names of the app. Their block is taken over and renamed, never doubled.
const OLD_NAMES = ['FiveM Server Manager', 'QBCore Control'];
const STARTS = [BLOCK_START, ...OLD_NAMES.map((n) => `# >>> ${n} (managed by the app, edits here may be replaced)`)];
const ENDS = [BLOCK_END, ...OLD_NAMES.map((n) => `# <<< ${n}`)];
const OFF_MARKER = '# qb-control-off: ';
const AGENT_LINES = ['add_ace resource.qb-control command allow', 'ensure qb-control'];

export const SECRET_KEYS = new Set([
  'sv_licensekey', 'mysql_connection_string', 'rcon_password', 'steam_webapikey', 'sv_tebexsecret',
]);
export const SECRET_MASK = '(hidden - leave this as is to keep the current value)';

const EOL = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

export const readCfg = (cfgPath) => readFile(cfgPath, 'utf8');

export const writeCfg = (cfgPath, text) => replaceFile(cfgPath, text);

function splitComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#') return [line.slice(0, i), line.slice(i)];
    else if (c === '/' && line[i + 1] === '/') return [line.slice(0, i), line.slice(i)];
  }
  return [line, ''];
}

/** Everything server.cfg starts at boot: individual resources and [category] folders. */
export function parseBoot(text) {
  const names = new Set();
  const categories = new Set();
  const turnedOff = new Set();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(OFF_MARKER)) {
      const m = raw.slice(OFF_MARKER.length).match(/^(?:ensure|start)\s+(\S+)/);
      if (m) turnedOff.add(m[1]);
      continue;
    }
    const [code] = splitComment(raw);
    const m = code.match(/^\s*(ensure|start|restart)\s+(\S+)/);
    if (!m) continue;
    const name = m[2].replace(/^["']|["']$/g, '');
    if (name.startsWith('[') && name.endsWith(']')) categories.add(name);
    else names.add(name);
  }
  return { names, categories, turnedOff };
}

function withBlock(text, mutate) {
  const eol = EOL(text);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => STARTS.includes(l));
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && ENDS.includes(l));
  let block = [...AGENT_LINES];
  let head = lines;
  let tail = [];
  if (start !== -1 && end > start) {
    block = lines.slice(start + 1, end);
    head = lines.slice(0, start);
    tail = lines.slice(end + 1);
  }
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  for (const required of [...AGENT_LINES].reverse()) {
    if (!block.includes(required)) block.unshift(required);
  }
  const next = mutate ? mutate(block) || block : block;
  return [...head, '', BLOCK_START, ...next, BLOCK_END, ...tail.filter((l, i) => l.trim() !== '' || i < tail.length - 1), ''].join(eol);
}

/** Adds the app's block (agent permission and start line) when it is not there yet. */
export const ensureManagedBlock = (text) => withBlock(text);

/** Changes the lines inside the app's block; mutate gets the lines and may change them in place. */
export const editManagedBlock = (text, mutate) => withBlock(text, mutate);

export function addBootLine(text, name) {
  const off = `${OFF_MARKER}ensure ${name}`;
  const eol = EOL(text);
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l === off || l === `${OFF_MARKER}start ${name}`);
  if (i !== -1) {
    lines[i] = lines[i].slice(OFF_MARKER.length);
    return lines.join(eol);
  }
  return withBlock(text, (block) => { if (!block.includes(`ensure ${name}`)) block.push(`ensure ${name}`); });
}

/** Turns off explicit start lines for name, keeping them so they can be restored. */
export function removeBootLine(text, name) {
  const eol = EOL(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(ensure|start)\\s+["']?${escaped}["']?\\s*(?:[#].*)?$`);
  return text.split(/\r?\n/).map((line) => (
    pattern.test(line) ? `${OFF_MARKER}${line.trim().replace(/\s*#.*$/, '')}` : line
  )).join(eol);
}

const CONVAR_LINE = /^(\s*)(set[rsa]?)\s+(\S+)\s+(.*?)\s*$/i;

/** The value server.cfg gives a setting (set, sets, setr or seta), or null when it isn't set. The last one wins. */
export function readConvar(text, key) {
  let value = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = splitComment(raw)[0].match(CONVAR_LINE);
    if (m && m[3].toLowerCase() === key.toLowerCase()) value = m[4].replace(/^["']|["']$/g, '');
  }
  return value;
}

/** True for the ways people write "on" in server.cfg. */
export const convarOn = (value) => value !== null && /^(1|true|on|yes)$/i.test(value.trim());

/** Sets a setting: every existing line for it is changed in place, or one is added to the app's block. */
export function setConvar(text, key, value) {
  const eol = EOL(text);
  let found = false;
  const lines = text.split(/\r?\n/).map((raw) => {
    const [code, comment] = splitComment(raw);
    const m = code.match(CONVAR_LINE);
    if (!m || m[3].toLowerCase() !== key.toLowerCase()) return raw;
    found = true;
    return `${m[1]}${m[2]} ${m[3]} ${value}${comment ? ` ${comment.trim()}` : ''}`;
  });
  if (found) return lines.join(eol);
  return withBlock(text, (block) => { block.push(`set ${key} ${value}`); });
}

/** The value of a command line such as "sv_maxclients 10" (not "set ..."), or null. The last one wins. */
export function readCommand(text, key) {
  let value = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = splitComment(raw)[0].match(/^\s*(\S+)\s+(.*?)\s*$/);
    if (m && m[1].toLowerCase() === key.toLowerCase()) value = m[2].replace(/^["']|["']$/g, '');
  }
  return value;
}

/** Sets a command line such as "sv_maxclients 32": changed in place, or added to the app's block. */
export function setCommand(text, key, value) {
  const eol = EOL(text);
  let found = false;
  const lines = text.split(/\r?\n/).map((raw) => {
    const [code, comment] = splitComment(raw);
    const m = code.match(/^(\s*)(\S+)\s+/);
    if (!m || m[2].toLowerCase() !== key.toLowerCase()) return raw;
    found = true;
    return `${m[1]}${m[2]} ${value}${comment ? ` ${comment.trim()}` : ''}`;
  });
  if (found) return lines.join(eol);
  return withBlock(text, (block) => { block.push(`${key} ${value}`); });
}

/** Deletes every start line and off-marker for name; used when a resource is removed. */
export function forgetBootLines(text, name) {
  const eol = EOL(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:${OFF_MARKER})?\\s*(ensure|start)\\s+["']?${escaped}["']?\\s*(?:[#].*)?$`);
  return text.split(/\r?\n/).filter((line) => !pattern.test(line)).join(eol);
}

const keyOf = (code) => {
  const m = code.match(/^\s*(?:(?:set|sets|setr)\s+)?([\w.:-]+)\s+/);
  return m ? m[1] : null;
};

/** Replaces secret values with a visible placeholder. */
export function maskSecrets(text) {
  return text.split(/\r?\n/).map((line) => {
    const [code, comment] = splitComment(line);
    const key = keyOf(code);
    if (!key || !SECRET_KEYS.has(key.toLowerCase())) return line;
    const m = code.match(/^(\s*(?:(?:set|sets|setr)\s+)?[\w.:-]+\s+)(.*?)(\s*)$/);
    if (!m) return line;
    return `${m[1]}"${SECRET_MASK}"${m[3]}${comment}`;
  }).join(EOL(text));
}

/** Puts the real secret values back before writing an edited file to disk. */
export function restoreSecrets(edited, original) {
  const originals = new Map();
  for (const line of original.split(/\r?\n/)) {
    const [code] = splitComment(line);
    const key = keyOf(code);
    if (key && SECRET_KEYS.has(key.toLowerCase())) originals.set(key.toLowerCase(), code.trim());
  }
  return edited.split(/\r?\n/).map((line) => {
    if (!line.includes(SECRET_MASK)) return line;
    const [code, comment] = splitComment(line);
    const key = keyOf(code)?.toLowerCase();
    if (!key || !originals.has(key)) {
      throw new Error(`Could not restore the hidden value for ${key || 'a setting'}. Reload the file and try again.`);
    }
    return `${originals.get(key)}${comment ? ` ${comment}` : ''}`;
  }).join(EOL(edited));
}

export function connectionStringOf(text) {
  for (const line of text.split(/\r?\n/)) {
    const [code] = splitComment(line);
    const m = code.match(/^\s*(?:set|sets|setr)\s+mysql_connection_string\s+["']?([^"']*)["']?\s*$/i);
    if (m) return m[1];
  }
  return null;
}

/** Understands both the URL form and the semicolon form that oxmysql accepts. */
export function parseConnection(value) {
  if (!value) return null;
  if (/^mysql:\/\//i.test(value)) {
    const u = new URL(value);
    return {
      host: u.hostname, port: u.port || '3306', user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, ''),
    };
  }
  const parts = Object.fromEntries(value.split(';').filter(Boolean).map((p) => {
    const [k, ...v] = p.split('=');
    return [k.trim().toLowerCase(), v.join('=').trim()];
  }));
  return {
    host: parts.host || parts.server || '127.0.0.1', port: parts.port || '3306',
    user: parts.user || parts.uid || parts.userid || 'root',
    password: parts.password || parts.pwd || '', database: parts.database || parts.db || '',
  };
}
