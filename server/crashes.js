// When the server crashes or goes down: what happened in plain words, the likely cause, and the
// fix. A fix that only switches something off gets a button (pressed by the owner, never on its
// own); everything else gets plain steps. Each crash is kept for Things to fix on Home, and sent as
// an alert: a Windows notification and, once a channel is set up, a Discord message.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { COLORS, sendDiscord } from './discord.js';
import { lastActivity } from './doctor.js';
import { recordEvent } from './events.js';
import { STATE_DIR } from './paths.js';
import { replaceFileSync } from './retry.js';

const FILE = 'crashes.json';
const KEEP = 30;
/** How long a crash stays in Things to fix, unless the server has run fine since. */
const SHOW_MS = 12 * 3600 * 1000;
/** The same crash again within this is a crash loop: counted, not announced again. */
const SAME_MS = 3 * 60 * 1000;
/** Discord gets at most one message this often; a crash loop is summed up in the next one. */
const DISCORD_GAP_MS = 3 * 60 * 1000;

const plain = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\^\d/g, '').trim();
/** A log line as FiveM said it, without txAdmin's box and channel names. */
const said = (line) => plain(line).replace(/^.*?(?:STDERR|STDOUT|TXADMIN)\W+/i, '').replace(/^\[[^\]]*\]\s*/, '').replace(/[↩\s]+$/, '').slice(0, 300);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Where each start of the server begins in its console. */
const BOOT = /FXServer Starting|\[\s*resources\] Scanning resources\./;
export const sinceBoot = (lines) => lines.slice(Math.max(0, lines.findLastIndex((l) => BOOT.test(l))));

/** txAdmin's reasons for restarting the server that mean something went wrong. */
export const isCrashReason = (reason) => /process close|crash|timed out|hang|not responding|heartbeat|health ?check|failed/i.test(String(reason || ''))
  && !/schedul|request/i.test(String(reason || ''));

/** txAdmin's "Restarting server: <reason>" in a log line, or null. */
export const restartReasonOf = (line) => plain(line).match(/Restarting server:\s*(.+?)\.?$/i)?.[1] || null;

/** Your host's (Wings) own words when the whole server process crashed. */
export const isHostCrashLine = (line) => /Detected server process in a crashed state/i.test(line);

function stuckScript(name, title, detail, kind = 'stuck') {
  return {
    kind,
    title: `${name} ${title}`,
    detail,
    steps: [`Press the button to start the server without ${name}. Then check its install steps, or ask its author.`],
    suspect: name,
    fix: {
      label: `Turn ${name} off at boot`,
      confirm: `${name} won't start with the server any more, so the server can start without it. You can turn it back on from Resources, or with Undo.`,
      fix: { type: 'boot-off', name },
    },
  };
}

/**
 * Why the server crashed, from what it printed since its latest start (lines) and txAdmin's reason
 * for restarting it (reason; none when the whole server went down). It only blames a script when
 * the evidence points at one.
 */
