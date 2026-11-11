// "Friends can't join?": works out what stands between the server and players outside your home,
// from this PC alone: its network address, Windows Firewall, the router's address, and what FiveM's
// server list reported when it tried to reach the server. Nothing here contacts outside services.
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { serverLogTail } from './doctor.js';
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

/** Whether the rules let TCP and UDP through to this server on the given network profile. */
export function firewallCovers(rules, { program, port, profile }) {
  const forUs = (r) => r.enabled && r.allow
    && (/^any$/i.test(r.profiles) || !profile || r.profiles.toLowerCase().split(',').includes(profile.toLowerCase()))
    && ((r.program && r.program.toLowerCase() === program.toLowerCase()) || r.localPort.split(',').includes(String(port)));
  const covered = (proto) => rules.some((r) => forUs(r) && (r.protocol.toUpperCase() === proto || /^any$/i.test(r.protocol)));
  return { tcp: covered('TCP'), udp: covered('UDP') };
}

/**
 * What FiveM's server list said about reaching the server. It only checks a few minutes after a
 * start, so a fresh start without a result yet is "pending", reporting how the last check went.
 */
export const LISTING_SETTLE_MS = 6 * 60 * 1000;
export function listingStatus(lines, now = Date.now()) {
  const failedAt = (l) => /Server list query returned an error/i.test(l);
  const ipOf = (l) => l.match(/reach the server at (\d+\.\d+\.\d+\.\d+):\d+/)?.[1] || null;
  const boot = lines.findLastIndex((t) => t.includes('FXServer Starting'));
  const since = boot >= 0 ? lines.slice(boot) : lines;
  const before = boot >= 0 ? lines.slice(0, boot) : [];
  const failedNow = since.filter(failedAt);
  if (failedNow.length) return { status: 'blocked', publicIp: ipOf(failedNow.at(-1)) };
  const failedBefore = before.filter(failedAt);
  const stamp = boot >= 0 ? lines[boot].match(/Starting - (\d+\/\d+\/\d+, [\d:]+ [AP]M)/)?.[1] : null;
  const startedAt = stamp ? new Date(stamp.replace(',', '')).getTime() : NaN;
  const running = since.some((t) => /\[qb-control\] ready/.test(t));
  // FiveM's list only checks a few minutes in, and logs nothing when it succeeds.
  if (running && Number.isFinite(startedAt) && now - startedAt >= LISTING_SETTLE_MS) return { status: 'ok', publicIp: null };
  return { status: 'pending', publicIp: failedBefore.length ? ipOf(failedBefore.at(-1)) : null, lastFailed: failedBefore.length > 0 };
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
    settle(exec('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }).then((r) => parseFirewall(r.stdout)), null),
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
