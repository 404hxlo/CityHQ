import {
  ArrowLeft, ChevronRight, Download, Ellipsis, File as FileIcon, FileCode, FileImage, FileMusic, FilePlay, Folder, FolderOpen, FolderPlus,
  Pencil, Replace, RotateCw, Search, Trash2, Undo2, Upload, X,
} from 'lucide-react';
import {
  useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode,
} from 'react';
import {
  api, SERVER_SCOPE, type BrowseEntry, type ChangedScript, type FileChangeResult, type FileDetails, type Problem, type RestartResult, type SearchResponse,
} from '../api';
import { takeFilesTarget } from '../nav';
import { ProblemList } from '../Problems';
import { FileEditor } from '../SettingsEditor';
import {
  Button, Empty, formatBytes, formatWhen, Modal, Notice, Segmented, Spinner, useConfirm, usePoll, useToast,
} from '../ui';

type SearchMode = 'names' | 'text';
interface Selection { path: string; line?: number }

const KEEP_DAYS = 30;
const TYPE_LABELS: Record<string, string> = {
  ytd: 'GTA texture pack', ydr: 'GTA model', ydd: 'GTA clothing or character model', yft: 'GTA vehicle or prop model',
  ymap: 'GTA map placement', ytyp: 'GTA map object definitions', ybn: 'GTA collision data', ycd: 'GTA animation',
  awc: 'GTA audio', rel: 'GTA audio data', dat: 'Game data', ttf: 'Font', otf: 'Font', woff: 'Font', woff2: 'Font',
  ogg: 'Sound', mp3: 'Sound', wav: 'Sound', m4a: 'Sound', flac: 'Sound', mp4: 'Video', webm: 'Video', mov: 'Video',
  zip: 'Zip archive', rar: 'RAR archive', '7z': '7-Zip archive',
  fxap: 'Protected script (Cfx asset escrow)', exe: 'Program', dll: 'Program library',
};

const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '');
const typeLabel = (name: string) => TYPE_LABELS[extensionOf(name)] || (name.includes('.') ? `${extensionOf(name).toUpperCase()} file` : 'File');
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.split('/').pop() || path;
const childPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const countLabel = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isInside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** The quick checks, so a typo is caught in the box; the app checks everything again. */
function nameProblem(name: string): string | null {
  if (!name) return 'Type a name first.';
  if (/[<>:"/\\|?*]/.test(name)) return 'A name can\'t have any of these in it: < > : " / \\ | ? *';
  if (name.endsWith('.')) return 'A name can\'t end with a dot.';
  return null;
}

/** What the game does with a changed file, in a sentence. */
function scriptNote(script: ChangedScript | null, online: boolean): string | null {
  if (!script) return null;
  if (!online || script.state === 'offline') return `The server is off, so ${script.name} picks this up when the server starts.`;
  if (script.state !== 'started') return `${script.name} isn't running, so this is used the next time it starts.`;
  if (script.loadscreen) return `Players see this the next time they join, after ${script.name} restarts. Restarting a loading screen doesn't affect anyone who's playing.`;
  if (script.stream) return `Restart ${script.name} so the server sends players the new file. Anyone who's on now may need to reconnect to see it.`;
  return `Players get this after ${script.name} restarts.`;
}
const canRestartNow = (script: ChangedScript | null, online: boolean): script is ChangedScript => Boolean(script && online && script.state === 'started' && script.canRestart);

// Remembered while the app is open, so visiting another page keeps your place.
let lastFolder = '';

function EntryIcon({ type, kind }: { type: string; kind?: string }) {
  if (type === 'dir') return <Folder size={18} className="entry-icon entry-dir" />;
  if (kind === 'image') return <FileImage size={18} className="entry-icon" />;
  if (kind === 'audio') return <FileMusic size={18} className="entry-icon" />;
  if (kind === 'video') return <FilePlay size={18} className="entry-icon" />;
  if (kind === 'text') return <FileCode size={18} className="entry-icon" />;
  return <FileIcon size={18} className="entry-icon" />;
}

function Breadcrumb({ path, onOpen }: { path: string; onOpen: (p: string) => void }) {
  const parts = path ? path.split('/') : [];
  return (
    <nav className="breadcrumb" aria-label="Folder path">
      <button className={parts.length ? '' : 'current'} onClick={() => onOpen('')}>Server files</button>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/');
        return (
          <span key={target} className="crumb">
            <ChevronRight size={14} />
            <button className={i === parts.length - 1 ? 'current' : ''} onClick={() => onOpen(target)}>{part}</button>
          </span>
        );
      })}
    </nav>
  );
}

