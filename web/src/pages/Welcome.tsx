import {
  AlertTriangle, ArrowLeft, CheckCircle2, Database, FolderOpen, FolderSearch, Hammer, Info, Loader2, PlugZap, RefreshCw, Server, XCircle,
} from 'lucide-react';
import {
  useCallback, useEffect, useRef, useState, type ReactNode,
} from 'react';
import {
  api, type NewServerJob, type ServerCandidate, type WelcomeInfo,
} from '../api';
import { ReportButton } from '../Report';
import { Term } from '../Term';
import {
  Button, Notice, Spinner, useAction,
} from '../ui';

type Step =
  | { kind: 'start' }
  | { kind: 'find' }
  | { kind: 'review'; candidate: ServerCandidate }
  | { kind: 'connecting'; root: string; needsTools: boolean }
  | { kind: 'new' }
  | { kind: 'restarting'; text: string };

const LEVEL_ICON: Record<ServerCandidate['problems'][number]['level'], ReactNode> = {
  bad: <XCircle size={17} />,
  warn: <AlertTriangle size={17} />,
  info: <Info size={17} />,
};

function Problems({ items }: { items: ServerCandidate['problems'] }) {
  if (!items.length) return <p className="welcome-ok"><CheckCircle2 size={16} />Everything CityHQ needs is there.</p>;
  return (
    <ul className="health-list">
      {items.map((p) => (
        <li key={p.text} className={`health-item health-${p.level}`}>
          <div className="health-icon">{LEVEL_ICON[p.level]}</div>
          <div className="health-body"><p>{p.text}</p></div>
        </li>
      ))}
    </ul>
  );
}

const databaseText = (c: ServerCandidate) => {
  if (!c.database) return 'Not found in server.cfg';
  const d = c.database;
  return `${d.name || '(no database name)'} on ${d.host}:${d.port}, user ${d.user}${d.hasPassword ? ', with a password' : ', no password'}${d.managed ? ' (CityHQ runs it)' : ''}`;
};

/** One server found on this PC. */
function CandidateCard({ c, onPick }: { c: ServerCandidate; onPick: () => void }) {
  const bad = c.problems.filter((p) => p.level === 'bad').length;
  const warn = c.problems.filter((p) => p.level === 'warn').length;
  return (
    <li className="candidate">
      <div className="candidate-main">
        <Server size={18} />
        <div>
          <strong className="candidate-path">{c.root}</strong>
          <span className="muted-note">
            {c.dataPath ? `Game port ${c.gamePort} · txAdmin ${c.txAdminPort}` : 'txAdmin not set up yet'}
            {c.qbcore ? ' · QBCore' : ''}
            {bad ? ` · ${bad} problem${bad === 1 ? '' : 's'}` : warn ? ` · ${warn} thing${warn === 1 ? '' : 's'} to check` : ''}
          </span>
        </div>
      </div>
      <Button variant="primary" onClick={onPick}>Use this one</Button>
    </li>
  );
}

