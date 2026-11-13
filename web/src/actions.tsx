// Everything Home's command box and its cards can do: what each action asks for, how it runs, and
// what it says afterwards. What someone typed is understood in commands.ts.
import {
  Archive, BarChart3, BookOpen, Boxes, Building2, Car, CloudRain, FolderOpen, HeartPulse, Map as MapIcon, Megaphone, MessageSquare,
  Package, PackagePlus, Play, Power, RotateCw, Settings as SettingsIcon, ShieldBan, Sparkles, Square, Sun, Terminal, Trash2,
  UserMinus, Users, Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { api, type Player, type Resource, type Shared } from './api';
import {
  banHoursFrom, findNamed, findPlayer, firstNumber, githubUrlFrom, keepCase, minutesFrom, normalize, playerName, reasonFrom,
  timeFrom, VOCABULARY, weatherFrom, type Matchable,
} from './commands';
import { openAddResource } from './nav';
import { startTour } from './Tour';

export type Mode = 'simple' | 'pro';

/** What the actions know about the server right now. */
export interface Ctx {
  players: Player[];
  shared: Shared | null;
  resources: Resource[];
  online: boolean;
  hosted: boolean;
  local: boolean;
  canPower: boolean;
  playerCount: number;
  mode: Mode;
}

export type Value = string | number | boolean | undefined;
export type Values = Record<string, Value>;

export type FieldDef =
  | { key: string; kind: 'text'; label: string; placeholder?: string; multiline?: boolean; max?: number; optional?: boolean }
  | { key: string; kind: 'player'; label: string; everyone?: boolean }
  | { key: string; kind: 'pick'; label: string; source: 'items' | 'vehicles' | 'resources'; placeholder?: string }
  | { key: string; kind: 'number'; label: string; min: number; max: number }
  | { key: string; kind: 'toggle'; label: string; help?: string }
  | { key: string; kind: 'choice'; label: string; options: { value: string; label: string }[] };

/** What a finished action says, as a block on Home. Kept in this browser's storage, so plain data. */
export interface Outcome {
  ok: boolean;
  title: string;
  detail?: string;
  table?: { head: string[]; rows: string[][] };
  links?: { label: string; go: string }[];
}

export interface ActionDef extends Matchable {
  icon: ReactNode;
  /** One plain line about what it does. */
  hint: string;
  /** How to type it in full, shown as you type: "kick <player> [reason]". */
  usage: string;
  fields?: FieldDef[];
  needsOnline?: boolean;
  danger?: boolean;
  /** Runs as soon as it has what it needs: always, or only in Pro mode. */
  instant?: 'always' | 'pro';
  /** Shown only in Pro mode's lists (still found by typing). */
  pro?: boolean;
  defaults?: (ctx: Ctx) => Values;
  parse?: (rest: string, ctx: Ctx, raw: string) => Values;
  /** Another action that fits better ("restart qb-garages" is a script, not the server). */
  redirect?: (rest: string, ctx: Ctx) => string | null;
  /** What's still needed, in plain words, or null when it can run. */
  missing?: (v: Values, ctx: Ctx) => string | null;
  confirm?: (v: Values, ctx: Ctx) => { title: string; body: string; confirm: string } | null;
  button?: (v: Values, ctx: Ctx) => string;
  /** A place to go instead of something to run. */
  go?: (v: Values) => void;
  run?: (v: Values, ctx: Ctx) => Promise<Outcome>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const words = (id: string) => {
  const found = VOCABULARY.find((v) => v.id === id);
  if (!found) throw new Error(`Unknown action ${id}`);
  return found;
};
const playerOf = (v: Values, ctx: Ctx) => ctx.players.find((p) => p.id === Number(v.player)) || null;
const whoOf = (v: Values, ctx: Ctx) => {
  const p = playerOf(v, ctx);
  return p ? playerName(p) : 'the player';
};
const needPlayer = (v: Values, ctx: Ctx) => (v.player === 'all' || playerOf(v, ctx) ? null : 'Choose a player');
const resourceNamed = (text: string, ctx: Ctx) => {
  const q = normalize(text).split(' ')[0];
  return q ? ctx.resources.find((r) => r.name.toLowerCase() === q) || null : null;
};
/** "tommy for spamming" → the player and "for spamming" in its own capitals. */
const playerAndRest = (rest: string, ctx: Ctx, raw: string) => {
  const found = findPlayer(rest, ctx.players);
  return { player: found.player?.id, text: keepCase(raw, found.rest) };
};

export const WEATHER_OPTIONS = [
  { value: 'EXTRASUNNY', label: 'Sunny' }, { value: 'CLEAR', label: 'Clear' }, { value: 'CLOUDS', label: 'Cloudy' },
  { value: 'OVERCAST', label: 'Overcast' }, { value: 'RAIN', label: 'Rain' }, { value: 'THUNDER', label: 'Storm' },
  { value: 'FOGGY', label: 'Fog' }, { value: 'SMOG', label: 'Smog' }, { value: 'SNOWLIGHT', label: 'Light snow' },
  { value: 'BLIZZARD', label: 'Blizzard' }, { value: 'XMAS', label: 'Christmas' }, { value: 'HALLOWEEN', label: 'Halloween' },
];
const weatherLabel = (id: Value) => WEATHER_OPTIONS.find((w) => w.value === id)?.label || String(id);
const clockText = (hour: number, minute = 0) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

const page = (id: string, title: string, icon: ReactNode, hint: string, hash: string): ActionDef => ({
  ...words(id), title, icon, hint, usage: words(id).words[0] || title, go: () => { window.location.hash = hash; },
});

export const ACTIONS: ActionDef[] = [
  {
    ...words('announce'),
    icon: <Megaphone size={16} />,
    hint: 'On every player\'s screen',
    usage: 'announce <message>',
    needsOnline: true,
    instant: 'pro',
    fields: [
      { key: 'message', kind: 'text', label: 'Message', multiline: true, max: 240, placeholder: 'What should everyone see?' },
      { key: 'big', kind: 'toggle', label: 'Big banner', help: 'At the top of the screen, with a timer. Off: a small message instead.' },
    ],
    defaults: () => ({ big: true }),
    parse: (rest, _ctx, raw) => (rest ? { message: keepCase(raw, rest) } : {}),
    missing: (v) => (String(v.message || '').trim() ? null : 'Type the message'),
    button: (_v, ctx) => (ctx.playerCount ? `Send to ${plural(ctx.playerCount, 'player')}` : 'Send'),
    run: async (v) => {
      const text = String(v.message).trim();
      const r = v.big ? await api.banner('Announcement', text, 10, false) : await api.announce(text);
      return { ok: true, title: `Shown to ${plural(r.players, 'player')}`, detail: text };
    },
  },
  {
    ...words('players'),
    icon: <Users size={16} />,
    hint: 'Names, jobs and ping',
    usage: 'players',
    needsOnline: true,
    instant: 'always',
    run: async () => {
      const list = await api.players();
      if (!list.length) return { ok: true, title: 'Nobody is in the city right now', links: [{ label: 'Let friends join', go: 'health' }] };
      return {
        ok: true,
        title: `${plural(list.length, 'player')} in the city`,
        table: {
          head: ['Player', 'Job', 'Ping'],
          rows: list.slice(0, 12).map((p) => [playerName(p), p.job ? `${p.job.label}${p.job.gradeName ? ` · ${p.job.gradeName}` : ''}` : 'Choosing a character', `${p.ping} ms`]),
        },
        links: [{ label: list.length > 12 ? `See all ${list.length} in Players` : 'Open Players', go: 'players' }],
      };
    },
  },
  {
    ...words('restart'),
    icon: <RotateCw size={16} />,
    hint: 'Players are warned first',
    usage: 'restart [in 5 minutes]',
    redirect: (rest, ctx) => (resourceNamed(rest, ctx) ? 'ensure' : null),
    fields: [{ key: 'when', kind: 'choice', label: 'When', options: [{ value: 'now', label: 'Now' }, { value: '5', label: 'In 5 minutes' }, { value: '15', label: 'In 15 minutes' }] }],
    defaults: (ctx) => ({ when: ctx.playerCount > 0 ? '5' : 'now' }),
    parse: (rest) => {
      const m = minutesFrom(rest);
      return m ? { when: m >= 10 ? '15' : '5' } : /\bnow\b/.test(rest) ? { when: 'now' } : {};
    },
    danger: true,
    confirm: (v, ctx) => (v.when === 'now' && ctx.playerCount > 0
      ? { title: 'Restart the server now?', body: `${plural(ctx.playerCount, 'player')} ${ctx.playerCount === 1 ? 'is' : 'are'} online. Their progress is saved, then they're disconnected.`, confirm: 'Restart now' }
      : null),
    missing: (_v, ctx) => (ctx.online || ctx.canPower ? null : 'The server isn\'t running, and your host\'s panel controls starting it'),
    button: (v) => (v.when === 'now' ? 'Restart now' : `Restart in ${v.when} minutes`),
    run: async (v) => {
      if (v.when === 'now') {
        await api.restart();
        return { ok: true, title: 'The server restarted', detail: 'Players can join again.' };
      }
      const r = await api.restartLater(Number(v.when));
      return { ok: true, title: `The server restarts at ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, detail: 'Players are warned at 15, 5 and 1 minutes. You can cancel it on Home.' };
    },
  },
  {
    ...words('start'),
    icon: <Play size={16} />,
    hint: 'Turn the server on',
    usage: 'start',
    redirect: (rest, ctx) => (resourceNamed(rest, ctx) ? 'start-script' : null),
    instant: 'always',
    missing: (_v, ctx) => (!ctx.canPower ? 'Start the server from your host\'s panel' : ctx.online ? 'The server is already running' : null),
    run: async () => {
      await api.start();
      return { ok: true, title: 'Your server is online', detail: 'Players can join now.' };
    },
  },
  {
    ...words('stop'),
    icon: <Square size={15} />,
    hint: 'Saves players, then turns it off',
    usage: 'stop',
    redirect: (rest, ctx) => (resourceNamed(rest, ctx) ? 'stop-script' : null),
    danger: true,
    confirm: (_v, ctx) => ({
      title: 'Stop the server?',
      body: `${ctx.playerCount ? `${plural(ctx.playerCount, 'player')} ${ctx.playerCount === 1 ? 'is' : 'are'} online. Their progress is saved, then they're disconnected. ` : ''}${ctx.hosted ? 'Your host stops the server.' : 'txAdmin stops too.'} Use Start to bring it back.`,
      confirm: 'Stop server',
    }),
    missing: (_v, ctx) => (!ctx.canPower ? 'Stop the server from your host\'s panel' : null),
    button: () => 'Stop the server',
    run: async () => {
      await api.stop();
      return { ok: true, title: 'The server is stopped', detail: 'Use Start whenever you\'re ready.' };
    },
  },
  {
    ...words('kick'),
    icon: <UserMinus size={16} />,
    hint: 'They can join again',
    usage: 'kick <player> [reason]',
    needsOnline: true,
    danger: true,
    fields: [{ key: 'player', kind: 'player', label: 'Player' }, { key: 'reason', kind: 'text', label: 'Reason they see', optional: true, max: 200, placeholder: 'Please read the rules in Discord' }],
    parse: (rest, ctx, raw) => {
      const { player, text } = playerAndRest(rest, ctx, raw);
      return { player, reason: text ? keepCase(raw, reasonFrom(text)) : undefined };
    },
    missing: needPlayer,
    confirm: (v, ctx) => ({ title: `Kick ${whoOf(v, ctx)}?`, body: 'They\'re disconnected, and can join again whenever they like.', confirm: 'Kick' }),
    button: (v, ctx) => `Kick ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      const who = whoOf(v, ctx);
      await api.playerAction(Number(v.player), 'kick', { reason: String(v.reason || '').trim() || undefined });
      return { ok: true, title: `${who} was kicked`, detail: v.reason ? `Reason: ${v.reason}` : undefined };
    },
  },
  {
    ...words('ban'),
    icon: <ShieldBan size={16} />,
    hint: 'For a while, or for good',
    usage: 'ban <player> [1 day] [reason]',
    needsOnline: true,
    danger: true,
    pro: true,
    fields: [
      { key: 'player', kind: 'player', label: 'Player' },
      { key: 'hours', kind: 'choice', label: 'How long', options: [{ value: '24', label: '1 day' }, { value: '168', label: '1 week' }, { value: '720', label: '30 days' }, { value: 'forever', label: 'For good' }] },
      { key: 'reason', kind: 'text', label: 'Reason they see', optional: true, max: 200, placeholder: 'Cheating' },
    ],
    defaults: () => ({ hours: '24' }),
    parse: (rest, ctx, raw) => {
      const { player, text } = playerAndRest(rest, ctx, raw);
      const hours = banHoursFrom(text);
      const forever = /\b(perm|permanent|forever)\b/.test(text);
      const reason = text.replace(/\b(\d{1,4}|a|an|one)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/i, '').replace(/\b(perm|permanent|forever)\b/i, '').trim();
      return { player, hours: forever ? 'forever' : hours ? String(hours) : undefined, reason: reason ? reasonFrom(reason) : undefined };
    },
    missing: needPlayer,
    confirm: (v, ctx) => ({ title: `Ban ${whoOf(v, ctx)}?`, body: v.hours === 'forever' ? 'They can\'t join again unless you unban them on the Players page.' : `They can't join for ${Number(v.hours) >= 24 ? plural(Math.round(Number(v.hours) / 24), 'day') : plural(Number(v.hours), 'hour')}. You can unban them on the Players page.`, confirm: 'Ban' }),
    button: (v, ctx) => `Ban ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      const who = whoOf(v, ctx);
      await api.playerAction(Number(v.player), 'ban', { reason: String(v.reason || '').trim() || undefined, hours: v.hours === 'forever' ? undefined : Number(v.hours) });
      return { ok: true, title: `${who} was banned`, detail: v.reason ? `Reason: ${v.reason}` : undefined, links: [{ label: 'See bans', go: 'players' }] };
    },
  },
  {
    ...words('revive'),
    icon: <HeartPulse size={16} />,
    hint: 'Bring a downed player back',
    usage: 'revive <player | everyone>',
    needsOnline: true,
    instant: 'pro',
    fields: [{ key: 'player', kind: 'player', label: 'Who', everyone: true }],
    parse: (rest, ctx, raw) => (/\b(everyone|all|everybody)\b/.test(normalize(raw)) ? { player: 'all' } : { player: findPlayer(rest, ctx.players).player?.id }),
    missing: needPlayer,
    button: (v, ctx) => (v.player === 'all' ? 'Revive everyone' : `Revive ${whoOf(v, ctx)}`),
    run: async (v, ctx) => {
      if (v.player === 'all') {
        const r = await api.reviveAll();
        return { ok: true, title: `Revived ${plural(r.revived, 'player')}` };
      }
      const r = await api.playerAction(Number(v.player), 'revive');
      return { ok: true, title: `${whoOf(v, ctx)} was revived`, detail: r.message };
    },
  },
  {
    ...words('heal'),
    icon: <Sparkles size={16} />,
    hint: 'Full health, wounds cleared',
    usage: 'heal <player>',
    needsOnline: true,
    instant: 'pro',
    pro: true,
    fields: [{ key: 'player', kind: 'player', label: 'Player' }],
    parse: (rest, ctx) => ({ player: findPlayer(rest, ctx.players).player?.id }),
    missing: needPlayer,
    button: (v, ctx) => `Heal ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      await api.playerAction(Number(v.player), 'heal');
      return { ok: true, title: `${whoOf(v, ctx)} was healed` };
    },
  },
  {
    ...words('give'),
    icon: <Package size={16} />,
    hint: 'Straight into their inventory',
    usage: 'give <player> <item> [amount]',
    needsOnline: true,
    instant: 'pro',
    fields: [
      { key: 'player', kind: 'player', label: 'Player' },
      { key: 'item', kind: 'pick', label: 'Item', source: 'items', placeholder: 'Start typing an item' },
      { key: 'amount', kind: 'number', label: 'How many', min: 1, max: 1000 },
    ],
    defaults: () => ({ amount: 1 }),
    parse: (rest, ctx) => {
      const found = findPlayer(rest, ctx.players);
      const item = findNamed(found.rest, ctx.shared?.items || []);
      return { player: found.player?.id, item: item?.name, amount: firstNumber(found.rest) ?? undefined };
    },
    missing: (v, ctx) => needPlayer(v, ctx) || (v.item ? null : 'Choose an item'),
    button: (v, ctx) => `Give to ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      const label = ctx.shared?.items.find((i) => i.name === v.item)?.label || String(v.item);
      await api.playerAction(Number(v.player), 'giveItem', { item: v.item, amount: Number(v.amount) || 1 });
      return { ok: true, title: `Gave ${Number(v.amount) || 1} × ${label} to ${whoOf(v, ctx)}` };
    },
  },
  {
    ...words('car'),
    icon: <Car size={16} />,
    hint: 'With keys and a full tank',
    usage: 'car <player> <model>',
    needsOnline: true,
    instant: 'pro',
    fields: [{ key: 'player', kind: 'player', label: 'Player' }, { key: 'model', kind: 'pick', label: 'Car', source: 'vehicles', placeholder: 'adder, sultan, police...' }],
    parse: (rest, ctx) => {
      const found = findPlayer(rest, ctx.players);
      const list = (ctx.shared?.vehicles || []).map((c) => ({ name: c.model, label: c.name }));
      const car = findNamed(found.rest, list);
      const typed = normalize(found.rest).split(' ')[0];
      return { player: found.player?.id, model: car?.name || (/^[a-z0-9_]{2,}$/.test(typed || '') ? typed : undefined) };
    },
    missing: (v, ctx) => needPlayer(v, ctx) || (v.model ? null : 'Choose a car'),
    button: (v, ctx) => `Spawn for ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      const r = await api.playerAction(Number(v.player), 'spawnCar', { model: v.model });
      return { ok: true, title: `${String(v.model)} spawned for ${whoOf(v, ctx)}`, detail: r.message };
    },
  },
  {
    ...words('fixcar'),
    icon: <Wrench size={16} />,
    hint: 'Repair the car they\'re in or next to',
    usage: 'fixcar <player>',
    needsOnline: true,
    instant: 'pro',
    pro: true,
    fields: [{ key: 'player', kind: 'player', label: 'Player' }],
    parse: (rest, ctx) => ({ player: findPlayer(rest, ctx.players).player?.id }),
    missing: needPlayer,
    button: (v, ctx) => `Fix ${whoOf(v, ctx)}'s car`,
    run: async (v, ctx) => {
      await api.playerAction(Number(v.player), 'fixCar');
      return { ok: true, title: `${whoOf(v, ctx)}'s car was repaired` };
    },
  },
  {
    ...words('message'),
    icon: <MessageSquare size={16} />,
    hint: 'A message only they see',
    usage: 'message <player> <text>',
    needsOnline: true,
    instant: 'pro',
    fields: [{ key: 'player', kind: 'player', label: 'Player' }, { key: 'message', kind: 'text', label: 'Message', max: 200, placeholder: 'Meet me at the police station' }],
    parse: (rest, ctx, raw) => {
      const { player, text } = playerAndRest(rest, ctx, raw);
      return { player, message: text || undefined };
    },
    missing: (v, ctx) => needPlayer(v, ctx) || (String(v.message || '').trim() ? null : 'Type the message'),
    button: (v, ctx) => `Send to ${whoOf(v, ctx)}`,
    run: async (v, ctx) => {
      await api.playerAction(Number(v.player), 'notify', { message: String(v.message).trim() });
      return { ok: true, title: `Sent to ${whoOf(v, ctx)}`, detail: String(v.message) };
    },
  },
  {
    ...words('weather'),
    icon: <CloudRain size={16} />,
    hint: 'Rain, snow, fog or sunshine',
    usage: 'weather <rain | snow | sunny | ...>',
    needsOnline: true,
    instant: 'always',
    fields: [{ key: 'weather', kind: 'choice', label: 'Weather', options: WEATHER_OPTIONS }],
    parse: (rest, _ctx, raw) => {
      const w = weatherFrom(rest) || weatherFrom(raw);
      return w ? { weather: w } : {};
    },
    missing: (v) => (v.weather ? null : 'Choose the weather'),
    button: (v) => `Make it ${weatherLabel(v.weather).toLowerCase()}`,
    run: async (v) => {
      await api.setWorld({ weather: String(v.weather) });
      return { ok: true, title: `The weather is now ${weatherLabel(v.weather).toLowerCase()}`, links: [{ label: 'More in City', go: 'city' }] };
    },
  },
  {
    ...words('time'),
    icon: <Sun size={16} />,
    hint: 'Morning, noon or night',
    usage: 'time <night | noon | 14:30>',
    needsOnline: true,
    instant: 'always',
    fields: [{ key: 'hour', kind: 'choice', label: 'Time', options: [{ value: '6', label: 'Sunrise' }, { value: '9', label: 'Morning' }, { value: '12', label: 'Noon' }, { value: '19', label: 'Sunset' }, { value: '22', label: 'Night' }, { value: '0', label: 'Midnight' }] }],
    parse: (rest, _ctx, raw) => {
      const t = timeFrom(rest) || timeFrom(raw);
      return t ? { hour: String(t.hour), minute: t.minute } : {};
    },
    missing: (v) => (v.hour !== undefined && v.hour !== '' ? null : 'Choose a time'),
    button: (v) => `Set to ${clockText(Number(v.hour), Number(v.minute) || 0)}`,
    run: async (v) => {
      await api.setWorld({ hour: Number(v.hour), minute: Number(v.minute) || 0 });
      return { ok: true, title: `It's now ${clockText(Number(v.hour), Number(v.minute) || 0)} in the city` };
    },
  },
  {
    ...words('backup'),
    icon: <Archive size={16} />,
    hint: 'Players, settings and scripts',
    usage: 'backup',
    instant: 'always',
    run: async (_v, ctx) => {
      if (ctx.hosted) {
        const r = await api.createDatabaseBackup();
        return { ok: true, title: 'Your database is backed up on this PC', detail: r.tables ? `${plural(r.tables, 'table')} copied.` : undefined, links: [{ label: 'Open Backups', go: 'backups' }] };
      }
      const b = await api.createBackup();
      const size = b.size >= 1024 ** 3 ? `${(b.size / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b.size / 1024 ** 2))} MB`;
      return { ok: true, title: 'Everything is backed up', detail: `${size}: ${b.parts.join(', ')}.`, links: [{ label: 'Open Backups', go: 'backups' }] };
    },
  },
  {
    ...words('install'),
    icon: <PackagePlus size={16} />,
    hint: 'From a zip, a folder or GitHub',
    usage: 'install [GitHub link]',
    parse: (_rest, _ctx, raw) => ({ url: githubUrlFrom(raw) || undefined }),
    go: (v) => openAddResource(String(v.url || '')),
  },
  {
    ...words('ensure'),
    icon: <RotateCw size={16} />,
    hint: 'Stop and start one script, then check it',
    usage: 'ensure <script>',
    needsOnline: true,
    instant: 'pro',
    pro: true,
    fields: [{ key: 'resource', kind: 'pick', label: 'Script', source: 'resources', placeholder: 'Start typing a script name' }],
    parse: (rest, ctx) => {
      const r = resourceNamed(rest, ctx) || findNamed(rest, ctx.resources.map((x) => ({ name: x.name, label: x.name })));
      return r ? { resource: r.name } : {};
    },
    missing: (v) => (v.resource ? null : 'Choose a script'),
    button: (v) => `Restart ${v.resource}`,
    run: async (v) => {
      const r = await api.restartChecked(String(v.resource));
      if (r.ok) return { ok: true, title: `${v.resource} restarted`, detail: r.problems.length ? `${plural(r.problems.length, 'warning')} while starting.` : 'It started without problems.' };
      return { ok: false, title: `${v.resource} didn't start`, detail: r.problems[0]?.title || `It's ${r.state} now.`, links: [{ label: 'Open the script', go: 'resources' }] };
    },
  },
  {
    ...words('start-script'),
    icon: <Play size={16} />,
    hint: 'Turn one script on',
    usage: 'start <script>',
    needsOnline: true,
    instant: 'pro',
    pro: true,
    fields: [{ key: 'resource', kind: 'pick', label: 'Script', source: 'resources' }],
    parse: (rest, ctx) => ({ resource: resourceNamed(rest, ctx)?.name }),
    missing: (v) => (v.resource ? null : 'Choose a script'),
    button: (v) => `Start ${v.resource}`,
    run: async (v) => {
      const r = await api.resourceAction(String(v.resource), 'start');
      return { ok: r.state === 'started', title: r.state === 'started' ? `${v.resource} started` : `${v.resource} is ${r.state}` };
    },
  },
  {
    ...words('stop-script'),
    icon: <Power size={16} />,
    hint: 'Turn one script off until the next restart',
    usage: 'stop <script>',
    needsOnline: true,
    danger: true,
    pro: true,
    fields: [{ key: 'resource', kind: 'pick', label: 'Script', source: 'resources' }],
    parse: (rest, ctx) => ({ resource: resourceNamed(rest, ctx)?.name }),
    missing: (v) => (v.resource ? null : 'Choose a script'),
    confirm: (v) => ({ title: `Stop ${v.resource}?`, body: 'Anything that needs it stops working until it starts again. It starts again at the next restart, unless you turn that off on the Resources page.', confirm: 'Stop it' }),
    button: (v) => `Stop ${v.resource}`,
    run: async (v) => {
      const r = await api.resourceAction(String(v.resource), 'stop');
      return { ok: true, title: `${v.resource} is ${r.state === 'stopped' ? 'stopped' : r.state}` };
    },
  },
  {
    ...words('clearcars'),
    icon: <Trash2 size={16} />,
    hint: 'Removes cars nobody is in',
    usage: 'clearcars [in 60 seconds]',
    needsOnline: true,
    danger: true,
    pro: true,
    fields: [{ key: 'seconds', kind: 'choice', label: 'When', options: [{ value: '60', label: 'In 1 minute, with a countdown' }, { value: '0', label: 'Now' }] }],
    defaults: () => ({ seconds: '60' }),
    confirm: (v) => (v.seconds === '0' ? { title: 'Clear empty cars now?', body: 'Every car nobody is sitting in disappears, including parked ones out on the street.', confirm: 'Clear them' } : null),
    button: (v) => (v.seconds === '0' ? 'Clear now' : 'Start the countdown'),
    run: async (v) => {
      const r = await api.clearVehicles(Number(v.seconds));
      return r.scheduled ? { ok: true, title: 'Empty cars are cleared in 1 minute', detail: 'Everyone sees a countdown.' } : { ok: true, title: `${plural(r.removed || 0, 'empty car')} cleared` };
    },
  },
  page('open-players', 'Open Players', <Users size={16} />, 'Help the people who are on', 'players'),
  page('open-city', 'Open City', <Building2 size={16} />, 'Weather, time, events and the whitelist', 'city'),
  page('open-resources', 'Open Resources', <Boxes size={16} />, 'Your scripts', 'resources'),
  page('open-files', 'Open Files', <FolderOpen size={16} />, 'Edit any server file', 'files'),
  page('open-backups', 'Open Backups', <Archive size={16} />, 'Restore, and undo changes', 'backups'),
  page('open-health', 'Open Health', <HeartPulse size={16} />, 'Checks, and letting friends join', 'health'),
  page('open-stats', 'Open Stats', <BarChart3 size={16} />, 'Players, CPU and memory over time', 'overview'),
  page('open-console', 'Open the console', <Terminal size={16} />, 'The server\'s full live log', 'console'),
  page('open-settings', 'Open Settings', <SettingsIcon size={16} />, 'Backups, restarts, phone access', 'settings'),
  page('open-learn', 'Learn the basics', <BookOpen size={16} />, 'How FiveM servers work, in plain words', 'learn'),
  { ...words('tour'), icon: <MapIcon size={16} />, hint: 'A short look around CityHQ', usage: 'tour', go: () => startTour() },
];

export const actionById = (id: string) => ACTIONS.find((a) => a.id === id) || null;

/** The cards on a new user's Home, and the buttons under the command box. */
export const STARTER_IDS = ['announce', 'players', 'install', 'backup', 'weather', 'restart'];
export const POPULAR_IDS: Record<Mode, string[]> = {
  simple: ['announce', 'restart', 'revive', 'give', 'car', 'backup'],
  pro: ['announce', 'restart', 'players', 'give', 'car', 'weather', 'ensure', 'backup'],
};

/** Values from typed text, on top of the action's defaults. Empty ones are left out. */
export function valuesFor(action: ActionDef, rest: string, ctx: Ctx, raw: string): Values {
  const out: Values = { ...(action.defaults?.(ctx) || {}) };
  const parsed = action.parse?.(rest, ctx, raw) || {};
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** Whether it can run straight away, without a form. */
export function runsNow(action: ActionDef, values: Values, ctx: Ctx): boolean {
  if (!action.run || action.danger) return false;
  if (action.instant !== 'always' && !(action.instant === 'pro' && ctx.mode === 'pro')) return false;
  if (action.needsOnline && !ctx.online) return false;
  return !action.missing?.(values, ctx);
}

/** Why it can't run at all right now (as opposed to details still to fill in). */
export function blockedBy(action: ActionDef, ctx: Ctx): string | null {
  if (action.needsOnline && !ctx.online) return 'The server needs to be running first';
  return null;
}