function EntryRow({ entry, active, onClick }: { entry: BrowseEntry; active: boolean; onClick: () => void }) {
  const meta = entry.type === 'dir'
    ? (typeof entry.items === 'number' ? countLabel(entry.items) : 'Folder')
    : `${formatBytes(entry.size)} · ${formatWhen(entry.modified)}`;
  return (
    <li>
      <button className={`entry-row ${active ? 'active' : ''}`} aria-current={active ? 'true' : undefined} onClick={onClick}>
        <EntryIcon type={entry.type} kind={entry.kind} />
        <span className="entry-text">
          <span className="entry-name">{entry.name}</span>
          <span className="entry-meta">{meta}</span>
        </span>
        {entry.type === 'dir' && <ChevronRight size={16} className="entry-go" />}
      </button>
    </li>
  );
}

interface MenuItem { label: string; icon: ReactNode; danger?: boolean; onSelect: () => void }

/** The ⋯ button: a short list of less common actions. */
function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    ref.current?.querySelector<HTMLButtonElement>('.menu-item')?.focus();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="more-menu" ref={ref}>
      <button type="button" className="btn btn-default more-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={label}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={`menu-item ${item.danger ? 'is-danger' : ''}`} onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface NameRequest {
  title: string; label: string; initial: string; confirm: string; hint?: string;
  submit: (name: string) => Promise<void>;
}

/** Asks for a name, for a new folder or a rename. Mistakes are shown in the box, not as toasts. */
function NameDialog({ request, onClose }: { request: NameRequest; onClose: () => void }) {
  const [name, setName] = useState(request.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Like File Explorer: the name is picked out, without the .webp or .lua after it.
    const dot = request.initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : request.initial.length);
  }, [request.initial]);

  const submit = async () => {
    const wanted = name.trim();
    const problem = nameProblem(wanted);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await request.submit(wanted);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={request.title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{request.confirm}</Button>
        </>
      )}
    >
      <form className="name-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="input-label" htmlFor="name-field">{request.label}</label>
        <input
          id="name-field"
          ref={inputRef}
          className="input"
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setName(e.target.value); setError(null); }}
        />
      </form>
      {error && <Notice kind="error">{error}</Notice>}
      {request.hint && <p className="muted-note">{request.hint}</p>}
    </Modal>
  );
}

/** A sound or video, with a plain note when this PC can't play its format. */
function MediaPreview({ kind, src }: { kind: 'audio' | 'video'; src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`media-preview media-${kind}`}>
      {kind === 'audio'
        ? <audio controls preload="metadata" src={src} onError={() => setFailed(true)} />
        : <video controls preload="metadata" src={src} onError={() => setFailed(true)} />}
      {failed && <p className="muted-note">This {kind === 'audio' ? 'sound' : 'video'} can't be played here, but the game may still be able to use it.</p>}
    </div>
  );
}

interface ViewerActions {
  onReplace: (file: File, details: FileDetails) => void;
  onRename: (details: FileDetails) => void;
  onDelete: (details: FileDetails) => void;
}

