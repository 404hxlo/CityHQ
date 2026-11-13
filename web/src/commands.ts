// Understanding what someone types into Home's command box: which action they mean, and the
// details in what they typed (a player, an item, an amount, the weather). Plain matching against a
// fixed list of actions and the server's own names, nothing guessed by AI. No React here, so it
// can be tested on its own (web/commands.test.ts).
import type { Player } from './api';

/** Lower case, single spaces, no punctuation at the ends. */
export function normalize(text: string): string {
  return String(text || '').toLowerCase().replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
}

export interface Matchable {
  id: string;
  /** The word to type, such as "announce". */
  command: string;
  /** Other ways to say it, in plain words: "tell everyone", "make it rain". */
  words: string[];
  title: string;
}

export interface Match<T extends Matchable> { action: T; score: number; rest: string }

/** The text after a phrase, wherever it starts. */
function after(q: string, phrase: string): string | null {
  if (q === phrase) return '';
  if (q.startsWith(`${phrase} `)) return q.slice(phrase.length + 1);
  const at = q.indexOf(` ${phrase} `);
  if (at >= 0) return q.slice(at + phrase.length + 2);
  if (q.endsWith(` ${phrase}`)) return '';
  return null;
}

/** Letters of a in b, in order: "rstrt" fits "restart". */
function subsequence(a: string, b: string): boolean {
  let i = 0;
  for (const c of b) if (c === a[i]) i += 1;
  return i === a.length;
}

/**
 * How well typed text fits an action, and what's left after the words that matched it
 * ("kick tommy" leaves "tommy"). 0 means not at all. A longer phrase at the start beats a
 * shorter one ("give car" is a car, not an item called "car").
 */
export function scoreAction<T extends Matchable>(action: T, text: string): Match<T> {
  const q = normalize(text);
  const none = { action, score: 0, rest: q };
  if (!q) return none;
  const [first, ...others] = q.split(' ');
  const rest = others.join(' ');
  let best = none;
  const better = (score: number, left: string) => { if (score > best.score) best = { action, score, rest: left }; };
  if (first === action.command) better(95, rest);
  for (const w of action.words) {
    const left = after(q, w);
    if (left !== null) better(q.startsWith(w) ? 94 + 2 * w.split(' ').length : 70 - Math.min(20, q.indexOf(w)), left);
  }
  if (first.length >= 2 && action.command.startsWith(first)) better(82 - (action.command.length - first.length), rest);
  for (const w of action.words) if (first.length >= 3 && w.startsWith(first)) better(60, rest);
  const title = normalize(action.title);
  if (q.length >= 3 && title.includes(q)) better(50, '');
  if (first.length >= 3 && subsequence(first, action.command)) better(25, rest);
  return best;
}

/**
 * Every action Home understands: the word to type and plain ways to say it. The buttons, forms
 * and what each one does are in actions.tsx, by the same id.
 */
