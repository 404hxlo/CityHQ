import {
  ArrowLeft, ChevronRight, Download, File as FileIcon, FileCode, FileImage, Folder, FolderOpen, Search,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, SERVER_SCOPE, type BrowseEntry, type SearchResponse,
} from '../api';
import { takeFilesTarget } from '../nav';
import { FileEditor } from '../SettingsEditor';
import {
  Button, Empty, formatBytes, formatWhen, Notice, Segmented, Spinner, useConfirm, usePoll,
} from '../ui';

type SearchMode = 'names' | 'text';
interface Selection { path: string; line?: number }

const TYPE_LABELS: Record<string, string> = {
  ytd: 'GTA texture pack', ydr: 'GTA model', ydd: 'GTA clothing or character model', yft: 'GTA vehicle or prop model',
  ymap: 'GTA map placement', ytyp: 'GTA map object definitions', ybn: 'GTA collision data', ycd: 'GTA animation',
  awc: 'GTA audio', rel: 'GTA audio data', dat: 'Game data', ttf: 'Font', otf: 'Font', woff: 'Font', woff2: 'Font',
  ogg: 'Sound', mp3: 'Sound', wav: 'Sound', mp4: 'Video', webm: 'Video', zip: 'Zip archive', rar: 'RAR archive', '7z': '7-Zip archive',
  fxap: 'Protected script (Cfx asset escrow)', exe: 'Program', dll: 'Program library',
};

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() || '';
const typeLabel = (name: string) => TYPE_LABELS[extensionOf(name)] || (name.includes('.') ? `${extensionOf(name).toUpperCase()} file` : 'File');
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const countLabel = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

// Remembered while the app is open, so visiting another page keeps your place.
let lastFolder = '';

function EntryIcon({ type, kind }: { type: string; kind?: string }) {
  if (type === 'dir') return <Folder size={18} className="entry-icon entry-dir" />;
  if (kind === 'image') return <FileImage size={18} className="entry-icon" />;
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
    ? countLabel(entry.items ?? 0)
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

function FileViewer({ selection, online, onBack, onDirtyChange }: {
  selection: Selection; online: boolean; onBack: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const { path, line } = selection;
  const { data: info, error } = usePoll(() => api.fileDetails(path), 0, [path]);
  const confirm = useConfirm();

  const current = info?.path === path ? info : null;
  const scope = current?.editor.scope;

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
          <h2>{path.split('/').pop()}</h2>
          <p className="muted-note">
            {current
              ? `${typeLabel(current.name)} · ${formatBytes(current.size)} · Changed ${formatWhen(current.modified).replace(/^Today at/, 'today at')}`
              : ' '}
          </p>
        </div>
        {current?.canDownload && (
          <a className="btn btn-ghost" href={api.rawUrl(path, true)} download={current.name}><Download size={16} /><span>Download</span></a>
        )}
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {!error && !current && <Spinner label="Opening file" />}

      {current?.kind === 'text' && (
        <FileEditor
          key={`${current.editor.scope}|${current.editor.path}|${line ?? ''}`}
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
          <img src={api.rawUrl(path)} alt={current.name} />
        </div>
      )}
      {current?.kind === 'binary' && (
        <Empty icon={<FileIcon size={30} />} title={typeLabel(current.name)}>
          This file isn't text or a picture, so it can't be shown here.
        </Empty>
      )}
      {current?.kind === 'large' && (
        <Empty icon={<FileCode size={30} />} title="Too large to open here">
          This file is {formatBytes(current.size)}, and files can be opened here up to 2 MB.
        </Empty>
      )}
    </div>
  );
}

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
  const dirty = useRef(false);
  const confirm = useConfirm();
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

  const listing = usePoll(() => api.browse(folder), 0, [folder]);

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

      <div className={`files-layout ${selected ? 'has-file' : ''}`}>
        <section className="files-list" aria-label={inSearch ? 'Search results' : 'Folder contents'}>
          <Breadcrumb path={folder} onOpen={setFolder} />

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
              {!listing.loading && listing.data && listing.data.entries.length === 0 && (
                <Empty icon={<FolderOpen size={26} />} title="This folder is empty" />
              )}
              {!listing.loading && listing.data && listing.data.entries.length > 0 && (
                <ul className="entry-list">
                  {listing.data.entries.map((entry) => (
                    <EntryRow key={entry.path} entry={entry} active={selected?.path === entry.path} onClick={() => openEntry(entry)} />
                  ))}
                </ul>
              )}
              {listing.data?.truncated && <p className="muted-note list-note">This folder is very large, so only the first {listing.data.entries.length} items are shown. Use search to find the rest.</p>}
            </>
          )}
        </section>

        <section className="files-view" aria-label="File" ref={viewRef}>
          {selected
            ? <FileViewer key={`${selected.path}|${selected.line ?? ''}`} selection={selected} online={online} onBack={closeFile} onDirtyChange={onDirtyChange} />
            : <Empty icon={<FileCode size={30} />} title="Pick a file to open it">You can read and change text files, preview pictures, and download the rest.</Empty>}
        </section>
      </div>
    </div>
  );
}
