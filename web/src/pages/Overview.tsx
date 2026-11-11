import {
  Activity, AlertTriangle, Archive, Bell, Boxes, CalendarDays, Check, CheckCircle2, Clock, Copy, ExternalLink, Gamepad2,
  LogIn, LogOut, Megaphone, Pencil, Play, RotateCw, Square, Timer, TrendingDown, TrendingUp, UserRound, Users, X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  api, type Dashboard, type HistoryPoint, type Overview as OverviewData, type UpcomingItem,
} from '../api';
import { LineChart } from '../Chart';
import { openPlayer } from '../nav';
import { ProblemList, RecentFixes } from '../Problems';
import {
  Button, Empty, formatBytes, formatUptime, formatWhen, Modal, Notice, Segmented, ServerBadge, Spinner, Toggle,
  useAction, useConfirm, usePoll,
} from '../ui';
import {
  AreaChart, Avatar, Calendar, HeroArt, Sparkline,
} from '../Visuals';

const cpuValue = (p: HistoryPoint) => (p.running ? p.cpu : null);
const memValue = (p: HistoryPoint) => (p.running && p.mem !== null ? p.mem / 1024 ** 3 : null);
const cpuFormat = (n: number) => `${n < 10 && n % 1 !== 0 ? n.toFixed(1) : Math.round(n)}%`;
const memFormat = (n: number) => `${Number(n.toFixed(2))} GB`;

interface Props {
  data: OverviewData | null;
  error: string | null;
  refresh: () => void;
  local: boolean;
  goTo: (page: string) => void;
}

function CopyRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard is unavailable on plain http from a phone */ }
  };
  return (
    <button className="copy-row" onClick={copy} title="Copy">
      <code>{text}</code>
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function useNow(everyMs: number, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, active]);
  return now;
}

