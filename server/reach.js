// "Friends can't join?": works out what stands between the server and players outside your home,
// from this PC alone: its network address, Windows Firewall, the router's address, and what FiveM's
// server list reported when it tried to reach the server. Nothing here contacts outside services.
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { serverLogTail, startedAt } from './doctor.js';
import {
  FXSERVER_EXE, GAME_PORT, HttpError, TMP_DIR,
} from './paths.js';

const exec = promisify(execFile);

/** The default gateway (the router) and this PC's address on that network, from "route print". */
export function parseRoute(text) {
  const m = text.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+\d+/m);
  return m ? { gateway: m[1], localIp: m[2] } : null;
}

/** Inbound firewall rules from "netsh advfirewall firewall show rule ... verbose". */
export function parseFirewall(text) {
  return text.split(/\r?\n(?=Rule Name:)/).filter((b) => b.startsWith('Rule Name:')).map((b) => {
    const field = (name) => b.match(new RegExp(`^${name}:\\s+(.+)$`, 'm'))?.[1]?.trim() || '';
    return {
      name: field('Rule Name'),
      enabled: /^yes$/i.test(field('Enabled')),
      allow: /^allow$/i.test(field('Action')),
      profiles: field('Profiles'),
      protocol: field('Protocol'),
      localPort: field('LocalPort'),
      program: field('Program'),
    };
  });
}

const PROFILE_FLAGS = [[1, 'Domain'], [2, 'Private'], [4, 'Public']];

/**
 * Inbound rules from PowerShell's firewall objects, in parseFirewall's shape. Unlike netsh's text,
 * these read the same in every Windows language. profile is Windows' flags: 0 means any network.
 */
export function rulesFromObjects(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map((r) => {
    const flags = Number(r.profile) || 0;
    return {
      name: String(r.name ?? ''),
      enabled: true,
      allow: true,
      profiles: flags ? PROFILE_FLAGS.filter(([bit]) => flags & bit).map(([, name]) => name).join(',') : 'Any',
      protocol: String(r.protocol ?? ''),
      localPort: String(r.localPort ?? ''),
      program: String(r.program ?? ''),
    };
  });
}

// Every enabled inbound "allow" rule, with its program and ports, joined in one pass (asking for each
// rule's filters one by one takes minutes on a PC with many rules).
const FIREWALL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow)',
  '$apps = @{}; foreach ($f in Get-NetFirewallApplicationFilter) { $apps[$f.InstanceID] = $f.Program }',
  '$ports = @{}; foreach ($f in Get-NetFirewallPortFilter) { $ports[$f.InstanceID] = $f }',
  "$out = foreach ($r in $rules) { $p = $ports[$r.InstanceID]; [pscustomobject]@{ name = $r.DisplayName; profile = [int]$r.Profile; program = [string]$apps[$r.InstanceID]; protocol = [string]$p.Protocol; localPort = (@($p.LocalPort) -join ',') } }",
  'ConvertTo-Json -Compress -Depth 3 -InputObject @($out)',
].join('; ');

async function firewallRules() {
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_SCRIPT], { windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024 * 1024 });
    return rulesFromObjects(JSON.parse(stdout.trim() || '[]'));
  } catch {
    // Windows without the firewall commands for PowerShell: netsh, whose words only parse in English.
    const { stdout } = await exec('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
    return parseFirewall(stdout);
  }
}

/** Whether the rules let TCP and UDP through to this server on the given network profile. */
export function firewallCovers(rules, { program, port, profile }) {
  // LocalPort is a list of single ports and ranges: "30120,30121" or "30100-30200".
  const portListed = (list) => list.split(',').map((p) => p.trim()).some((p) => {
    const range = p.match(/^(\d+)-(\d+)$/);
    return range ? port >= Number(range[1]) && port <= Number(range[2]) : p === String(port);
  });
  // Windows calls a work network "DomainAuthenticated"; its rules say "Domain".
  const network = profile === 'DomainAuthenticated' ? 'Domain' : profile;
  const forUs = (r) => r.enabled && r.allow
    && (/^any$/i.test(r.profiles) || !network || r.profiles.toLowerCase().split(',').includes(network.toLowerCase()))
    && ((r.program && r.program.toLowerCase() === program.toLowerCase()) || portListed(r.localPort));
  const covered = (proto) => rules.some((r) => forUs(r) && (r.protocol.toUpperCase() === proto || /^any$/i.test(r.protocol)));
  return { tcp: covered('TCP'), udp: covered('UDP') };
}

/**
 * What FiveM's server list said about reaching the server. It only checks a few minutes after a
 * start, so a fresh start without a result yet is "pending", reporting how the last check went.
 */
export const LISTING_SETTLE_MS = 6 * 60 * 1000;
const failedAt = (l) => /Server list query returned an error/i.test(l);
const ipOf = (l) => l.match(/reach the server at (\d+\.\d+\.\d+\.\d+):\d+/)?.[1] || null;

/**
 * FiveM's server list's last complaint since the latest start: its own words, the address it
 * tried to reach the server at (when it says), and the log line. Null when there's none.
 */
export function listingError(lines) {
  const boot = lines.findLastIndex((t) => t.includes('FXServer Starting'));
  const line = (boot >= 0 ? lines.slice(boot) : lines).findLast(failedAt);
  if (!line) return null;
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\^\d/g, '');
  return { text: plain.replace(/^.*?Server list query returned an error:?\s*/i, '').trim(), ip: ipOf(plain), raw: line };
}

