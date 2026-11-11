import {
  ArrowUpCircle, Download, ExternalLink, RefreshCw, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, type UpdateStatus } from './api';
import {
  Button, Notice, Spinner, Toggle, useAction, useConfirm, usePoll,
} from './ui';

/** Release notes are short Markdown lists; show them as plain lines and bullets. */
function Notes({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.replace(/\*\*|__|`/g, '').trimEnd()).filter((l) => l.trim());
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) out.push(<ul key={`u${out.length}`}>{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>);
    bullets = [];
  };
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { bullets.push(bullet[1]); continue; }
    flush();
    out.push(<p key={`p${out.length}`}>{line.replace(/^#+\s*/, '')}</p>);
  }
  flush();
  return <div className="update-notes">{out}</div>;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet');

function Progress({ job }: { job: NonNullable<UpdateStatus['job']> }) {
  const sized = job.step === 'Downloading' && job.totalMb;
  return (
    <div className="update-progress" role="status">
      <Spinner />
      <span>
        {job.done
          ? 'Closing CityHQ to finish. It opens again by itself in a minute or so; the game server keeps running.'
          : sized ? `Downloading ${job.mb} of ${job.totalMb} MB` : `${job.step}...`}
      </span>
      {sized ? <progress max={job.totalMb ?? undefined} value={job.mb} /> : null}
    </div>
  );
}

/** The Updates card on the Settings page (on the PC only). */
export function UpdatesCard() {
  const { data, setData } = usePoll(api.updates, 1500);
  const { busy, run } = useAction();
  const confirm = useConfirm();

  if (!data) return <section className="card"><Spinner /></section>;
  const { latest, job } = data;
  const working = Boolean(job && !job.error);

  const install = async () => {
    if (!latest) return;
    const ok = await confirm({
      title: `Update CityHQ to ${latest.version}?`,
      body: (
        <p>
          CityHQ downloads the new version{latest.sizeMb ? ` (about ${latest.sizeMb} MB)` : ''}, checks it, then closes and opens again by itself.
          Your game server keeps running and players aren't affected. If the new version doesn't open, the current one is put back.
        </p>
      ),
      confirm: 'Update now',
    });
    if (!ok) return;
    const result = await run('install', () => api.installUpdate());
    if (result) setData(result);
  };

  return (
    <section className="card" id="updates">
      <div className="card-row">
        <h3 className="card-title"><ArrowUpCircle size={16} />Updates</h3>
        <Toggle
          checked={data.autoCheck}
          disabled={busy === 'auto'}
          label="Check for new versions automatically"
          onChange={async (enabled) => { const r = await run('auto', () => api.setAutoUpdate(enabled)); if (r) setData(r); }}
        />
      </div>
      <p className="muted-note">
        You have CityHQ <strong>{data.current}</strong>. {data.autoCheck ? 'It looks for a new version every few hours, and only installs one when you press Update.' : 'Automatic checks are off; press Check now to look.'}
      </p>

      {data.available && latest ? (
        <div className="update-box">
          <h4>CityHQ {latest.version} is available</h4>
          {latest.notes ? <Notes text={latest.notes} /> : <p className="muted-note">See GitHub for what changed.</p>}
          {job?.error && <Notice kind="error">{job.error}</Notice>}
          {working && job ? <Progress job={job} /> : data.cantInstall ? (
            <>
              <Notice kind="info">{data.cantInstall}</Notice>
              <a className="btn btn-primary" href={latest.page} target="_blank" rel="noreferrer"><Download size={15} /><span>Download from GitHub</span></a>
            </>
          ) : (
            <div className="button-row">
              <Button variant="primary" icon={<Download size={15} />} busy={busy === 'install'} onClick={install}>{job?.error ? 'Try again' : 'Update now'}</Button>
              <a className="btn btn-ghost" href={latest.page} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>On GitHub</span></a>
            </div>
          )}
        </div>
      ) : (
        <p className="muted-note">
          {data.checking ? 'Checking...' : data.error || (data.checkedAt ? 'You have the newest version.' : '')}
        </p>
      )}

      <div className="button-row">
        <Button icon={<RefreshCw size={15} />} busy={busy === 'check' || data.checking} disabled={working} onClick={async () => { const r = await run('check', () => api.checkUpdates()); if (r) setData(r); }}>Check now</Button>
        <span className="muted-note">Last checked: {when(data.checkedAt)}</span>
      </div>
      {data.lastLog && /did not|failed|Putting the old/i.test(data.lastLog) && (
        <Notice kind="warn">The last update didn't finish: {data.lastLog.replace(/^\S+ \S+ /, '')}</Notice>
      )}
    </section>
  );
}

const DISMISS_KEY = 'cityhq.updateDismissed';
const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY); } catch { return null; } };

/** The line at the top of every page when a newer CityHQ is out. */
export function UpdateNotice({ version }: { version: string }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed === version) return null;
  const hide = () => {
    try { localStorage.setItem(DISMISS_KEY, version); } catch { /* the notice just comes back next time */ }
    setDismissed(version);
  };
  return (
    <div className="update-notice" role="status">
      <ArrowUpCircle size={18} />
      <span>CityHQ {version} is available.</span>
      <a className="btn btn-primary" href="#settings" onClick={() => setTimeout(() => document.getElementById('updates')?.scrollIntoView({ behavior: 'smooth' }), 300)}>See what's new</a>
      <button className="icon-btn" aria-label="Hide until the next version" title="Hide until the next version" onClick={hide}><X size={16} /></button>
    </div>
  );
}
