import {
  Archive, BarChart3, Bell, Boxes, Building2, CircleHelp, FolderOpen, HeartPulse, House, KeyRound, Plus, RotateCw,
  Search as SearchIcon, Settings as SettingsIcon, Terminal, Users, X,
} from 'lucide-react';
import {
  useCallback, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { api, onSignedOut, type Overview as OverviewData } from './api';
import { CommandBox, useActionCtx } from './CommandBox';
import { useMode } from './mode';
import { openHomeAction } from './nav';
import { Backups, HostedBackups } from './pages/Backups';
import { City } from './pages/City';
import { Console } from './pages/Console';
import { Files } from './pages/Files';
import { Health } from './pages/Health';
import { Home, RAW_ID } from './pages/Home';
import { Learn } from './pages/Learn';
import { Move } from './pages/Move';
import { Overview } from './pages/Overview';
import { Players } from './pages/Players';
import { Resources } from './pages/Resources';
import { SettingsPage } from './pages/SettingsPage';
import { Welcome } from './pages/Welcome';
import { Tour } from './Tour';
import { UpdateNotice } from './Updates';
import {
  Button, ConfirmProvider, formatBytes, Notice, ServerBadge, Spinner, ToastProvider, usePoll,
} from './ui';
import type { Mode } from './actions';

type Page = 'home' | 'overview' | 'health' | 'city' | 'resources' | 'players' | 'files' | 'backups' | 'console' | 'settings' | 'learn' | 'move';
interface NavItem { id: Page; label: string; icon: ReactNode; pro?: boolean }
const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: <House size={17} /> },
  { id: 'players', label: 'Players', icon: <Users size={17} /> },
  { id: 'city', label: 'City', icon: <Building2 size={17} /> },
  { id: 'resources', label: 'Resources', icon: <Boxes size={17} /> },
  { id: 'files', label: 'Files', icon: <FolderOpen size={17} /> },
  { id: 'backups', label: 'Backups', icon: <Archive size={17} /> },
  { id: 'health', label: 'Health', icon: <HeartPulse size={17} /> },
  { id: 'overview', label: 'Stats', icon: <BarChart3 size={17} /> },
  { id: 'console', label: 'Console', icon: <Terminal size={17} />, pro: true },
];
const PAGES: Page[] = [...NAV.map((n) => n.id), 'settings', 'learn', 'move'];
const isPage = (value: string): value is Page => (PAGES as string[]).includes(value);
const pageFromHash = (): Page => {
  const hash = window.location.hash.slice(1);
  return isPage(hash) ? hash : 'home';
};

const STATE_WORD: Record<string, string> = {
  online: 'Online', stopped: 'Off', 'panel-only': 'Game server off', starting: 'Starting', restarting: 'Restarting', stopping: 'Stopping',
  restoring: 'Restoring', unreachable: 'Not answering',
};
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Login({ onDone, startError }: { onDone: () => void; startError: string | null }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(startError);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(code);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/logo.svg" alt="" width={52} height={52} />
        <h1>CityHQ</h1>
        <p className="muted-note">Enter the passcode shown under Settings in the app on your PC, or scan its QR code.</p>
        {error && <Notice kind="error">{error}</Notice>}
        <label className="input-label" htmlFor="passcode"><KeyRound size={14} /> Passcode</label>
        <input
          id="passcode"
          className="input passcode-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button variant="primary" type="submit" busy={busy} disabled={!code.trim()}>Sign in</Button>
      </form>
    </main>
  );
}

/** Simple or Pro, at the top of every page. */
function ModeSwitch({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="How much detail to show">
      {(['simple', 'pro'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          className={mode === m ? 'on' : ''}
          title={m === 'simple' ? 'Simple: plain words, forms and starting points' : 'Pro: command syntax, the raw log and every tool'}
          onClick={() => setMode(m)}
        >
          {m === 'simple' ? 'Simple' : 'Pro'}
        </button>
      ))}
    </div>
  );
}

