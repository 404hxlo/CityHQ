import { ArrowDownToLine, Search, SendHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ConsoleLine } from '../api';
import { openFilesAt } from '../nav';
import { Button, Notice, Segmented, useAction, useToast } from '../ui';

/** Finds a place in a script mentioned by an error line, like @qb-core/server/x.lua:12. */
function locationIn(text: string) {
  const m = text.match(/@([\w.-]+)\/([^\s:]+\.(?:lua|js)):(\d+)/);
  return m ? { resource: m[1], file: m[2], line: Number(m[3]) } : null;
}

function ConsoleRow({ line }: { line: ConsoleLine }) {
  const toast = useToast();
  const location = line.level === 'error' ? locationIn(line.text) : null;
  const open = async () => {
    if (!location) return;
    try {
      const { resources } = await api.resources();
      const resource = resources.find((r) => r.name === location.resource);
      if (!resource) throw new Error(`${location.resource} isn't in your resources folder.`);
      if (!resource.folder) throw new Error(`${location.resource} is built into FiveM, so its files can't be opened here.`);
      const path = `${resource.folder}/${location.file}`;
      openFilesAt(path.slice(0, path.lastIndexOf('/')), { path, line: location.line });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className={`console-line level-${line.level}`}>
      {line.text}
      {location && <button className="console-open" onClick={open}>Open line {location.line}</button>}
    </div>
  );
}

const MAX_LINES = 3000;
const QUICK = ['refresh', 'status'];
type Level = 'all' | 'warn' | 'error';

export function Console({ online }: { online: boolean }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const box = useRef<HTMLDivElement>(null);
  const offset = useRef<number | undefined>(undefined);
  const { busy, run } = useAction();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const chunk = await api.console(offset.current);
        if (!alive) return;
        offset.current = chunk.offset;
        setError(null);
        if (chunk.reset) setLines(chunk.lines);
        else if (chunk.lines.length) setLines((old) => [...old, ...chunk.lines].slice(-MAX_LINES));
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 5000 : 1200);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (level === 'error' && l.level !== 'error') return false;
      if (level === 'warn' && l.level === 'info') return false;
      return !q || l.text.toLowerCase().includes(q);
    });
  }, [lines, level, query]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const send = async (text = command) => {
    const value = text.trim();
    if (!value) return;
    const result = await run('send', () => api.command(value));
    if (result) {
      history.current = [value, ...history.current.filter((h) => h !== value)].slice(0, 50);
      historyIndex.current = -1;
      setCommand('');
      setFollow(true);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') send();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndex.current + (e.key === 'ArrowUp' ? 1 : -1);
      if (next < -1 || next >= history.current.length) return;
      historyIndex.current = next;
      setCommand(next === -1 ? '' : history.current[next]);
    }
  };

  return (
    <div className="console-page">
      <header className="page-head">
        <h1>Console</h1>
        <Segmented
          label="Level"
          value={level}
          onChange={setLevel}
          options={[{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'error', label: 'Errors' }]}
        />
      </header>

      {error && <Notice kind="error">{error}</Notice>}

      <div className="console-tools">
        <label className="search">
          <Search size={16} />
          <input type="search" placeholder="Search the log" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {!follow && <Button icon={<ArrowDownToLine size={16} />} onClick={() => setFollow(true)}>Jump to latest</Button>}
      </div>

      <div className="console-box" ref={box} onScroll={onScroll} role="log" aria-label="Server console" tabIndex={0}>
        {visible.length === 0 && <div className="console-line muted-note">{lines.length ? 'No lines match this filter.' : 'Waiting for server output...'}</div>}
        {visible.map((l, i) => <ConsoleRow key={i} line={l} />)}
      </div>

      <div className="console-input">
        <span className="prompt" aria-hidden="true">&gt;</span>
        <input
          placeholder={online ? 'Type a server command' : 'The server is off'}
          aria-label="Server command"
          value={command}
          disabled={!online}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKey}
        />
        <Button variant="primary" icon={<SendHorizontal size={16} />} aria-label="Run command" busy={busy === 'send'} disabled={!online || !command.trim()} onClick={() => send()} />
      </div>
      <div className="quick-commands">
        {QUICK.map((c) => <button key={c} className="filter-chip" disabled={!online} onClick={() => send(c)}>{c}</button>)}
      </div>
    </div>
  );
}
