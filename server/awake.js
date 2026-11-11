// Keeps the PC from going to sleep while the game server runs. Sleep freezes FXServer mid-boot or
// mid-game, and txAdmin then restarts it on wake. Only the desktop app can ask Windows for this,
// and Windows still sleeps when the lid is closed or the power button is pressed.
import { desktop } from './desktop.js';
import { getProcessState } from './processes.js';
import { getSettings } from './settings.js';

const CHECK_MS = 10000;
let timer = null;
let current = 'off';

/**
 * What to ask Windows for: 'off', 'system' (stay awake, the screen may turn off) or 'display'
 * (screen on too, the only thing a Modern Standby laptop honours on battery past a few minutes).
 */
export function awakeMode({ enabled, screenOnBattery, serverRunning, onBattery }) {
  if (!enabled || !serverRunning) return 'off';
  return onBattery && screenOnBattery ? 'display' : 'system';
}

function apply() {
  const hooks = desktop();
  if (!hooks?.setKeepAwake) return;
  const { keepAwake } = getSettings();
  const p = getProcessState();
  const mode = awakeMode({
    ...keepAwake,
    serverRunning: Boolean(p.monitor || p.game),
    onBattery: Boolean(hooks.onBattery?.()),
  });
  if (mode !== current) {
    hooks.setKeepAwake(mode);
    current = mode;
  }
}

/** What the Settings page shows. */
export function awakeStatus() {
  const hooks = desktop();
  const p = getProcessState();
  return {
    supported: Boolean(hooks?.setKeepAwake),
    holding: current,
    // Whether Windows really has the request right now, not just what was asked for.
    active: Boolean(hooks?.isKeepingAwake?.()),
    serverRunning: Boolean(p.monitor || p.game),
    onBattery: Boolean(hooks?.onBattery?.()),
  };
}

/** Re-checks straight away, such as after the setting changes. */
export const refreshAwake = () => apply();

export function startAwakeWatch() {
  if (timer) return;
  apply();
  timer = setInterval(apply, CHECK_MS);
  timer.unref?.();
}

export function stopAwakeWatch() {
  if (timer) clearInterval(timer);
  timer = null;
  desktop()?.setKeepAwake?.('off');
  current = 'off';
}
