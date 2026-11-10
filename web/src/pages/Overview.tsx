import {
  AlertTriangle, Archive, Bell, Boxes, Check, CheckCircle2, Clock, Copy, ExternalLink, Gamepad2, Megaphone, Play, RotateCw, Square, Timer, Users, X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type HistoryPoint, type Overview as OverviewData } from '../api';
import { LineChart } from '../Chart';
import { ProblemList } from '../Problems';
import {
  Button, Empty, formatBytes, formatUptime, formatWhen, Modal, Notice, ServerBadge, Spinner, useAction, useConfirm,
} from '../ui';

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

function useCountdown(at: number | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  if (!at) return '';
  const left = Math.max(0, Math.round((at - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const timeOnly = (ms: number) => formatWhen(ms).replace(/^Today at /, 'today at ');

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

export function Overview({ data, error, refresh, local, goTo }: Props) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [message, setMessage] = useState('');
  const [askRestart, setAskRestart] = useState(false);
  const pending = data?.schedule?.pendingRestart;
  const countdown = useCountdown(pending?.at);

  const players = data?.status?.players ?? 0;
  const playerWarning = players > 0
    ? <p>{players} player{players === 1 ? ' is' : 's are'} online. Their progress is saved, then they are disconnected.</p>
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
  }, [confirm, run, refresh, players]);

  const announce = async () => {
    const text = message.trim();
    if (!text) return;
    const result = await run('announce', () => api.announce(text), (r) => `Sent to ${r.players} player${r.players === 1 ? '' : 's'}`);
    if (result) setMessage('');
  };

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
  const isOnline = state === 'online';
  const isBusy = Boolean(busy) || ['starting', 'stopping', 'restarting', 'restoring'].includes(state);

  const restartLater = async (minutes: number) => {
    setAskRestart(false);
    await run('later', () => api.restartLater(minutes), `The server will restart in ${minutes} minutes. Players are being warned.`);
    refresh();
  };
  const cancelLater = async () => {
    await run('cancel', () => api.cancelRestartLater(), 'Restart cancelled');
    refresh();
  };
  const dismissAlert = async (id: string) => {
    await run('seen', () => api.markSeen(id));
    refresh();
  };
  const schedule = data.schedule;
  const errorCount = data.problems.filter((p) => p.severity === 'error').length;
  const canStart = state === 'stopped' || state === 'panel-only';
  const connectAddress = `localhost:${data.gamePort}`;

  return (
    <div className="page-stack">
      <header className="hero">
        <div className="hero-main">
          <ServerBadge state={state} />
          <h1>{data.serverName}</h1>
          <p className="hero-sub">
            {isOnline && status && `Up for ${formatUptime(status.uptimeSec)} on FiveM build ${status.version.match(/\d{4,}/)?.[0] || status.version}`}
            {state === 'starting' && 'Loading resources. This usually takes under a minute.'}
            {state === 'restarting' && 'Saving players and restarting. This usually takes under a minute.'}
            {state === 'restoring' && 'Restoring from a backup. This usually takes under a minute.'}
            {state === 'stopping' && 'Saving players and shutting down.'}
            {state === 'stopped' && 'The server and txAdmin are not running.'}
            {state === 'panel-only' && 'txAdmin is running, but the game server is off.'}
          </p>
        </div>
        <div className="hero-actions">
          {canStart ? (
            <Button variant="primary" icon={<Play size={16} />} busy={busy === 'start'} disabled={isBusy} onClick={() => power('start')}>Start server</Button>
          ) : (
            <>
              <Button variant="primary" icon={<RotateCw size={16} />} busy={busy === 'restart'} disabled={isBusy} onClick={() => setAskRestart(true)}>Restart</Button>
              <Button icon={<Square size={15} />} busy={busy === 'stop'} disabled={isBusy} onClick={() => power('stop')}>Stop</Button>
            </>
          )}
        </div>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {!data.processes.database && canStart === false && <Notice kind="error">The database is not running, so QBCore cannot save anything. Restart the server to bring it back.</Notice>}

      {data.helperOutdated && isOnline && <Notice kind="info">The app was updated. Restart the server once when it's convenient, so the check for typos in files works fully.</Notice>}

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
            <strong>Restarting in {countdown}</strong>
            <div className="muted-note">{pending.reason === 'scheduled' ? 'This is your scheduled restart.' : 'You asked for this.'} Players are warned at 15, 5 and 1 minutes.</div>
          </div>
          <Button busy={busy === 'cancel'} onClick={cancelLater}>{pending.reason === 'scheduled' ? 'Skip this one' : 'Cancel'}</Button>
        </div>
      )}

      {(schedule.backupRunning || schedule.nextBackup || schedule.nextRestart) && (
        <div className="schedule-line">
          {schedule.backupRunning
            ? <span><Archive size={14} /> {schedule.backupRunning.step}...</span>
            : schedule.nextBackup && <button className="link-plain" onClick={() => goTo('backups')}><Archive size={14} /> Next backup {timeOnly(schedule.nextBackup)}</button>}
          {schedule.nextRestart && !pending && <button className="link-plain" onClick={() => goTo('settings')}><Timer size={14} /> Next restart {timeOnly(schedule.nextRestart)}</button>}
        </div>
      )}

      <div className="stat-row">
        <button className="stat" onClick={() => goTo('players')}>
          <span className="stat-label"><Users size={15} />Players</span>
          <span className="stat-value">{status ? status.players : '-'}<small>{status ? ` / ${status.maxClients}` : ''}</small></span>
        </button>
        <button className="stat" onClick={() => goTo('resources')}>
          <span className="stat-label"><Boxes size={15} />Resources running</span>
          <span className="stat-value">{status ? status.resourcesStarted : '-'}<small>{status ? ` of ${status.resourcesTotal}` : ''}</small></span>
        </button>
        <div className="stat">
          <span className="stat-label"><Clock size={15} />Uptime</span>
          <span className="stat-value">{status ? formatUptime(status.uptimeSec) : '-'}</span>
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
          current={isOnline && stats.cpuPct !== null ? cpuFormat(Math.round(stats.cpuPct * 10) / 10) : '-'}
          detail={stats.sysCpuPct !== null ? `Whole PC: ${Math.round(stats.sysCpuPct)}%` : undefined}
        />
        <LineChart
          title="Server memory"
          points={history}
          value={memValue}
          format={memFormat}
          minTop={1}
          niceStep={0.5}
          current={isOnline ? formatBytes(stats.memBytes) : '-'}
          detail={`Whole PC: ${formatBytes(stats.sysMemUsed)} of ${formatBytes(stats.sysMemTotal)}`}
        />
      </div>

      <section className="card">
        <h3 className="card-title">
          {data.problems.length === 0 ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {data.problems.length === 0 ? 'No problems found' : `${data.problems.length} thing${data.problems.length === 1 ? '' : 's'} to check${errorCount ? `, ${errorCount} of them serious` : ''}`}
        </h3>
        {data.problems.length === 0
          ? <p className="muted-note">Nothing wrong in the server's latest startup log.</p>
          : <ProblemList problems={data.problems} onChanged={refresh} />}
        {data.problems.length > 0 && <button className="link" onClick={() => goTo('console')}>Open the full console</button>}
      </section>

      <div className="two-col">
        <div className="stack">
          <section className="card">
            <h3 className="card-title"><Megaphone size={16} />Announce to everyone</h3>
            <div className="input-row">
              <input
                className="input"
                placeholder="Message shown in game"
                maxLength={300}
                value={message}
                disabled={!isOnline}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') announce(); }}
              />
              <Button onClick={announce} busy={busy === 'announce'} disabled={!isOnline || !message.trim()}>Send</Button>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title"><Gamepad2 size={16} />Join the game</h3>
            <p className="muted-note">In FiveM, press F8 and type:</p>
            <CopyRow text={`connect ${connectAddress}`} />
            {local && (
              <div className="link-row">
                <a className="btn btn-default" href={`fivem://connect/${connectAddress}`} target="_blank" rel="noreferrer"><Gamepad2 size={16} /><span>Open in FiveM</span></a>
                <a className="btn btn-ghost" href={`http://localhost:${data.txAdminPort}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a>
              </div>
            )}
          </section>
        </div>
      </div>

      {askRestart && <RestartDialog players={players} onClose={() => setAskRestart(false)} onNow={() => { setAskRestart(false); power('restart'); }} onLater={restartLater} />}
    </div>
  );
}