export const VOCABULARY: Matchable[] = [
  { id: 'announce', command: 'announce', title: 'Tell everyone something', words: ['tell everyone', 'message everyone', 'say to everyone', 'broadcast', 'announcement', 'say'] },
  { id: 'players', command: 'players', title: 'See who\'s playing', words: ['who is playing', 'whos playing', 'who is online', 'whos online', 'who is on', 'whos on', 'online players', 'list players', 'player list'] },
  { id: 'restart', command: 'restart', title: 'Restart the server', words: ['restart the server', 'restart server', 'reboot'] },
  { id: 'start', command: 'start', title: 'Start the server', words: ['start the server', 'start server', 'turn on the server', 'turn on'] },
  { id: 'stop', command: 'stop', title: 'Stop the server', words: ['stop the server', 'stop server', 'shut down', 'shutdown', 'turn off the server', 'turn off'] },
  { id: 'kick', command: 'kick', title: 'Kick a player', words: ['kick a player', 'remove a player', 'kick out'] },
  { id: 'ban', command: 'ban', title: 'Ban a player', words: ['ban a player'] },
  { id: 'revive', command: 'revive', title: 'Revive a player', words: ['revive everyone', 'revive all', 'revive a player', 'resurrect', 'bring back'] },
  { id: 'heal', command: 'heal', title: 'Heal a player', words: ['heal a player'] },
  { id: 'give', command: 'give', title: 'Give an item', words: ['give an item', 'give item'] },
  { id: 'car', command: 'car', title: 'Spawn a car', words: ['spawn a car', 'spawn car', 'give a car', 'give car', 'spawn'] },
  { id: 'fixcar', command: 'fixcar', title: 'Fix a player\'s car', words: ['fix a car', 'fix car', 'repair a car', 'repair car', 'repair'] },
  { id: 'message', command: 'message', title: 'Message one player', words: ['message a player', 'send a message to', 'dm', 'whisper', 'tell'] },
  { id: 'weather', command: 'weather', title: 'Change the weather', words: ['make it rain', 'make it snow', 'make it sunny', 'make it stormy', 'make it foggy', 'change the weather', 'set weather', 'rain', 'snow', 'sunny', 'storm', 'thunder', 'fog', 'clear skies'] },
  { id: 'time', command: 'time', title: 'Change the time of day', words: ['make it night', 'make it day', 'make it morning', 'change the time', 'set time', 'night', 'midnight', 'morning', 'noon', 'sunset', 'sunrise'] },
  { id: 'backup', command: 'backup', title: 'Back up everything', words: ['make a backup', 'back up now', 'backup now', 'back up', 'save everything'] },
  { id: 'install', command: 'install', title: 'Add a script', words: ['add a script', 'install a script', 'add script', 'add a resource', 'add resource', 'new script'] },
  { id: 'ensure', command: 'ensure', title: 'Restart one script', words: ['restart a script', 'restart script', 'reload a script', 'reload script', 'refresh a script'] },
  { id: 'start-script', command: 'start-script', title: 'Start a script', words: ['start a script', 'start script', 'turn on a script'] },
  { id: 'stop-script', command: 'stop-script', title: 'Stop a script', words: ['stop a script', 'stop script', 'turn off a script'] },
  { id: 'clearcars', command: 'clearcars', title: 'Clear empty cars', words: ['clear the streets', 'clear cars', 'delete cars', 'remove cars', 'clean up cars'] },
  { id: 'open-players', command: 'open', title: 'Open Players', words: ['open players', 'go to players', 'manage players'] },
  { id: 'open-city', command: 'open', title: 'Open City', words: ['open city', 'go to city', 'whitelist', 'city'] },
  { id: 'open-resources', command: 'open', title: 'Open Resources', words: ['open resources', 'go to resources', 'my scripts', 'scripts', 'resources'] },
  { id: 'open-files', command: 'open', title: 'Open Files', words: ['open files', 'go to files', 'edit a file', 'server.cfg', 'files', 'config'] },
  { id: 'open-backups', command: 'open', title: 'Open Backups', words: ['open backups', 'go to backups', 'restore a backup', 'restore', 'backups', 'undo a change'] },
  { id: 'open-health', command: 'open', title: 'Open Health', words: ['open health', 'go to health', 'whats wrong', 'check the server', 'health', 'problems', 'friends cant join'] },
  { id: 'open-stats', command: 'open', title: 'Open Stats', words: ['open stats', 'statistics', 'graphs', 'charts', 'stats'] },
  { id: 'open-console', command: 'open', title: 'Open the console', words: ['open console', 'open the console', 'full log', 'console', 'logs', 'log'] },
  { id: 'open-settings', command: 'open', title: 'Open Settings', words: ['open settings', 'go to settings', 'preferences', 'options', 'settings', 'schedule'] },
  { id: 'open-learn', command: 'help', title: 'Learn the basics', words: ['how do i', 'learn the basics', 'learn', 'glossary'] },
  { id: 'tour', command: 'tour', title: 'Take the tour', words: ['take the tour', 'show me around', 'tour'] },
];

