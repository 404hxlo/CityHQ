// "Report a problem": a bug report for CityHQ's GitHub page, written here and shown in full before
// anything leaves the PC. Nothing is sent by CityHQ: the person opens it on GitHub (where reports are
// public) or copies it. License keys, passwords, player IDs, IP addresses, email addresses, long
// tokens and the Windows user name are taken out first.
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOverview } from './control.js';
import { desktop } from './desktop.js';
import {
  HttpError, LOG_DIR, MANAGED_DB, ROOT, ROOT_FOUND,
} from './paths.js';
import { APP_VERSION } from './updates.js';

export const ISSUES_URL = 'https://github.com/404hxlo/CityHQ/issues/new';
// Browsers and GitHub cut off very long links; past this the details are pasted in by hand.
export const MAX_URL = 7500;
const LOG_LINES = 40;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A folder written every way it shows up in logs: C:\x\y, C:/x/y, C:\\x\\y and file:///C:/x%20y. */
function folderForms(folder) {
  if (!folder) return [];
  const back = path.win32.normalize(folder).replace(/\\+$/, '');
  const fwd = back.replace(/\\/g, '/');
  return [...new Set([back, back.replace(/\\/g, '\\\\'), fwd, encodeURI(fwd)])].filter((f) => f.length > 3);
}

/** Takes private details out of text that is about to be shown publicly. */
export function redact(text, { home = os.homedir(), user = safeUser(), root = ROOT_FOUND ? ROOT : null } = {}) {
  let out = String(text ?? '');
  // Folders first, longest first, so a server folder inside the user folder becomes <server folder>.
  const folders = [...folderForms(root).map((f) => [f, '<server folder>']), ...folderForms(home).map((f) => [f, '%USERPROFILE%'])]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [form, label] of folders) out = out.replace(new RegExp(escapeRe(form), 'gi'), label);
  out = out
    .replace(/cfxk_[A-Za-z0-9_]+/g, 'cfxk_(hidden)')
    // Game panel API keys (Pterodactyl client and application keys).
    .replace(/\bptl[ac]_[A-Za-z0-9]+/g, 'ptlc_(hidden)')
    .replace(/(mysql:\/\/[^:\s"'/]+:)[^@\s"']+@/gi, '$1(hidden)@')
    .replace(/\b(password|pwd|token|secret|apikey|api_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&"']+)/gi, '$1$2(hidden)')
    .replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '(Discord webhook hidden)')
    .replace(/\b(license2?|steam|discord|fivem|xbl|live|ip|citizenid):[A-Za-z0-9._:-]+/gi, '$1:(hidden)')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '(email hidden)')
    .replace(/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '(IP hidden)')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '(hidden)')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '(hidden)');
  // The Windows user name on its own, for paths written some other way. Short names are too common
  // a word to replace safely.
  if (user && user.length >= 4) out = out.replace(new RegExp(`\\b${escapeRe(user)}\\b`, 'gi'), '<user>');
  return out;
}

function safeUser() {
  try { return os.userInfo().username; } catch { return null; }
}

/** The last lines of CityHQ's own log, where its errors go. */
function recentLog() {
  const file = path.join(LOG_DIR, 'control-app.log');
  if (!existsSync(file)) return '';
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, 'utf8').slice(size > 256 * 1024 ? -256 * 1024 : 0);
    return text.trimEnd().split(/\r?\n/).slice(-LOG_LINES).map((l) => l.slice(0, 400)).join('\n');
  } catch { return ''; }
}

/** Facts about this copy and setup that help find a bug. Nothing about players or the city. */
export function technicalDetails({ problems = [] } = {}) {
  const setup = !ROOT_FOUND ? 'no server chosen yet (Welcome screen)' : MANAGED_DB ? 'server set up by CityHQ' : 'existing server with its own database';
  return {
    lines: [
      `CityHQ: ${APP_VERSION} (${desktop()?.installFolder?.() ? 'ready-made download' : desktop() ? 'built from source' : 'web only'})`,
      `Windows: ${os.release()} (${os.arch()})`,
      `Setup: ${setup}`,
      ...(ROOT_FOUND ? [`Server: ${getOverview().state}`] : []),
      ...(problems.length ? [`Problems CityHQ shows: ${problems.slice(0, 6).join('; ')}`] : []),
    ],
    log: recentLog(),
  };
}

const fence = (text) => `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;

/**
 * The report as GitHub shows it, and a link that opens it there. When the whole report doesn't fit
 * in a link, the link carries it without the log and the screen copies the full text to paste in.
 */
export function buildReport({ what, doing = '', details = null }, scrub = redact) {
  const said = scrub(String(what || '').trim()).slice(0, 4000);
  if (!said) throw new HttpError(400, 'Say what went wrong first.');
  const steps = scrub(String(doing || '').trim()).slice(0, 2000);
  const firstLine = said.split('\n')[0];
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const head = [
    '### What happened', said,
    ...(steps ? ['', '### What I was doing', steps] : []),
  ];
  const facts = details ? ['', '### Details', ...details.lines.map((l) => `- ${scrub(l)}`)] : [];
  const log = details?.log ? ['', '<details><summary>CityHQ log (last lines, private details removed)</summary>', '', fence(scrub(details.log)), '', '</details>'] : [];
  const footer = ['', '_Sent from CityHQ\'s Report a problem._'];
  const body = [...head, ...facts, ...log, ...footer].join('\n');
  const link = (text) => `${ISSUES_URL}?${new URLSearchParams({ title, body: text }).toString()}`;
  let url = link(body);
  let complete = true;
  if (url.length > MAX_URL) {
    complete = false;
    url = link([...head, ...facts, '', '_The log is too long for a link: paste the copied report below this line._', ...footer].join('\n'));
    if (url.length > MAX_URL) url = link([...head.map((l) => l.slice(0, 1500)), '', '_Paste the copied report below._'].join('\n'));
  }
  return { title, body, url, complete };
}
