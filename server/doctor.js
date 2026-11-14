// The startup doctor: explains each time txAdmin restarted the server or a start didn't finish,
// using txAdmin's own log, the server log and Windows' sleep records. It only blames a script when
// the evidence points at one: a pause of the whole process (sleep, standby) is never a script's fault.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { clean } from './console.js';
import { controlActions } from './control.js';
import { FXSERVER_LOG } from './paths.js';

const exec = promisify(execFile);
const ADMIN_LOG = path.join(path.dirname(FXSERVER_LOG), 'admin.log');
const TAIL_BYTES = 6 * 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;
const PAUSE_MS = 60000;

/** The last few MB of the server log, cleaned, as lines. */
export const serverLogTail = (bytes = TAIL_BYTES) => tail(FXSERVER_LOG, bytes);

/** The end of txAdmin's own log, where it says why it restarted the server. */
export const adminLogTail = (bytes = 64 * 1024) => tail(ADMIN_LOG, bytes);

async function tail(file, bytes = TAIL_BYTES) {
  if (!existsSync(file)) return [];
  const { size } = await stat(file);
  const start = Math.max(0, size - bytes);
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = clean(buf.toString('utf8')).split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

// ---- the date in txAdmin's start banner ----
// txAdmin writes "FXServer Starting - <date>" with toLocaleString(), so the date comes in this PC's
// own format: 11/10/2026, 5:23:22 PM in the US, 10.11.2026, 17:23:22 in Germany, 2026/11/10 17:23:22
// in Japan, and with Arabic or other digits in some languages.
const OTHER_DIGITS = [0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10];
const plainDigits = (text) => text.replace(/[٠-٩۰-۹०-९০-৯๐-๙０-９]/g, (d) => {
  const code = d.charCodeAt(0);
  return String(code - OTHER_DIGITS.find((base) => code >= base && code <= base + 9));
});

/** How a locale writes a date and time: the order of day, month and year, and its words for AM and PM. */
export function dateShapeOf(locale) {
  const format = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const partsAt = (hour) => format.formatToParts(new Date(2026, 10, 14, hour, 5, 9));
  const period = (hour) => partsAt(hour).find((p) => p.type === 'dayPeriod')?.value?.trim().toLowerCase() || null;
  return {
    order: partsAt(13).map((p) => p.type).filter((t) => t === 'year' || t === 'month' || t === 'day'),
    am: period(1),
    pm: period(13),
    // Thailand counts years from 543 BC; calendars with other months (Persian, say) aren't read.
    calendar: format.resolvedOptions().calendar,
  };
}

const PC_DATE_SHAPE = dateShapeOf();

/** The date in a txAdmin start banner, written in this PC's format (or the shape given), or null. */
export function parseBannerStamp(text, shape = PC_DATE_SHAPE) {
  const calendar = shape.calendar || 'gregory';
  if (!['gregory', 'iso8601', 'buddhist'].includes(calendar)) return null;
  const raw = plainDigits(String(text ?? '')).toLowerCase();
  const numbers = (raw.match(/\d+/g) || []).map(Number);
  if (numbers.length < 5) return null;
  const [n1, n2, n3, hourRaw, minute, second = 0] = numbers;
  let year;
  let first;
  let second2;
  if (n1 >= 1000) [year, first, second2] = [n1, n2, n3];
  else if (n3 >= 1000) [first, second2, year] = [n1, n2, n3];
  else return null;
  // Which of the other two is the month: the PC's own order, unless the numbers say otherwise.
  const dateOrder = shape.order.filter((t) => t !== 'year');
  let monthFirst = dateOrder[0] === 'month';
  if (first > 12 && second2 <= 12) monthFirst = false;
  else if (second2 > 12 && first <= 12) monthFirst = true;
  const [month, day] = monthFirst ? [first, second2] : [second2, first];
  let hour = hourRaw;
  const says = (word) => Boolean(word) && raw.includes(word);
  if (says(shape.pm) || /(^|[^a-z])p\.?\s?m\.?($|[^a-z])/.test(raw)) hour = (hour % 12) + 12;
  else if (says(shape.am) || /(^|[^a-z])a\.?\s?m\.?($|[^a-z])/.test(raw)) hour %= 12;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (calendar === 'buddhist') year -= 543;
  const date = new Date(year, month - 1, day, hour, minute, second);
  return date.getDate() === day ? date : null;
}

const STARTING = /Starting - (.+)$/;

/** The date of a "... Starting - <date>" line, or null when the line isn't one. */
export const startedAt = (line, shape = PC_DATE_SHAPE) => parseBannerStamp(String(line ?? '').match(STARTING)?.[1], shape);

/** Each server start in the server log, with its lines. shape: how dates are written (this PC's way). */
export function bootSegments(lines, shape = PC_DATE_SHAPE) {
  const out = [];
  for (const line of lines) {
    if (/FXServer Starting - /.test(line)) { out.push({ start: startedAt(line, shape), lines: [] }); continue; }
    if (out.length) out.at(-1).lines.push(line);
  }
  return out.filter((s) => s.start);
}

/**
 * txAdmin's "Restarting server: ..." lines, dated. Its lines only carry a time of day, so each run of
 * txAdmin is dated backwards from the next "Starting - <date>" banner or, for the newest run, from
 * when the log was last written (`end`): every timestamped line gets the latest date at or before
 * the line after it. Without an upper bound, lines are dated forwards from their banner.
 */
export function adminRestarts(lines, end = null, shape = PC_DATE_SHAPE) {
  const runs = [{ base: null, items: [] }];
  for (const line of lines) {
    const stamp = startedAt(line, shape);
    if (stamp) { runs.push({ base: stamp, items: [] }); continue; }
    const t = line.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
    if (!t) continue;
    const restart = line.match(/\[MONITOR\] Restarting server: (.+)$/);
    runs.at(-1).items.push({ time: [Number(t[1]), Number(t[2]), Number(t[3])], reason: restart ? restart[1].trim() : null });
  }
  const withTime = (day, [h, m, s]) => { const d = new Date(day); d.setHours(h, m, s, 0); return d; };
  const out = [];
  runs.forEach((run, r) => {
    const upper = r + 1 < runs.length ? runs[r + 1].base : (end ? new Date(end) : null);
    const dated = [];
    if (upper) {
      let next = upper;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const at = withTime(next, run.items[i].time);
        if (at > next) at.setDate(at.getDate() - 1);
        dated[i] = at;
        next = at;
      }
    } else if (run.base) {
      let prev = run.base;
      run.items.forEach((item, i) => {
        const at = withTime(prev, item.time);
        if (at < prev) at.setDate(at.getDate() + 1);
        dated[i] = at;
        prev = at;
      });
    } else return;
    run.items.forEach((item, i) => { if (item.reason) out.push({ at: dated[i], reason: item.reason }); });
  });
  return out;
}