function FileViewer({
  selection, online, version, busy, actions, onBack, onDirtyChange,
}: {
  selection: Selection; online: boolean; version: number; busy: boolean; actions: ViewerActions;
  onBack: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const { path, line } = selection;
  const { data: info, error } = usePoll(() => api.fileDetails(path), 0, [path, version]);
  const confirm = useConfirm();
  const picker = useRef<HTMLInputElement>(null);

  const current = info?.path === path ? info : null;
  const scope = current?.editor.scope;
  const changeable = Boolean(current?.canChange && !current.lock);
  // A new address after a replace, so the picture, sound or video shows the new file.
  const rawSrc = `${api.rawUrl(path)}&v=${version}`;

  const restartServer = async () => {
    const ok = await confirm({ title: 'Restart the server now?', body: <p>Changes to server.cfg apply after a restart. Players are saved and disconnected first.</p>, confirm: 'Restart' });
    if (ok) await api.restart();
  };
  const restartResource = () => api.restartChecked(scope as string);

  const isServer = scope === SERVER_SCOPE;
  let onRestart: (() => Promise<unknown>) | undefined;
  let restartLabel: string | undefined;
  if (isServer && online) { onRestart = restartServer; restartLabel = 'Save and restart server'; }
  if (!isServer && current?.resourceRunning && online) { onRestart = restartResource; restartLabel = `Save and restart ${scope}`; }

  return (
    <div className="file-viewer">
      <header className="viewer-head">
        <Button variant="ghost" className="files-back" icon={<ArrowLeft size={16} />} onClick={onBack}>Back</Button>
        <div className="viewer-title">
          <h2>{nameOf(path)}</h2>
          <p className="muted-note">
            {current
              ? `${typeLabel(current.name)} · ${formatBytes(current.size)} · Changed ${formatWhen(current.modified).replace(/^Today at/, 'today at')}`
              : ' '}
          </p>
        </div>
        {current && (
          <div className="viewer-actions">
            {changeable && (
              <>
                <Button variant="primary" icon={<Replace size={15} />} busy={busy} onClick={() => picker.current?.click()}>Replace…</Button>
                <input
                  ref={picker}
                  type="file"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) actions.onReplace(file, current);
                  }}
                />
              </>
            )}
            {current.canDownload && (
              <a className="btn btn-default" href={api.rawUrl(path, true)} download={current.name}><Download size={16} /><span>Download</span></a>
            )}
            {changeable && (
              <MoreMenu
                label={`More for ${current.name}`}
                items={[
                  { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => actions.onRename(current) },
                  { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => actions.onDelete(current) },
                ]}
              />
            )}
          </div>
        )}
      </header>

      {current?.lock === 'helper' && <p className="muted-note">This is part of CityHQ's helper (qb-control). CityHQ keeps it up to date itself, so it can't be changed here.</p>}
      {error && <Notice kind="error">{error}</Notice>}
      {!error && !current && <Spinner label="Opening file" />}

      {current?.kind === 'text' && (
        <FileEditor
          key={`${current.editor.scope}|${current.editor.path}|${line ?? ''}|${version}`}
          scope={current.editor.scope}
          path={current.editor.path}
          line={line}
          restartLabel={restartLabel}
          onRestart={onRestart}
          restartHint="Changes apply the next time this starts."
          onDirtyChange={onDirtyChange}
        />
      )}
      {current?.kind === 'image' && (
        <div className="image-preview">
          <img src={rawSrc} alt={current.name} />
        </div>
      )}
      {(current?.kind === 'audio' || current?.kind === 'video') && (
        current.canDownload
          ? <MediaPreview key={rawSrc} kind={current.kind} src={rawSrc} />
          : <Empty icon={<FilePlay size={30} />} title={typeLabel(current.name)}>This file can't be played here.</Empty>
      )}
      {current?.kind === 'binary' && (
        <Empty icon={<FileIcon size={30} />} title={typeLabel(current.name)}>
          {changeable ? 'This file can\'t be shown here, but you can replace it with a new one or download it.' : 'This file can\'t be shown here.'}
        </Empty>
      )}
      {current?.kind === 'large' && (
        <Empty icon={<FileCode size={30} />} title="Too large to open here">
          This file is {formatBytes(current.size)}, and files can be opened here up to 2 MB.{changeable ? ' You can still replace it with a new one.' : ''}
        </Empty>
      )}
    </div>
  );
}

type DoneKind = 'replace' | 'add' | 'folder' | 'rename' | 'delete';
/** What the last change did, for the bar under the search: restart its script, or undo it. */
interface Done {
  kind: DoneKind;
  message: string;
  changes: { id: string; title: string }[];
  /** The files and folders it changed, as they are named after it. */
  paths: string[];
  script: ChangedScript | null;
  notes: string[];
  from?: string;
  to?: string;
  undone?: string;
  restart?: { ok: boolean; problems: Problem[]; error?: string };
}

