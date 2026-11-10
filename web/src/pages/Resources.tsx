import {
  ChevronRight, Database, Download, FolderOpen, Link2, Loader2, PackageOpen, PackagePlus, Play, RefreshCw, RotateCw, Search, Square, Trash2, Undo2, Upload,
} from 'lucide-react';
import {
  useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import {
  api, type InstalledResource, type Problem, type Resource, type TrashItem,
} from '../api';
import { openFilesAt, takeResourceTargets } from '../nav';
import { ProblemList } from '../Problems';
import { SettingsEditor } from '../SettingsEditor';
import {
  Button, Drawer, Empty, formatWhen, Modal, Notice, ResourceBadge, Segmented, Spinner, Toggle, useAction, useCanLeave, useConfirm, usePoll, useToast,
} from '../ui';

type Filter = 'all' | 'running' | 'stopped' | 'off' | 'problems';

const matchesFilter = (r: Resource, filter: Filter) => {
  switch (filter) {
    case 'running': return r.state === 'started';
    case 'stopped': return r.state !== 'started';
    case 'off': return !r.boot.enabled;
    case 'problems': return Boolean(r.problem);
    default: return true;
  }
};

const nameList = (names: string[]) => names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');

function useResourceActions(reload: () => Promise<unknown> | void) {
  const confirm = useConfirm();
  const { busy, run } = useAction();

  const act = async (r: Resource, action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop' && (r.warnOnStop || r.dependents.length)) {
      const body: ReactNode = (
        <>
          {r.warnOnStop && <p>{r.name} is a core part of the server. Other things may stop working until it is started again.</p>}
          {r.dependents.length > 0 && <p>These resources need it: {nameList(r.dependents)}.</p>}
        </>
      );
      if (!await confirm({ title: `Stop ${r.name}?`, body, confirm: 'Stop it', danger: true })) return;
    }
    if (action === 'stop') {
      await run(`${r.name}:stop`, () => api.resourceAction(r.name, 'stop'), `${r.name} stopped`);
    } else {
      const verb = action === 'start' ? 'started' : 'restarted';
      await run(`${r.name}:${action}`, () => api.restartChecked(r.name), (result) => (result.ok ? `${r.name} ${verb}` : `${r.name} ${verb}, but reported a problem. Open it to see what's wrong.`));
    }
    await reload();
  };

  const setBoot = async (r: Resource, enabled: boolean) => {
    if (!enabled && (r.boot.source === 'category' || r.dependents.length)) {
      const body: ReactNode = (
        <>
          {r.boot.source === 'category' && (
            <p>{r.name} starts as part of the {r.category} group. To leave it out, it will be stopped now and moved to the [disabled] folder. You can turn it back on any time.</p>
          )}
          {r.dependents.length > 0 && <p>These resources need it and may fail: {nameList(r.dependents)}.</p>}
        </>
      );
      if (!await confirm({ title: `Don't start ${r.name} with the server?`, body, confirm: 'Turn off', danger: r.dependents.length > 0 })) return;
    }
    await run(`${r.name}:boot`, () => api.setBoot(r.name, enabled), enabled ? `${r.name} will start with the server` : `${r.name} will not start with the server`);
    await reload();
  };

  return { busy, act, setBoot };
}

