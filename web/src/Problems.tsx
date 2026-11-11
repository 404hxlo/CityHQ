import {
  AlertTriangle, BookOpen, CheckCircle2, Database, Download, FileCode, MessagesSquare, Settings2, Undo2, Video, Wrench, XCircle,
} from 'lucide-react';
import {
  useCallback, useEffect, useState, type ReactNode,
} from 'react';
import {
  api, type FixRecord, type Problem, type ProblemAction, type ProblemLink,
} from './api';
import { openAddResource, openFilesAt, openResourcePanel } from './nav';
import {
  Button, formatWhen, useAction, useConfirm,
} from './ui';

const LINK_ICONS: Record<ProblemLink['kind'], ReactNode> = {
  doc: <BookOpen size={14} />,
  video: <Video size={14} />,
  forum: <MessagesSquare size={14} />,
};

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Lets "Recently fixed" lists refresh when a fix is made anywhere on the page. */
export const FIXED_EVENT = 'qbc-problem-fixed';

function ActionButton({ action, problemId, onChanged }: { action: ProblemAction; problemId: string; onChanged?: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();

  if (action.kind === 'fix') {
    const fix = async () => {
      const ok = await confirm({ title: `${action.label}?`, body: <p>{action.confirm}</p>, confirm: 'Fix it' });
      if (!ok) return;
      const done = await run('fix', () => api.fixProblem(problemId), (result) => result.message);
      if (done) {
        window.dispatchEvent(new Event(FIXED_EVENT));
        onChanged?.();
      }
    };
    return <Button variant="primary" icon={<Wrench size={15} />} busy={busy === 'fix'} onClick={fix}>{action.label}</Button>;
  }
  if (action.kind === 'open-file') {
    return <Button variant="primary" icon={<FileCode size={15} />} onClick={() => openFilesAt(parentOf(action.path), { path: action.path, line: action.line })}>{action.label}</Button>;
  }
  if (action.kind === 'open-resource') {
    return <Button icon={<Settings2 size={15} />} onClick={() => openResourcePanel(action.name)}>{action.label}</Button>;
  }
  if (action.kind === 'install') {
    return <Button variant="primary" icon={<Download size={15} />} onClick={() => openAddResource(action.url)}>{action.label}</Button>;
  }
  const runSql = async () => {
    const ok = await confirm({
      title: `Run ${action.file}?`,
      body: <p>This changes your database, so a backup of it is made first. Only run it if you trust {action.name}.</p>,
      confirm: 'Back up and run',
    });
    if (!ok) return;
    const done = await run('sql', () => api.runSql(action.name, action.file), `${action.file} ran. Restart ${action.name} to use it.`);
    if (done) onChanged?.();
  };
  return <Button variant="primary" icon={<Database size={15} />} busy={busy === 'sql'} onClick={runSql}>{action.label}</Button>;
}

/** One problem: what happened, how to fix it, a button that helps, and where to read more. */
export function ProblemCard({ problem, onChanged }: { problem: Problem; onChanged?: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const isError = problem.severity === 'error';
  return (
    <article className={`problem ${isError ? 'problem-error' : 'problem-warning'}`}>
      <header className="problem-head">
        {isError ? <XCircle size={18} /> : <AlertTriangle size={18} />}
        <h4>{problem.title}</h4>
        <span className="problem-level">{isError ? 'Problem' : 'Worth a look'}</span>
      </header>
      <p className="problem-what">{problem.what}</p>
      {problem.fix.length > 0 && (
        <div className="problem-fix">
          <h5>How to fix it</h5>
          <ol>{problem.fix.map((step) => <li key={step}>{step}</li>)}</ol>
        </div>
      )}
      {problem.actions.length > 0 && (
        <div className="problem-actions">
          {problem.actions.map((action) => <ActionButton key={action.label} action={action} problemId={problem.id} onChanged={onChanged} />)}
        </div>
      )}
      <div className="problem-links">
        {problem.links.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{LINK_ICONS[link.kind]}<span>{link.label}</span></a>
        ))}
      </div>
      <button className="link problem-raw-toggle" aria-expanded={showRaw} onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? 'Hide the original message' : 'Show the original message'}
      </button>
      {showRaw && <code className="problem-raw">{problem.raw}</code>}
    </article>
  );
}

export function ProblemList({ problems, onChanged }: { problems: Problem[]; onChanged?: () => void }) {
  return (
    <div className="problem-list-cards">
      {problems.map((problem) => <ProblemCard key={problem.id} problem={problem} onChanged={onChanged} />)}
    </div>
  );
}

const RECENT_MS = 24 * 3600 * 1000;

/** Fixes made in the last day, each with Undo when it can be undone. */
export function RecentFixes({ onChanged }: { onChanged?: () => void }) {
  const [fixes, setFixes] = useState<FixRecord[]>([]);
  const { busy, run } = useAction();
  const load = useCallback(() => {
    api.recentFixes().then((all) => setFixes(all.filter((f) => Date.now() - f.at < RECENT_MS).slice(0, 5))).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(FIXED_EVENT, load);
    return () => window.removeEventListener(FIXED_EVENT, load);
  }, [load]);
  if (!fixes.length) return null;
  const undo = async (f: FixRecord) => {
    const done = await run(`undo:${f.id}`, () => api.undoFix(f.id), (r) => r.message);
    if (done) { load(); onChanged?.(); }
  };
  return (
    <div className="recent-fixes">
      <h5>Recently fixed</h5>
      <ul>
        {fixes.map((f) => (
          <li key={f.id} className={f.undone ? 'is-undone' : ''}>
            {f.undone ? <Undo2 size={15} /> : <CheckCircle2 size={15} />}
            <div className="recent-fix-text">
              <strong>{f.label}</strong>
              <span>{f.undone ? `Undone${f.undoneAt ? ` ${formatWhen(f.undoneAt)}` : ''}` : f.message}</span>
              <span className="muted-note">{f.title} · {formatWhen(f.at)}</span>
            </div>
            {f.undoable && (
              <Button variant="ghost" icon={<Undo2 size={15} />} busy={busy === `undo:${f.id}`} onClick={() => undo(f)}>Undo</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
