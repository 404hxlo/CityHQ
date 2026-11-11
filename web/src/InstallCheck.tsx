import {
  AlertTriangle, BookOpen, CheckCircle2, ChevronDown, ChevronUp, ClipboardCheck, Download, FileCode, Info, Wrench, XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, type ScriptCheck } from './api';
import { openAddResource, openFilesAt } from './nav';
import { FIXED_EVENT } from './Problems';
import {
  Button, Spinner, useAction, useConfirm, usePoll,
} from './ui';

const ICON: Record<ScriptCheck['status'], ReactNode> = {
  bad: <XCircle size={17} />,
  warn: <AlertTriangle size={17} />,
  info: <Info size={17} />,
  ok: <CheckCircle2 size={17} />,
};

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function CheckRow({ name, check, onDone }: { name: string; check: ScriptCheck; onDone: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const fix = async () => {
    if (!check.fix) return;
    if (!await confirm({ title: `${check.fix.label}?`, body: <p>{check.fix.confirm}</p>, confirm: 'Fix it' })) return;
    if (await run('fix', () => api.scriptCheckFix(name, check.id), (r) => r.message)) {
      window.dispatchEvent(new Event(FIXED_EVENT));
      onDone();
    }
  };
  return (
    <li className={`health-item health-${check.status}`}>
      <div className="health-icon">{ICON[check.status]}</div>
      <div className="health-body">
        <h4>{check.title}</h4>
        <p>{check.detail}</p>
        {check.steps.length > 0 && <ol className="health-steps">{check.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
        {(check.fix || check.install || check.openFile) && (
          <div className="health-actions">
            {check.fix && <Button variant="primary" icon={<Wrench size={15} />} busy={busy === 'fix'} onClick={fix}>{check.fix.label}</Button>}
            {check.install && <Button variant="primary" icon={<Download size={15} />} onClick={() => openAddResource(check.install!.url)}>{check.install.label}</Button>}
            {check.openFile && <Button icon={<FileCode size={15} />} onClick={() => openFilesAt(parentOf(check.openFile!.path), { path: check.openFile!.path, line: check.openFile!.line })}>{check.openFile.label}</Button>}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Reads a script and says what it needs to work on this server. `open` starts it expanded, such as
 * right after an install; otherwise it shows a one-line summary that opens on a click.
 */
export function InstallCheck({ name, open = false }: { name: string; open?: boolean }) {
  const report = usePoll(() => api.scriptCheck(name), 0, [name]);
  const [expanded, setExpanded] = useState(open);
  const [showOk, setShowOk] = useState(false);
  const checks = report.data?.checks || [];
  const problems = checks.filter((c) => c.status === 'bad' || c.status === 'warn');
  const rest = checks.filter((c) => c.status !== 'bad' && c.status !== 'warn');
  const summary = !report.data
    ? 'Checking what it needs'
    : problems.length ? `${problems.length} thing${problems.length === 1 ? '' : 's'} to sort out` : 'Nothing to sort out';

  return (
    <section className={`install-check ${problems.length ? 'has-problems' : ''}`}>
      <button className="install-check-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ClipboardCheck size={17} />
        <span><strong>Install check</strong><span className="muted-note"> · {summary}</span></span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {expanded && (
        <div className="install-check-body">
          {!report.data && !report.error && <Spinner label="Reading the script" />}
          {report.error && <p className="muted-note">{report.error}</p>}
          {report.data && (
            <>
              <ul className="health-list install-check-list">
                {problems.map((c) => <CheckRow key={c.id} name={name} check={c} onDone={report.refresh} />)}
                {(showOk || !problems.length) && rest.map((c) => <CheckRow key={c.id} name={name} check={c} onDone={report.refresh} />)}
              </ul>
              {problems.length > 0 && rest.length > 0 && (
                <button className="link health-ok-toggle" onClick={() => setShowOk(!showOk)}>{showOk ? 'Hide' : 'Show'} the other {rest.length} check{rest.length === 1 ? '' : 's'}</button>
              )}
              {report.data.docs && (
                <p className="install-check-docs"><BookOpen size={14} /><a href={report.data.docs.url} target="_blank" rel="noreferrer">{report.data.docs.label}</a></p>
              )}
              {report.data.notes && (
                <details className="install-notes">
                  <summary>The author's notes ({report.data.notes.file})</summary>
                  <pre>{report.data.notes.text}</pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
