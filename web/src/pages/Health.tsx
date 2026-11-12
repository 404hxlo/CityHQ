import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, HeartPulse, History, Info, Moon, RefreshCw, Wrench, XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  api, type DoctorIncident, type FixResult, type HealthFinding, type PlannedFix,
} from '../api';
import { FriendsCard } from '../Friends';
import { Term } from '../Term';
import { FIXED_EVENT, RecentFixes } from '../Problems';
import {
  Button, Empty, Spinner, useAction, useConfirm, usePoll,
} from '../ui';

const STATUS_ICON: Record<HealthFinding['status'], ReactNode> = {
  bad: <XCircle size={18} />,
  warn: <AlertTriangle size={18} />,
  info: <Info size={18} />,
  ok: <CheckCircle2 size={18} />,
};

/** A Fix button that asks first, runs the fix the server plans, and refreshes the page. */
function FixButton({ fix, run: doFix, onDone }: { fix: PlannedFix; run: () => Promise<FixResult>; onDone: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const press = async () => {
    if (!await confirm({ title: `${fix.label}?`, body: <p>{fix.confirm}</p>, confirm: 'Fix it' })) return;
    const done = await run('fix', doFix, (r) => r.message);
    if (done) {
      window.dispatchEvent(new Event(FIXED_EVENT));
      onDone();
    }
  };
  return <Button variant="primary" icon={<Wrench size={15} />} busy={busy === 'fix'} onClick={press}>{fix.label}</Button>;
}

function FindingCard({ f, onDone }: { f: HealthFinding; onDone: () => void }) {
  return (
    <article className={`health-item health-${f.status}`}>
      <div className="health-icon">{STATUS_ICON[f.status]}</div>
      <div className="health-body">
        <h4>{f.title}</h4>
        <p>{f.detail}</p>
        {f.steps.length > 0 && <ol className="health-steps">{f.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
        {(f.fix || f.goTo) && (
          <div className="health-actions">
            {f.fix && <FixButton fix={f.fix} run={() => api.healthFix(f.id)} onDone={onDone} />}
            {f.goTo && <Button onClick={() => document.getElementById(f.goTo as string)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Show me how</Button>}
          </div>
        )}
      </div>
    </article>
  );
}

function Checks() {
  const checks = usePoll(api.health, 0);
  const [showOk, setShowOk] = useState(false);
  const findings = checks.data || [];
  const problems = findings.filter((f) => f.status !== 'ok');
  const good = findings.filter((f) => f.status === 'ok');
  return (
    <section className="card">
      <div className="card-title-row">
        <h3 className="card-title"><HeartPulse size={16} />Checks</h3>
        <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={!checks.data} onClick={() => checks.refresh()}>Check again</Button>
      </div>
      {!checks.data && !checks.error && <Spinner label="Checking the PC, the database and the server's files" />}
      {checks.error && <p className="muted-note">{checks.error}</p>}
      {checks.data && (
        <>
          <p className="muted-note">
            {problems.length === 0 ? 'Everything checked looks good.' : `${problems.length} thing${problems.length === 1 ? '' : 's'} to look at.`}
          </p>
          <div className="health-list">
            {problems.map((f) => <FindingCard key={f.id} f={f} onDone={checks.refresh} />)}
          </div>
          {good.length > 0 && (
            <>
              <button className="link health-ok-toggle" aria-expanded={showOk} onClick={() => setShowOk(!showOk)}>
                {showOk ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                {showOk ? 'Hide' : 'Show'} the {good.length} thing{good.length === 1 ? '' : 's'} that look good
              </button>
              {showOk && <div className="health-list">{good.map((f) => <FindingCard key={f.id} f={f} onDone={checks.refresh} />)}</div>}
            </>
          )}
        </>
      )}
      <RecentFixes onChanged={checks.refresh} />
    </section>
  );
}

const KIND_ICON: Record<DoctorIncident['kind'], ReactNode> = {
  paused: <Moon size={17} />,
  planned: <CheckCircle2 size={17} />,
  crash: <XCircle size={17} />,
  license: <AlertTriangle size={17} />,
  'stuck-script': <AlertTriangle size={17} />,
  hang: <AlertTriangle size={17} />,
  other: <Info size={17} />,
};

function Doctor() {
  const report = usePoll(api.doctor, 0);
  const [showPlanned, setShowPlanned] = useState(false);
  const incidents = report.data?.incidents || [];
  const shown = incidents.filter((i) => showPlanned || i.kind !== 'planned');
  const planned = incidents.length - incidents.filter((i) => i.kind !== 'planned').length;
  return (
    <section className="card">
      <div className="card-title-row">
        <h3 className="card-title"><History size={16} />Restarts in the last 24 hours</h3>
        <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={!report.data} onClick={() => report.refresh()}>Check again</Button>
      </div>
      <p className="muted-note">Why the server restarted or didn't finish starting, worked out from <Term id="txadmin">txAdmin</Term>'s log, the server's log and Windows' sleep records. A script is only blamed when the evidence points at it.</p>
      {!report.data && !report.error && <Spinner label="Reading the logs" />}
      {report.error && <p className="muted-note">{report.error}</p>}
      {report.data && (
        <>
          <p className="doctor-summary">{report.data.summary}</p>
          {shown.length === 0 && (
            <Empty icon={<CheckCircle2 size={28} />} title="Nothing to explain">
              {planned > 0 ? 'Only planned restarts, which you can show below.' : 'No restarts to look at.'}
            </Empty>
          )}
          <ul className="doctor-list">
            {shown.map((i) => (
              <li key={i.id} className={`doctor-item doctor-${i.kind}`}>
                <div className="doctor-icon">{KIND_ICON[i.kind]}</div>
                <div className="health-body">
                  <h4>
                    <span className="doctor-time">{new Date(i.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                    {i.title}
                  </h4>
                  <p>{i.detail}</p>
                  {i.advice && <p className="doctor-advice">{i.advice}</p>}
                  {i.fix && (
                    <div className="health-actions">
                      <FixButton fix={i.fix} run={() => api.doctorFix(i.id)} onDone={report.refresh} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {planned > 0 && (
            <button className="link health-ok-toggle" onClick={() => setShowPlanned(!showPlanned)}>
              {showPlanned ? 'Hide' : 'Show'} {planned} planned restart{planned === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Health: checks for beginner traps, and why the server restarted. */
export function Health({ hosted = false }: { hosted?: boolean }) {
  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Health</h1>
          <p className="muted-note">Common setup problems, checked for you, with a fix where one is safe. Every fix asks first and can be undone where that's possible.</p>
        </div>
      </header>
      <Checks />
      {/* The router, firewall and Windows' records are about a server on this PC. */}
      {!hosted && <FriendsCard />}
      {!hosted && <Doctor />}
    </div>
  );
}