export function listingStatus(lines, now = Date.now(), shape = undefined) {
  const boot = lines.findLastIndex((t) => t.includes('FXServer Starting'));
  const since = boot >= 0 ? lines.slice(boot) : lines;
  const before = boot >= 0 ? lines.slice(0, boot) : [];
  const failedNow = since.filter(failedAt);
  if (failedNow.length) return { status: 'blocked', publicIp: ipOf(failedNow.at(-1)) };
  const failedBefore = before.filter(failedAt);
  // txAdmin writes the start time in this PC's own date format.
  const started = boot >= 0 ? startedAt(lines[boot], shape)?.getTime() ?? NaN : NaN;
  const running = since.some((t) => /\[qb-control\] ready/.test(t));
  // FiveM's list only checks a few minutes in, and logs nothing when it succeeds.
  if (running && Number.isFinite(started) && now - started >= LISTING_SETTLE_MS) return { status: 'ok', publicIp: null };
  return { status: 'pending', publicIp: failedBefore.length ? ipOf(failedBefore.at(-1)) : null, lastFailed: failedBefore.length > 0 };
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The network phone access listens on, from Windows' network profiles ({ alias, name, category })
 * and this PC's network adapters: { category: 'Public' | 'Private' | 'Work', name, page }, where page
 * is the part of Windows' settings that changes it ('wifi' or 'ethernet'). When there are several,
 * the least private one counts, since phone access listens on all of them. Null when unknown.
 */
export function pickNetwork(profiles, interfaces) {
  const list = (Array.isArray(profiles) ? profiles : [profiles]).filter((p) => p && p.category);
  const homeAdapters = Object.entries(interfaces || {})
    .filter(([, addresses]) => (addresses || []).some((a) => a.family === 'IPv4' && !a.internal && PRIVATE_IPV4.test(a.address)))
    .map(([name]) => name.toLowerCase());
  const mine = list.filter((p) => homeAdapters.includes(String(p.alias || '').toLowerCase()));
  const candidates = mine.length ? mine : list;
  const pick = candidates.find((p) => p.category === 'Public') || candidates.find((p) => p.category === 'Private') || candidates[0];
  if (!pick) return null;
  return {
    category: pick.category === 'DomainAuthenticated' ? 'Work' : pick.category,
    name: pick.name ? String(pick.name) : null,
    page: /wi-?fi|wlan|wireless/i.test(String(pick.alias || '')) ? 'wifi' : 'ethernet',
  };
}

let networkCache = { at: 0, value: null };

/** pickNetwork for this PC now, asked of Windows at most every 30 seconds. */
export async function networkInfo() {
  if (Date.now() - networkCache.at < 30000) return networkCache.value;
  const script = 'Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; name = $_.Name; category = [string]$_.NetworkCategory } } | ConvertTo-Json -Compress';
  let value = null;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
    value = pickNetwork(JSON.parse(stdout.trim() || '[]'), os.networkInterfaces());
  } catch { /* not readable here */ }
  networkCache = { at: Date.now(), value };
  return value;
}

async function networkProfile() {
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-NetConnectionProfile | Where-Object IPv4Connectivity -eq 'Internet' | Select-Object -First 1).NetworkCategory"], { windowsHide: true, timeout: 10000 });
    return stdout.trim() || null;
  } catch { return null; }
}

export async function reachReport() {
  const settle = (p, fallback) => p.then((v) => v, () => fallback);
  const [route, fw, profile, net, log] = await Promise.all([
    settle(exec('route', ['print', '-4', '0.0.0.0'], { windowsHide: true, timeout: 8000 }).then((r) => parseRoute(r.stdout)), null),
    settle(firewallRules(), null),
    networkProfile(),
    settle(exec('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000 }).then((r) => r.stdout), ''),
    settle(serverLogTail(4 * 1024 * 1024), []),
  ]);
  const localIp = route?.localIp
    || Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))?.address
    || null;
  const firewall = fw ? firewallCovers(fw, { program: FXSERVER_EXE, port: GAME_PORT, profile }) : null;
  return {
    port: GAME_PORT,
    localIp,
    gateway: route?.gateway || null,
    profile,
    listening: new RegExp(`0\\.0\\.0\\.0:${GAME_PORT}\\s+0\\.0\\.0\\.0:0\\s+LISTENING`).test(net),
    firewall: firewall ? { ...firewall, ok: firewall.tcp && firewall.udp } : null,
    listing: listingStatus(log),
  };
}

/**
 * Adds Windows Firewall rules for this server's FXServer.exe (TCP and UDP, every network type).
 * Windows shows its own permission prompt first; nothing changes unless the person accepts it.
 */
export async function askFirewallRules() {
  await mkdir(TMP_DIR, { recursive: true });
  const script = path.join(TMP_DIR, 'cityhq-firewall.ps1');
  await writeFile(script, `${firewallCommand()}\r\n`, 'utf8');
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"')`,
    ], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    throw new HttpError(500, `Windows could not be asked: ${err.message}`);
  }
  return { asked: true };
}

/** The same rules as a command to run in an administrator PowerShell, for doing it by hand. */
export const firewallCommand = () => ['TCP', 'UDP'].map((p) => `New-NetFirewallRule -DisplayName "FiveM server (CityHQ) ${p}" -Direction Inbound -Program "${FXSERVER_EXE}" -Protocol ${p} -Action Allow -Profile Any`).join('\n');
