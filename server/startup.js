// Explains why the server would not start, using what Windows itself recorded.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { FXSERVER_EXE, LOG_DIR } from './paths.js';

const exec = promisify(execFile);
// Windows writes the device path (\Device\HarddiskVolume12\QBCore-Server\...), so match without the drive.
const EXE_TAIL = FXSERVER_EXE.slice(2).toLowerCase();
const LOAD = /process \((.+?)\) attempted to load (.+?) that did not meet/i;

/** The files Windows refused to load into this server's FXServer, from Code Integrity event text. */
export function parseBlockedFiles(lines, exeTail = EXE_TAIL) {
  const files = new Set();
  for (const line of lines) {
    const m = LOAD.exec(line);
    if (m && m[1].toLowerCase().endsWith(exeTail)) files.add(path.win32.basename(m[2]));
  }
  return [...files];
}

export function blockMessage({ files, smartAppControl }) {
  const which = files.length ? `it won't let ${files.join(' and ')} load` : 'it stops one of the server\'s files from loading';
  if (smartAppControl) {
    return `Windows Smart App Control is blocking the server: ${which}, so txAdmin closes straight away. `
      + 'To fix it, open Windows Security, go to App & browser control, then Smart App Control settings, and turn it off. '
      + 'Then press Start. Microsoft Defender keeps protecting the PC either way.';
  }
  return `A Windows security policy is blocking the server: ${which}, so txAdmin closes straight away. `
    + 'Allow the server folder in that policy, then press Start.';
}

/** Asks Windows whether it blocked any of the server's files since a given time. */
export async function windowsBlock(sinceMs) {
  // 3033 and 3077 are enforced blocks; 3076 only audits and never stops anything.
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(sinceMs - 5000)}).LocalDateTime
$lines = @(Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-CodeIntegrity/Operational'; Id=3033,3077; StartTime=$since } | ForEach-Object { ($_.Message -split '\r?\n')[0] })
$sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
ConvertTo-Json -Compress -InputObject @{ lines = $lines; sac = $sac }`;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 });
    const { lines, sac } = JSON.parse(stdout.trim() || '{}');
    const files = parseBlockedFiles(Array.isArray(lines) ? lines : [lines].filter(Boolean));
    return files.length ? { files, smartAppControl: sac === 1 } : null;
  } catch {
    return null;
  }
}

/** The window title of one process, from tasklist, which is much lighter than starting PowerShell. */
async function windowTitle(pid) {
  try {
    const { stdout } = await exec('tasklist.exe', ['/FI', `PID eq ${pid}`, '/V', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 });
    const fields = stdout.trim().match(/"([^"]*)"/g);
    return fields ? fields[fields.length - 1].slice(1, -1) : '';
  } catch { return ''; }
}

const READ_BOX = String.raw`
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class QbcBox {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Read(uint pid) {
    var o = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      var t = new StringBuilder(64); GetWindowText(h, t, 64);
      if (p == pid && t.ToString() == "Fatal Error") {
        EnumChildWindows(h, (c, l2) => {
          var k = new StringBuilder(32); GetClassName(c, k, 32);
          var s = new StringBuilder(2048); GetWindowText(c, s, 2048);
          if (k.ToString() == "Static" && s.Length > 0) o.Add(s.ToString());
          return true;
        }, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
'@
[QbcBox]::Read(PID_HERE) -join ' '`;

/**
 * On a fatal error FXServer shows a "Fatal Error" box and waits for someone to click OK, so the
 * process never closes by itself. Returns the box's text, or null when it isn't showing one.
 */
export async function fatalErrorBox(pid) {
  if (!Number.isInteger(pid) || await windowTitle(pid) !== 'Fatal Error') return null;
  try {
    const script = READ_BOX.replace('PID_HERE', String(pid));
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
    return stdout.trim().replace(/\s+/g, ' ').slice(0, 400) || 'no details were shown';
  } catch {
    return 'no details could be read';
  }
}

/** The last thing txAdmin printed before closing, if anything. */
function lastConsoleError() {
  try {
    const text = readFileSync(path.join(LOG_DIR, 'txadmin-console.err.log'), 'utf8');
    const line = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
    return /cfxk_|licensekey/i.test(line) ? '' : line.slice(0, 300);
  } catch { return ''; }
}

/** Why txAdmin closed during startup, as plainly as can be told. */
export async function whyStartFailed(startedAt, { closed, boxText }) {
  const block = await windowsBlock(startedAt);
  if (block) return blockMessage(block);
  if (boxText) return `The server stopped on a fatal error while starting: ${boxText}`;
  if (!closed) return 'The server did not come online in 3 minutes. Check the Console page.';
  const said = lastConsoleError();
  return `txAdmin closed right after starting${said ? `, saying: ${said}` : ', and Windows did not record a reason'}. Press Start to try again.`;
}