/**
 * The longest pause of the whole server in a boot: FXServer's sync and network threads report the
 * same huge gap at once, which only happens when Windows stops the process (sleep, standby).
 */
export function wholePause(lines) {
  let longest = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].match(/(sync|network) thread hitch warning: timer interval of (\d+) milliseconds/);
    const b = lines[i + 1].match(/(sync|network) thread hitch warning: timer interval of (\d+) milliseconds/);
    if (!a || !b || a[1] === b[1]) continue;
    const ms = Math.min(Number(a[2]), Number(b[2]));
    if (ms > PAUSE_MS && Math.abs(Number(a[2]) - Number(b[2])) < 2000) longest = Math.max(longest, ms);
  }
  return longest;
}

/** What the boot was doing last: the script it was loading, or the license check. */
export function lastActivity(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const loading = lines[i].match(/Creating script environments for ([\w.-]+)/);
    if (loading) return { kind: 'resource', name: loading[1] };
    if (/Authenticating server license key/.test(lines[i])) return { kind: 'license' };
  }
  return null;
}

const SCRIPT_LIKE = /^[\w.-]+$/;
const when = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mins = (ms) => `${Math.round(ms / 60000)} minute${Math.round(ms / 60000) === 1 ? '' : 's'}`;

/** One restart explained: what happened, who's at fault, and a fix only when a script really is. */
export function explainRestart({ at, reason }, segment, sleeps = [], actions = []) {
  const lines = segment?.lines || [];
  const pause = wholePause(lines);
  const slept = sleeps.find((s) => s.to >= at.getTime() - 5 * 60000 && s.to <= at.getTime() + 60000);
  const blamed = reason.match(/Resource "([^"]+)" failed to start/)?.[1] || null;
  const id = `restart:${at.getTime()}`;
  const base = { id, at: at.getTime(), reason };
  if (pause > PAUSE_MS || slept) {
    const sleptLong = slept && slept.to - slept.from >= 60000;
    let asleep;
    if (pause > PAUSE_MS) {
      asleep = `Windows paused the whole server for ${mins(pause)}${sleptLong ? ` (the PC was asleep from ${when(new Date(slept.from))} to ${when(new Date(slept.to))})` : ' (sleep or standby)'}`;
    } else if (sleptLong) {
      asleep = `The PC was asleep from ${when(new Date(slept.from))} to ${when(new Date(slept.to))}`;
    } else {
      asleep = `The PC briefly went to sleep at ${when(new Date(slept.from))} while the server was starting`;
    }
    return {
      ...base,
      kind: 'paused',
      title: sleptLong || pause > PAUSE_MS ? 'The PC went to sleep' : 'The PC dipped into sleep',
      detail: `${asleep}. Nothing could run, so when it carried on, txAdmin thought the server had hung and restarted it.${blamed ? ` txAdmin named ${blamed}, but it was only the script loading at that moment and isn't at fault.` : ''}`,
      advice: 'Keep the PC awake while the server runs (see the PC sleep check above), and keep it plugged in.',
    };
  }
  if (/process close detected/i.test(reason)) {
    const byCityHQ = actions.some((a) => ['restarting', 'stopping', 'restoring'].includes(a.state) && a.at >= at.getTime() - 10 * 60000 && a.at <= at.getTime() + 30000);
    if (byCityHQ || lines.some((l) => /Restart requested from CityHQ/i.test(l))) {
      return { ...base, kind: 'planned', title: 'Restarted on purpose', detail: 'The server was asked to restart (from CityHQ or txAdmin), so this is expected.' };
    }
    // Once the server had fully started, the last script loaded says nothing about a crash.
    const booted = lines.some((l) => /\[qb-control\] ready/.test(l));
    const last = booted ? null : lastActivity(lines);
    return {
      ...base,
      kind: 'crash',
      title: booted ? 'The server closed unexpectedly' : 'The server closed while starting',
      detail: `FXServer stopped without being asked to.${last?.kind === 'resource' ? ` It was loading ${last.name} at the time.` : ''} Crash reports are in the server's crashes folder. (Restarts CityHQ makes itself are recognised from now on, so older ones may show here too.)`,
      suspect: last?.kind === 'resource' ? last.name : null,
    };
  }
  const suspect = blamed || (lastActivity(lines)?.kind === 'resource' ? lastActivity(lines).name : null);
  if (lastActivity(lines)?.kind === 'license' && !blamed) {
    return {
      ...base,
      kind: 'license',
      title: 'The start got stuck checking the license key',
      detail: 'The server couldn\'t finish checking its license key with FiveM, which needs the internet. This happens when the internet drops or the key is wrong.',
      advice: 'Check the PC is online. If it keeps happening, check the license key on portal.cfx.re.',
    };
  }
  if (!suspect || !SCRIPT_LIKE.test(suspect)) {
    return { ...base, kind: 'other', title: 'txAdmin restarted the server', detail: `Its reason: ${reason}` };
  }
  return {
    ...base,
    kind: blamed ? 'stuck-script' : 'hang',
    title: `${suspect} ${blamed ? 'got stuck while starting' : 'was loading when the server hung'}`,
    detail: blamed
      ? `${suspect} took longer than txAdmin allows to start, so it restarted the whole server. The PC wasn't asleep at the time, so this points at ${suspect}.`
      : `The server stopped responding while ${suspect} was loading, and the PC wasn't asleep, so ${suspect} is the likely cause.`,
    suspect,
    fix: {
      label: `Turn ${suspect} off at boot`,
      confirm: `${suspect} won't start with the server any more, so the server can start without it. You can turn it back on from Resources, or with Undo, once you've checked its install steps or asked its author.`,
      fix: { type: 'boot-off', name: suspect },
    },
  };
}