export function explainCrash({
  reason = null, lines = [], wentDown = false, hosted = false, memory = null, dumpSaved = false,
} = {}) {
  const text = lines.map(plain);
  const licenseLine = text.findLast((l) => /could not authenticate server license key|license key authentication failed/i.test(l));
  if (licenseLine) {
    const words = said(licenseLine);
    const inactive = /inactive/i.test(words);
    return {
      kind: 'license',
      title: inactive ? 'The server can\'t start: its license key is inactive' : 'The server can\'t start: FiveM didn\'t accept its license key',
      detail: `FiveM refused the license key: "${words}"${inactive ? ' Since October 2026, a key only works once the server\'s details are filled in on the Cfx.re Portal.' : ''}`,
      steps: inactive ? [
        'Sign in at portal.cfx.re with the Cfx.re account the key comes from, and open Servers, then Server Registration Keys.',
        'Open the key your server uses and choose Edit Server Details. Fill in Name, Tagline, Description and Language, then save, and activate the key if the Portal asks.',
        'Restart the server.',
      ] : [
        'Sign in at portal.cfx.re and check that the key in server.cfg is still there and active.',
        'If it isn\'t, make a new one there and put it in server.cfg (Settings, Server settings).',
        'Restart the server.',
      ],
      suspect: null,
      fix: null,
    };
  }
  const outOfMemory = text.some((l) => /out of memory|std::bad_alloc|allocation failed|oom.?kill/i.test(l) && !/out of memory:\s*false/i.test(l))
    || Boolean(memory?.limitBytes && memory.usedBytes >= memory.limitBytes * 0.95);
  if (outOfMemory) {
    return {
      kind: 'memory',
      title: 'The server ran out of memory',
      detail: memory?.limitBytes
        ? `It was using ${gb(memory.usedBytes)} of the ${gb(memory.limitBytes)} your plan allows when it went down.`
        : 'It used all the memory it could get, so it was closed.',
      steps: [
        'Turn on Scheduled restarts in Settings, so memory is freed once a day.',
        'Switch off scripts you don\'t use on the Resources page.',
        hosted ? 'If it keeps happening, ask your host for a plan with more memory.' : 'Close other programs on this PC while the server runs.',
      ],
      suspect: null,
      fix: null,
    };
  }
  // Once the server had fully started, the last script it loaded says nothing about a crash.
  const booted = text.some((l) => /\[qb-control\] ready/.test(l));
  const last = lastActivity(text);
  const loading = !booted && last?.kind === 'resource' ? last.name : null;
  const why = String(reason || '');
  if (/timed out/i.test(why)) {
    if (!booted && last?.kind === 'license') {
      return {
        kind: 'license',
        title: 'The start got stuck checking the license key',
        detail: 'The server couldn\'t finish checking its license key with FiveM, which needs the internet. This happens when the internet drops or the key is wrong.',
        steps: ['Check the server is online.', 'If it keeps happening, check the key on portal.cfx.re, then restart the server.'],
        suspect: null,
        fix: null,
      };
    }
    if (loading) return stuckScript(loading, 'got stuck while the server was starting', `txAdmin waited for the server to finish starting and gave up while ${loading} was loading, so ${loading} is the likely cause.`);
  }
  if (/hang|not responding|heartbeat|health ?check/i.test(why)) {
    if (loading) return stuckScript(loading, 'was loading when the server froze', `The server stopped answering while ${loading} was loading, so ${loading} is the likely cause.`, 'hang');
    return {
      kind: 'hang',
      title: 'The server froze',
      detail: 'It stopped answering for too long, so txAdmin restarted it. Anyone online was disconnected.',
      steps: [
        'A script stuck in a loop usually causes this. Open the Console page and look for errors or "hitch warning" lines just before it.',
        'If it happens after many hours, turn on Scheduled restarts in Settings.',
      ],
      suspect: null,
      fix: null,
    };
  }
  if (loading) {
    return stuckScript(loading, 'was loading when the server crashed', `The server closed while ${loading} was starting, so ${loading} is the likely cause. A file in it may be damaged, or made for a newer game version.`, 'crash');
  }
  // A crash once the server was running, or the whole server going down.
  const scriptError = text.slice(-40).findLast((l) => /SCRIPT ERROR: @[\w.-]+\//.test(l));
  const errorScript = scriptError?.match(/SCRIPT ERROR: @([\w.-]+)\//)?.[1] || null;
  const timedOut = /timed out/i.test(why);
  let what;
  if (wentDown) what = hosted ? 'Your host says the whole server process crashed.' : 'txAdmin stopped running.';
  else if (timedOut) what = 'txAdmin waited for the server to finish starting and gave up.';
  else what = 'The game server closed without being asked to.';
  return {
    kind: wentDown ? 'down' : timedOut ? 'stuck' : 'crash',
    title: wentDown ? 'The server went down' : timedOut ? 'The server didn\'t finish starting' : 'The server crashed',
    detail: `${what}${errorScript ? ` Just before, ${errorScript} showed an error.` : ''}${dumpSaved ? ' A crash report was saved in the server\'s crashes folder.' : ''}`,
    steps: [
      ...(errorScript ? [`Check ${errorScript}'s error on the Console page. An update from its author often fixes it.`] : []),
      `Open the Console page and look at the last lines before it ${wentDown ? 'went down' : timedOut ? 'gave up' : 'crashed'}.`,
      'If it happens again, think about which scripts you added or updated most recently, and switch them off one at a time on the Resources page.',
    ],
    suspect: errorScript,
    fix: null,
  };
}

// ---------------------------------------------------------------- the crashes kept
const fileIn = (stateDir) => path.join(stateDir, FILE);

export function readCrashes(stateDir = STATE_DIR) {
  try {
    const list = JSON.parse(readFileSync(fileIn(stateDir), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeCrashes(list, stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true });
    replaceFileSync(fileIn(stateDir), JSON.stringify(list.slice(0, KEEP), null, 1));
  } catch { /* the alert still went out */ }
}

const discordState = new Map();

/**
 * Keeps a crash and tells the owner: an alert (which Windows shows as a notification) and, when
 * set up, Discord. The same crash again within a few minutes (a crash loop) is counted on the
 * first one instead of being announced again. after says what happens next (who restarts it).
 */
export function reportCrash(explained, {
  reason = null, raw = '', serverName = '', after = '', stateDir = STATE_DIR, now = Date.now(), send = sendDiscord, record = recordEvent,
} = {}) {
  const list = readCrashes(stateDir);
  const same = list.find((c) => !c.resolvedAt && c.kind === explained.kind && c.suspect === explained.suspect && now - c.lastAt < SAME_MS);
  let report;
  if (same) {
    same.count += 1;
    same.lastAt = now;
    report = same;
  } else {
    report = {
      id: String(now), at: now, lastAt: now, count: 1, reason, raw: String(raw || '').slice(-4000), after, resolvedAt: null, ...explained,
    };
    list.unshift(report);
  }
  writeCrashes(list, stateDir);
  const todo = report.fix ? `Press "${report.fix.label}" in Things to fix on CityHQ's Home.` : report.steps[0];
  if (!same) record({ level: 'alert', title: report.title, detail: `${report.detail}${after ? ` ${after}` : ''} ${report.fix ? 'Open CityHQ to fix it in one click.' : 'Open CityHQ to see what to do.'}` });
  const d = discordState.get(stateDir) || { at: 0, unsent: 0 };
  if (now - d.at >= DISCORD_GAP_MS) {
    const more = d.unsent ? `\n\nIt also went down ${d.unsent} more time${d.unsent === 1 ? '' : 's'} since the last message.` : '';
    discordState.set(stateDir, { at: now, unsent: 0 });
    Promise.resolve(send({
      title: `${serverName ? `${serverName}: ` : ''}${report.title}`,
      description: `${report.detail}${after ? `\n\n${after}` : ''}\n\n**What to do:** ${todo}${more}`,
      color: COLORS.alert,
    }, { stateDir })).catch(() => {});
  } else {
    discordState.set(stateDir, { ...d, unsent: d.unsent + 1 });
  }
  return report;
}

/** After CityHQ tried to start the server again: back up (good news on Discord too), or still down. */
export function reportRecovery({ ok, detail = '', serverName = '' }, { stateDir = STATE_DIR, send = sendDiscord, record = recordEvent } = {}) {
  const title = ok ? 'The server is back up' : 'The server is still down';
  record(ok ? { title, detail: 'CityHQ started it again.' } : { level: 'alert', title, detail });
  Promise.resolve(send({
    title: `${serverName ? `${serverName}: ` : ''}${title}`,
    description: ok ? 'CityHQ started it again.' : detail,
    color: ok ? COLORS.ok : COLORS.alert,
  }, { stateDir })).catch(() => {});
}

/**
 * For Things to fix: the latest crash, from the last 12 hours, unless it was dealt with. Once the
 * server has run for half an hour since (uptimeSec, from CityHQ's helper), it's over.
 */
export function crashProblem({ stateDir = STATE_DIR, now = Date.now(), uptimeSec = null } = {}) {
  const [c] = readCrashes(stateDir);
  if (!c || c.resolvedAt || now - c.lastAt > SHOW_MS) return null;
  if (Number.isFinite(uptimeSec) && uptimeSec >= 1800 && now - uptimeSec * 1000 > c.lastAt) return null;
  const when = new Date(c.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return {
    id: `crash:${c.id}`,
    rule: 'crash',
    severity: 'error',
    resource: c.suspect || null,
    count: c.count,
    title: c.count > 1 ? `${c.title} (${c.count} times)` : c.title,
    what: `${c.count > 1 ? 'Last at' : 'At'} ${when}. ${c.detail}${c.after ? ` ${c.after}` : ''}`,
    fix: c.steps,
    actions: c.fix ? [{ kind: 'fix', label: c.fix.label, confirm: c.fix.confirm, fix: c.fix.fix }] : [],
    links: [],
    raw: c.raw || c.reason || '',
  };
}

/** Marks a crash dealt with (its fix was pressed), so it leaves Things to fix. */
export function resolveCrash(id, stateDir = STATE_DIR) {
  const list = readCrashes(stateDir);
  const c = list.find((x) => x.id === String(id));
  if (!c) return;
  c.resolvedAt = Date.now();
  writeCrashes(list, stateDir);
}