function ChangeBar({
  done, online, busy, onRestart, onUndo, onClose,
}: {
  done: Done; online: boolean; busy: string | null;
  onRestart: () => void; onUndo: (thenRestart: boolean) => void; onClose: () => void;
}) {
  const restarted = done.restart?.ok;
  const failed = done.restart && !done.restart.ok ? done.restart : null;
  const note = restarted ? null : scriptNote(done.script, online);
  return (
    <div className="change-bar" role="status">
      <div className="change-bar-body">
        <p className="change-bar-title">{done.undone || done.message}</p>
        {note && <p>{note}</p>}
        {restarted && done.script && <p>{done.script.name} restarted{done.script.loadscreen ? '. Players see the new loading screen the next time they join.' : ' without problems.'}</p>}
        {!done.undone && done.notes.map((n) => <p key={n}>{n}</p>)}
        {failed && (
          <div className="change-bar-problem">
            <Notice kind="error">{failed.error || `${done.script?.name} reported a problem when it restarted.`}</Notice>
            {failed.problems.length > 0 && <ProblemList problems={failed.problems} />}
          </div>
        )}
        <div className="button-row change-bar-actions">
          {failed && done.changes.length > 0 && !done.undone && (
            <Button variant="primary" icon={<Undo2 size={15} />} busy={busy === 'undo'} onClick={() => onUndo(true)}>Undo my change and restart</Button>
          )}
          {!failed && !restarted && canRestartNow(done.script, online) && (
            <Button variant="primary" icon={<RotateCw size={15} />} busy={busy === 'restart'} disabled={Boolean(busy)} onClick={onRestart}>Restart {done.script.name}</Button>
          )}
          {!failed && done.changes.length > 0 && !done.undone && (
            <Button icon={<Undo2 size={15} />} busy={busy === 'undo'} disabled={Boolean(busy)} onClick={() => onUndo(false)}>Undo</Button>
          )}
        </div>
      </div>
      <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
    </div>
  );
}

interface Uploading { verb: string; name: string; index: number; total: number; fraction: number }

/** The files in a drop, and how many folders were in it (those can't be added yet). */
function droppedFiles(transfer: DataTransfer) {
  const files: File[] = [];
  let folders = 0;
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders += 1; continue; }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

