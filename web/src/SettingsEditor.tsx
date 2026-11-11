import {
  CheckCircle2, ChevronDown, ChevronUp, Code2, Eye, History, Maximize2, Minimize2, RotateCcw, Search, SlidersHorizontal, Undo2, WrapText,
} from 'lucide-react';
import {
  lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject,
} from 'react';
import {
  api, ApiError, type EditableFile, type Field, type FileEntry, type FileVersion, type Problem, type RestartResult,
} from './api';
import type { FindInfo } from './CodeEditor';
import { ProblemList } from './Problems';
import {
  Button, Empty, formatBytes, formatWhen, Modal, Notice, Segmented, Spinner, Toggle, useAction, useConfirm, useToast,
} from './ui';

const CodeEditor = lazy(() => import('./CodeEditor'));
const VISIBLE_FIELD_LIMIT = 250;
const WRAP_KEY = 'qbc-wrap-lines';

function loadWrapPreference() {
  try { return localStorage.getItem(WRAP_KEY) !== 'off'; } catch { return true; }
}
function saveWrapPreference(on: boolean) {
  try { localStorage.setItem(WRAP_KEY, on ? 'on' : 'off'); } catch { /* only a convenience */ }
}

type Mode = 'simple' | 'code';
type Changes = Record<string, boolean | number | string>;

