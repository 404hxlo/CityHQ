import { Archive, Boxes, FolderOpen, Gauge, KeyRound, Settings as SettingsIcon, Terminal, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, onSignedOut } from './api';
import { Backups } from './pages/Backups';
import { Console } from './pages/Console';
import { Files } from './pages/Files';
import { Overview } from './pages/Overview';
import { Players } from './pages/Players';
import { Resources } from './pages/Resources';
import { SettingsPage } from './pages/SettingsPage';
import {
  Button, ConfirmProvider, Notice, ServerBadge, Spinner, ToastProvider, usePoll,
} from './ui';

type Page = 'overview' | 'resources' | 'players' | 'files' | 'backups' | 'console' | 'settings';
const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={20} /> },
  { id: 'resources', label: 'Resources', icon: <Boxes size={20} /> },
  { id: 'players', label: 'Players', icon: <Users size={20} /> },
  { id: 'files', label: 'Files', icon: <FolderOpen size={20} /> },
  { id: 'backups', label: 'Backups', icon: <Archive size={20} /> },
  { id: 'console', label: 'Console', icon: <Terminal size={20} /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={20} /> },
];

const isPage = (value: string): value is Page => NAV.some((n) => n.id === value);
const pageFromHash = (): Page => {
  const hash = window.location.hash.slice(1);
  return isPage(hash) ? hash : 'overview';
};

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
        <img src="/logo.svg" alt="" width={56} height={56} />
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

function Shell({ local, onSignOut }: { local: boolean; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const overview = usePoll(api.overview, 2500);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const goTo = useCallback((next: string) => { window.location.hash = next; }, []);
  const state = overview.data?.state;
  const online = state === 'online';

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <span>CityHQ</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <a href={`#${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
                {n.icon}<span>{n.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          {state && <ServerBadge state={state} />}
          {overview.data?.serverName && <div className="rail-server">{overview.data.serverName}</div>}
        </div>
      </nav>

      <div className="topbar">
        <img src="/logo.svg" alt="" width={26} height={26} />
        <span className="topbar-name">{overview.data?.serverName || 'CityHQ'}</span>
        {state && <ServerBadge state={state} />}
      </div>

      <main className={`content ${page === 'console' ? 'content-console' : ''} ${page === 'files' ? 'content-files' : ''}`}>
        {page === 'overview' && <Overview data={overview.data} error={overview.error} refresh={overview.refresh} local={local} goTo={goTo} />}
        {page === 'resources' && <Resources />}
        {page === 'players' && <Players gamePort={overview.data?.gamePort ?? 30121} />}
        {page === 'files' && <Files online={online} />}
        {page === 'backups' && <Backups />}
        {page === 'console' && <Console online={online} />}
        {page === 'settings' && <SettingsPage online={online} onSignOut={onSignOut} />}
      </main>
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
