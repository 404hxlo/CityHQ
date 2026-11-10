import {
  Car, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Cloudy, Factory, Ghost, Gift, HeartPulse,
  Lightbulb, LockKeyhole, Megaphone, Moon, Snowflake, Sun, Sunrise, Sunset, Timer, Trash2, UserPlus,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type KnownPlayer, type World } from '../api';
import {
  Button, Notice, Spinner, Toggle, useAction, useConfirm, usePoll,
} from '../ui';
import { Avatar, PlayerPicker } from '../Visuals';

const WEATHER: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: 'EXTRASUNNY', label: 'Sunny', icon: <Sun size={18} /> },
  { id: 'CLEAR', label: 'Clear', icon: <CloudSun size={18} /> },
  { id: 'CLOUDS', label: 'Cloudy', icon: <Cloud size={18} /> },
  { id: 'OVERCAST', label: 'Overcast', icon: <Cloudy size={18} /> },
  { id: 'RAIN', label: 'Rain', icon: <CloudRain size={18} /> },
  { id: 'THUNDER', label: 'Storm', icon: <CloudLightning size={18} /> },
  { id: 'FOGGY', label: 'Fog', icon: <CloudFog size={18} /> },
  { id: 'SMOG', label: 'Smog', icon: <Factory size={18} /> },
  { id: 'SNOWLIGHT', label: 'Light snow', icon: <Snowflake size={18} /> },
  { id: 'BLIZZARD', label: 'Blizzard', icon: <CloudSnow size={18} /> },
  { id: 'XMAS', label: 'Christmas', icon: <Gift size={18} /> },
  { id: 'HALLOWEEN', label: 'Halloween', icon: <Ghost size={18} /> },
];

const TIMES: { label: string; hour: number; icon: React.ReactNode }[] = [
  { label: 'Sunrise', hour: 6, icon: <Sunrise size={16} /> },
  { label: 'Morning', hour: 9, icon: <Sun size={16} /> },
  { label: 'Noon', hour: 12, icon: <Sun size={16} /> },
  { label: 'Sunset', hour: 19, icon: <Sunset size={16} /> },
  { label: 'Night', hour: 23, icon: <Moon size={16} /> },
];

const pad = (n: number) => String(n).padStart(2, '0');