function FieldInput({ field, value, onChange }: { field: Field; value: boolean | number | string; onChange: (v: boolean | number | string) => void }) {
  if (field.type === 'boolean') {
    return <Toggle checked={value === true} onChange={onChange} label={field.key} />;
  }
  if (field.type === 'number') {
    return (
      <input
        className="input input-number"
        type="number"
        step="any"
        inputMode="decimal"
        aria-label={field.key}
        value={value === '' ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }
  return <input className="input" type="text" aria-label={field.key} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}

function FieldList({ fields, changes, onChange }: { fields: Field[]; changes: Changes; onChange: (id: string, v: boolean | number | string, original: Field) => void }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => `${f.key} ${f.label} ${f.help}`.toLowerCase().includes(q));
  }, [fields, query]);
  const visible = filtered.slice(0, VISIBLE_FIELD_LIMIT);
  const groups = useMemo(() => {
    const map = new Map<string, Field[]>();
    for (const f of visible) {
      if (!map.has(f.group)) map.set(f.group, []);
      map.get(f.group)?.push(f);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <div className="field-list">
      {fields.length > 8 && (
        <label className="search">
          <Search size={16} />
          <input type="search" placeholder={`Search ${fields.length} settings`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      {groups.map(([group, items]) => (
        <section key={group} className="field-group">
          <h4>{group}</h4>
          {items.map((f) => {
            const value = f.id in changes ? changes[f.id] : f.value;
            return (
              <div key={f.id} className={`field-row ${f.id in changes ? 'changed' : ''}`}>
                <div className="field-text">
                  <div className="field-label">{f.label}</div>
                  {f.help && <div className="field-help">{f.help}</div>}
                  <code className="field-key">{f.key}</code>
                </div>
                <div className="field-control"><FieldInput field={f} value={value} onChange={(v) => onChange(f.id, v, f)} /></div>
              </div>
            );
          })}
        </section>
      ))}
      {filtered.length > VISIBLE_FIELD_LIMIT && (
        <p className="muted-note">Showing the first {VISIBLE_FIELD_LIMIT} of {filtered.length}. Search to find the rest.</p>
      )}
      {!filtered.length && <p className="muted-note">No settings match "{query}".</p>}
    </div>
  );
}

const NO_FIND: FindInfo = { current: 0, total: 0, capped: false };

/** The code view's find bar: Enter goes to the next match, Shift+Enter back, Esc clears. */
function FindBar({ inputRef, text, info, onText, onStep }: {
  inputRef: RefObject<HTMLInputElement | null>;
  text: string;
  info: FindInfo;
  onText: (text: string) => void;
  onStep: (dir: 1 | -1) => void;
}) {
  const count = info.total
    ? `${info.current || '-'} of ${info.total}${info.capped ? '+' : ''}`
    : 'No matches';
  return (
    <div className={`search code-find ${text && !info.total ? 'no-match' : ''}`} role="search">
      <Search size={16} />
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in this file"
        aria-label="Find in this file"
        spellCheck={false}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            // Esc here never closes full screen: it clears the text, then leaves the box.
            e.preventDefault();
            e.stopPropagation();
            if (text) onText(''); else e.currentTarget.blur();
          }
        }}
      />
      {text && <span className="find-count" aria-live="polite">{count}</span>}
      <button type="button" className="icon-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!info.total} onClick={() => onStep(-1)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" className="icon-btn" title="Next match (Enter)" aria-label="Next match" disabled={!info.total} onClick={() => onStep(1)}>
        <ChevronDown size={16} />
      </button>
    </div>
  );
}

function VersionsModal({ scope, path, onClose, onRestored }: { scope: string; path: string; onClose: () => void; onRestored: (f: EditableFile) => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const confirm = useConfirm();
  useEffect(() => {
    api.versions(scope, path).then(setVersions).catch((e) => toast(e.message, 'error'));
  }, [scope, path, toast]);
  const restore = async (v: FileVersion) => {
    const ok = await confirm({
      title: 'Restore this version?',
      body: <p>{path} goes back to how it was on {formatWhen(v.savedAt)}. Your current version is backed up first, so you can undo this.</p>,
      confirm: 'Restore',
    });
    if (!ok) return;
    const file = await run(v.id, () => api.restoreVersion(scope, path, v.id), 'Version restored');
    if (file) { onRestored(file); onClose(); }
  };
  return (
    <Modal title={`Backups of ${path}`} onClose={onClose}>
      {!versions && <Spinner />}
      {versions && !versions.length && <p className="muted-note">No backups yet. One is saved automatically each time you change this file.</p>}
      {versions && versions.length > 0 && (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.id}>
              <div>
                <div>{formatWhen(v.savedAt)}</div>
                <div className="muted-note">{formatBytes(v.size)}</div>
              </div>
              <Button icon={<RotateCcw size={15} />} busy={busy === v.id} onClick={() => restore(v)}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

interface FileEditorProps {
  scope: string;
  path: string;
  restartLabel?: string;
  /** Runs after a "save and restart". Omit when nothing can be restarted right now. */
  onRestart?: () => Promise<unknown>;
  restartHint?: string;
  /** Opens the code view at this line, such as from a search result. */
  line?: number;
  /** Shown at the start of the toolbar, such as a file picker. */
  leading?: ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Opens one file: simple settings or code, with backups. Remount it to open another file. */
export function FileEditor({
  scope, path, restartLabel, onRestart, restartHint, line, leading, onDirtyChange,
}: FileEditorProps) {
  const [doc, setDoc] = useState<EditableFile | null>(null);
  const [mode, setMode] = useState<Mode>('code');
  const [changes, setChanges] = useState<Changes>({});
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [wrap, setWrap] = useState(loadWrapPreference);
  const [mistake, setMistake] = useState<{ line?: number; plain: string; message?: string } | null>(null);
  const [jump, setJump] = useState<{ line: number; token: number } | null>(null);
  const [findText, setFindText] = useState('');
  const [findStep, setFindStep] = useState<{ dir: 1 | -1; token: number } | null>(null);
  const [findInfo, setFindInfo] = useState<FindInfo>(NO_FIND);
  const findInput = useRef<HTMLInputElement>(null);
  const [lastSave, setLastSave] = useState<{ backupId: string; at: number; checked: boolean } | null>(null);
  const [failure, setFailure] = useState<{ backupId: string; message: string | null; problems: Problem[] } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc belongs to an open dialog or the editor's find box first.
      if (document.querySelector('.modal') || (e.target as Element | null)?.closest?.('.cm-panel')) return;
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const toggleWrap = () => {
    saveWrapPreference(!wrap);
    setWrap(!wrap);
  };

  const stepFind = (dir: 1 | -1) => setFindStep({ dir, token: Date.now() + Math.random() });
  const updateFindInfo = useCallback((next: FindInfo) => {
    setFindInfo((cur) => (cur.current === next.current && cur.total === next.total && cur.capped === next.capped ? cur : next));
  }, []);
  /** Ctrl+F: puts the selected text (if any) in the find bar and moves there. */
  const focusFind = useCallback((selected = '') => {
    if (selected) setFindText(selected);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  }, []);

  // Ctrl+F also works when the editor itself is not focused (the editor handles it when it is).
  const codeOpen = Boolean(doc) && mode === 'code';
  useEffect(() => {
    if (!codeOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      if (document.querySelector('.modal')) return;
      e.preventDefault();
      focusFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [codeOpen, focusFind]);

  const dirty = mode === 'simple' ? Object.keys(changes).length > 0 : Boolean(doc && !doc.readOnly && code !== doc.content);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const applyDoc = useCallback((file: EditableFile, keepMode = false) => {
    setDoc(file);
    setCode(file.content);
    setChanges({});
    setError(null);
    if (!keepMode) setMode(file.fields.length && !line ? 'simple' : 'code');
  }, [line]);

  const load = useCallback(async () => {
    setDoc(null);
    setError(null);
    try {
      applyDoc(await api.file(scope, path));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [scope, path, applyDoc]);

  useEffect(() => { load(); }, [load]);

  const guardDiscard = async () => {
    if (!dirty) return true;
    return confirm({ title: 'Discard your changes?', body: <p>You have changes that are not saved yet.</p>, confirm: 'Discard', danger: true });
  };

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    if (await guardDiscard()) {
      setChanges({});
      if (doc) setCode(doc.content);
      setMode(next);
    }
  };

  const changeField = (id: string, value: boolean | number | string, field: Field) => {
    setChanges((current) => {
      const copy = { ...current };
      if (value === field.value) delete copy[id];
      else copy[id] = value;
      return copy;
    });
  };

  const reload = async () => {
    if (await guardDiscard()) load();
  };

  const persist = (force: boolean) => (mode === 'simple'
    ? api.saveFields(scope, path, Object.entries(changes).map(([id, value]) => ({ id, value })), (doc as EditableFile).etag, force)
    : api.saveFile(scope, path, code, (doc as EditableFile).etag, force));

  const restartAfter = async (key: string, backupId: string | null | undefined) => {
    if (!onRestart) return;
    // A restart that can't go right is the moment to offer the way back.
    const result = await run<RestartResult | unknown | { failed: string }>(key, () => onRestart().catch((err: Error) => ({ failed: err.message })));
    const checked = result as RestartResult & { failed?: string };
    if (checked?.failed) {
      if (backupId) setFailure({ backupId, message: checked.failed, problems: [] });
      else toast(checked.failed, 'error');
      return;
    }
    if (checked?.ok === false) {
      if (backupId) setFailure({ backupId, message: null, problems: checked.problems || [] });
      else toast('Restarted, but it reported a problem. Check Recent problems.', 'error');
      return;
    }
    toast('Saved and restarted');
  };

  const save = async (thenRestart: boolean, force = false) => {
    if (!doc) return;
    const key = thenRestart ? 'save-restart' : 'save';
    let saved: EditableFile | undefined;
    try {
      saved = await run(key, async () => {
        try {
          return await persist(force);
        } catch (err) {
          // Handled below, so it shouldn't also appear as a generic error.
          if (err instanceof ApiError && err.data?.syntax) return { syntaxError: err.data.syntax } as unknown as EditableFile;
          throw err;
        }
      });
    } catch { /* run() reports errors itself */ }
    if (!saved) return;
    const syntax = (saved as unknown as { syntaxError?: NonNullable<ApiError['data']>['syntax'] }).syntaxError;
    if (syntax) {
      setMistake(syntax);
      if (mode === 'code' && syntax.line) setJump({ line: syntax.line, token: Date.now() });
      return;
    }
    setMistake(null);
    applyDoc(saved, true);
    if (saved.backupId) setLastSave({ backupId: saved.backupId, at: Date.now(), checked: Boolean(saved.syntaxChecked) });
    if (thenRestart) await restartAfter(key, saved.backupId);
    else toast(saved.syntaxChecked ? 'Saved, and no mistakes were found.' : 'Saved. A backup of the old version was kept.');
  };

  const undoSave = async (backupId: string, thenRestart: boolean) => {
    const restored = await run('undo', () => api.restoreVersion(scope, path, backupId));
    if (!restored) return;
    applyDoc(restored, true);
    setLastSave(null);
    setFailure(null);
    setMistake(null);
    if (thenRestart && onRestart) await run('undo', onRestart, 'Your change was undone and it restarted.');
    else toast('Your change was undone.');
  };

  const hasFields = Boolean(doc?.fields.length);
  const changeCount = mode === 'simple' ? Object.keys(changes).length : 1;
  const showToolbar = Boolean(leading) || Boolean(doc);

  return (
    <div className={`settings-editor ${fullscreen ? 'is-fullscreen' : ''}`}>
      {showToolbar && (
        <div className="editor-toolbar">
          {fullscreen && !leading && <code className="fullscreen-name">{path}</code>}
          {leading}
          {hasFields && (
            <Segmented
              label="Editing mode"
              value={mode}
              onChange={switchMode}
              options={[{ value: 'simple', label: 'Simple' }, { value: 'code', label: 'Code' }]}
            />
          )}
          {doc && mode === 'code' && (
            <Button variant="ghost" className={wrap ? 'is-on' : ''} aria-pressed={wrap} title="Keep long lines inside the box" icon={<WrapText size={16} />} onClick={toggleWrap}>Wrap lines</Button>
          )}
          {doc && !doc.readOnly && <Button variant="ghost" icon={<History size={16} />} onClick={() => setShowVersions(true)}>Backups</Button>}
          {codeOpen && <FindBar inputRef={findInput} text={findText} info={findInfo} onText={setFindText} onStep={stepFind} />}
          {doc && (
            <Button
              variant="ghost"
              className="fullscreen-toggle"
              aria-pressed={fullscreen}
              title={fullscreen ? 'Back to the normal view (Esc)' : 'Fill the whole window'}
              icon={fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              onClick={() => setFullscreen(!fullscreen)}
            >
              {fullscreen ? 'Exit full screen' : 'Full screen'}
            </Button>
          )}
        </div>
      )}

      {error && (
        <Notice kind="error">
          {error}
          <div><button className="link" onClick={reload}>Try again</button></div>
        </Notice>
      )}
      {!error && !doc && <Spinner label="Opening file" />}
      {doc?.readOnly && doc.readOnlyReason && <p className="muted-note hint-line"><Eye size={14} /> {doc.readOnlyReason}</p>}

      {mistake && (
        <div className="mistake">
          <Notice kind="error">
            <strong>{mistake.line ? `There's a mistake on line ${mistake.line}, so this wasn't saved.` : 'There\'s a mistake in this file, so it wasn\'t saved.'}</strong>
            <div>{mistake.plain}</div>
            {mistake.message && <code className="mistake-detail">{mistake.message}</code>}
          </Notice>
          <div className="button-row">
            {mode === 'simple' && <Button onClick={() => { setMode('code'); if (mistake.line) setJump({ line: mistake.line, token: Date.now() }); }}>Show me in the code</Button>}
            {mode === 'code' && mistake.line && <Button onClick={() => setJump({ line: mistake.line as number, token: Date.now() })}>Show me the line</Button>}
            <Button variant="ghost" className="text-danger" busy={busy === 'save'} onClick={() => save(false, true)}>Save anyway</Button>
            <Button variant="ghost" onClick={() => setMistake(null)}>Dismiss</Button>
          </div>
        </div>
      )}

      {failure && (
        <div className="undo-offer">
          <h4>{failure.message ? 'The restart didn\'t work after your change' : 'Something went wrong after your change'}</h4>
          {failure.message && <p>{failure.message}</p>}
          <div className="button-row">
            <Button variant="primary" icon={<Undo2 size={15} />} busy={busy === 'undo'} onClick={() => undoSave(failure.backupId, Boolean(onRestart))}>Undo my change and restart</Button>
            <Button variant="ghost" onClick={() => setFailure(null)}>Keep my change</Button>
          </div>
          {failure.problems.length > 0 && <ProblemList problems={failure.problems} />}
        </div>
      )}

      {lastSave && !dirty && !failure && (
        <p className="saved-note">
          <CheckCircle2 size={14} />
          <span>Saved{lastSave.checked ? ', and no mistakes were found' : ''}.</span>
          <button className="link" disabled={busy === 'undo'} onClick={() => undoSave(lastSave.backupId, false)}>Undo this change</button>
        </p>
      )}

      {doc && mode === 'simple' && <FieldList fields={doc.fields} changes={changes} onChange={changeField} />}
      {doc && mode === 'code' && (
        <div className="code-frame">
          <Suspense fallback={<Spinner label="Loading editor" />}>
            <CodeEditor
              path={path}
              value={code}
              onChange={setCode}
              readOnly={doc.readOnly}
              line={line}
              wrap={wrap}
              jump={jump}
              find={findText}
              findStep={findStep}
              onFindInfo={updateFindInfo}
              onFindKey={focusFind}
            />
          </Suspense>
        </div>
      )}
      {doc && !doc.readOnly && !hasFields && !dirty && /\.lua$/i.test(path) && (
        <p className="muted-note hint-line"><SlidersHorizontal size={14} /> Simple settings appear for files with "config" in their name.</p>
      )}

      {dirty && (
        <div className="save-bar">
          <span>{mode === 'simple' ? `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}` : 'Unsaved changes'}</span>
          <div className="save-actions">
            <Button variant="ghost" onClick={() => { setChanges({}); if (doc) setCode(doc.content); }} disabled={Boolean(busy)}>Discard</Button>
            <Button variant={onRestart ? 'default' : 'primary'} onClick={() => save(false)} busy={busy === 'save'} disabled={Boolean(busy)}>Save</Button>
            {onRestart && restartLabel && <Button variant="primary" onClick={() => save(true)} busy={busy === 'save-restart'} disabled={Boolean(busy)}>{restartLabel}</Button>}
          </div>
        </div>
      )}
      {dirty && restartHint && !onRestart && <p className="muted-note">{restartHint}</p>}

      {showVersions && <VersionsModal scope={scope} path={path} onClose={() => setShowVersions(false)} onRestored={(f) => applyDoc(f)} />}
    </div>
  );
}

interface SettingsEditorProps {
  scope: string;
  restartLabel: string;
  onRestart?: () => Promise<unknown>;
  restartHint?: string;
}

/** FileEditor with a picker for the files of one resource (or server.cfg). */
export function SettingsEditor({ scope, restartLabel, onRestart, restartHint }: SettingsEditorProps) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const confirm = useConfirm();
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setPath('');
    api.files(scope).then(({ files: list }) => {
      if (!live) return;
      setFiles(list);
      setPath(list.find((f) => f.editable)?.path || '');
    }).catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [scope]);

  const selectFile = async (next: string) => {
    if (next === path) return;
    if (dirty.current && !await confirm({ title: 'Discard your changes?', body: <p>You have changes that are not saved yet.</p>, confirm: 'Discard', danger: true })) return;
    setPath(next);
  };

  const options = (files || []).filter((f) => f.editable);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!files) return <Spinner label="Reading files" />;
  if (!path) return <Empty icon={<Code2 size={28} />} title="No editable files">This resource has no text files to change.</Empty>;

  return (
    <FileEditor
      key={`${scope}|${path}`}
      scope={scope}
      path={path}
      restartLabel={restartLabel}
      onRestart={onRestart}
      restartHint={restartHint}
      onDirtyChange={onDirtyChange}
      leading={(
        <label className="file-select">
          <span className="sr-only">File</span>
          <select value={path} onChange={(e) => selectFile(e.target.value)}>
            {options.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </label>
      )}
    />
  );
}
