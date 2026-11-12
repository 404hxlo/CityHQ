// A hosted server's panel API key or SFTP password. Kept apart from everything else, locked with
// Windows' own protection for this Windows account (Electron safeStorage), and never sent to the
// screens, the phone page or a problem report.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { desktop } from '../desktop.js';
import { HttpError } from '../paths.js';
import { replaceFileSync } from '../retry.js';

const FILE = 'remote-secret.bin';

export function canKeepSecrets() {
  const hooks = desktop();
  try { return Boolean(hooks?.canProtect?.()); } catch { return false; }
}

/** Saves the secret for a hosted server whose state lives in stateDir. */
export function saveSecret(stateDir, secret, file = FILE) {
  if (!canKeepSecrets()) throw new HttpError(409, 'Hosted servers need the CityHQ desktop app, which can lock your key with Windows\' own protection.');
  mkdirSync(stateDir, { recursive: true });
  replaceFileSync(path.join(stateDir, file), desktop().protect(secret));
}

/** The secret, or null when there is none or it can't be unlocked (another Windows account, say). */
export function loadSecret(stateDir, file = FILE) {
  if (!canKeepSecrets()) return null;
  try {
    return desktop().unprotect(readFileSync(path.join(stateDir, file), 'utf8').trim()) || null;
  } catch { return null; }
}

/** Removes a saved secret (after a move, say). */
export function forgetSecret(stateDir, file = FILE) {
  try { rmSync(path.join(stateDir, file), { force: true }); } catch { /* already gone */ }
}