/** Ctrl K on any page other than Home: the same box, in a pop-up. */
function Palette({ data, local, mode, onClose }: { data: OverviewData | null; local: boolean; mode: Mode; onClose: () => void }) {
  const hosted = data?.hosted || null;
  const base = useMemo(() => ({
    online: data?.state === 'online',
    hosted: Boolean(hosted),
    local,
    canPower: !hosted || hosted.capabilities.power,
    playerCount: data?.status?.players ?? 0,
    mode,
  }), [data?.state, data?.status?.players, hosted, local, mode]);
  const { ctx, ensure } = useActionCtx(base, true);
  useEffect(() => { ensure(); }, [ensure]);
  return (
    <div className="overlay overlay-palette" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search or run a command">
        <CommandBox
          ctx={ctx}
          mode={mode}
          below
          autoFocus
          onEscape={onClose}
          placeholder="Search players, scripts and pages, or type what you want to do"
          onAction={(action, values) => {
            onClose();
            if (action.go) action.go(values);
            else openHomeAction({ id: action.id, values, run: false });
          }}
          onRaw={(text) => { onClose(); openHomeAction({ id: RAW_ID, values: { text }, run: true }); }}
          trailing={<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>}
        />
        <p className="palette-hint">Enter runs or opens the highlighted one. Actions that need details open on Home.</p>
      </div>
    </div>
  );
}