function WorldCard({ online }: { online: boolean }) {
  const { data, error, setData } = usePoll(api.world, online ? 15000 : 0, [online]);
  const { busy, run } = useAction();
  const [custom, setCustom] = useState('');
  const change = async (key: string, patch: Partial<World>, message: string) => {
    const next = await run(key, () => api.setWorld(patch), message);
    if (next) setData(next);
  };
  if (!online) return null;
  if (error && !data) return <Notice kind="info">{error}</Notice>;
  if (!data) return <Spinner label="Reading the weather" />;
  return (
    <>
      <div className="weather-grid">
        {WEATHER.map((w) => (
          <button
            key={w.id}
            className={`weather-tile${data.weather === w.id ? ' active' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => change(`w:${w.id}`, { weather: w.id, dynamicWeather: false }, `Weather set to ${w.label.toLowerCase()}`)}
          >
            {w.icon}<span>{w.label}</span>
          </button>
        ))}
      </div>
      <label className="switch-line">
        <Toggle checked={data.dynamicWeather} onChange={(v) => change('dyn', { dynamicWeather: v }, v ? 'Weather changes on its own again' : 'Weather stays as it is')} label="Change weather on its own" />
        <span>Let the weather change on its own every few minutes</span>
      </label>

      <div className="time-row">
        <div className="clock-face" aria-label={`In-game time ${pad(data.hour)}:${pad(data.minute)}`}>{pad(data.hour)}:{pad(data.minute)}</div>
        <div className="time-presets">
          {TIMES.map((t) => (
            <Button key={t.label} icon={t.icon} busy={busy === `t:${t.hour}`} onClick={() => change(`t:${t.hour}`, { hour: t.hour, minute: 0 }, `Time set to ${t.label.toLowerCase()}`)}>{t.label}</Button>
          ))}
        </div>
      </div>
      <div className="input-row">
        <input className="input input-time" type="time" aria-label="Exact time" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <Button
          disabled={!custom}
          busy={busy === 'custom'}
          onClick={() => {
            const [h, m] = custom.split(':').map(Number);
            change('custom', { hour: h, minute: m }, `Time set to ${custom}`);
          }}
        >
          Set time
        </Button>
      </div>
      <label className="switch-line">
        <Toggle checked={data.timeFrozen} onChange={(v) => change('freeze', { timeFrozen: v }, v ? 'Time is frozen' : 'Time moves again')} label="Freeze time" />
        <span>Freeze the clock at the current time</span>
      </label>
      <label className="switch-line">
        <Toggle checked={data.blackout} onChange={(v) => change('blackout', { blackout: v }, v ? 'Blackout across the city' : 'Power is back on')} label="Blackout" />
        <span>Blackout: switch off every light in the city</span>
      </label>
    </>
  );
}

function BannerCard({ online }: { online: boolean }) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('Announcement');
  const [message, setMessage] = useState('');
  const [seconds, setSeconds] = useState(10);
  const [countdown, setCountdown] = useState(false);
  const send = async () => {
    const done = await run('banner', () => api.banner(title.trim(), message.trim(), seconds, countdown), (r) => `Shown to ${r.players} player${r.players === 1 ? '' : 's'}`);
    if (done) setMessage('');
  };
  return (
    <>
      <div className="banner-preview" aria-hidden="true">
        <div className="banner-band">
          <strong>{title.trim() || 'Announcement'}</strong>
          <span>{message.trim() || 'Your message appears here'}</span>
          {countdown && <em>{Math.floor(seconds / 60)}:{pad(seconds % 60)}</em>}
        </div>
      </div>
      <input className="input" maxLength={80} placeholder="Title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input" rows={2} maxLength={240} placeholder="Message, like: Car meet at Legion Square" aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="input-row wrap">
        <select className="input" aria-label="Show for" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
          {[5, 10, 15, 30, 60, 120, 300].map((s) => <option key={s} value={s}>Show for {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}</option>)}
        </select>
        <label className="switch-line">
          <Toggle checked={countdown} onChange={setCountdown} label="Show a countdown" />
          <span>Count down</span>
        </label>
      </div>
      <Button variant="primary" icon={<Megaphone size={15} />} busy={busy === 'banner'} disabled={!online || !message.trim()} onClick={send}>Show to everyone</Button>
    </>
  );
}

function EventsCard({ online }: { online: boolean }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const reviveAll = async () => {
    const ok = await confirm({ title: 'Revive everyone?', body: <p>Every player who is down or dead gets back up with full health.</p>, confirm: 'Revive everyone' });
    if (ok) await run('revive', () => api.reviveAll(), (r) => `Revived ${r.revived} player${r.revived === 1 ? '' : 's'}`);
  };
  const clear = async (seconds: number) => {
    const ok = await confirm({
      title: seconds ? `Clear empty cars in ${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minutes`}?` : 'Clear empty cars now?',
      body: (
        <>
          <p>Every car with nobody in it is removed from the streets. Players get their own cars back from the impound lot.</p>
          {seconds > 0 && <p>Everyone sees a countdown first, so they can get in their cars.</p>}
        </>
      ),
      confirm: 'Clear cars',
      danger: true,
    });
    if (!ok) return;
    await run(`clear:${seconds}`, () => api.clearVehicles(seconds), (r) => (r.scheduled ? `Countdown started. Cars clear in ${r.scheduled} seconds.` : `Removed ${r.removed} empty car${r.removed === 1 ? '' : 's'}`));
  };
  return (
    <div className="event-list">
      <div className="event-row">
        <span className="event-icon tone-green"><HeartPulse size={18} /></span>
        <span className="event-main"><strong>Revive everyone</strong><span className="muted-note">Bring every downed player back with full health.</span></span>
        <Button busy={busy === 'revive'} disabled={!online} onClick={reviveAll}>Revive all</Button>
      </div>
      <div className="event-row">
        <span className="event-icon tone-amber"><Car size={18} /></span>
        <span className="event-main"><strong>Clear empty cars</strong><span className="muted-note">Remove abandoned cars to tidy the streets and help performance.</span></span>
        <div className="button-row">
          <Button icon={<Timer size={15} />} busy={busy === 'clear:30'} disabled={!online} onClick={() => clear(30)}>In 30 s</Button>
          <Button icon={<Timer size={15} />} busy={busy === 'clear:120'} disabled={!online} onClick={() => clear(120)}>In 2 min</Button>
          <Button variant="ghost" icon={<Trash2 size={15} />} busy={busy === 'clear:0'} disabled={!online} onClick={() => clear(0)}>Now</Button>
        </div>
      </div>
    </div>
  );
}

function WhitelistCard() {
  const { data, error, setData } = usePoll(api.whitelist, 0);
  const people = usePoll(api.knownPlayers, 0);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const update = async (key: string, change: Parameters<typeof api.setWhitelist>[0], message: string) => {
    const next = await run(key, () => api.setWhitelist(change), (r) => (r.applied ? message : `${message}. The server gets it the next time it starts.`));
    if (next) setData(next);
  };
  const toggle = async (enabled: boolean) => {
    if (enabled) {
      const ok = await confirm({
        title: 'Turn on the whitelist?',
        body: <><p>Only the players on this list, and your admins, can join. Anyone else is turned away with a message.</p><p>Players who are already online stay connected.</p></>,
        confirm: 'Turn on',
      });
      if (!ok) return;
    }
    await update('toggle', { enabled }, enabled ? 'Whitelist is on' : 'Whitelist is off. Anyone can join.');
  };
  const add = (p: KnownPlayer) => { setAdding(false); update(`add:${p.license}`, { add: { id: p.license, name: p.name } }, `${p.name} can join`); };
  if (error && !data) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Spinner />;
  return (
    <>
      <label className="switch-line">
        <Toggle checked={data.enabled} disabled={busy === 'toggle'} onChange={toggle} label="Whitelist" />
        <span>{data.enabled ? 'On: only people below and your admins can join' : 'Off: anyone can join'}</span>
      </label>
      {data.entries.length > 0 ? (
        <ul className="people-list">
          {data.entries.map((e) => (
            <li key={e.id}>
              <Avatar name={e.name || '?'} size={30} />
              <span className="people-main"><strong>{e.name || 'Unknown player'}</strong></span>
              <Button variant="ghost" busy={busy === `rm:${e.id}`} onClick={() => update(`rm:${e.id}`, { remove: e.id }, `${e.name || 'Player'} removed`)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : <p className="muted-note">Nobody added yet. Admins can always join.</p>}
      {adding ? (
        people.data ? <PlayerPicker players={people.data} exclude={data.entries.map((e) => e.id)} onPick={add} /> : people.error ? <Notice kind="info">{people.error}</Notice> : <Spinner />
      ) : <Button icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Add a player</Button>}
    </>
  );
}

export function City({ online, helperOutdated }: { online: boolean; helperOutdated: boolean }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [players, setPlayers] = useState(0);
  useEffect(() => { api.overview().then((o) => setPlayers(o.status?.players ?? 0)).catch(() => {}); }, [helperOutdated]);
  const restart = async () => {
    const ok = await confirm({
      title: 'Restart the server now?',
      body: <p>{players > 0 ? `${players} player${players === 1 ? ' is' : 's are'} online. Their progress is saved, then they are disconnected.` : 'Nobody is online right now.'}</p>,
      confirm: 'Restart',
    });
    if (ok) await run('restart', () => api.restart(), 'Server restarted. The new controls are on.');
  };
  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>City</h1>
          <p className="muted-note">Change the world for everyone in the city, run events and choose who can join.</p>
        </div>
      </header>

      {!online && <Notice kind="info">Start the server to change the weather, run events and use these controls.</Notice>}
      {online && helperOutdated && (
        <div className="countdown-banner">
          <Lightbulb size={18} />
          <div>
            <strong>Restart the server once to turn these on</strong>
            <div className="muted-note">The new in-city controls are installed and load the next time the server starts.</div>
          </div>
          <Button variant="primary" busy={busy === 'restart'} onClick={restart}>Restart now</Button>
        </div>
      )}

      <div className="city-grid">
        <section className="card">
          <h3 className="card-title"><CloudSun size={16} />Weather and time</h3>
          {online ? <WorldCard online={online} /> : <p className="muted-note">Available while the server is running.</p>}
        </section>
        <div className="stack">
          <section className="card">
            <h3 className="card-title"><Megaphone size={16} />Big announcement</h3>
            <p className="muted-note">Shows across the middle of everyone's screen, with an optional countdown.</p>
            <BannerCard online={online} />
          </section>
          <section className="card">
            <h3 className="card-title"><HeartPulse size={16} />Server events</h3>
            <EventsCard online={online} />
          </section>
          <section className="card">
            <h3 className="card-title"><LockKeyhole size={16} />Whitelist</h3>
            <p className="muted-note">Make the server invite-only. This keeps working even when CityHQ is closed.</p>
            <WhitelistCard />
          </section>
        </div>
      </div>
    </div>
  );
}