/** Finds servers on this PC, or checks a folder someone browses to or types. */
function FindServer({ info, onBack, onReview }: { info: WelcomeInfo; onBack: () => void; onReview: (c: ServerCandidate) => void }) {
  const [found, setFound] = useState<ServerCandidate[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const { busy, run } = useAction();

  const scan = useCallback(async () => {
    setFound(null);
    setScanError(null);
    try { setFound(await api.welcomeScan()); } catch (err) { setScanError((err as Error).message); }
  }, []);
  useEffect(() => { scan(); }, [scan]);

  const check = async (folder: string) => {
    const c = await run('check', () => api.welcomeCheck(folder));
    if (c) onReview(c);
  };
  const browse = async () => {
    const picked = await run('pick', () => api.welcomePick());
    if (picked?.folder) await check(picked.folder);
  };

  return (
    <section className="welcome-card">
      <button type="button" className="link-plain welcome-back" onClick={onBack}><ArrowLeft size={15} />Back</button>
      <h2>Which server is yours?</h2>
      <p className="muted-note">CityHQ looked for FiveM servers on this PC (folders with FXServer.exe in them).</p>
      {!found && !scanError && <Spinner label="Looking for FiveM servers on this PC (up to 10 seconds)" />}
      {scanError && <Notice kind="error">{scanError}</Notice>}
      {found && found.length === 0 && <Notice kind="info">No servers turned up in the usual places. Choose its folder below instead.</Notice>}
      {found && found.length > 0 && (
        <ul className="candidate-list">
          {found.map((c) => <CandidateCard key={c.root} c={c} onPick={() => check(c.folder)} />)}
        </ul>
      )}
      <div className="welcome-or">
        <h3>Somewhere else?</h3>
        <p className="muted-note">Choose the folder that holds your server: the one with FXServer.exe in it, or the folder above it (it usually also has txData).</p>
        <div className="input-row wrap">
          {info.desktop && <Button icon={<FolderOpen size={15} />} busy={busy === 'pick'} onClick={browse}>Browse...</Button>}
          <input className="input" placeholder="C:\FXServer" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label="Server folder" />
          <Button disabled={!typed.trim()} busy={busy === 'check'} onClick={() => check(typed.trim())}>Check this folder</Button>
        </div>
        {found && <Button variant="ghost" icon={<RefreshCw size={15} />} onClick={scan}>Look again</Button>}
      </div>
    </section>
  );
}

/** What CityHQ found in the chosen folder, before connecting. */
function Review({ c, onBack, onConnect }: { c: ServerCandidate; onBack: () => void; onConnect: (port: number) => void }) {
  const [port, setPort] = useState(String(c.txAdminPort));
  // Only a folder with no FiveM server in it can't be used; everything else can be fixed later.
  const blocked = !c.found;
  return (
    <section className="welcome-card">
      <button type="button" className="link-plain welcome-back" onClick={onBack}><ArrowLeft size={15} />Back</button>
      <h2>{c.found ? 'This is what CityHQ found' : 'That isn\'t a server folder'}</h2>
      <dl className="path-list welcome-facts">
        <dt>Server folder</dt><dd>{c.root}</dd>
        {c.fxserverDir && <><dt>FiveM's server</dt><dd>{c.fxserverDir}</dd></>}
        {c.txDataDir && <><dt><Term id="txadmin">txAdmin</Term> data</dt><dd>{c.txDataDir}{c.profile !== 'default' ? ` (profile ${c.profile})` : ''}</dd></>}
        {c.dataPath && <><dt>Server files</dt><dd>{c.dataPath}</dd></>}
        {c.dataPath && <><dt>Game port</dt><dd>{c.gamePort}</dd></>}
        <dt>Database</dt><dd>{databaseText(c)}{c.databaseUp === false ? ' — not answering right now' : c.databaseUp ? ' — answering' : ''}</dd>
        <dt>txAdmin</dt><dd>{c.txAdminRunning ? `Running on port ${c.txAdminPort}` : `Not running (port ${c.txAdminPort})`}</dd>
      </dl>
      <Problems items={c.problems} />
      {c.found && (
        <>
          <label className="input-label" htmlFor="txa-port">txAdmin's port (change it only if you set a different one)</label>
          <input id="txa-port" className="input input-number" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
          <p className="muted-note">
            Connecting adds CityHQ's small helper script (qb-control) to your server and a few marked lines to server.cfg, so CityHQ can see players and
            run its tools. {c.database && !c.database.managed ? 'CityHQ also downloads the official MariaDB tools (about 100 MB, once) to back up your database. ' : ''}
            Nothing else changes, and your server keeps running.
          </p>
        </>
      )}
      <div className="welcome-actions">
        <Button variant="primary" icon={<PlugZap size={15} />} disabled={blocked || !Number(port)} onClick={() => onConnect(Number(port))}>Connect CityHQ to this server</Button>
      </div>
    </section>
  );
}

/** Saving the choice, getting the database tools if needed, then starting again on that server. */
function Connecting({ needsTools, onRestart }: { needsTools: boolean; onRestart: (text: string) => void }) {
  const [step, setStep] = useState<string>(needsTools ? 'Getting the database tools' : 'Starting CityHQ on your server');
  const [mb, setMb] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const restartRef = useRef(onRestart);
  restartRef.current = onRestart;

  const relaunch = useCallback(async () => {
    try {
      const r = await api.welcomeRelaunch();
      restartRef.current(r.relaunching ? 'CityHQ is starting again on your server. This window closes and opens by itself in a few seconds.' : 'Close CityHQ (right-click its tray icon and choose Quit), then open it again.');
    } catch (err) { setError((err as Error).message); }
  }, []);

  // The download runs on the PC's side; this starts it once per attempt and follows its progress.
  useEffect(() => {
    if (!needsTools) { relaunch(); return undefined; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      if (stopped) return;
      const p = await api.welcomeProgress().catch(() => null);
      if (stopped) return;
      if (p?.tools.ready) { setStep('Starting CityHQ on your server'); setMb(null); relaunch(); return; }
      if (p?.tools.error && !p.tools.running) { setError(p.tools.error); return; }
      if (p?.tools.progress) { setStep(p.tools.progress.step); setMb(p.tools.progress.mb); }
      timer = setTimeout(follow, 1000);
    };
    setError(null);
    api.welcomeTools().then(follow).catch((err) => setError((err as Error).message));
    return () => { stopped = true; clearTimeout(timer); };
  }, [needsTools, attempt, relaunch]);
  const getTools = () => setAttempt((n) => n + 1);

  return (
    <section className="welcome-card">
      <h2>Connecting</h2>
      {!error && <div className="progress-line"><Loader2 size={16} className="spin" /><span>{step}{mb ? ` (${mb} MB so far)` : ''}...</span></div>}
      {error && (
        <>
          <Notice kind="error">{error}</Notice>
          <p className="muted-note">Your choice is saved. Without the tools, everything works except backups and running SQL files; CityHQ tries again each time it starts.</p>
          <div className="welcome-actions">
            <Button variant="primary" onClick={getTools}>Try again</Button>
            <Button onClick={relaunch}>Continue without them</Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Building a new server: where it goes, then setup's steps as they happen. */
function NewServer({ info, onBack, onBuilt }: { info: WelcomeInfo; onBack: () => void; onBuilt: () => void }) {
  const [folder, setFolder] = useState(info.suggestedNewFolder);
  const [job, setJob] = useState<NewServerJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job?.running) return undefined;
    const timer = setInterval(async () => {
      const p = await api.welcomeProgress().catch(() => null);
      if (p?.newServer) setJob(p.newServer);
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.running]);

  const start = async () => {
    setError(null);
    try { setJob(await api.welcomeNew(folder.trim())); } catch (err) { setError((err as Error).message); }
  };

  const heading = job ? [...job.lines].reverse().find((l) => l.startsWith('== '))?.slice(3) : null;
  if (job) {
    return (
      <section className="welcome-card">
        <h2>{job.running ? 'Building your server' : job.ok ? 'Your server folder is ready' : 'Setup stopped'}</h2>
        {job.running && <div className="progress-line"><Loader2 size={16} className="spin" /><span>{heading || 'Starting'}... This takes 3 to 6 minutes.</span></div>}
        <pre className="setup-log" aria-live="polite">{job.lines.slice(-14).join('\n')}</pre>
        {job.ok && (
          <>
            <p className="muted-note">Next, CityHQ starts again on {job.root} and opens txAdmin, where you create your account and choose the QBCore recipe.</p>
            <div className="welcome-actions"><Button variant="primary" onClick={onBuilt}>Continue</Button></div>
          </>
        )}
        {job.ok === false && (
          <>
            <Notice kind="error">{job.error}</Notice>
            <p className="muted-note">Running it again continues where it stopped.</p>
            <div className="welcome-actions">
              <Button variant="primary" onClick={start}>Try again</Button>
              <Button onClick={() => setJob(null)}>Change the folder</Button>
            </div>
          </>
        )}
      </section>
    );
  }
  return (
    <section className="welcome-card">
      <button type="button" className="link-plain welcome-back" onClick={onBack}><ArrowLeft size={15} />Back</button>
      <h2>Make a new QBCore server</h2>
      <p className="muted-note">
        CityHQ downloads FiveM's server (from fivem.net) and a private database (MariaDB, checked against its published checksum) into one new
        folder. That's about 200 MB, and the server needs about 4 GB of space as it grows. Nothing is installed into Windows, and other servers on
        this PC are left alone.
      </p>
      <ul className="welcome-needs">
        <li><CheckCircle2 size={15} />A free FiveM license key from <a href="https://portal.cfx.re" target="_blank" rel="noreferrer">portal.cfx.re</a> (txAdmin asks for it later)</li>
        <li><CheckCircle2 size={15} />Windows Smart App Control turned off (Windows Security, App &amp; browser control); it blocks one of FiveM's files</li>
      </ul>
      <label className="input-label" htmlFor="new-folder">Where should it go? A new or empty folder, with no spaces in its path.</label>
      <input id="new-folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="welcome-actions">
        <Button variant="primary" icon={<Hammer size={15} />} disabled={!folder.trim()} onClick={start}>Build my server</Button>
      </div>
    </section>
  );
}

/** The first thing a downloaded CityHQ shows: connect to a server, or build one. */
export function Welcome({ local }: { local: boolean }) {
  const [info, setInfo] = useState<WelcomeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const { run } = useAction();

  useEffect(() => {
    if (!local) return;
    api.welcome().then(setInfo).catch((err) => setError((err as Error).message));
  }, [local]);

  const connect = async (c: ServerCandidate, port: number) => {
    const saved = await run('use', () => api.welcomeUse(c.folder, port));
    if (saved) setStep({ kind: 'connecting', root: saved.root, needsTools: saved.needsTools });
  };
  const restartAfterBuild = async () => {
    const r = await run('relaunch', () => api.welcomeRelaunch());
    if (r) setStep({ kind: 'restarting', text: r.relaunching ? 'CityHQ is starting again on your new server. This window closes and opens by itself in a few seconds.' : 'Close CityHQ (right-click its tray icon and choose Quit), then open it again.' });
  };

  let body: ReactNode;
  if (!local) {
    body = <section className="welcome-card"><h2>Finish setting up on the PC</h2><p className="muted-note">CityHQ hasn't been connected to a server yet. Open it on the PC that runs the server to choose one.</p></section>;
  } else if (error) {
    body = <Notice kind="error">{error}</Notice>;
  } else if (!info) {
    body = <Spinner />;
  } else if (step.kind === 'start') {
    body = (
      <section className="welcome-card">
        <h2>Do you already have a FiveM server?</h2>
        <div className="choice-grid">
          <button type="button" className="choice" onClick={() => setStep({ kind: 'find' })}>
            <FolderSearch size={26} />
            <strong>Yes, I have one</strong>
            <span>CityHQ finds it on this PC and connects to it: txAdmin, its ports and its database (XAMPP, MySQL or MariaDB). Your server stays as it is.</span>
          </button>
          <button type="button" className="choice" onClick={() => setStep({ kind: 'new' })}>
            <Hammer size={26} />
            <strong>No, make me one</strong>
            <span>CityHQ builds a new QBCore server in one folder, with its own database, then walks you through txAdmin's setup.</span>
          </button>
        </div>
        <p className="muted-note welcome-db-note"><Database size={14} />CityHQ is made for QBCore servers that run with txAdmin.</p>
      </section>
    );
  } else if (step.kind === 'find') {
    body = <FindServer info={info} onBack={() => setStep({ kind: 'start' })} onReview={(c) => setStep({ kind: 'review', candidate: c })} />;
  } else if (step.kind === 'review') {
    body = <Review c={step.candidate} onBack={() => setStep({ kind: 'find' })} onConnect={(port) => connect(step.candidate, port)} />;
  } else if (step.kind === 'connecting') {
    body = <Connecting needsTools={step.needsTools} onRestart={(text) => setStep({ kind: 'restarting', text })} />;
  } else if (step.kind === 'new') {
    body = <NewServer info={info} onBack={() => setStep({ kind: 'start' })} onBuilt={restartAfterBuild} />;
  } else {
    body = <section className="welcome-card"><h2>Almost there</h2><div className="progress-line"><Loader2 size={16} className="spin" /><span>{step.text}</span></div></section>;
  }

  return (
    <main className="welcome">
      <header className="welcome-head">
        <img src="/logo.svg" alt="" width={56} height={56} />
        <div>
          <h1>Welcome to CityHQ</h1>
          <p className="muted-note">Headquarters for your QBCore roleplay city. Let's connect it to your server.</p>
        </div>
      </header>
      {body}
      <footer className="welcome-foot">
        <span className="muted-note">Stuck, or something looks wrong?</span>
        <ReportButton />
      </footer>
    </main>
  );
}