function countdownText(at: number, now: number) {
  const left = Math.max(0, Math.round((at - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** "in 3h 20m", "in 12 min", "5 min ago", "yesterday". */
export function relative(ms: number, now: number) {
  const diff = ms - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  const text = mins < 1 ? 'a moment' : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}` : `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`;
  if (mins < 1) return diff > 0 ? 'in a moment' : 'just now';
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

const timeOnly = (ms: number) => formatWhen(ms).replace(/^Today at /, 'today at ');

function greeting(hour: number) {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function RestartDialog({ players, onClose, onNow, onLater }: { players: number; onClose: () => void; onNow: () => void; onLater: (minutes: number) => void }) {
  return (
    <Modal title="Restart the server?" onClose={onClose}>
      <p>{players > 0 ? `${players} player${players === 1 ? ' is' : 's are'} online. Their progress is saved, then they are disconnected.` : 'Nobody is online right now.'}</p>
      {players > 0 && <p>Giving a countdown warns everyone in game first.</p>}
      <div className="restart-choices">
        <Button variant="primary" icon={<RotateCw size={15} />} onClick={onNow}>Restart now</Button>
        <Button icon={<Timer size={15} />} onClick={() => onLater(5)}>In 5 minutes</Button>
        <Button icon={<Timer size={15} />} onClick={() => onLater(15)}>In 15 minutes</Button>
      </div>
    </Modal>
  );
}

function AnnounceDialog({ onClose }: { onClose: () => void }) {
  const { busy, run } = useAction();
  const [message, setMessage] = useState('');
  const [big, setBig] = useState(false);
  const send = async () => {
    const text = message.trim();
    if (!text) return;
    const done = big
      ? await run('send', () => api.banner('Announcement', text, 10, false), (r) => `Shown to ${r.players} player${r.players === 1 ? '' : 's'}`)
      : await run('send', () => api.announce(text), (r) => `Sent to ${r.players} player${r.players === 1 ? '' : 's'}`);
    if (done) onClose();
  };
  return (
    <Modal
      title="Announce to everyone"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Megaphone size={15} />} busy={busy === 'send'} disabled={!message.trim()} onClick={send}>Send</Button></>}
    >
      <textarea className="input" rows={3} maxLength={240} placeholder="Message shown in game" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
      <label className="switch-line">
        <Toggle checked={big} onChange={setBig} label="Show as a big banner" />
        <span>Show it as a big banner across everyone's screen, not just in chat</span>
      </label>
    </Modal>
  );
}

function StatCard({ icon, tone, label, value, unit, foot, trend, spark, onClick }: {
  icon: React.ReactNode; tone: 'violet' | 'blue' | 'green' | 'amber'; label: string; value: React.ReactNode; unit?: string;
  foot?: React.ReactNode; trend?: { pct: number } | null; spark?: (number | null)[]; onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="stat-card" onClick={onClick}>
      <div className="stat-top">
        <span className={`stat-icon tone-${tone}`}>{icon}</span>
        <span className="stat-text">
          <span className="stat-label">{label}</span>
          <span className="stat-value">{value}{unit && <small>{unit}</small>}</span>
        </span>
      </div>
      <div className="stat-bottom">
        <span className="stat-foot">
          {trend && (
            <span className={`trend ${trend.pct >= 0 ? 'up' : 'down'}`}>
              {trend.pct >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {Math.abs(Math.round(trend.pct))}%
            </span>
          )}
          {foot}
        </span>
        {spark && <Sparkline values={spark} label={`${label} trend`} />}
      </div>
    </Tag>
  );
}

const UPCOMING_LABEL: Record<UpcomingItem['kind'], string> = { countdown: 'Countdown', restart: 'Daily', backup: 'Nightly' };

export function Overview({ data, error, refresh, local, goTo }: Props) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [askRestart, setAskRestart] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [range, setRange] = useState<'day' | 'week'>('day');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const dash = usePoll(api.dashboard, 30000);
  const online = data?.state === 'online';
  const players = usePoll(api.players, online ? 5000 : 0, [online]);
  const pending = data?.schedule?.pendingRestart;
  const now = useNow(1000, Boolean(pending));
  const clock = useNow(30000);

  const playerCount = data?.status?.players ?? 0;
  const playerWarning = playerCount > 0
    ? <p>{playerCount} player{playerCount === 1 ? ' is' : 's are'} online. Their progress is saved, then they are disconnected.</p>
    : <p>Nobody is online right now.</p>;

  const power = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop') {
      const ok = await confirm({
        title: 'Stop the server?',
        body: <>{playerWarning}<p>txAdmin stops too. Use Start here to bring both back.</p></>,
        confirm: 'Stop server',
        danger: true,
      });
      if (!ok) return;
    }
    const labels = { start: 'Server is online', stop: 'Server stopped', restart: 'Server restarted' };
    await run(action, () => api[action](), labels[action]);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, run, refresh, playerCount]);

  if (!data) {
    return error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  }

  if (!data.folderFound) {
    return (
      <Empty icon={<Boxes size={32} />} title="No server folder found">
        CityHQ manages the server folder it is installed in, and it isn't inside one.
        Run Setup.cmd from the download to create a server folder with the app in it, then open the app from there.
      </Empty>
    );
  }

  if (!data.deployed) {
    return (
      <Empty icon={<Boxes size={32} />} title="Your server is not set up yet">
        Finish the setup in txAdmin, then come back here. If txAdmin won't open, double-click
        Start-Server.bat in your server folder first. Its window shows the PIN txAdmin asks for.
        {local && <div className="empty-actions"><a className="btn btn-primary" href={`http://localhost:${data.txAdminPort}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a></div>}
      </Empty>
    );
  }

  const { state, status, stats, history } = data;
  const isBusy = Boolean(busy) || ['starting', 'stopping', 'restarting', 'restoring'].includes(state);
  const canStart = state === 'stopped' || state === 'panel-only';
  const connectAddress = `localhost:${data.gamePort}`;
  const d: Dashboard | null = dash.data;
  const name = d?.greetingName || '';

  const restartLater = async (minutes: number) => {
    setAskRestart(false);
    await run('later', () => api.restartLater(minutes), `The server will restart in ${minutes} minutes. Players are being warned.`);
    refresh();
    dash.refresh();
  };
  const cancelLater = async () => {
    await run('cancel', () => api.cancelRestartLater(), 'Restart cancelled');
    refresh();
    dash.refresh();
  };
  const dismissAlert = async (id: string) => {
    await run('seen', () => api.markSeen(id));
    refresh();
  };
  const saveName = async () => {
    const saved = await run('name', () => api.setGreeting(nameDraft), 'Saved');
    if (saved) { setEditingName(false); dash.refresh(); }
  };

  const errorCount = data.problems.filter((p) => p.severity === 'error').length;
  const todayUnique = d?.today.unique ?? 0;
  const yesterdayUnique = d?.yesterday.unique ?? 0;
  const uniqueTrend = yesterdayUnique > 0 ? { pct: ((todayUnique - yesterdayUnique) / yesterdayUnique) * 100 } : null;
  const recentSpark = d ? d.day.slice(-48).map((p) => p.v) : undefined;
  const weekSpark = d ? d.days.map((x) => x.unique) : undefined;

  const subline = {
    online: status ? `${status.players} player${status.players === 1 ? '' : 's'} in the city · up ${formatUptime(status.uptimeSec)}` : 'Online',
    starting: 'Loading resources. This usually takes under a minute.',
    restarting: 'Saving players and restarting. This usually takes under a minute.',
    restoring: 'Restoring from a backup. This takes about 4 minutes.',
    stopping: 'Saving players and shutting down.',
    stopped: 'The server is off. Start it whenever you are ready.',
    'panel-only': 'txAdmin is running, but the game server is off.',
  }[state];

  return (
    <div className="page-stack dash">
      <section className="hero-banner">
        <div className="hero-copy">
          <div className="hero-greet">
            {editingName ? (
              <form className="name-edit" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
                <input className="input" autoFocus maxLength={40} placeholder="Your name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
                <Button type="submit" busy={busy === 'name'}>Save</Button>
                <Button variant="ghost" onClick={() => setEditingName(false)}>Cancel</Button>
              </form>
            ) : (
              <>
                <span>{greeting(new Date(clock).getHours())}{name ? `, ${name}` : ''}</span>
                <button className="icon-btn hero-name-btn" aria-label={name ? 'Change your name' : 'Add your name'} title={name ? 'Change your name' : 'Add your name'} onClick={() => { setNameDraft(name); setEditingName(true); }}>
                  <Pencil size={13} />
                </button>
              </>
            )}
          </div>
          <h1>{online ? `${data.serverName} is live` : data.serverName}</h1>
          <p className="hero-sub"><ServerBadge state={state} /> <span>{subline}</span></p>
          <div className="hero-actions">
            {canStart ? (
              <Button variant="primary" icon={<Play size={16} />} busy={busy === 'start'} disabled={isBusy} onClick={() => power('start')}>Start server</Button>
            ) : (
              <>
                <Button variant="primary" icon={<RotateCw size={16} />} busy={busy === 'restart'} disabled={isBusy} onClick={() => setAskRestart(true)}>Restart</Button>
                <Button icon={<Square size={15} />} busy={busy === 'stop'} disabled={isBusy} onClick={() => power('stop')}>Stop</Button>
              </>
            )}
            <Button icon={<Megaphone size={15} />} disabled={!online} onClick={() => setAnnouncing(true)}>Announce</Button>
          </div>
        </div>
        <HeroArt />
        <div className="hero-connect">
          <span>Join in FiveM with F8</span>
          <CopyRow text={`connect ${connectAddress}`} />
        </div>
      </section>

      {error && <Notice kind="error">{error}</Notice>}
      {!data.processes.database && !canStart && <Notice kind="error">The database is not running, so QBCore cannot save anything. Restart the server to bring it back.</Notice>}
      {data.helperOutdated && online && <Notice kind="info">CityHQ was updated. Restart the server once when it's convenient to turn on the new in-city controls.</Notice>}

      {data.alerts.map((alert) => (
        <div key={alert.id} className="alert-banner" role="alert">
          <Bell size={18} />
          <div>
            <strong>{alert.title}</strong>
            {alert.detail && <div>{alert.detail}</div>}
            <small>{timeOnly(alert.at)}</small>
          </div>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissAlert(alert.id)}><X size={16} /></button>
        </div>
      ))}

      {pending && (
        <div className="countdown-banner">
          <Timer size={18} />
          <div>
            <strong>Restarting in {countdownText(pending.at, now)}</strong>
            <div className="muted-note">{pending.reason === 'scheduled' ? 'This is your scheduled restart.' : 'You asked for this.'} Players are warned at 15, 5 and 1 minutes.</div>
          </div>
          <Button busy={busy === 'cancel'} onClick={cancelLater}>{pending.reason === 'scheduled' ? 'Skip this one' : 'Cancel'}</Button>
        </div>
      )}

      <div className="stat-grid">
        <StatCard
          icon={<Users size={18} />} tone="violet" label="Online now"
          value={status ? status.players : '-'} unit={status ? ` / ${status.maxClients}` : undefined}
          foot={<span>Peak today {d?.today.peak ?? 0}</span>}
          spark={recentSpark}
          onClick={() => goTo('players')}
        />
        <StatCard
          icon={<UserRound size={18} />} tone="blue" label="Players today"
          value={todayUnique}
          trend={uniqueTrend}
          foot={<span>{yesterdayUnique} yesterday</span>}
          spark={weekSpark}
        />
        <StatCard
          icon={<Boxes size={18} />} tone="green" label="Resources running"
          value={status ? status.resourcesStarted : '-'} unit={status ? ` of ${status.resourcesTotal}` : undefined}
          foot={<span>{data.problems.length ? `${data.problems.length} to check` : 'No problems found'}</span>}
          onClick={() => goTo('resources')}
        />
        <StatCard
          icon={<Clock size={18} />} tone="amber" label="Uptime"
          value={status ? formatUptime(status.uptimeSec) : '-'}
          foot={<span>{online && stats.cpuPct !== null ? `CPU ${cpuFormat(Math.round(stats.cpuPct * 10) / 10)} · ${formatBytes(stats.memBytes)}` : 'Server is off'}</span>}
        />
      </div>

      <div className="dash-grid">
        <div className="dash-col">
        <section className="card dash-wide">
          <div className="card-row">
            <div>
              <h3 className="card-title"><Activity size={16} />Player activity</h3>
              <p className="muted-note">Players online over the last {range === 'day' ? '24 hours' : '7 days'}</p>
            </div>
            <Segmented label="Range" value={range} onChange={setRange} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
          </div>
          {d ? <AreaChart points={range === 'day' ? d.day : d.week} range={range} /> : <Spinner label="Reading history" />}
        </section>

        <section className="card dash-wide">
          <div className="card-row">
            <h3 className="card-title"><Users size={16} />In the city now</h3>
            <button className="link-plain small" onClick={() => goTo('players')}>View all</button>
          </div>
          {!online && <p className="muted-note">The server is off, so nobody can be in the city.</p>}
          {online && players.data && players.data.length === 0 && <p className="muted-note">Nobody is online. Join with <code>connect {connectAddress}</code> in FiveM.</p>}
          {online && players.data && players.data.length > 0 && (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr><th>Player</th><th>Job</th><th>Status</th><th>Ping</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {players.data.slice(0, 8).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="who">
                          <Avatar name={p.character?.trim() || p.name} />
                          <span><strong>{p.character?.trim() || p.name}</strong><span className="muted-note">{p.name} · ID {p.id}</span></span>
                        </span>
                      </td>
                      <td>{p.job ? `${p.job.label}${p.job.gradeName ? ` · ${p.job.gradeName}` : ''}` : <span className="muted-note">Choosing a character</span>}</td>
                      <td>
                        {p.jailMonths ? <span className="pill pill-crash">In jail</span> : p.frozen ? <span className="pill pill-backup">Frozen</span> : <span className="pill pill-ok">Playing</span>}
                      </td>
                      <td className="num">{p.ping} ms</td>
                      <td><Button variant="ghost" onClick={() => openPlayer(p.id)}>Manage</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card dash-wide">
          <h3 className="card-title">
            {data.problems.length === 0 ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {data.problems.length === 0 ? 'No problems found' : `${data.problems.length} thing${data.problems.length === 1 ? '' : 's'} to check${errorCount ? `, ${errorCount} of them serious` : ''}`}
          </h3>
          {data.problems.length === 0
            ? <p className="muted-note">Nothing wrong in the server's latest startup log.</p>
            : <ProblemList problems={data.problems} onChanged={refresh} />}
          <RecentFixes onChanged={refresh} />
          {data.problems.length > 0 && <button className="link" onClick={() => goTo('console')}>Open the full console</button>}
        </section>

        </div>

        <div className="dash-col">
        <section className="card">
          <div className="card-row">
            <h3 className="card-title"><Timer size={16} />Coming up</h3>
            <button className="link-plain small" onClick={() => goTo('settings')}>Schedule</button>
          </div>
          {d && d.upcoming.length > 0 ? (
            <ul className="upcoming">
              {d.upcoming.map((u) => (
                <li key={`${u.kind}-${u.at}`}>
                  <span className={`upcoming-icon kind-${u.kind}`}>{u.kind === 'backup' ? <Archive size={15} /> : <Timer size={15} />}</span>
                  <span className="upcoming-main">
                    <strong>{u.title}</strong>
                    <span className="muted-note">{u.detail}</span>
                  </span>
                  <span className="upcoming-when">
                    <span className={`pill pill-${u.kind}`}>{UPCOMING_LABEL[u.kind]}</span>
                    <span className="muted-note">{relative(u.at, clock)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-note">Nothing scheduled. Turn on nightly backups and daily restarts under Settings.</p>
          )}
        </section>

        <section className="card">
          <h3 className="card-title"><CalendarDays size={16} />Calendar</h3>
          {d ? <Calendar history={d.history} schedule={d.schedule} /> : <Spinner />}
        </section>

        <section className="card">
          <h3 className="card-title"><Activity size={16} />Recent activity</h3>
          {d && d.activity.length > 0 ? (
            <ul className="feed">
              {d.activity.slice(0, 10).map((a) => (
                <li key={`${a.t}-${a.name}-${a.kind}`}>
                  <span className={`feed-icon ${a.kind}`}>{a.kind === 'join' ? <LogIn size={14} /> : <LogOut size={14} />}</span>
                  <span className="feed-main">
                    <span><strong>{a.name}</strong> {a.kind === 'join' ? 'joined' : 'left'}{a.character ? ` as ${a.character}` : ''}</span>
                    <span className="muted-note">{relative(a.t, clock)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="muted-note">Joins and leaves show up here once players come and go.</p>}
        </section>
        </div>
      </div>

      <div className="chart-row">
        <LineChart
          title="Server CPU"
          points={history}
          value={cpuValue}
          format={cpuFormat}
          minTop={10}
          niceStep={5}
          current={online && stats.cpuPct !== null ? cpuFormat(Math.round(stats.cpuPct * 10) / 10) : '-'}
          detail={stats.sysCpuPct !== null ? `Whole PC: ${Math.round(stats.sysCpuPct)}%` : undefined}
        />
        <LineChart
          title="Server memory"
          points={history}
          value={memValue}
          format={memFormat}
          minTop={1}
          niceStep={0.5}
          current={online ? formatBytes(stats.memBytes) : '-'}
          detail={`Whole PC: ${formatBytes(stats.sysMemUsed)} of ${formatBytes(stats.sysMemTotal)}`}
        />
      </div>

      {local && (
        <div className="link-row">
          <a className="btn btn-default" href={`fivem://connect/${connectAddress}`} target="_blank" rel="noreferrer"><Gamepad2 size={16} /><span>Open in FiveM</span></a>
          <a className="btn btn-ghost" href={`http://localhost:${data.txAdminPort}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a>
        </div>
      )}

      {askRestart && <RestartDialog players={playerCount} onClose={() => setAskRestart(false)} onNow={() => { setAskRestart(false); power('restart'); }} onLater={restartLater} />}
      {announcing && <AnnounceDialog onClose={() => setAnnouncing(false)} />}
    </div>
  );
}
