// Alerts in a Discord channel, so they reach the owner's phone. The owner pastes the channel's
// webhook link once in Settings; it's locked with Windows' own protection, like a host's key, and
// never shown again or put in a problem report. Only CityHQ's own summary is ever sent (it can quote
// FiveM's own words, such as why it refused the license key): never the log, player names or
// anything from server.cfg.
import { HttpError, STATE_DIR } from './paths.js';
import {
  canKeepSecrets, forgetSecret, loadSecret, saveSecret,
} from './remote/secret.js';
import { APP_VERSION } from './updates.js';

const FILE = 'discord-webhook.bin';
const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;
export const COLORS = { alert: 0xd9534f, ok: 0x3fb27f, info: 0x7a5ce6 };

let lastError = null;

/** True for a Discord channel webhook link (and nothing else, so alerts can only go to Discord). */
export const isDiscordWebhook = (url) => WEBHOOK.test(String(url || '').trim());

export const discordStatus = (stateDir = STATE_DIR) => ({
  set: Boolean(loadSecret(stateDir, FILE)),
  canKeep: canKeepSecrets(),
  lastError,
});

export function setDiscordWebhook(url, stateDir = STATE_DIR) {
  const value = String(url || '').trim();
  if (!isDiscordWebhook(value)) throw new HttpError(400, 'That isn\'t a Discord webhook link. In Discord, open the channel\'s settings, then Integrations, Webhooks, and use Copy Webhook URL.');
  saveSecret(stateDir, value, FILE);
  lastError = null;
  return discordStatus(stateDir);
}

export function forgetDiscordWebhook(stateDir = STATE_DIR) {
  forgetSecret(stateDir, FILE);
  lastError = null;
  return discordStatus(stateDir);
}

const cut = (text, max) => (String(text || '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text || ''));

/** The message Discord gets: one embed, trimmed to Discord's limits. */
export function discordMessage({ title, description = '', color = COLORS.alert, footer = '' }, at = new Date()) {
  return {
    username: 'CityHQ',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: cut(title, 250),
      description: cut(description, 3900),
      color,
      timestamp: at.toISOString(),
      footer: { text: cut(footer || `CityHQ ${APP_VERSION}`, 200) },
    }],
  };
}

/**
 * Posts to the saved webhook. Resolves to true when Discord took it, false when there's no
 * webhook or it failed (the reason is kept for Settings); it never throws, so an alert can't break
 * what raised it. throwErrors is for the test button, which shows the reason.
 */
export async function sendDiscord(message, { stateDir = STATE_DIR, fetchImpl = fetch, throwErrors = false } = {}) {
  const url = loadSecret(stateDir, FILE);
  if (!url) {
    if (throwErrors) throw new HttpError(409, 'Paste a Discord webhook link first.');
    return false;
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `CityHQ/${APP_VERSION}` },
      body: JSON.stringify(discordMessage(message)),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 401) throw new Error('Discord says this webhook no longer exists. Make a new one and paste it again.');
    if (!res.ok) throw new Error(`Discord answered ${res.status}.`);
    lastError = null;
    return true;
  } catch (err) {
    lastError = err.name === 'TimeoutError' ? 'Discord didn\'t answer in time.' : err.message;
    if (throwErrors) throw new HttpError(502, lastError);
    return false;
  }
}
