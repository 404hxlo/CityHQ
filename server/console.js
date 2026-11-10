// Reads the log txAdmin writes, so the console still works across restarts and shows boot errors.
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { FXSERVER_LOG } from './paths.js';

const INITIAL_BYTES = 128 * 1024;
const MAX_CHUNK = 512 * 1024;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const CARETS = /\^[0-9]/g;

const SECRET_PATTERNS = [
  /cfxk_[A-Za-z0-9_]+/g,
  /(mysql:\/\/[^:\s]+:)[^@\s]+@/g,
];

function clean(text) {
  let out = text.replace(ANSI, '').replace(CARETS, '').replace(/\r/g, '');
  out = out.replace(SECRET_PATTERNS[0], 'cfxk_(hidden)').replace(SECRET_PATTERNS[1], '$1(hidden)@');
  // FXServer pads its channel names to line them up, which wraps badly on small screens.
  return out.replace(/^\[\s+/gm, '[');
}

export function classify(line) {
  // Expected on a server that is not reachable from the internet, so not a real problem.
  if (/Server list query returned an error/i.test(line)) return 'warn';
  // Stack trace lines only name things like StackDumpError; the error itself is above them.
  if (/^\[[^\]]*\]\s*>\s/.test(line)) return 'info';
  if (/\b(SCRIPT ERROR|error|failed|couldn't|could not|exception|crash)\b/i.test(line) && !/\b0 errors?\b/i.test(line)) return 'error';
  if (/\b(warn(ing)?|deprecated)\b/i.test(line)) return 'warn';
  return 'info';
}

/** Returns new log text after byte offset since. Pass nothing for the recent tail. */
export async function readConsole(since) {
  if (!existsSync(FXSERVER_LOG)) return { offset: 0, lines: [], reset: false };
  const { size } = await stat(FXSERVER_LOG);
  let start = Number.isFinite(since) && since >= 0 ? since : Math.max(0, size - INITIAL_BYTES);
  // txAdmin rotates this file, in which case it shrinks and we start over.
  const reset = Number.isFinite(since) && since > size;
  if (reset) start = Math.max(0, size - INITIAL_BYTES);
  const firstRead = !Number.isFinite(since) || reset;
  const length = Math.min(MAX_CHUNK, size - start);
  if (length <= 0) return { offset: size, lines: [], reset };

  const handle = await open(FXSERVER_LOG, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    let end = start + length;
    // Hold back a partial last line until it is complete.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { offset: start, lines: [], reset };
    end = start + Buffer.byteLength(text.slice(0, lastNl + 1));
    text = text.slice(0, lastNl);
    let raw = clean(text).split('\n');
    if (firstRead && start > 0) raw = raw.slice(1);
    const lines = raw
      .filter((l) => l.trim())
      .map((l) => ({ text: l, level: classify(l) }));
    return { offset: end, lines, reset };
  } finally {
    await handle.close();
  }
}