export function Files({ online }: { online: boolean }) {
  const [initial] = useState(takeFilesTarget);
  const [folder, setFolderState] = useState(() => {
    if (initial.folder !== null) lastFolder = initial.folder;
    return lastFolder;
  });
  const [selected, setSelected] = useState<Selection | null>(initial.file);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('names');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [uploading, setUploading] = useState<Uploading | null>(null);
  const [naming, setNaming] = useState<NameRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);
  const dragDepth = useRef(0);
  const addPicker = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const confirm = useConfirm();
  const toast = useToast();
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

  const listing = usePoll(() => api.browse(folder), 0, [folder]);
  const here = listing.loading ? null : listing.data;
  // From the last answer while the next folder loads, so the buttons don't blink.
  const canChange = Boolean(listing.data?.canChange);
  const canAdd = canChange && listing.data?.lock !== 'helper';

  const setFolder = useCallback((next: string) => {
    lastFolder = next;
    setFolderState(next);
    setQuery('');
  }, []);

  // A folder that was removed or renamed sends you back to the top instead of a dead end.
  useEffect(() => {
    if (listing.error && folder) setFolder('');
  }, [listing.error, folder, setFolder]);

  const trimmed = query.trim();
  const minLength = 2;
  useEffect(() => {
    setSearchError(null);
    if (trimmed.length < minLength) {
      setResults(null);
      setSearching(false);
      return undefined;
    }
    let live = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(trimmed, mode, folder);
        if (live) setResults(response);
      } catch (err) {
        if (live) setSearchError((err as Error).message);
      } finally {
        if (live) setSearching(false);
      }
    }, mode === 'text' ? 550 : 250);
    return () => { live = false; clearTimeout(timer); };
  }, [trimmed, mode, folder]);

  // A file dropped beside the drop area must not open in place of the page.
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const guardDiscard = async () => {
    if (!dirty.current) return true;
    return confirm({ title: 'Discard your changes?', body: <p>You have changes that are not saved yet.</p>, confirm: 'Discard', danger: true });
  };

  const openFile = async (next: Selection) => {
    if (next.path === selected?.path && next.line === selected?.line) return;
    if (await guardDiscard()) setSelected(next);
  };

  const closeFile = async () => {
    if (await guardDiscard()) setSelected(null);
  };

  // Another page asked to show a file while this one is already open.
  useEffect(() => {
    const onTarget = () => {
      const target = takeFilesTarget();
      if (target.folder !== null) setFolder(target.folder);
      if (target.file) openFile(target.file);
    };
    window.addEventListener('qbc-files-target', onTarget);
    return () => window.removeEventListener('qbc-files-target', onTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEntry = (entry: BrowseEntry) => {
    if (entry.type === 'dir') setFolder(entry.path);
    else openFile({ path: entry.path });
  };

  // On a phone the file replaces the list, so start at the top of it instead of mid-page.
  const viewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && window.matchMedia('(max-width: 760px)').matches) viewRef.current?.scrollIntoView({ block: 'start' });
  }, [selected]);

  /**
   * Reads the folder again. The open file is only reloaded when the change was to it, so an
   * unsaved edit in the editor is never lost to a change somewhere else.
   */
  const afterChange = (touched: string[]) => {
    listing.refresh();
    if (selected && touched.some((p) => isInside(selected.path, p))) {
      dirty.current = false;
      setVersion((v) => v + 1);
    }
  };

  const finish = (kind: DoneKind, message: string, list: FileChangeResult[], extra: Partial<Done> = {}) => {
    const paths = list.map((r) => r.path);
    setDone({
      kind,
      message,
      changes: list.map((r) => r.change).filter((c): c is { id: string; title: string } => Boolean(c)),
      paths,
      script: list.find((r) => r.script)?.script || null,
      notes: list.map((r) => r.note).filter((n): n is string => Boolean(n)),
      ...extra,
    });
    afterChange(kind === 'replace' || kind === 'add' ? paths : []);
  };

  // ------------------------------------------------------------ adding and replacing
  const send = async (items: { file: File; target: string | null }[], into: string) => {
    const added: FileChangeResult[] = [];
    const replaced: FileChangeResult[] = [];
    const failed: string[] = [];
    for (const [index, { file, target }] of items.entries()) {
      const verb = target ? 'Replacing' : 'Adding';
      setUploading({ verb, name: file.name, index, total: items.length, fraction: 0 });
      const onProgress = (fraction: number) => setUploading({ verb, name: file.name, index, total: items.length, fraction });
      try {
        if (target) replaced.push(await api.replaceFile(target, file, onProgress));
        else added.push(await api.addFile(into, file, onProgress));
      } catch (err) {
        failed.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(null);
    return { added, replaced, failed };
  };

  const addFiles = async (files: File[]) => {
    if (!files.length || uploading || !canAdd) return;
    const into = folder;
    let check;
    try {
      check = await api.uploadCheck(into, files.map((f) => ({ name: f.name, size: f.size })));
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    if (check.problem) { toast(check.problem, 'error'); return; }
    const refused = check.files.filter((f) => f.problem);
    const plan = files
      .map((file, i) => ({ file, info: check.files[i] }))
      .filter(({ info }) => info && !info.problem)
      .map(({ file, info }) => ({ file, target: info.existing ? childPath(into, info.existing) : null }));
    if (!plan.length) {
      toast(refused[0]?.problem || 'Those files can\'t be added here.', 'error');
      return;
    }
    const replacing = plan.filter((p) => p.target);
    if (replacing.length) {
      const adding = plan.length - replacing.length;
      const names = replacing.map((p) => nameOf(p.target as string));
      const ok = await confirm({
        title: replacing.length === 1 ? `Replace ${names[0]}?` : `Replace ${replacing.length} files?`,
        body: (
          <>
            <p>{replacing.length === 1 ? `There's already a file named ${names[0]} in this folder.` : `These are already in this folder: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}.`}</p>
            <p>{replacing.length === 1 ? 'The old one is' : 'The old ones are'} kept for {KEEP_DAYS} days, so you can undo this.{adding ? ` The other ${plural(adding, 'file')} ${adding === 1 ? 'is' : 'are'} added too.` : ''}</p>
          </>
        ),
        confirm: adding ? 'Replace and add' : 'Replace',
      });
      if (!ok) return;
    }
    if (selected && replacing.some((p) => p.target === selected.path) && !(await guardDiscard())) return;
    const { added, replaced, failed } = await send(plan, into);
    const notes = [
      ...refused.map((f) => `Not added: ${f.name}. ${f.problem}`),
      ...failed.map((f) => `Didn't finish: ${f}`),
    ];
    if (!added.length && !replaced.length) {
      toast(notes[0] || 'Nothing was added.', 'error');
      return;
    }
    const named = (list: FileChangeResult[]) => (list.length === 1 ? nameOf(list[0].path) : plural(list.length, 'file'));
    const parts = [];
    if (added.length) parts.push(`Added ${named(added)}`);
    if (replaced.length) parts.push(`${parts.length ? 'replaced' : 'Replaced'} ${named(replaced)}`);
    const kept = replaced.length ? ` What was replaced is kept for ${KEEP_DAYS} days, so you can undo this.` : '';
    finish(added.length ? 'add' : 'replace', `${parts.join(' and ')} in ${nameOf(into) || 'the server folder'}.${kept}`, [...added, ...replaced], { notes });
  };

  const replaceOne = async (file: File, details: FileDetails) => {
    if (uploading) return;
    const oldType = extensionOf(details.name);
    const newType = extensionOf(file.name);
    if (oldType !== newType) {
      const ok = await confirm({
        title: `Use ${file.name} as ${details.name}?`,
        body: (
          <>
            <p>It's saved under the name {details.name}, so whatever uses that name picks it up.</p>
            <p>It's a {newType ? `.${newType}` : 'different kind of'} file and this one is {oldType ? `a .${oldType}` : 'without a type'}. Pictures and sounds often still work, but game files and scripts need the same kind of file.</p>
          </>
        ),
        confirm: 'Replace anyway',
      });
      if (!ok) return;
    }
    if (!(await guardDiscard())) return;
    try {
      const check = await api.uploadCheck(parentOf(details.path), [{ name: details.name, size: file.size }]);
      const problem = check.problem || check.files[0]?.problem;
      if (problem) { toast(problem, 'error'); return; }
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const { replaced, failed } = await send([{ file, target: details.path }], parentOf(details.path));
    if (!replaced.length) { toast(failed[0] || 'The file wasn\'t replaced.', 'error'); return; }
    finish('replace', `${details.name} was replaced. The old one is kept for ${KEEP_DAYS} days, so you can undo this.`, replaced);
  };

  // ------------------------------------------------------------ folders, renaming, deleting
  const newFolder = () => setNaming({
    title: 'New folder',
    label: `Name of the new folder in ${nameOf(folder) || 'Server files'}`,
    initial: 'New folder',
    confirm: 'Make folder',
    submit: async (name) => {
      const result = await api.makeFolder(folder, name);
      finish('folder', `Made the folder ${name}.`, [result]);
    },
  });

  const renameAt = (path: string, isDir: boolean, isScript: boolean) => {
    const old = nameOf(path);
    setNaming({
      title: `Rename ${old}`,
      label: 'New name',
      initial: old,
      confirm: 'Rename',
      hint: isScript
        ? 'This folder is a script, and its folder name is the script\'s name. server.cfg has to use the new name to start it.'
        : !isDir && extensionOf(old) ? `Keep the .${extensionOf(old)} at the end, or the game and scripts may not know what kind of file it is.` : undefined,
      submit: async (name) => {
        if (selected && isInside(selected.path, path) && !(await guardDiscard())) return;
        const result = await api.renameItem(path, name);
        if (selected && isInside(selected.path, path)) {
          dirty.current = false;
          setSelected({ path: result.path + selected.path.slice(path.length) });
        }
        if (isInside(folder, path)) setFolder(result.path + folder.slice(path.length));
        finish('rename', `Renamed ${old} to ${name}.`, [result], { from: path, to: result.path });
      },
    });
  };

  const deleteAt = async (path: string, isDir: boolean, isScript: boolean) => {
    const name = nameOf(path);
    let body: ReactNode = <p>CityHQ keeps it for {KEEP_DAYS} days, so you can undo this.</p>;
    if (isDir) body = <p>Everything in it is kept for {KEEP_DAYS} days, so you can undo this.</p>;
    if (isScript) {
      body = (
        <>
          <p>This folder is the script {name}. It's removed the same way the Resources page removes scripts: it stops first, then it goes to Recently removed with its line in server.cfg.</p>
          <p>You can bring it back from there, or undo this.</p>
        </>
      );
    }
    const ok = await confirm({ title: `Delete ${name}?`, body, confirm: 'Delete', danger: true });
    if (!ok) return;
    if (selected && isInside(selected.path, path) && !(await guardDiscard())) return;
    setBusy('delete');
    try {
      const result = await api.deleteItem(path);
      if (selected && isInside(selected.path, path)) { dirty.current = false; setSelected(null); }
      if (isInside(folder, path)) setFolder(parentOf(path));
      finish('delete', result.removedScript
        ? `Removed the script ${result.removedScript}. It's in Recently removed on the Resources page.`
        : `Deleted ${name}. It's kept for ${KEEP_DAYS} days, so you can undo this.`, [result], { from: path });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const viewerActions: ViewerActions = {
    onReplace: replaceOne,
    onRename: (d) => renameAt(d.path, false, false),
    onDelete: (d) => deleteAt(d.path, false, false),
  };

  const folderIsScript = Boolean(here?.resource);
  const folderItems: MenuItem[] = here && folder && !here.lock && canChange ? [
    { label: 'Rename this folder', icon: <Pencil size={15} />, onSelect: () => renameAt(folder, true, folderIsScript) },
    { label: 'Delete this folder', icon: <Trash2 size={15} />, danger: true, onSelect: () => deleteAt(folder, true, folderIsScript) },
  ] : [];

  // ------------------------------------------------------------ the bar's buttons
  const restartScript = async () => {
    const script = done?.script;
    if (!script) return;
    setBusy('restart');
    let outcome: Done['restart'];
    try {
      const result: RestartResult = await api.restartChecked(script.name);
      outcome = { ok: result.ok, problems: result.problems || [] };
    } catch (err) {
      outcome = { ok: false, problems: [], error: (err as Error).message };
    }
    setBusy(null);
    setDone((d) => (d ? { ...d, restart: outcome } : d));
    if (outcome.ok) toast(`${script.name} restarted.`);
  };

  const undoLast = async (thenRestart: boolean) => {
    if (!done) return;
    if (selected && done.to && isInside(selected.path, done.to) && !(await guardDiscard())) return;
    setBusy('undo');
    let message = '';
    try {
      for (const change of [...done.changes].reverse()) message = (await api.undoChange(change.id)).message;
    } catch (err) {
      setBusy(null);
      toast((err as Error).message, 'error');
      afterChange(done.paths);
      return;
    }
    // Follow a rename back, and close a file that an undone add took away again.
    if (done.kind === 'rename' && done.from && done.to) {
      if (selected && isInside(selected.path, done.to)) setSelected({ path: done.from + selected.path.slice(done.to.length) });
      if (isInside(folder, done.to)) setFolder(done.from + folder.slice(done.to.length));
    }
    if ((done.kind === 'add' || done.kind === 'folder') && selected && done.paths.some((p) => isInside(selected.path, p))) {
      const stillThere = await api.fileDetails(selected.path).catch(() => null);
      if (!stillThere) setSelected(null);
    }
    let restart: Done['restart'];
    if (thenRestart && done.script) {
      try {
        const result = await api.restartChecked(done.script.name);
        restart = { ok: result.ok, problems: result.problems || [] };
      } catch (err) {
        restart = { ok: false, problems: [], error: (err as Error).message };
      }
    }
    setBusy(null);
    setDone({ ...done, undone: message || 'Undone.', restart });
    afterChange(done.kind === 'replace' || done.kind === 'add' ? done.paths : []);
  };

  // ------------------------------------------------------------ dragging files in
  const dropProps = canAdd && !uploading ? {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const { files, folders } = droppedFiles(e.dataTransfer);
      if (folders) toast(`Folders can't be dropped here yet${files.length ? ', so only the files were added' : ''}. Make the folder with New folder, open it, then drop its files in.`, 'error');
      addFiles(files);
    },
  } : {};

  const inSearch = trimmed.length >= minLength;
  const scopeName = folder ? folder.split('/').pop() : 'all server files';

  return (
    <div className={`files-page ${selected ? 'has-file' : ''}`}>
      <header className="page-head">
        <div>
          <h1>Files</h1>
          <p className="muted-note">Everything in your server folder</p>
        </div>
      </header>

      <div className="filter-bar">
        <label className="search">
          <Search size={16} />
          <input type="search" placeholder={`Search ${scopeName}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented
          label="Search in"
          value={mode}
          onChange={setMode}
          options={[{ value: 'names', label: 'File names' }, { value: 'text', label: 'Inside files' }]}
        />
      </div>

      {uploading && (
        <div className="change-bar" role="status">
          <div className="change-bar-body">
            <p className="change-bar-title">
              {uploading.total > 1 ? `${uploading.verb} ${uploading.index + 1} of ${uploading.total}: ${uploading.name}` : `${uploading.verb} ${uploading.name}`}
            </p>
            <div className="upload-progress" role="progressbar" aria-valuenow={Math.round(uploading.fraction * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <div className="upload-bar"><span style={{ width: `${Math.round(uploading.fraction * 100)}%` }} /></div>
              <span>{uploading.fraction >= 1 ? 'Putting it in place' : `Sending ${Math.round(uploading.fraction * 100)}%. Please keep this open.`}</span>
            </div>
          </div>
        </div>
      )}
      {!uploading && done && (
        <ChangeBar done={done} online={online} busy={busy} onRestart={restartScript} onUndo={undoLast} onClose={() => setDone(null)} />
      )}

      <div className={`files-layout ${selected ? 'has-file' : ''}`}>
        <section className={`files-list ${dragging ? 'is-dropping' : ''}`} aria-label={inSearch ? 'Search results' : 'Folder contents'} {...dropProps}>
          <Breadcrumb path={folder} onOpen={setFolder} />

          {canChange && !inSearch && (
            <div className="folder-actions">
              {canAdd && (
                <>
                  <Button icon={<Upload size={15} />} disabled={Boolean(uploading)} onClick={() => addPicker.current?.click()}>Add files</Button>
                  <input
                    ref={addPicker}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = '';
                      addFiles(files);
                    }}
                  />
                  <Button icon={<FolderPlus size={15} />} disabled={Boolean(uploading)} onClick={newFolder}>New folder</Button>
                </>
              )}
              <MoreMenu label={`More for ${nameOf(folder)}`} items={folderItems} />
            </div>
          )}

          {inSearch && (
            <>
              {searchError && <Notice kind="error">{searchError}</Notice>}
              {searching && <Spinner label="Searching" />}
              {!searching && results && results.results.length === 0 && (
                <Empty icon={<Search size={26} />} title="Nothing found">
                  {mode === 'names' ? 'Try the "Inside files" search to look through what files contain.' : 'Only text files up to 1 MB are searched.'}
                </Empty>
              )}
              {!searching && results && results.results.length > 0 && (
                <>
                  <ul className="entry-list">
                    {results.results.map((hit) => (
                      <li key={`${hit.path}:${hit.line ?? ''}`}>
                        <button
                          className={`entry-row ${selected?.path === hit.path && selected?.line === hit.line ? 'active' : ''}`}
                          onClick={() => (hit.type === 'dir' ? setFolder(hit.path) : openFile({ path: hit.path, line: hit.line }))}
                        >
                          <EntryIcon type={hit.type} kind={hit.type === 'file' ? 'text' : undefined} />
                          <span className="entry-text">
                            <span className="entry-name">{hit.name}{hit.line ? <small> line {hit.line}</small> : null}</span>
                            {hit.text && <code className="entry-snippet">{hit.text}</code>}
                            <span className="entry-meta">{parentOf(hit.path) || 'Server files'}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {results.truncated && <p className="muted-note list-note">Showing the first {results.results.length}. Search for something more specific to narrow it down.</p>}
                  {results.timedOut && <p className="muted-note list-note">The search stopped early to stay quick. Open a smaller folder and search there.</p>}
                </>
              )}
            </>
          )}

          {!inSearch && (
            <>
              {listing.error && !folder && <Notice kind="error">{listing.error}</Notice>}
              {listing.loading && <Spinner label="Reading folder" />}
              {here && here.entries.length === 0 && (
                <Empty icon={<FolderOpen size={26} />} title="This folder is empty">
                  {canAdd ? 'Add files or drag them here.' : undefined}
                </Empty>
              )}
              {here && here.entries.length > 0 && (
                <ul className="entry-list">
                  {here.entries.map((entry) => (
                    <EntryRow key={entry.path} entry={entry} active={selected?.path === entry.path} onClick={() => openEntry(entry)} />
                  ))}
                </ul>
              )}
              {here?.truncated && <p className="muted-note list-note">This folder is very large, so only the first {here.entries.length} items are shown. Use search to find the rest.</p>}
              {canAdd && here && here.entries.length > 0 && <p className="muted-note list-note drop-hint">You can drag files here too.</p>}
              {here && !canChange && <p className="muted-note list-note">On a hosted server, add and replace files in your host's file manager for now.</p>}
            </>
          )}
          {dragging && <div className="drop-cover" aria-hidden="true"><Upload size={22} /><span>Drop to add to {nameOf(folder) || 'Server files'}</span></div>}
        </section>

        <section className="files-view" aria-label="File" ref={viewRef}>
          {selected
            ? (
              <FileViewer
                key={`${selected.path}|${selected.line ?? ''}`}
                selection={selected}
                online={online}
                version={version}
                busy={Boolean(uploading)}
                actions={viewerActions}
                onBack={closeFile}
                onDirtyChange={onDirtyChange}
              />
            )
            : <Empty icon={<FileCode size={30} />} title="Pick a file to open it">You can change text files, see pictures, play sounds and videos, and replace or download any file.</Empty>}
        </section>
      </div>

      {naming && <NameDialog request={naming} onClose={() => setNaming(null)} />}
    </div>
  );
}
