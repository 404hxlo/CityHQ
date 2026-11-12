import {
  AlertTriangle, ArrowLeft, CheckCircle2, CloudUpload, Info, Loader2, Pause, Play, Server, XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api, type HostedServerChoice, type MoveCheck, type MoveLogin, type MoveStatus,
} from '../api';
import {
  Button, Notice, Spinner, Toggle, useAction, useConfirm,
} from '../ui';

const GB = 1024 ** 3;
const gb = (bytes?: number | null) => (bytes ? `${(bytes / GB).toFixed(bytes > 10 * GB ? 0 : 1)} GB` : '0 GB');
const ICON: Record<'ok' | 'warn' | 'bad', ReactNode> = {
  ok: <CheckCircle2 size={17} />, warn: <AlertTriangle size={17} />, bad: <XCircle size={17} />,
};

function timeLeft(bytes: number, rate?: number) {
  if (!rate || rate < 1) return null;
  const s = bytes / rate;
  if (s < 90) return 'about a minute';
  if (s < 3600) return `about ${Math.round(s / 60)} minutes`;
  const h = s / 3600;
  return `about ${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
}

function Step({ done, active, title, children }: { done: boolean; active: boolean; title: string; children?: ReactNode }) {
  return (
    <li className={`move-step${done ? ' done' : active ? ' active' : ''}`}>
      <span className="move-step-icon">{done ? <CheckCircle2 size={18} /> : active ? <Loader2 size={18} className="spin" /> : <span className="move-dot" />}</span>
      <div><strong>{title}</strong>{children && <div className="muted-note">{children}</div>}</div>
    </li>
  );
}

function Bar({ value, total }: { value: number; total: number }) {
  const pct = total ? Math.min(100, (value / total) * 100) : 0;
  return <div className="update-progress" aria-label={`${Math.round(pct)}%`}><span style={{ width: `${pct}%` }} /></div>;
}

/** Where to move to: the host's panel (or SFTP), the server, and the passwords the move needs. */
function Destination({ onChecked }: { onChecked: (login: MoveLogin, check: MoveCheck) => void }) {
  const [mode, setMode] = useState<'panel' | 'sftp'>('panel');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [servers, setServers] = useState<HostedServerChoice[] | null>(null);
  const [serverId, setServerId] = useState('');
  const [sftpPassword, setSftpPassword] = useState('');
  const [sftp, setSftp] = useState({ host: '', port: '2022', username: '', password: '' });
  const [db, setDb] = useState({ host: '', port: '3306', name: '', username: '', password: '' });
  const { busy, run } = useAction();

  const find = async () => {
    const r = await run('servers', () => api.hostedServers(url.trim(), key.trim()));
    if (!r) return;
    setUrl(r.url);
    setServers(r.servers);
    if (r.servers.length === 1) setServerId(r.servers[0].id);
  };
  const check = async () => {
    const login: MoveLogin = mode === 'panel'
      ? { type: 'panel', url, key: key.trim(), serverId, sftpPassword }
      : {
        type: 'sftp', host: sftp.host.trim(), port: Number(sftp.port) || 22, username: sftp.username.trim(), password: sftp.password,
        database: { host: db.host.trim(), port: Number(db.port) || 3306, name: db.name.trim(), username: db.username.trim(), password: db.password },
      };
    const r = await run('check', () => api.moveCheck(login));
    if (r) onChecked(login, r);
  };

  return (
    <section className="card">
      <h3 className="card-title"><Server size={16} />Where is it moving to?</h3>
      <div className="segmented" role="group" aria-label="How to connect">
        <button type="button" className={mode === 'panel' ? 'active' : ''} aria-pressed={mode === 'panel'} onClick={() => setMode('panel')}>Panel API key</button>
        <button type="button" className={mode === 'sftp' ? 'active' : ''} aria-pressed={mode === 'sftp'} onClick={() => setMode('sftp')}>SFTP only</button>
      </div>
      {mode === 'panel' ? (
        <>
          <p className="muted-note">For RocketNode and other Pterodactyl-style panels: the panel unpacks your resources itself, which is much faster. Make a key under <strong>Account, API Credentials</strong>.</p>
          <label className="input-label" htmlFor="mv-url">Your panel's address</label>
          <input id="mv-url" className="input" placeholder="https://panel.yourhost.com" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
          <label className="input-label" htmlFor="mv-key">API key</label>
          <input id="mv-key" className="input" type="password" placeholder="ptlc_..." value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" />
          {!servers && <div className="welcome-actions"><Button variant="primary" busy={busy === 'servers'} disabled={!url.trim() || !key.trim()} onClick={find}>Find my servers</Button></div>}
          {servers && (
            <>
              <label className="input-label" htmlFor="mv-server">Server to move into</label>
              <select id="mv-server" className="input" value={serverId} onChange={(e) => setServerId(e.target.value)}>
                <option value="">Choose a server</option>
                {servers.map((s) => <option key={s.id} value={s.id} disabled={s.suspended}>{s.name}{s.address ? ` (${s.address.ip}:${s.address.port})` : ''}</option>)}
              </select>
              <label className="input-label" htmlFor="mv-sftp">Your panel password (big uploads go over SFTP, which uses it)</label>
              <input id="mv-sftp" className="input" type="password" value={sftpPassword} onChange={(e) => setSftpPassword(e.target.value)} autoComplete="off" />
              <div className="welcome-actions"><Button variant="primary" busy={busy === 'check'} disabled={!serverId || !sftpPassword} onClick={check}>Check before moving</Button></div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="muted-note">For any host with SFTP. Files go up one by one (slower), and you start and stop the server from your host's panel. Your host's panel shows the SFTP details, and the database details for your data.</p>
          <div className="input-row wrap">
            <input className="input" aria-label="SFTP address" placeholder="SFTP address" value={sftp.host} onChange={(e) => setSftp({ ...sftp, host: e.target.value })} spellCheck={false} autoComplete="off" />
            <input className="input input-number small" aria-label="SFTP port" type="number" value={sftp.port} onChange={(e) => setSftp({ ...sftp, port: e.target.value })} />
          </div>
          <input className="input" aria-label="SFTP username" placeholder="SFTP username" value={sftp.username} onChange={(e) => setSftp({ ...sftp, username: e.target.value })} spellCheck={false} autoComplete="off" />
          <input className="input" aria-label="SFTP password" type="password" placeholder="SFTP password" value={sftp.password} onChange={(e) => setSftp({ ...sftp, password: e.target.value })} autoComplete="off" />
          <h4 className="move-sub">The host's database</h4>
          <div className="input-row wrap">
            <input className="input" aria-label="Database address" placeholder="Database address" value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} spellCheck={false} autoComplete="off" />
            <input className="input input-number small" aria-label="Database port" type="number" value={db.port} onChange={(e) => setDb({ ...db, port: e.target.value })} />
          </div>
          <input className="input" aria-label="Database name" placeholder="Database name" value={db.name} onChange={(e) => setDb({ ...db, name: e.target.value })} spellCheck={false} autoComplete="off" />
          <input className="input" aria-label="Database username" placeholder="Database username" value={db.username} onChange={(e) => setDb({ ...db, username: e.target.value })} spellCheck={false} autoComplete="off" />
          <input className="input" aria-label="Database password" type="password" placeholder="Database password" value={db.password} onChange={(e) => setDb({ ...db, password: e.target.value })} autoComplete="off" />
          <div className="welcome-actions">
            <Button variant="primary" busy={busy === 'check'} disabled={!sftp.host || !sftp.username || !sftp.password || !db.host || !db.name || !db.username} onClick={check}>Check before moving</Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Moving the server on this PC to a host, start to finish. */
export function Move() {
  const [status, setStatus] = useState<MoveStatus | null>(null);
  const [checked, setChecked] = useState<{ login: MoveLogin; check: MoveCheck } | null>(null);
  const [copyPlayers, setCopyPlayers] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();

  const refresh = useCallback(async () => { setStatus(await api.move().catch(() => ({ phase: null }))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  // Follow the move while it runs.
  useEffect(() => {
    if (!status?.running && status?.phase !== 'finishing' && !finishing) return undefined;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [status?.running, status?.phase, finishing, refresh]);

  if (!status) return <Spinner />;

  const start = async () => {
    if (!checked) return;
    const r = await run('start', () => api.moveStart({ ...checked.login, copyPlayersDb: copyPlayers }));
    if (r) { setStatus(r); setChecked(null); }
  };
  const finish = async () => {
    const ok = await confirm({
      title: 'Finish the move?',
      body: (
        <>
          <p>CityHQ stops your server on this PC (players are told it's moving), copies your database and server.cfg to your host, puts its helper there and starts it.</p>
          <p>Your server here isn't deleted: it stays stopped, exactly as it is, in case you need it. Then CityHQ switches to the one on your host.</p>
        </>
      ),
      confirm: 'Finish the move',
    });
    if (!ok) return;
    setFinishing(true);
    const r = await run('finish', () => api.moveFinish({ stopLocal: true }));
    setFinishing(false);
    if (r) setDone(r.relaunching ? 'CityHQ is starting again on your hosted server. This window closes and opens by itself in a few seconds.' : 'Close CityHQ from its tray icon and open it again.');
    refresh();
  };

  const s = status.steps;
  const header = (
    <header className="page-head">
      <div>
        <a className="link-plain welcome-back" href="#settings"><ArrowLeft size={15} />Settings</a>
        <h1>Move to a host</h1>
        <p className="muted-note">Your server, its resources (maps and cars too), database and settings, moved to a host such as RocketNode. Your server on this PC stays as it is.</p>
      </div>
    </header>
  );

  if (done) return <div className="page-stack">{header}<Notice kind="info">{done}</Notice></div>;

  // Not started: choose where to, check, then start.
  if (!status.phase) {
    return (
      <div className="page-stack">
        {header}
        {!checked && <Destination onChecked={(login, check) => setChecked({ login, check })} />}
        {checked && (
          <section className="card">
            <h3 className="card-title"><Info size={16} />Before moving to {checked.check.target.name || 'your host'}</h3>
            <dl className="path-list welcome-facts">
              <dt>Your resources</dt><dd>{gb(checked.check.resources.bytes)} in {checked.check.resources.files.toLocaleString()} files</dd>
              {checked.check.target.dataPath && <><dt>Goes to</dt><dd>{checked.check.target.dataPath} on your host</dd></>}
              {checked.check.database && <><dt>Database</dt><dd>{checked.check.database.create ? `a new one, "${checked.check.database.name}"` : `"${checked.check.database.name}"`}{checked.check.database.host ? ` on ${checked.check.database.host}` : ''}</dd></>}
            </dl>
            <ul className="health-list">
              {checked.check.items.map((i) => (
                <li key={i.text} className={`health-item health-${i.level === 'ok' ? 'ok' : i.level === 'warn' ? 'warn' : 'bad'}`}>
                  <div className="health-icon">{ICON[i.level]}</div><div className="health-body"><p>{i.text}</p></div>
                </li>
              ))}
            </ul>
            <label className="switch-line">
              <Toggle checked={copyPlayers} onChange={setCopyPlayers} label="Bring txAdmin's player records" />
              <span>Bring txAdmin's player records too (bans, warnings, playtime)</span>
            </label>
            <p className="muted-note">Starting packs and uploads your resources while your server keeps running here. Nothing on your host is replaced yet: its resources and server.cfg are kept as copies. You finish the move yourself when it's ready.</p>
            <div className="welcome-actions">
              <Button onClick={() => setChecked(null)}>Back</Button>
              <Button variant="primary" icon={<CloudUpload size={16} />} busy={busy === 'start'} disabled={!checked.check.ok} onClick={start}>Start moving</Button>
            </div>
          </section>
        )}
      </div>
    );
  }

  const up = s?.upload;
  const moving = status.running && status.phase === 'moving';
  return (
    <div className="page-stack">
      {header}
      {status.error && <Notice kind="error">{status.error}</Notice>}
      <section className="card">
        <h3 className="card-title"><CloudUpload size={16} />Moving to {status.target?.name || 'your host'}</h3>
        <ol className="move-steps">
          <Step done={Boolean(s?.pack.done)} active={status.step === 'pack'} title="Pack your resources">
            {status.step === 'pack' ? `${gb(s?.pack.packed)} packed so far` : s?.pack.done ? `${gb(s?.pack.size)} zip, ready` : status.target?.type === 'sftp' ? 'Not needed: files go up one by one' : null}
          </Step>
          <Step done={Boolean(up?.done)} active={status.step === 'upload'} title="Upload to your host">
            {up && up.total ? (
              <>
                {gb(up.sent)} of {gb(up.total)}
                {status.step === 'upload' && up.rate ? ` · ${(up.rate / 1024 / 1024).toFixed(1)} MB/s · ${timeLeft((up.total || 0) - (up.sent || 0), up.rate) || ''} left` : ''}
                {!up.done && <Bar value={up.sent || 0} total={up.total} />}
              </>
            ) : null}
          </Step>
          <Step done={Boolean(s?.unpack.done)} active={status.step === 'unpack'} title="Unpack on your host">
            {s?.unpack.done ? `${s.unpack.folders} folders in resources${s.unpack.setAside ? `; the host's old ones kept as ${s.unpack.setAside}` : ''}` : status.step === 'unpack' ? (s?.unpack.files ? `${s.unpack.files.toLocaleString()} files sent` : 'Your host is unpacking. Big servers take a while.') : null}
          </Step>
          <Step done={Boolean(s?.files.done)} active={status.step === 'files'} title="Settings files server.cfg uses" />
          <Step done={status.phase === 'done'} active={status.phase === 'finishing'} title="Finish: database, server.cfg, switch over">
            {status.phase === 'finishing' ? ({ 'stop-local': 'Stopping your server here', 'stop-host': 'Stopping the host\'s server', database: 'Copying your database', settings: 'Writing server.cfg', txadmin: 'Bringing txAdmin\'s records', switch: 'Switching CityHQ over' } as Record<string, string>)[status.step || ''] || 'Working' : null}
          </Step>
        </ol>
        <div className="welcome-actions">
          {moving && <Button icon={<Pause size={15} />} busy={busy === 'pause'} onClick={() => run('pause', () => api.movePause()).then(refresh)}>Pause</Button>}
          {!status.running && (status.phase === 'paused' || status.phase === 'stopped') && (
            <Button variant="primary" icon={<Play size={15} />} busy={busy === 'continue'} onClick={() => run('continue', () => api.moveContinue()).then(refresh)}>Continue</Button>
          )}
          {status.phase === 'ready' && !finishing && <Button variant="primary" busy={busy === 'finish'} onClick={finish}>Finish the move</Button>}
          {!status.running && status.phase !== 'finishing' && status.phase !== 'done' && (
            <Button variant="ghost" busy={busy === 'cancel'} onClick={async () => {
              const ok = await confirm({ title: 'Stop this move?', body: <p>CityHQ forgets this move. Nothing on your PC or your host is deleted: files already uploaded stay there.</p>, confirm: 'Stop the move', danger: true });
              if (ok) { await run('cancel', () => api.moveCancel()); refresh(); }
            }}>Cancel the move</Button>
          )}
        </div>
        {moving && <p className="muted-note">Keep this PC on. CityHQ keeps it awake while it moves, and if the internet drops, Continue picks up where it stopped.</p>}
        {status.phase === 'ready' && <p className="muted-note">Your resources are on your host. Finishing takes a few minutes and stops your server here, so do it when nobody is on.</p>}
      </section>
    </div>
  );
}
