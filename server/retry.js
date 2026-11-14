// Windows briefly locks files while antivirus, search indexing, backup tools or an open editor
// read them, especially right after they were created. Replacing or moving a file at that moment
// fails with EPERM, EBUSY or EACCES, even though trying again a moment later works. Everything
// that saves or moves files goes through here, so a passing lock never turns into an error.
import { randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './paths.js';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const isBusy = (err) => BUSY.has(err?.code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn and tries again while it fails in a way worth retrying. The waits grow
 * (100 ms, 200 ms, 400 ms ... up to 2 s), about 7 seconds in all with the defaults.
 */
export async function retry(fn, {
  attempts = 8, firstDelayMs = 100, maxDelayMs = 2000, retryable = isBusy, wait = sleep,
} = {}) {
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      await wait(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

const lockedMessage = (target) => `${path.basename(target)} is open in another program, so it could not be saved. `
  + 'Close it there (or wait a moment if a virus scan is running), then try again.';

/** A name beside the file for its new copy, never the same for two saves at once. */
export const tempNameFor = (target) => `${target}.${process.pid}-${randomBytes(4).toString('hex')}.qbctmp`;

/**
 * Saves a file safely: the new text goes into a copy beside it, written all the way to the disk,
 * which then replaces the file in one step. A crash or power cut halfway never leaves a
 * half-written or empty file, and two saves at once never share a copy. If the swap keeps
 * failing, the copy is removed and the original stays exactly as it was.
 */
export async function replaceFile(target, text, { renameFn = rename, wait } = {}) {
  const tmp = tempNameFor(target);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  try {
    await retry(() => renameFn(tmp, target), { wait });
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    if (isBusy(err)) throw new HttpError(423, lockedMessage(target));
    throw err;
  }
}

/** The same for the app's own small settings files, which are saved synchronously. */
export function replaceFileSync(target, text) {
  const tmp = tempNameFor(target);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      if (attempt >= 6 || !isBusy(err)) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      Atomics.wait(pause, 0, 0, 50 * attempt);
    }
  }
}

/** Moves a folder, waiting out a passing lock. `what` names it in the message if it stays locked. */
export async function moveFolderSafely(from, to, what, { renameFn = rename, wait } = {}) {
  try {
    await retry(() => renameFn(from, to), { wait });
  } catch (err) {
    if (!isBusy(err)) throw err;
    throw new HttpError(423, `Windows would not let the app move ${what}, because a file in it is open in another program. `
      + 'Close any editor or window showing its files (or wait a moment if a virus scan is running), then try again.');
  }
}
