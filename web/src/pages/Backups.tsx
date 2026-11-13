import {
  Archive, Database, FolderOpen, History, Loader2, RotateCcw, Save, ScrollText, Settings2, Trash2, Undo2,
} from 'lucide-react';
import { useState } from 'react';
import {
  api, type BackupPart, type ChangeRecord, type ServerBackup,
} from '../api';
import {
  Button, Empty, formatBytes, formatWhen, Modal, Notice, Spinner, Toggle, useAction, useConfirm, usePoll,
} from '../ui';

const REASONS: Record<string, string> = {
  manual: 'You made this',
  nightly: 'Automatic',
  'before-restore': 'Made before a restore',
  'before-sql': 'Made before running a database file',
  'before-fix': 'Made before a one-click fix',
};

const CHANGES_SHOWN = 12;

/** Everything changed through CityHQ, newest first, each with Undo where there's a way back. */
function ChangeHistory() {
  const { data, refresh } = usePoll(api.history, 15000);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [all, setAll] = useState(false);
  const changes = data || [];
  const shown = all ? changes : changes.slice(0, CHANGES_SHOWN);
  const undo = async (c: ChangeRecord) => {
    const ok = await confirm({
      title: `Undo "${c.title}"?`,
      body: <p>{c.undoHint || 'This reverses that change.'}</p>,
      confirm: 'Undo',
      danger: c.kind === 'sql',
    });
    if (!ok) return;
    if (await run(c.id, () => api.undoChange(c.id), (r) => r.message)) refresh();
  };
  return (
    <section className="card">
      <h3 className="card-title"><History size={16} />What changed</h3>
      <p className="muted-note">Everything changed through CityHQ: edited files, scripts installed, removed or switched on and off, database files run, admin roles and one-click fixes. If something stops working, look here for what changed and undo it.</p>
      {!data && <Spinner />}
      {data && changes.length === 0 && <p className="muted-note">Nothing has been changed yet.</p>}
      {changes.length > 0 && (
        <ul className="change-list">
          {shown.map((c) => (
            <li key={c.id} className={`change-row ${c.undone ? 'is-undone' : ''}`}>
              <div className="change-text">
                <strong>{c.title}</strong>
                {c.detail && <span className="muted-note">{c.detail}</span>}
                <span className="muted-note">{formatWhen(c.at)}{c.undone ? ` · undone${c.undoneAt ? ` ${formatWhen(c.undoneAt)}` : ''}` : ''}</span>
              </div>
              {c.undoable && <Button variant="ghost" icon={<Undo2 size={15} />} busy={busy === c.id} onClick={() => undo(c)}>Undo</Button>}
            </li>
          ))}
        </ul>
      )}
      {changes.length > CHANGES_SHOWN && (
        <button className="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${changes.length}`}</button>
      )}
    </section>
  );
}

const PART_INFO: Record<BackupPart, { label: string; help: string; icon: React.ReactNode }> = {
  database: { label: 'Players and progress', help: 'Characters, money, items, vehicles and everything else in the database.', icon: <Database size={16} /> },
  settings: { label: 'Server settings', help: 'Your server.cfg file.', icon: <Settings2 size={16} /> },
  scripts: { label: 'Scripts and resource settings', help: 'Code and config files in your resources. Resources added since this backup stay, and game asset files are not touched.', icon: <ScrollText size={16} /> },
};

function RestoreDialog({ backup, onClose, onDone }: { backup: ServerBackup; onClose: () => void; onDone: () => void }) {
  const [parts, setParts] = useState<BackupPart[]>(backup.parts);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const toggle = (part: BackupPart, on: boolean) => setParts((list) => (on ? [...list, part] : list.filter((p) => p !== part)));

  const restore = async () => {
    const ok = await confirm({
      title: 'Restore this backup?',
      body: (
        <>
          <p>The server stops for about 4 minutes while this runs, so anyone online is disconnected. Anything that changed after {formatWhen(backup.createdAt).replace(/^Today at/, 'today at')} in the parts you chose will be replaced.</p>
          <p>A backup of how things are right now is made first, so you can undo this.</p>
        </>
      ),
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) return;
    const done = await run('restore', () => api.restoreBackup(backup.id, parts), 'Restore finished');
    if (done) onDone();
  };

  return (
    <Modal
      title={`Restore from ${formatWhen(backup.createdAt).replace(/^Today at/, 'today at')}`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy === 'restore'}>Cancel</Button>
          <Button variant="danger" icon={<RotateCcw size={15} />} busy={busy === 'restore'} disabled={!parts.length} onClick={restore}>Restore</Button>
        </>
      )}
    >
      <p>Choose what to put back:</p>
      <div className="restore-parts">
        {backup.parts.map((part) => (
          <label key={part} className="restore-part">
            <Toggle checked={parts.includes(part)} onChange={(on) => toggle(part, on)} label={PART_INFO[part].label} disabled={busy === 'restore'} />
            <span>
              <strong>{PART_INFO[part].label}</strong>
              <small>{PART_INFO[part].help}</small>
            </span>
          </label>
        ))}
      </div>
      {busy === 'restore' && <Spinner label="Restoring. This takes about 4 minutes, and the server comes back on its own. Please keep this open." />}
    </Modal>
  );
}