/** Actions that fit what was typed, best first. */
export function matchActions<T extends Matchable>(actions: T[], text: string, limit = 6): Match<T>[] {
  return actions
    .map((a) => scoreAction(a, text))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------- players
export const playerName = (p: Player) => p.character?.trim() || p.name;

/**
 * The online player someone means ("tommy", "briggs", "12" for ID 12, "tom b"), and what's left
 * of the text after their name. Only a clear match counts.
 */
export function findPlayer(text: string, players: Player[]): { player: Player | null; rest: string } {
  const q = normalize(text);
  if (!q || players.length === 0) return { player: null, rest: q };
  const tokens = q.split(' ');
  // An ID: "12" or "id 12".
  const idAt = tokens[0] === 'id' ? 1 : 0;
  if (/^\d+$/.test(tokens[idAt] || '')) {
    const byId = players.find((p) => p.id === Number(tokens[idAt]));
    if (byId) return { player: byId, rest: tokens.slice(idAt + 1).join(' ') };
  }
  let best: { player: Player; used: number; score: number } | null = null;
  let tie = false;
  for (const p of players) {
    let mine: { used: number; score: number } | null = null;
    const names = [playerName(p), p.name].map((n) => normalize(n).split(' ').filter(Boolean));
    for (const words of names) {
      // How many of the first typed words each start a word of this name, in order.
      let used = 0;
      let wi = 0;
      while (used < tokens.length && wi < words.length) {
        const t = tokens[used];
        const at = words.slice(wi).findIndex((w) => t.length >= 2 && w.startsWith(t));
        if (at < 0) break;
        wi += at + 1;
        used += 1;
      }
      if (!used) continue;
      const exact = words.some((w) => w === tokens[0]);
      const score = used * 10 + (exact ? 5 : 0) + tokens.slice(0, used).join('').length / 10;
      if (!mine || score > mine.score) mine = { used, score };
    }
    if (!mine) continue;
    if (!best || mine.score > best.score) { best = { player: p, ...mine }; tie = false; } else if (mine.score === best.score) tie = true;
  }
  // Two different players fitting just as well isn't a clear match.
  if (!best || tie) return { player: null, rest: q };
  return { player: best.player, rest: tokens.slice(best.used).join(' ') };
}

// ---------------------------------------------------------------- items, numbers, cars
export function firstNumber(text: string): number | null {
  const m = normalize(text).match(/(?:^|\s)(\d{1,7})(?:\s|$)/);
  return m ? Number(m[1]) : null;
}

export interface Named { name: string; label: string }

/** An item (or car) from the server's own list, by its name or label: "bandage", "water bottle". */
export function findNamed<T extends Named>(text: string, list: T[]): T | null {
  const q = normalize(text).replace(/(?:^|\s)\d+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || !list.length) return null;
  const exact = list.find((i) => normalize(i.name) === q || normalize(i.label) === q);
  if (exact) return exact;
  const words = q.split(' ');
  let best: { item: T; score: number } | null = null;
  for (const item of list) {
    const label = normalize(item.label);
    const name = normalize(item.name);
    let score = 0;
    if (label.startsWith(q) || name.startsWith(q.replace(/ /g, '_'))) score = 3;
    else if (label.includes(q) || name.includes(q.replace(/ /g, '_'))) score = 2;
    else if (words.every((w) => label.includes(w) || name.includes(w))) score = 1;
    if (score && (!best || score > best.score || (score === best.score && label.length < normalize(best.item.label).length))) best = { item, score };
  }
  return best?.item || null;
}

/**
 * The end of what was typed, in its own capitals: messages and reasons keep their case even though
 * matching works on lower case ("announce Car meet" → "Car meet").
 */
export function keepCase(raw: string, rest: string): string {
  const clean = String(raw || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
  return rest && clean.toLowerCase().endsWith(rest) ? clean.slice(clean.length - rest.length) : rest;
}

/** "for spamming" → "spamming". */
export const reasonFrom = (text: string) => normalize(text).replace(/^(for|because|reason:?)\s+/, '').trim();

// ---------------------------------------------------------------- weather and time
const WEATHER_WORDS: [RegExp, string][] = [
  [/\b(extra ?sunny|sunny|sun|sunshine|hot)\b/, 'EXTRASUNNY'],
  [/\bclear\b/, 'CLEAR'],
  [/\bovercast\b/, 'OVERCAST'],
  [/\bcloud(s|y)?\b/, 'CLOUDS'],
  [/\b(thunder|storm|stormy|lightning)\b/, 'THUNDER'],
  [/\b(rain|rainy|raining|wet)\b/, 'RAIN'],
  [/\b(fog|foggy|mist)\b/, 'FOGGY'],
  [/\bsmog\b/, 'SMOG'],
  [/\bblizzard\b/, 'BLIZZARD'],
  [/\b(snow|snowy|snowing)\b/, 'SNOWLIGHT'],
  [/\b(xmas|christmas)\b/, 'XMAS'],
  [/\bhalloween\b/, 'HALLOWEEN'],
];

export function weatherFrom(text: string): string | null {
  const q = normalize(text);
  for (const [re, id] of WEATHER_WORDS) if (re.test(q)) return id;
  return null;
}

const TIME_WORDS: [RegExp, number][] = [
  [/\bmidnight\b/, 0], [/\b(sunrise|dawn)\b/, 6], [/\bmorning\b/, 9], [/\b(noon|midday|day ?time|daytime|day)\b/, 12],
  [/\bafternoon\b/, 15], [/\b(sunset|dusk)\b/, 19], [/\bevening\b/, 20], [/\b(night|night ?time|nighttime|dark)\b/, 22],
];

/** An hour of the day from "night", "noon", "14", "2pm", "14:30". */
export function timeFrom(text: string): { hour: number; minute: number } | null {
  const q = normalize(text);
  const clock = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (clock[3] === 'pm' && hour < 12) hour += 12;
    if (clock[3] === 'am' && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }
  for (const [re, hour] of TIME_WORDS) if (re.test(q)) return { hour, minute: 0 };
  return null;
}

/** Minutes from "in 5 minutes", "5m", "in 15". */
export function minutesFrom(text: string): number | null {
  const m = normalize(text).match(/\b(\d{1,3})\s*(m|min|mins|minute|minutes)?\b/);
  return m ? Number(m[1]) : null;
}

/** Hours for a ban: "1 day", "12h", "a week"; null for permanent. */
export function banHoursFrom(text: string): number | null {
  const q = normalize(text);
  if (/\b(perm|permanent|forever)\b/.test(q)) return null;
  const m = q.match(/\b(\d{1,4}|a|an|one)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unit = m[2][0];
  return unit === 'h' ? n : unit === 'd' ? n * 24 : n * 24 * 7;
}

/** A GitHub address in what was typed, for adding a script from it. */
export function githubUrlFrom(text: string): string | null {
  const m = String(text || '').match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+[^\s]*/i);
  return m ? m[0] : null;
}