let sleepCache = { at: 0, value: [] };
/** Windows' sleep and wake records for the last day, as { from, to } in ms. Empty if unreadable. */
async function sleepWindows() {
  if (Date.now() - sleepCache.at < 60000) return sleepCache.value;
  const script = "$e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 42, 506, 507; StartTime = (Get-Date).AddDays(-1) } -ErrorAction SilentlyContinue | Sort-Object TimeCreated; $e | ForEach-Object { '{0}|{1}' -f ([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(), $_.Id }";
  let value = [];
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 });
    let from = null;
    for (const line of stdout.split(/\r?\n/)) {
      const [t, idText] = line.trim().split('|');
      const ms = Number(t);
      if (!ms) continue;
      if (idText === '506' || idText === '42') from = ms;
      else if (idText === '507' && from !== null) { value.push({ from, to: ms }); from = null; }
    }
  } catch { value = []; }
  sleepCache = { at: Date.now(), value };
  return value;
}

/** Every restart in the last day, newest first, plus a one-line summary. */
export async function startupDoctor() {
  const [serverLines, adminLines, sleeps, adminWritten] = await Promise.all([
    tail(FXSERVER_LOG), tail(ADMIN_LOG, 512 * 1024), sleepWindows(), stat(ADMIN_LOG).then((s) => s.mtimeMs).catch(() => null),
  ]);
  const segments = bootSegments(serverLines);
  const since = Date.now() - DAY_MS;
  const restarts = adminRestarts(adminLines, adminWritten).filter((r) => r.at.getTime() >= since);
  const actions = controlActions();
  const incidents = restarts.map((r) => {
    const segment = [...segments].reverse().find((s) => s.start.getTime() <= r.at.getTime());
    return explainRestart(r, segment, sleeps, actions);
  }).reverse();
  const paused = incidents.filter((i) => i.kind === 'paused').length;
  const unplanned = incidents.filter((i) => i.kind !== 'planned').length;
  let summary = 'No unexpected restarts in the last 24 hours.';
  if (unplanned) {
    summary = `${unplanned} unexpected restart${unplanned === 1 ? '' : 's'} in the last 24 hours`;
    summary += paused ? `, ${paused === unplanned ? 'all' : paused} because Windows paused the server (sleep or standby).` : '.';
  }
  return { summary, incidents };
}