/** A hosted server's backups: the host's own copies of everything, and CityHQ's database copies. */
export function HostedBackups() {
  const { data, error, refresh } = usePoll(api.hostedBackups, 10000);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  const host = data.host || [];
  const full = data.limit !== null && host.length >= data.limit;

  const restore = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Restore "${name}"?`,
      body: (
        <>
          <p>CityHQ stops the server, then your host puts back every file from this backup. Files changed or added since then are replaced.</p>
          <p>The database isn't part of your host's backup unless your host says so. Make a database copy below first if you're unsure.</p>
        </>
      ),
      confirm: 'Stop and restore',
      danger: true,
    });
    if (ok && await run(`restore:${id}`, () => api.restoreHostBackup(id), 'Your host is restoring it. Start the server from Home when it\'s done.')) refresh();
  };
  const download = async (id: string) => {
    const r = await run(`dl:${id}`, () => api.hostBackupLink(id));
    if (r?.url) window.open(r.url, '_blank', 'noreferrer');
  };
  const remove = async (id: string, name: string) => {
    const ok = await confirm({ title: `Delete "${name}"?`, body: <p>Your host deletes this backup. It can't be brought back.</p>, confirm: 'Delete backup', danger: true });
    if (ok && await run(`rm:${id}`, () => api.deleteHostBackup(id), 'Backup deleted')) refresh();
  };

  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Backups</h1>
          <p className="muted-note">Your host keeps copies of the whole server; CityHQ can also keep a copy of the database and server.cfg on this PC.</p>
        </div>
      </header>

      <section className="card">
        <div className="card-title-row">
          <h3 className="card-title"><Archive size={16} />Your host's backups</h3>
          {data.kind === 'panel' && <Button variant="primary" icon={<Save size={15} />} busy={busy === 'host'} disabled={full} onClick={() => run('host', () => api.createHostBackup(), 'Your host is making a backup. It shows here when it\'s done.').then(refresh)}>Back up now</Button>}
        </div>
        {data.kind !== 'panel' && <p className="muted-note">Your host's own backups are made in its panel. Connecting with a panel API key lets CityHQ list, make and restore them here.</p>}
        {data.hostError && <Notice kind="error">{data.hostError}</Notice>}
        {data.kind === 'panel' && !data.hostError && (
          <>
            <p className="muted-note">{data.limit !== null ? `Your plan keeps up to ${data.limit} backup${data.limit === 1 ? '' : 's'}.` : ''}{full ? ' Delete one to make another.' : ''}</p>
            {host.length === 0 && <Empty icon={<Archive size={28} />} title="No backups yet">Your host hasn't made any backups of this server.</Empty>}
            <ul className="backup-list">
              {host.map((b) => (
                <li key={b.id} className="backup-row">
                  <div className="backup-main">
                    <strong>{b.name}</strong>
                    <span className="muted-note">{b.done ? (b.ok ? `${formatWhen(b.completedAt || b.createdAt || 0)} · ${formatBytes(b.bytes)}` : 'This backup failed') : <><Loader2 size={13} className="spin" /> Being made</>}</span>
                  </div>
                  <div className="button-row">
                    <Button variant="ghost" busy={busy === `dl:${b.id}`} disabled={!b.done || !b.ok} onClick={() => download(b.id)}>Download</Button>
                    <Button icon={<RotateCcw size={15} />} busy={busy === `restore:${b.id}`} disabled={!b.done || !b.ok} onClick={() => restore(b.id, b.name)}>Restore</Button>
                    <Button variant="ghost" icon={<Trash2 size={15} />} busy={busy === `rm:${b.id}`} disabled={b.locked} onClick={() => remove(b.id, b.name)} aria-label={`Delete ${b.name}`} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-title-row">
          <h3 className="card-title"><Database size={16} />Database copies on this PC</h3>
          <div className="button-row">
            {data.canOpenFolder && <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => run('open', () => api.openDatabaseBackups())}>Open folder</Button>}
            <Button icon={<Save size={15} />} busy={busy === 'db'} onClick={() => run('db', () => api.createDatabaseBackup(), (r) => `Database copied${r.tables !== null ? ` (${r.tables} tables)` : ''}`).then(refresh)}>Copy the database</Button>
          </div>
        </div>
        <p className="muted-note">Your players, characters and everything scripts save, plus server.cfg, downloaded to this PC. It needs your host's database to accept connections from outside.</p>
        {data.local.length === 0 && <p className="muted-note">No copies yet.</p>}
        <ul className="backup-list">
          {data.local.map((b) => (
            <li key={b.id} className="backup-row">
              <div className="backup-main"><strong>{formatWhen(b.createdAt)}</strong><span className="muted-note">{formatBytes(b.size)} · {b.parts.join(' and ')}</span></div>
              <Button variant="ghost" icon={<Trash2 size={15} />} busy={busy === `lrm:${b.id}`} onClick={() => run(`lrm:${b.id}`, () => api.deleteDatabaseBackup(b.id), 'Deleted').then(refresh)} aria-label="Delete this copy" />
            </li>
          ))}
        </ul>
      </section>
      <ChangeHistory />
    </div>
  );
}

export function Backups() {
  const { data, error, refresh } = usePoll(api.backups, 3000);
  const automation = usePoll(api.automation, 0);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [restoring, setRestoring] = useState<ServerBackup | null>(null);

  const backups = data?.backups || [];
  const running = data?.running;
  const settings = automation.data?.backups;

  const backupNow = async () => {
    await run('backup', () => api.createBackup(), (b) => (b.skipped.length
      ? `Backup finished (${formatBytes(b.size)}). ${b.skipped.length} busy file${b.skipped.length === 1 ? ' was' : 's were'} skipped.`
      : `Backup finished (${formatBytes(b.size)})`));
    refresh();
  };
  const remove = async (backup: ServerBackup) => {
    const ok = await confirm({
      title: 'Delete this backup?',
      body: <p>The backup from {formatWhen(backup.createdAt).replace(/^Today at/, 'today at')} will be permanently deleted. This can't be undone.</p>,
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(backup.id, () => api.deleteBackup(backup.id), 'Backup deleted');
    refresh();
  };
  const updateSchedule = async (patch: { enabled?: boolean; time?: string; keep?: number }) => {
    const updated = await run('schedule', () => api.setAutomation({ backups: patch }));
    if (updated) automation.setData(updated);
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label="Reading backups" />;

  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Backups</h1>
          <p className="muted-note">Players and progress, server settings, and all your scripts.</p>
        </div>
        <div className="button-row">
          {data.canOpenFolder && <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => run('open', () => api.openBackupsFolder())}>Open folder</Button>}
          <Button variant="primary" icon={<Save size={16} />} busy={busy === 'backup' || Boolean(running)} disabled={Boolean(running)} onClick={backupNow}>Back up now</Button>
        </div>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {running && <div className="progress-line"><Loader2 size={16} className="spin" /><span>{running.step}...</span></div>}

      <section className="card">
        <div className="card-row">
          <h3 className="card-title"><History size={16} />Automatic backups</h3>
          {settings && <Toggle checked={settings.enabled} onChange={(enabled) => updateSchedule({ enabled })} label="Automatic backups" disabled={busy === 'schedule'} />}
        </div>
        {settings?.enabled && (
          <div className="inline-settings">
            <label>
              <span>Every day at</span>
              <input className="input input-time" type="time" value={settings.time} onChange={(e) => { if (e.target.value) updateSchedule({ time: e.target.value }); }} />
            </label>
            <label>
              <span>Keep the last</span>
              <input className="input input-number small" type="number" min={1} max={90} value={settings.keep} onChange={(e) => { const keep = Number(e.target.value); if (keep >= 1 && keep <= 90) updateSchedule({ keep }); }} />
              <span>days</span>
            </label>
          </div>
        )}
        <p className="muted-note">
          {settings?.enabled
            ? 'This runs while CityHQ is open or in the tray. If your PC was off at that time, it catches up the next time the app opens.'
            : 'Turn this on so your players\' progress is protected without having to remember.'}
        </p>
        <p className="muted-note">Backups are stored on this PC's drive, so copy important ones somewhere else too, in case the drive fails. Game asset files aren't included because they don't change; keep your original downloads of those.</p>
      </section>

      {backups.length === 0 && !running && (
        <Empty icon={<Archive size={30} />} title="No backups yet">Press "Back up now" to make your first one. It takes about 20 seconds, and players stay connected.</Empty>
      )}

      {backups.length > 0 && (
        <ul className="backup-list">
          {backups.map((backup) => (
            <li key={backup.id} className="backup-row">
              <div className="backup-info">
                <strong>{formatWhen(backup.createdAt)}</strong>
                <span className="muted-note">
                  {REASONS[backup.reason] || 'Automatic'} · {formatBytes(backup.size)}
                  {backup.parts.length < 3 && ` · ${backup.parts.map((p) => PART_INFO[p].label).join(', ')} only`}
                </span>
                {backup.skipped.length > 0 && (
                  <details className="backup-skipped">
                    <summary>{backup.skipped.length} busy file{backup.skipped.length === 1 ? ' was' : 's were'} skipped</summary>
                    <p className="muted-note">These were in use while the backup ran. Everything else was saved.</p>
                    <ul>{backup.skipped.map((line) => <li key={line}><code>{line}</code></li>)}</ul>
                  </details>
                )}
              </div>
              <div className="button-row">
                <Button icon={<RotateCcw size={15} />} onClick={() => setRestoring(backup)}>Restore</Button>
                <Button variant="ghost" title="Delete this backup" aria-label="Delete this backup" icon={<Trash2 size={15} />} busy={busy === backup.id} onClick={() => remove(backup)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <ChangeHistory />

      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onDone={() => { setRestoring(null); refresh(); }} />}
    </div>
  );
}