function ResourceDetail({ resource, serverOnline, onClose, reload }: { resource: Resource; serverOnline: boolean; onClose: () => void; reload: () => Promise<unknown> | void }) {
  const { busy, act, setBoot } = useResourceActions(reload);
  const { run, busy: removing } = useAction();
  const confirm = useConfirm();
  const canLeave = useCanLeave();
  const isRunning = resource.state === 'started';
  const [problems, setProblems] = useState<Problem[]>([]);
  const [sqlFiles, setSqlFiles] = useState<string[]>([]);

  const loadExtras = () => {
    api.problems(true).then((all) => setProblems(all.filter((p) => p.resource === resource.name))).catch(() => {});
    api.sqlFiles(resource.name).then(setSqlFiles).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadExtras, [resource.name]);

  const runSql = async (file: string) => {
    const ok = await confirm({
      title: `Run ${file}?`,
      body: <p>This changes your database, so a backup of it is made first. Only run it if you trust {resource.name}, and only once unless its instructions say otherwise.</p>,
      confirm: 'Back up and run',
    });
    if (ok) await run(file, () => api.runSql(resource.name, file), `${file} ran. Restart ${resource.name} to use it.`);
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${resource.name}?`,
      body: (
        <>
          <p>It will be stopped and moved to Recently removed, where you can restore it.</p>
          {resource.dependents.length > 0 && <p>These resources need it and will fail: {nameList(resource.dependents)}.</p>}
        </>
      ),
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const result = await run('remove', () => api.removeResource(resource.name), `${resource.name} removed`);
    if (result) { await reload(); onClose(); }
  };

  return (
    <Drawer onClose={onClose} label={resource.name}>
      <header className="drawer-head">
        <div>
          <ResourceBadge state={resource.state} problem={resource.problem} />
          <h2>{resource.name}</h2>
          <p className="muted-note">
            {[resource.version && `Version ${resource.version}`, resource.author && `by ${resource.author}`, resource.category].filter(Boolean).join(' · ')}
          </p>
          {resource.description && <p className="drawer-desc">{resource.description}</p>}
        </div>
        <Button variant="ghost" onClick={async () => { if (await canLeave()) onClose(); }}>Close</Button>
      </header>

      <div className="drawer-controls">
        <div className="button-row">
          {isRunning ? (
            <>
              <Button variant="primary" icon={<RotateCw size={15} />} busy={busy === `${resource.name}:restart`} disabled={!serverOnline || !resource.canStop} onClick={() => act(resource, 'restart')}>Restart</Button>
              <Button icon={<Square size={14} />} busy={busy === `${resource.name}:stop`} disabled={!serverOnline || !resource.canStop} onClick={() => act(resource, 'stop')}>Stop</Button>
            </>
          ) : (
            <Button variant="primary" icon={<Play size={15} />} busy={busy === `${resource.name}:start`} disabled={!serverOnline} onClick={() => act(resource, 'start')}>Start</Button>
          )}
        </div>
        <label className="boot-switch">
          <Toggle checked={resource.boot.enabled} disabled={!resource.canStop || busy === `${resource.name}:boot`} onChange={(v) => setBoot(resource, v)} label="Start with the server" />
          <span>Start with the server</span>
        </label>
      </div>

      {!resource.canStop && <Notice kind="info">The app uses {resource.name} to talk to the server, so it has to stay on.</Notice>}
      {resource.problem && !problems.length && <Notice>{resource.problem}. Check the Console page for details.</Notice>}
      {problems.length > 0 && <ProblemList problems={problems} onChanged={loadExtras} />}
      {resource.dependencies.length > 0 && (
        <div className="chip-line">
          <span className="muted-note">Needs</span>
          {resource.dependencies.map((d) => <span key={d} className={`chip ${resource.missingDependencies.includes(d) ? 'chip-bad' : ''}`}>{d}</span>)}
        </div>
      )}
      {sqlFiles.length > 0 && (
        <div className="sql-box">
          <p><Database size={15} /> Database files that came with this resource:</p>
          {sqlFiles.map((f) => (
            <div key={f} className="sql-row">
              <code>{f}</code>
              <Button busy={removing === f} onClick={() => runSql(f)}>Run</Button>
            </div>
          ))}
        </div>
      )}

      <SettingsEditor
        scope={resource.name}
        restartLabel={isRunning ? 'Save and restart resource' : 'Save and start resource'}
        onRestart={serverOnline && resource.canStop ? async () => { const result = await api.restartChecked(resource.name); await reload(); return result; } : undefined}
        restartHint="Changes apply the next time this resource starts."
      />

      <footer className="drawer-foot button-row">
        <Button variant="ghost" icon={<FolderOpen size={15} />} onClick={async () => { if (await canLeave()) openFilesAt(resource.folder); }}>Browse all its files</Button>
        {resource.canRemove && (
          <Button variant="ghost" className="text-danger" icon={<Trash2 size={15} />} busy={removing === 'remove'} onClick={remove}>Remove this resource</Button>
        )}
      </footer>
    </Drawer>
  );
}

function InstallResult({ item, serverOnline, onDone }: { item: InstalledResource; serverOnline: boolean; onDone: () => void }) {
  const [boot, setBoot] = useState(true);
  const [start, setStart] = useState(serverOnline);
  const [ranSql, setRanSql] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const { busy, run } = useAction();

  const runSql = async (file: string) => {
    const r = await run(file, () => api.runSql(item.name, file), `${file} ran successfully`);
    if (r) setRanSql((list) => [...list, file]);
  };
  const finish = async () => {
    const r = await run('finish', () => api.activate(item.name, boot, start && serverOnline), start && serverOnline ? `${item.name} started` : `${item.name} is ready`);
    if (r) { setFinished(true); onDone(); }
  };

  return (
    <div className="install-result">
      <h3>{item.name}{item.version && <small> v{item.version}</small>}</h3>
      {item.description && <p className="muted-note">{item.description}</p>}
      {item.missingDependencies.length > 0 && <Notice>It needs resources you do not have: {item.missingDependencies.join(', ')}. Install those first or it will not start.</Notice>}
      {item.sqlFiles.length > 0 && (
        <div className="sql-box">
          <p><Database size={15} /> It comes with database files. Most resources need these run once. Run them only if you trust this resource.</p>
          {item.sqlFiles.map((f) => (
            <div key={f} className="sql-row">
              <code>{f}</code>
              <Button busy={busy === f} disabled={ranSql.includes(f)} onClick={() => runSql(f)}>{ranSql.includes(f) ? 'Done' : 'Run'}</Button>
            </div>
          ))}
        </div>
      )}
      {finished ? <p className="muted-note">All set.</p> : (
        <>
          <label className="boot-switch"><Toggle checked={boot} onChange={setBoot} label="Start with the server" /><span>Start with the server</span></label>
          <label className="boot-switch"><Toggle checked={start && serverOnline} disabled={!serverOnline} onChange={setStart} label="Start it now" /><span>Start it now{!serverOnline && ' (server is off)'}</span></label>
          <Button variant="primary" busy={busy === 'finish'} onClick={finish}>Finish</Button>
        </>
      )}
    </div>
  );
}

const INSTALL_PHASES: Record<string, string> = {
  downloading: 'Downloading',
  receiving: 'Receiving the file',
  unpacking: 'Unpacking. Large resources can take a few minutes',
  checking: 'Checking what\'s inside',
  installing: 'Installing',
};

function AddResource({ serverOnline, startUrl, onClose, reload }: { serverOnline: boolean; startUrl: string; onClose: () => void; reload: () => Promise<unknown> | void }) {
  const [mode, setMode] = useState<'github' | 'zip'>('github');
  const [url, setUrl] = useState(startUrl);
  const [installed, setInstalled] = useState<InstalledResource[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const settings = usePoll(api.settings, 0);
  const { busy, run } = useAction();
  const working = busy === 'install';

  // Large installs run for a while, so keep showing what stage they're at.
  useEffect(() => {
    if (!working) { setPhase(null); return undefined; }
    const timer = setInterval(() => {
      api.installStatus().then((s) => setPhase(s.phase ? `${INSTALL_PHASES[s.phase] || 'Working'}${s.detail ? ` (${s.detail})` : ''}` : null)).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [working]);

  const done = async (result?: { installed?: InstalledResource[] }) => {
    if (result?.installed) { setInstalled(result.installed); await reload(); }
  };
  const fromGithub = async () => done(await run('install', () => api.installGithub(url.trim())));
  const fromFile = async (file?: File) => {
    if (!file) return;
    setProgress(0);
    const result = await run('install', () => api.installUpload(file, setProgress));
    setProgress(null);
    await done(result);
  };
  const fromPc = async (type: 'file' | 'folder') => done(await run('install', () => api.installPick(type)));

  const uploading = progress !== null && progress < 1;
  const canPick = Boolean(settings.data?.desktop);

  return (
    <Modal title="Add a resource" onClose={() => { if (!working) onClose(); }} footer={installed ? <Button onClick={onClose}>Close</Button> : undefined}>
      {installed ? installed.map((item) => <InstallResult key={item.name} item={item} serverOnline={serverOnline} onDone={() => reload()} />) : (
        <>
          <Notice kind="info">Resources run with full access to your server. Only add ones from people you trust.</Notice>
          <Segmented
            label="Source"
            value={mode}
            onChange={setMode}
            options={[{ value: 'github', label: 'GitHub link' }, { value: 'zip', label: canPick ? 'From this PC' : 'Upload a file' }]}
          />
          {mode === 'github' ? (
            <div className="stack-tight">
              <label className="input-label" htmlFor="github-url">GitHub link</label>
              <div className="input-row">
                <input
                  id="github-url"
                  className="input"
                  placeholder="https://github.com/owner/resource"
                  value={url}
                  disabled={working}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) fromGithub(); }}
                />
                <Button variant="primary" icon={<Download size={16} />} busy={working} disabled={!url.trim()} onClick={fromGithub}>Install</Button>
              </div>
            </div>
          ) : (
            <div className="stack-tight">
              <input ref={fileRef} className="sr-only" type="file" accept=".zip,.rar,.7z" onChange={(e) => { fromFile(e.target.files?.[0]); e.target.value = ''; }} />
              {canPick ? (
                <>
                  <div className="button-row">
                    <Button variant="primary" icon={<Upload size={16} />} busy={working} onClick={() => fromPc('file')}>Choose a zip, rar or 7z</Button>
                    <Button icon={<FolderOpen size={16} />} disabled={working} onClick={() => fromPc('folder')}>Choose a folder</Button>
                  </div>
                  <p className="muted-note">Large resources are fine here, because they're read straight from your drive. Choosing a folder copies it and leaves the original where it is.</p>
                </>
              ) : (
                <>
                  <Button variant="primary" icon={<Upload size={16} />} busy={working} onClick={() => fileRef.current?.click()}>Choose a zip, rar or 7z</Button>
                  <p className="muted-note">Large files work, but they take a while to send over Wi-Fi. For anything over 1 GB, it's faster to use the app on your PC.</p>
                </>
              )}
            </div>
          )}
          {uploading && (
            <div className="upload-progress" role="progressbar" aria-valuenow={Math.round((progress as number) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <div className="upload-bar"><span style={{ width: `${Math.round((progress as number) * 100)}%` }} /></div>
              <span>Sending {Math.round((progress as number) * 100)}%. Please keep this open.</span>
            </div>
          )}
          {working && !uploading && (
            <div className="progress-line"><Loader2 size={16} className="spin" /><span>{phase || 'Working'}...</span></div>
          )}
        </>
      )}
    </Modal>
  );
}

function RecentlyRemoved({ items, reload }: { items: TrashItem[]; reload: () => void }) {
  const { busy, run } = useAction();
  if (!items.length) return null;
  const restore = async (item: TrashItem) => {
    const r = await run(item.id, () => api.restoreTrash(item.id), `${item.name} restored`);
    if (r) reload();
  };
  return (
    <section className="card">
      <h3 className="card-title"><Undo2 size={16} />Recently removed</h3>
      <ul className="version-list">
        {items.map((item) => (
          <li key={item.id}>
            <div><div>{item.name}</div><div className="muted-note">{formatWhen(item.removedAt)}</div></div>
            <Button icon={<Undo2 size={15} />} busy={busy === item.id} onClick={() => restore(item)}>Restore</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Resources() {
  const { data, error, refresh } = usePoll(api.resources, 4000);
  const trash = usePoll(api.trash, 0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [initial] = useState(takeResourceTargets);
  const [selected, setSelected] = useState<string | null>(initial.name);
  const [adding, setAdding] = useState<string | null>(initial.addUrl);
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);

  // Another part of the app asked to open a resource or install something.
  useEffect(() => {
    const onTarget = () => {
      const target = takeResourceTargets();
      if (target.name) setSelected(target.name);
      if (target.addUrl) { setSelected(null); setAdding(target.addUrl); }
    };
    window.addEventListener('qbc-resources-target', onTarget);
    return () => window.removeEventListener('qbc-resources-target', onTarget);
  }, []);

  const reload = async () => { await refresh(); await trash.refresh(); };
  const { busy, act, setBoot } = useResourceActions(reload);

  const resources = useMemo(() => data?.resources || [], [data]);
  const counts = useMemo(() => ({
    all: resources.length,
    running: resources.filter((r) => matchesFilter(r, 'running')).length,
    stopped: resources.filter((r) => matchesFilter(r, 'stopped')).length,
    off: resources.filter((r) => matchesFilter(r, 'off')).length,
    problems: resources.filter((r) => matchesFilter(r, 'problems')).length,
  }), [resources]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, Resource[]>();
    for (const r of resources) {
      if (!matchesFilter(r, filter)) continue;
      if (q && !`${r.name} ${r.description} ${r.category}`.toLowerCase().includes(q)) continue;
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)?.push(r);
    }
    return [...map.entries()];
  }, [resources, query, filter]);

  const selectedResource = resources.find((r) => r.name === selected) || null;
  const serverOnline = Boolean(data?.serverOnline);

  const rescan = async () => {
    setRefreshing(true);
    try {
      await api.refresh();
      await refresh();
      toast('Checked for new resources');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label="Reading resources" />;

  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Resources</h1>
          <p className="muted-note">{counts.running} of {counts.all} running</p>
        </div>
        <div className="button-row">
          <Button variant="ghost" icon={<RefreshCw size={16} />} busy={refreshing} disabled={!serverOnline} onClick={rescan}>Rescan</Button>
          <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setAdding('')}>Add resource</Button>
        </div>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {!serverOnline && <Notice kind="info">The server is off, so resources can't be started or stopped right now. You can still edit settings.</Notice>}

      <div className="filter-bar">
        <label className="search">
          <Search size={16} />
          <input type="search" placeholder="Search resources" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="filter-chips" role="group" aria-label="Filter">
          {([['all', 'All'], ['running', 'Running'], ['stopped', 'Not running'], ['off', 'Off at boot'], ['problems', 'Problems']] as [Filter, string][]).map(([key, label]) => (
            <button key={key} className={`filter-chip ${filter === key ? 'active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}<span>{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && <Empty icon={<PackageOpen size={30} />} title="No resources match">Try a different search or filter.</Empty>}

      {groups.map(([category, items]) => (
        <section key={category} className="resource-group">
          <h2 className="group-title">{category}<span>{items.length}</span></h2>
          <ul className="resource-list">
            {items.map((r) => {
              const running = r.state === 'started';
              return (
                <li key={r.name} className="resource-row">
                  <button className="resource-open" onClick={() => setSelected(r.name)}>
                    <span className="resource-name">{r.name}</span>
                    {r.description && <span className="resource-desc">{r.description}</span>}
                  </button>
                  <div className="resource-state"><ResourceBadge state={r.state} problem={r.problem} /></div>
                  <div className="resource-boot">
                    <Toggle checked={r.boot.enabled} disabled={!r.canStop || busy === `${r.name}:boot`} onChange={(v) => setBoot(r, v)} label={`Start ${r.name} with the server`} />
                    <span className="boot-label">At boot</span>
                  </div>
                  <div className="resource-actions">
                    {running ? (
                      <>
                        <Button variant="ghost" title={`Restart ${r.name}`} aria-label={`Restart ${r.name}`} icon={<RotateCw size={16} />} busy={busy === `${r.name}:restart`} disabled={!serverOnline || !r.canStop} onClick={() => act(r, 'restart')} />
                        <Button variant="ghost" title={`Stop ${r.name}`} aria-label={`Stop ${r.name}`} icon={<Square size={15} />} busy={busy === `${r.name}:stop`} disabled={!serverOnline || !r.canStop} onClick={() => act(r, 'stop')} />
                      </>
                    ) : (
                      <Button variant="ghost" title={`Start ${r.name}`} aria-label={`Start ${r.name}`} icon={<Play size={16} />} busy={busy === `${r.name}:start`} disabled={!serverOnline} onClick={() => act(r, 'start')} />
                    )}
                    <Button variant="ghost" title={`Open ${r.name}`} aria-label={`Open ${r.name}`} icon={<ChevronRight size={17} />} onClick={() => setSelected(r.name)} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <RecentlyRemoved items={trash.data || []} reload={reload} />

      <p className="muted-note hint-line"><Link2 size={14} /> Tip: open a resource to change its settings without touching any code.</p>

      {selectedResource && <ResourceDetail key={selectedResource.name} resource={selectedResource} serverOnline={serverOnline} onClose={() => setSelected(null)} reload={reload} />}
      {adding !== null && <AddResource serverOnline={serverOnline} startUrl={adding} onClose={() => setAdding(null)} reload={reload} />}
    </div>
  );
}
