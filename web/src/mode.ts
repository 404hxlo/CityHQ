// Simple or Pro, and the small things Home remembers on this device (a hidden welcome, typed
// commands). Browser storage only: a convenience that may be empty, never something that matters.
import { useCallback, useEffect, useState } from 'react';
import type { Mode } from './actions';

const MODE_KEY = 'cityhq-mode';
const EVENT = 'cityhq-stored';

export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window or storage turned off: it just isn't remembered */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

/** A remembered string that updates everywhere it's shown. */
export function useStored(key: string, fallback: string): [string, (v: string | null) => void] {
  const [value, setValue] = useState(() => readStored(key) ?? fallback);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === key) setValue(readStored(key) ?? fallback); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [key, fallback]);
  const set = useCallback((v: string | null) => writeStored(key, v), [key]);
  return [value, set];
}

/** Simple (the default, for people new to running a server) or Pro. */
export function useMode(): [Mode, (m: Mode) => void] {
  const [value, set] = useStored(MODE_KEY, 'simple');
  return [value === 'pro' ? 'pro' : 'simple', set];
}

/** Commands typed into Home, newest first, for the up arrow. */
const TYPED_KEY = 'cityhq-typed';
export function typedHistory(): string[] {
  try { return JSON.parse(readStored(TYPED_KEY) || '[]'); } catch { return []; }
}
export function rememberTyped(text: string) {
  const list = [text, ...typedHistory().filter((t) => t !== text)].slice(0, 40);
  writeStored(TYPED_KEY, JSON.stringify(list));
}
