// Turns config files into simple form fields, and writes changes back by editing only
// the value on the exact line, so comments and formatting stay as the author wrote them.
import { SECRET_KEYS } from './cfg.js';

const SCALAR = /(=\s*)(true|false|-?\d+(?:\.\d+)?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')(\s*,?\s*)$/d;
const OPENERS = /\b(function|if|for|while)\b/g;
const CLOSERS = /\bend\b/g;

/** Splits a Lua line into code and comment, tracking whether a block comment stays open. */
function splitLua(line, inBlock) {
  let code = '';
  let i = 0;
  let quote = null;
  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf(']]', i);
      if (end === -1) return { code, comment: '', inBlock: true };
      i = end + 2;
      inBlock = false;
      continue;
    }
    const c = line[i];
    if (quote) {
      code += c;
      if (c === '\\') { code += line[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; code += c; i++; continue; }
    if (line.startsWith('--[[', i)) { inBlock = true; i += 4; continue; }
    if (line.startsWith('--', i)) return { code, comment: line.slice(i + 2).trim(), inBlock: false };
    code += c;
    i++;
  }
  return { code, comment: '', inBlock };
}

/** Removes string contents so braces and keywords inside strings are not counted. */
const stripStrings = (code) => code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

function count(text, char) {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

function typedValue(raw) {
  if (raw === 'true' || raw === 'false') return { type: 'boolean', value: raw === 'true' };
  if (/^-?\d/.test(raw)) return { type: 'number', value: Number(raw) };
  return { type: 'string', value: raw.slice(1, -1).replace(/\\(.)/g, '$1') };
}

function humanize(key) {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

export function parseLuaFields(text) {
  const fields = [];
  const stack = [];
  let inBlock = false;
  let blockDepth = 0;
  let lastComment = '';

  text.split(/\r?\n/).forEach((line, index) => {
    const parsed = splitLua(line, inBlock);
    const wasBlock = inBlock;
    inBlock = parsed.inBlock;
    const code = parsed.code;
    const bare = stripStrings(code);
    const trimmed = code.trim();

    if (!trimmed) {
      lastComment = !wasBlock && parsed.comment ? parsed.comment : '';
      return;
    }

    const opens = (bare.match(OPENERS) || []).length;
    const closes = (bare.match(CLOSERS) || []).length;
    const inCode = blockDepth > 0 || opens > 0;
    blockDepth = Math.max(0, blockDepth + opens - closes);

    const named = stack.every((frame) => frame !== null);
    if (!inCode && named) {
      const scalar = code.match(SCALAR);
      if (scalar) {
        const before = code.slice(0, scalar.index).trim();
        let key = null;
        const path = stack.filter(Boolean);
        const dotted = before.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[["'][^"']+["']\])*)$/);
        const bracket = before.match(/^\[["']([^"']+)["']\]$/);
        if (bracket) key = [...path, bracket[1]].join('.');
        else if (dotted) key = [...path, dotted[1].replace(/\[["']([^"']+)["']\]/g, '.$1')].join('.');
        if (key && !before.startsWith('local ')) {
          const raw = scalar[2];
          const [valueStart, valueEnd] = scalar.indices[2];
          const parts = key.split('.');
          fields.push({
            id: `${index + 1}:${key}`,
            line: index + 1,
            key,
            label: humanize(parts[parts.length - 1]),
            group: parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'General',
            raw,
            start: valueStart,
            end: valueEnd,
            help: parsed.comment || lastComment,
            ...typedValue(raw),
          });
        }
      }
    }

    if (!inCode) {
      // Track named tables like `Config.Items = {` and anonymous ones like `{` in a list.
      const opensTable = count(bare, '{');
      const closesTable = count(bare, '}');
      if (opensTable > closesTable) {
        const m = code.match(/^\s*(?:\[["']([^"']+)["']\]|([A-Za-z_][\w.]*))\s*=\s*\{\s*(?:,\s*)?$/);
        const name = m ? (m[1] || m[2]) : null;
        const isOuter = bare.trim().endsWith('{');
        stack.push(name && isOuter && !/^local\s/.test(trimmed) ? name : null);
        for (let i = 1; i < opensTable - closesTable; i++) stack.push(null);
      } else if (closesTable > opensTable) {
        for (let i = 0; i < closesTable - opensTable; i++) stack.pop();
      }
    }
    lastComment = '';
  });
  return fields;
}

const CFG_LABELS = {
  sv_maxclients: 'Max players',
  sv_enforcegamebuild: 'Game build',
  sv_endpointprivacy: 'Hide player IP addresses',
  sv_scripthookallowed: 'Allow ScriptHook mods',
  qb_locale: 'QBCore language',
  usetarget: 'Use the targeting system',
  resources_usesystemchat: 'Use the built-in chat',
  voice_usenativeaudio: 'Voice: native audio',
  voice_defaultcycle: 'Voice: range key',
  voice_defaultvolume: 'Voice: default volume',
  voice_enableradioanim: 'Voice: radio animation',
  voice_syncdata: 'Voice: sync data',
  voice_usesendingrangeonly: 'Voice: sending range only',
};

const CFG_LINE = /^(\s*(?:(?:set|sets|setr)\s+)?)([\w.:-]+)(\s+)("[^"]*"|'[^']*'|[^\s#]+)(\s*(?:#.*|\/\/.*)?)$/;
const CFG_COMMANDS = new Set([
  'ensure', 'start', 'restart', 'stop', 'exec', 'add_ace', 'remove_ace', 'add_principal', 'remove_principal',
  'endpoint_add_tcp', 'endpoint_add_udp', 'load_server_icon',
]);

export function parseCfgFields(text) {
  const fields = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(#|\/\/|$)/.test(line)) return;
    const m = line.match(CFG_LINE);
    if (!m) return;
    const key = m[2];
    if (CFG_COMMANDS.has(key.toLowerCase()) || SECRET_KEYS.has(key.toLowerCase())) return;
    if (!m[1].trim() && !key.startsWith('sv_')) return;
    const raw = m[4];
    const unquoted = raw.replace(/^["']|["']$/g, '');
    const start = m[1].length + m[2].length + m[3].length;
    const typed = unquoted === 'true' || unquoted === 'false'
      ? { type: 'boolean', value: unquoted === 'true' }
      : /^-?\d+(\.\d+)?$/.test(unquoted)
        ? { type: 'number', value: Number(unquoted) }
        : { type: 'string', value: unquoted };
    fields.push({
      id: `${index + 1}:${key}`,
      line: index + 1,
      key,
      label: CFG_LABELS[key.toLowerCase()] || humanize(key.replace(/^sv_/, '')),
      group: m[1].trim() ? 'Server variables' : 'Server options',
      raw,
      start,
      end: start + raw.length,
      help: m[5].replace(/^\s*(#|\/\/)\s*/, '').trim(),
      ...typed,
    });
  });
  return fields;
}

function formatValue(field, value) {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.label} must be on or off`);
    const text = String(value);
    return /^["']/.test(field.raw) ? `${field.raw[0]}${text}${field.raw[0]}` : text;
  }
  if (field.type === 'number') {
    const n = Number(value);
    if (value === '' || value === null || !Number.isFinite(n)) throw new Error(`${field.label} must be a number`);
    return /^["']/.test(field.raw) ? `${field.raw[0]}${n}${field.raw[0]}` : String(n);
  }
  const str = String(value);
  if (/[\r\n]/.test(str)) throw new Error(`${field.label} cannot contain line breaks`);
  const quote = /^'/.test(field.raw) ? "'" : '"';
  if (!/^["']/.test(field.raw) && /^[^\s"'#]+$/.test(str)) return str;
  return `${quote}${str.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`)}${quote}`;
}

/** Applies {id, value} changes. Fails if the file no longer matches what the user saw. */
export function applyFieldChanges(text, kind, changes) {
  const parse = kind === 'cfg' ? parseCfgFields : parseLuaFields;
  const byId = new Map(parse(text).map((f) => [f.id, f]));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const change of changes) {
    const field = byId.get(change.id);
    if (!field) throw new Error('This file changed since it was opened. Reload it and try again.');
    const line = lines[field.line - 1];
    lines[field.line - 1] = line.slice(0, field.start) + formatValue(field, change.value) + line.slice(field.end);
  }
  return lines.join(eol);
}