function Shell({ local, onSignOut }: { local: boolean; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [mode, setMode] = useMode();
  const [palette, setPalette] = useState(false);
  const overview = usePoll(api.overview, 2500);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Ctrl K: the command box on Home, or the pop-up anywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (pageFromHash() === 'home') window.dispatchEvent(new Event('qbc-focus-command'));
        else setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goTo = useCallback((next: string) => { window.location.hash = next; }, []);
  const data = overview.data;
  const state = data?.state;
  const online = state === 'online';
  const hosted = data?.hosted || null;
  const nav = NAV.filter((n) => !n.pro || mode === 'pro' || page === n.id);
  const problems = data?.problems.length || 0;
  const alerts = data?.alerts.length || 0;
  const restartAt = data?.schedule?.pendingRestart?.at || data?.schedule?.nextRestart || null;

  // A downloaded copy that hasn't been connected to a server yet starts on the Welcome screen.
  if (data && data.folderFound === false) {
    return (
      <>
        <div className="titlebar titlebar-min"><img src="/logo.svg" alt="" width={18} height={18} /><span>CityHQ</span></div>
        <Welcome local={local} />
      </>
    );
  }

  return (
    <div className={`app mode-${mode}`}>
      <header className="titlebar">
        <img className="tb-logo" src="/logo.svg" alt="" width={18} height={18} />
        <div className="tb-tab" title={hosted ? `${data?.serverName} on ${hosted.label}` : data?.serverName}>
          <i className={`tb-dot state-${state || 'none'}`} />
          <span className="tb-name">{data?.serverName || 'CityHQ'}</span>
          {hosted && <span className="tb-host">{hosted.label}</span>}
        </div>
        <a className="tb-plus" href="#settings" title="Change server, or move to a host (in Settings)" aria-label="Change server"><Plus size={15} /></a>
        <span className="tb-drag" />
        <button type="button" className="tb-search" onClick={() => (page === 'home' ? window.dispatchEvent(new Event('qbc-focus-command')) : setPalette(true))}>
          <SearchIcon size={14} /><span>Search or run a command</span><kbd>Ctrl K</kbd>
        </button>
        <ModeSwitch mode={mode} setMode={setMode} />
        <a className="tb-icon tb-help" href="#learn" title="Learn the basics" aria-label="Learn the basics"><CircleHelp size={16} /></a>
        <a className="tb-icon" href="#home" title={alerts ? `${alerts} alert${alerts === 1 ? '' : 's'} on Home` : 'No alerts'} aria-label={`${alerts} alerts`}>
          <Bell size={16} />{alerts > 0 && <span className="tb-badge">{alerts}</span>}
        </a>
        <span className="tb-caption-space" aria-hidden="true" />
      </header>

      <div className="topbar">
        <img src="/logo.svg" alt="" width={24} height={24} />
        <span className="topbar-name">{data?.serverName || 'CityHQ'}</span>
        {state && <ServerBadge state={state} />}
        <button type="button" className="icon-btn" aria-label="Search or run a command" onClick={() => (page === 'home' ? window.dispatchEvent(new Event('qbc-focus-command')) : setPalette(true))}><SearchIcon size={18} /></button>
      </div>

      <nav className="sidenav" aria-label="Main">
        <ul>
          {nav.map((n) => (
            <li key={n.id}>
              <a href={`#${n.id}`} title={n.label} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
                {n.icon}<span>{n.label}</span>
                {n.id === 'players' && online && data?.status ? <small className="nav-n">{data.status.players}</small> : null}
                {n.id === 'health' && problems > 0 ? <small className="nav-c">{problems}</small> : null}
              </a>
            </li>
          ))}
        </ul>
        <div className="sidenav-foot">
          <a href="#settings" className={`sidenav-settings ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined}>
            <SettingsIcon size={17} /><span>Settings</span>
          </a>
        </div>
      </nav>

      <main className={`main page-${page}`}>
        {page === 'home' && <Home data={data} error={overview.error} refresh={overview.refresh} local={local} mode={mode} />}
        {page !== 'home' && (
          <div className={`content ${page === 'console' ? 'content-console' : ''} ${page === 'files' ? 'content-files' : ''}`}>
            {local && data?.update && page !== 'console' && page !== 'files' && <UpdateNotice version={data.update.version} />}
            {page === 'overview' && <Overview data={data} error={overview.error} refresh={overview.refresh} local={local} goTo={goTo} />}
            {page === 'health' && <Health hosted={Boolean(hosted)} />}
            {page === 'city' && <City online={online} helperOutdated={Boolean(data?.helperOutdated)} />}
            {page === 'resources' && <Resources />}
            {page === 'players' && <Players gamePort={data?.gamePort ?? 30121} />}
            {page === 'files' && <Files online={online} />}
            {page === 'backups' && (hosted ? <HostedBackups /> : <Backups />)}
            {page === 'console' && <Console online={online} />}
            {page === 'settings' && <SettingsPage online={online} onSignOut={onSignOut} />}
            {page === 'learn' && <Learn />}
            {page === 'move' && (hosted ? <Notice kind="info">This CityHQ runs a hosted server already. Moving works from a server on this PC.</Notice> : local ? <Move /> : <Notice kind="info">Moving a server is done on the PC that runs it.</Notice>)}
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span className={`sb-state state-${state || 'none'}`}><i />{state ? STATE_WORD[state] || state : 'Connecting'}</span>
        {online && data?.status && <span><Users size={12} />{data.status.players} / {data.status.maxClients}</span>}
        {online && data && data.stats.cpuPct !== null && <span>CPU {Math.round(data.stats.cpuPct)}%</span>}
        {online && data?.stats.memBytes ? <span>{formatBytes(data.stats.memBytes)}</span> : null}
        {data && !data.processes.database && !hosted && state !== 'stopped' && <span className="sb-bad">Database off</span>}
        <span className="sb-space" />
        {restartAt && online && <span><RotateCw size={12} />Restart at {hhmm(restartAt)}</span>}
        {data?.schedule?.nextBackup ? <span><Archive size={12} />Backup at {hhmm(data.schedule.nextBackup)}</span> : null}
        {data?.helperOutdated && online && <span title="CityHQ's helper on the server updates when the server restarts">Helper updates at next restart</span>}
        {local && data?.update && <a className="sb-accent" href="#settings">CityHQ {data.update.version} is ready</a>}
        <span>{hosted ? hosted.label : 'This PC'}</span>
      </footer>

      {palette && <Palette data={data} local={local} mode={mode} onClose={() => setPalette(false)} />}
      <Tour autoStart={Boolean(data?.deployed)} />
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<{ authed: boolean; local: boolean } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch (err) {
      setStartError((err as Error).message);
      setSession({ authed: false, local: false });
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onSignedOut(() => setSession((s) => (s ? { ...s, authed: false } : s)));
    (async () => {
      // A scanned QR code carries a one-time token after the #; it never reaches server logs.
      const match = window.location.hash.match(/^#p=([a-f0-9]+)$/);
      if (match) {
        window.history.replaceState(null, '', window.location.pathname);
        try {
          await api.pair(match[1]);
        } catch (err) {
          setStartError((err as Error).message);
        }
      }
      await check();
    })();
    return () => { unsubscribe(); };
  }, [check]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setSession((s) => (s ? { ...s, authed: false } : s));
  }, []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {!session && <div className="login"><Spinner /></div>}
        {session && !session.authed && <Login startError={startError} onDone={() => { setStartError(null); check(); }} />}
        {session?.authed && <Shell local={session.local} onSignOut={signOut} />}
      </ConfirmProvider>
    </ToastProvider>
  );
}
