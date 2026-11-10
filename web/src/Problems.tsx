import {
  AlertTriangle, BookOpen, Database, Download, FileCode, MessagesSquare, Settings2, Video, XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, type Problem, type ProblemAction, type ProblemLink } from './api';
import { openAddResource, openFilesAt, openResourcePanel } from './nav';
import { Button, useAction, useConfirm } from './ui';

const LINK_ICONS: Record<ProblemLink['kind'], ReactNode> = {
  doc: <BookOpen size={14} />,
  video: <Video size={14} />,
  forum: <MessagesSquare size={14} />,
};

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function ActionButton({ action, onChanged }: { action: ProblemAction; onChanged?: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();

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
          {problem.actions.map((action) => <ActionButton key={action.label} action={action} onChanged={onChanged} />)}
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
