// Home: the server's command centre. A stream of blocks (what's going on, what you've done, the
// live log), a box to type what you want in plain words, and a live panel beside it. Simple mode
// adds a welcome and clickable starting points; Pro mode shows the raw log and command syntax.
import {
  AlertTriangle, Bell, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, ExternalLink, Gamepad2, Loader2, Play, Power,
  RotateCw, Square, Terminal, Timer, Users, X, XCircle,
} from 'lucide-react';
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import {
  actionById, blockedBy, POPULAR_IDS, runsNow, STARTER_IDS,
  type ActionDef, type Ctx, type FieldDef, type Mode, type Outcome, type Values,
} from '../actions';
import {
  api, type ConsoleLine, type Dashboard, type Overview as OverviewData, type Problem,
} from '../api';
import { CommandBox, useActionCtx } from '../CommandBox';
import { findNamed, normalize, playerName } from '../commands';
import { readStored, useStored, writeStored } from '../mode';
import { takeHomeAction } from '../nav';
import { ProblemCard, ProblemList, RecentFixes } from '../Problems';
import { startTour } from '../Tour';
import {
  Button, formatBytes, formatUptime, Modal, Notice, Spinner, Toggle, useConfirm, usePoll, useToast,
} from '../ui';
import { UpdateNotice } from '../Updates';
import { Sparkline } from '../Visuals';
import { ConsoleRow } from './Console';
import { FinishTxAdmin } from './Overview';

interface Props {
  data: OverviewData | null;
  error: string | null;
  refresh: () => void;
  local: boolean;
  mode: Mode;
}

export function Home({ data, error, refresh, local, mode }: Props) {
  if (!data) return <div className="content">{error ? <Notice kind="error">{error}</Notice> : <Spinner />}</div>;
  if (!data.deployed) return <div className="content"><FinishTxAdmin data={data} local={local} /></div>;
  return <HomeLive data={data} error={error} refresh={refresh} local={local} mode={mode} />;
}

// ---------------------------------------------------------------- what's been done, remembered here
interface Entry { id: string; at: number; command: string; outcome: Outcome | null }
const LOG_KEY = 'cityhq-home-log';
const readLog = (): Entry[] => {
  try { return (JSON.parse(readStored(LOG_KEY) || '[]') as Entry[]).filter((e) => e.outcome); } catch { return []; }
};
const saveLog = (list: Entry[]) => writeStored(LOG_KEY, JSON.stringify(list.filter((e) => e.outcome).slice(-30)));

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Short names for the buttons under the box in Simple mode. */
const CHIP_LABEL: Record<string, string> = {
  announce: 'Announce', restart: 'Restart', revive: 'Revive a player', give: 'Give an item', car: 'Spawn a car', backup: 'Back up',
};

/** How an action reads as a command: "kick Tommy Briggs", "weather rain". */
function commandText(action: ActionDef, values: Values, ctx: Ctx): string {
  if (action.go) return action.words[0];
  const player = ctx.players.find((p) => p.id === Number(values.player));
  const bits = [action.command];
  if (values.player === 'all') bits.push('everyone');
  else if (player) bits.push(playerName(player));
  if (values.weather) bits.push(String(values.weather).toLowerCase());
  if (values.resource) bits.push(String(values.resource));
  if (values.item) bits.push(String(values.item));
  if (values.model) bits.push(String(values.model));
  return bits.join(' ');
}

function HomeLive({ data, error, refresh, local, mode }: Props & { data: OverviewData }) {
  const toast = useToast();
  const confirm = useConfirm();
  const online = data.state === 'online';
  const hosted = data.hosted || null;
  const canPower = !hosted || hosted.capabilities.power;
  const playerCount = data.status?.players ?? 0;
  const base = useMemo(
    () => ({ online, hosted: Boolean(hosted), local, canPower, playerCount, mode }),
    [online, hosted, local, canPower, playerCount, mode],
  );
  const { ctx, ensure } = useActionCtx(base, true);
  const dash = usePoll(api.dashboard, 30000);
  const [entries, setEntries] = useState<Entry[]>(readLog);
  const [form, setForm] = useState<{ action: ActionDef; values: Values; key: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' }); });
  }, []);

  const addEntry = useCallback((entry: Entry) => {
    setEntries((list) => {
      const next = [...list.filter((e) => e.id !== entry.id), entry];
      saveLog(next);
      return next;
    });
  }, []);

  const execute = useCallback(async (action: ActionDef, values: Values) => {
    if (!action.run) return;
    const entry: Entry = { id: `${Date.now()}-${action.id}`, at: Date.now(), command: commandText(action, values, ctx), outcome: null };
    addEntry(entry);
    scrollDown();
    let outcome: Outcome;
    try {
      outcome = await action.run(values, ctx);
    } catch (err) {
      outcome = { ok: false, title: `${action.title} didn't work`, detail: (err as Error).message };
    }
    addEntry({ ...entry, outcome });
    scrollDown();
    refresh();
  }, [addEntry, ctx, refresh, scrollDown]);

  const start = useCallback((action: ActionDef, values: Values = {}) => {
    if (action.go) { action.go(values); return; }
    const blocked = blockedBy(action, ctx);
    if (blocked) { toast(`${blocked}.`, 'error'); return; }
    if (runsNow(action, values, ctx)) { setForm(null); execute(action, values); return; }
    setForm({ action, values: { ...(action.defaults?.(ctx) || {}), ...values }, key: Date.now() });
    scrollDown();
  }, [ctx, execute, scrollDown, toast]);

  const startById = useCallback((id: string) => {
    const action = actionById(id);
    if (action) start(action);
  }, [start]);

  const runRaw = useCallback(async (text: string) => {
    // "quit" stops the game server at once, without saving anyone first.
    if (/^\s*(quit|exit)\b/i.test(text) && !(await confirm({
      title: 'Shut the server down now?',
      body: <p><code>{text}</code> stops the game server straight away, without saving players first. Stop, on the right, saves everyone before it shuts down.</p>,
      confirm: 'Run it anyway',
      danger: true,
    }))) return;
    const entry: Entry = { id: `${Date.now()}-raw`, at: Date.now(), command: text, outcome: null };
    addEntry(entry);
    scrollDown();
    try {
      await api.command(text);
      addEntry({ ...entry, outcome: { ok: true, title: 'Sent to the server\'s console', detail: 'Its answer shows in the live log.' } });
    } catch (err) {
      addEntry({ ...entry, outcome: { ok: false, title: 'The server didn\'t take that command', detail: (err as Error).message } });
    }
    scrollDown();
  }, [addEntry, confirm, scrollDown]);

  // An action picked with Ctrl K on another page opens here.
  const startRef = useRef(start);
  startRef.current = start;
  const rawRef = useRef(runRaw);
  rawRef.current = runRaw;
  useEffect(() => {
    const take = () => {
      const target = takeHomeAction();
      if (!target) return;
      if (target.id === RAW_ID) { rawRef.current(String(target.values.text || '')); return; }
      const action = actionById(target.id);
      if (action) startRef.current(action, target.values);
    };
    take();
    window.addEventListener('qbc-home-action', take);
    return () => window.removeEventListener('qbc-home-action', take);
  }, []);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('qbc-focus-command', focus);
    return () => window.removeEventListener('qbc-focus-command', focus);
  }, []);

  useEffect(() => { scrollDown(); }, [scrollDown]);

  const clearLog = () => { setEntries([]); saveLog([]); };
  const dismissAlert = async (id: string) => { try { await api.markSeen(id); } catch { /* shown again next time */ } refresh(); };
  const pending = data.schedule?.pendingRestart;

  return (
    <div className="home">
      <section className="home-stream">
        <div className="home-blocks" ref={streamRef}>
          <div className="home-blocks-in">
            {mode === 'simple' && <WelcomeBlock data={data} />}
            {local && data.update && <UpdateNotice version={data.update.version} />}
            {error && <Notice kind="error">{error}</Notice>}
            <ServerBlock data={data} local={local} mode={mode} onStart={startById} />
            {mode === 'simple' && <StarterBlock ctx={ctx} onStart={startById} />}
            {entries.length > 0 && (
              <div className="blk-divider">
                <span>Earlier</span>
                <button type="button" className="link-plain" onClick={clearLog}>Clear</button>
              </div>
            )}
            {entries.map((e) => <EntryBlock key={e.id} entry={e} />)}
            {hosted?.problem && <Notice kind="error">{hosted.problem}</Notice>}
            {!data.processes.database && online && (
              <Notice kind="error">The database isn't running, so the server can't save anything. {data.databaseManaged === false ? 'Start your database (for example MySQL in XAMPP\'s control panel).' : 'Restart the server to bring it back.'}</Notice>
            )}
            {data.helperOutdated && online && <Notice kind="info">CityHQ was updated. Restart the server once when it suits you, to turn on its newest in-game tools.</Notice>}
            {data.alerts.map((alert) => (
              <Block key={alert.id} className="blk-alert" icon={<Bell size={16} />} title={alert.title} time={alert.at}
                right={<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissAlert(alert.id)}><X size={15} /></button>}>
                {alert.detail && <p>{alert.detail}</p>}
              </Block>
            ))}
            {pending && <CountdownBlock at={pending.at} scheduled={pending.reason === 'scheduled'} onDone={refresh} />}
            {form && (
              <ActionForm
                key={form.key}
                action={form.action}
                initial={form.values}
                ctx={ctx}
                mode={mode}
                ensure={ensure}
                onCancel={() => setForm(null)}
                onDone={(outcome, values) => {
                  const entry: Entry = { id: `${Date.now()}-${form.action.id}`, at: Date.now(), command: commandText(form.action, values, ctx), outcome };
                  setForm(null);
                  addEntry(entry);
                  scrollDown();
                  refresh();
                }}
              />
            )}
            <LiveLog mode={mode} online={online} />
          </div>
        </div>

        <div className="home-composer">
          <CommandBox
            ctx={ctx}
            mode={mode}
            inputRef={inputRef}
            onFocus={ensure}
            onAction={(action, values) => start(action, values)}
            onRaw={runRaw}
            placeholder={mode === 'simple'
              ? 'What do you want to do? Try "kick a player", "make it rain" or "add a script"'
              : 'Type a command, a player or a script. Tab completes, ↑ for history'}
          />
          <div className="quick">
            <span className="quick-lead">{mode === 'simple' ? 'Popular:' : 'Commands:'}</span>
            {POPULAR_IDS[mode].map((id) => {
              const a = actionById(id);
              if (!a) return null;
              return (
                <button key={id} type="button" className="quick-chip" onClick={() => start(a)} title={a.hint}>
                  {a.icon}<span>{mode === 'pro' ? a.command : CHIP_LABEL[id] || a.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <HomeSide data={data} dash={dash.data} mode={mode} onStart={startById} refresh={refresh} />
    </div>
  );
}

/** The id an action from another page uses to mean "send this text to the server's console". */
export const RAW_ID = '__raw';

// ---------------------------------------------------------------- blocks
function Block({ icon, title, cmd, time, right, children, className = '' }: {
  icon?: ReactNode; title: ReactNode; cmd?: string; time?: number; right?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section className={`blk ${className}`}>
      <header className="blk-head">
        {icon && <span className="blk-icon">{icon}</span>}
        <strong className="blk-title">{title}</strong>
        {cmd && <code className="blk-cmd">{cmd}</code>}
        <span className="blk-right">{right}{time && <time>{hhmm(time)}</time>}</span>
      </header>
      {children && <div className="blk-body">{children}</div>}
    </section>
  );
}

function WelcomeBlock({ data }: { data: OverviewData }) {
  const [hidden, setHidden] = useStored('cityhq-home-welcome', '');
  if (hidden === 'hidden') return null;
  const checks = [
    { ok: true, label: 'Server found' },
    { ok: data.processes.database || Boolean(data.hosted), label: 'Database connected' },
    { ok: !data.helperOutdated, label: 'Helper installed' },
    ...(data.hosted ? [] : [{ ok: Boolean(data.schedule?.nextBackup), label: data.schedule?.nextBackup ? 'Nightly backup on' : 'Nightly backup off' }]),
  ];
  return (
    <section className="blk home-welcome">
      <div>
        <h2>Welcome to your server's home</h2>
        <p>Click anything below, or type what you want to do in the box at the bottom, in your own words. Everything you do shows up here.</p>
        <ul className="home-checks">
          {checks.map((c) => <li key={c.label} className={c.ok ? 'ok' : 'off'}>{c.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{c.label}</li>)}
        </ul>
      </div>
      <div className="home-welcome-actions">
        <Button onClick={startTour}>Take the tour</Button>
        <Button variant="ghost" icon={<X size={14} />} onClick={() => setHidden('hidden')}>Hide</Button>
      </div>
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard isn't available over plain http from a phone */ }
  };
  return <Button icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>{copied ? 'Copied' : label}</Button>;
}

function ServerBlock({ data, local, mode, onStart }: { data: OverviewData; local: boolean; mode: Mode; onStart: (id: string) => void }) {
  const hosted = data.hosted || null;
  const canPower = !hosted || hosted.capabilities.power;
  const join = hosted ? hosted.join?.text || null : `localhost:${data.gamePort}`;
  // A hosted server can be found by name only while FiveM's list has it.
  const listed = hosted ? hosted.join?.listed ?? null : true;
  const state = data.state;
  if (state === 'online') {
    return (
      <Block className="blk-ok" icon={<CheckCircle2 size={16} />} title="Your server is online" right={data.status ? <span>up {formatUptime(data.status.uptimeSec)}</span> : null}>
        {join && <p>Players join with <code>connect {join}</code> in FiveM's F8 console{listed ? ', or by searching for your server\'s name' : ''}.</p>}
        {listed === false && <p className="muted-note">FiveM's server list doesn't have it right now, so searching won't find it and its cfx.re link won't open.{join !== hosted?.join?.link ? ' This address works anyway.' : ''}</p>}
        <div className="blk-actions">
          {join && <CopyButton text={`connect ${join}`} label="Copy join command" />}
          {local && join && <a className="btn btn-ghost" href={`fivem://connect/${join}`} target="_blank" rel="noreferrer"><Gamepad2 size={14} /><span>Open in FiveM</span></a>}
          {mode === 'simple' && !hosted && <a className="btn btn-ghost" href="#health"><Users size={14} /><span>Let friends outside your home join</span></a>}
        </div>
      </Block>
    );
  }
  if (state === 'stopped' || state === 'panel-only') {
    return (
      <Block icon={<Power size={16} />} title="Your server is off">
        <p>{state === 'panel-only' ? 'txAdmin is running, but the game server is off.' : 'Start it whenever you\'re ready. It takes about a minute.'}</p>
        <div className="blk-actions">
          {canPower && <Button variant="primary" icon={<Play size={14} />} onClick={() => onStart('start')}>Start the server</Button>}
          {!canPower && hosted?.panelUrl && <a className="btn btn-default" href={hosted.panelUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /><span>Start it from your host's panel</span></a>}
        </div>
      </Block>
    );
  }
  if (state === 'unreachable') {
    return (
      <Block icon={<AlertTriangle size={16} />} title="CityHQ can't see your server right now">
        <p>{hosted?.capabilities.power === false
          ? 'CityHQ\'s helper isn\'t answering yet. It starts when the server restarts: restart it from your host\'s panel when nobody is on.'
          : 'CityHQ can\'t reach your host right now. It keeps trying.'}</p>
        {hosted?.panelUrl && <div className="blk-actions"><a className="btn btn-default" href={hosted.panelUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /><span>Open your host's panel</span></a></div>}
      </Block>
    );
  }
  const words: Record<string, string> = {
    starting: 'Starting: loading your scripts. This usually takes under a minute.',
    restarting: 'Restarting: saving players first. This usually takes under a minute.',
    stopping: 'Stopping: saving players, then shutting down.',
    restoring: 'Restoring from a backup. This takes about 4 minutes.',
  };
  return <Block icon={<Loader2 size={16} className="spin" />} title={words[state] || 'Working...'} />;
}

function StarterBlock({ ctx, onStart }: { ctx: Ctx; onStart: (id: string) => void }) {
  return (
    <Block title="Things you can do" right={<span>Each one also works by typing</span>}>
      <div className="starter-grid">
        {STARTER_IDS.map((id) => {
          const a = actionById(id);
          if (!a) return null;
          const off = blockedBy(a, ctx);
          return (
            <button key={id} type="button" className="starter" onClick={() => onStart(id)} disabled={Boolean(off)} title={off || a.hint}>
              <span className="starter-icon">{a.icon}</span>
              <span className="starter-text"><strong>{a.title}</strong><span>{off || a.hint}<code>{a.command}</code></span></span>
            </button>
          );
        })}
      </div>
    </Block>
  );
}

function EntryBlock({ entry }: { entry: Entry }) {
  const o = entry.outcome;
  if (!o) return <Block icon={<Loader2 size={16} className="spin" />} title="Working on it..." cmd={entry.command} time={entry.at} />;
  return (
    <Block className={o.ok ? 'blk-ok' : 'blk-bad'} icon={o.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} title={o.title} cmd={entry.command} time={entry.at}>
      {(o.detail || o.table || o.links) && (
        <>
          {o.detail && <p>{o.detail}</p>}
          {o.table && (
            <div className="table-wrap">
              <table className="blk-table">
                <thead><tr>{o.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>{o.table.rows.map((row) => <tr key={row.join('|')}>{row.map((cell, i) => <td key={`${i}-${cell}`}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          {o.links && <div className="blk-links">{o.links.map((l) => <a key={l.go + l.label} href={`#${l.go}`}>{l.label}</a>)}</div>}
        </>
      )}
    </Block>
  );
}

function CountdownBlock({ at, scheduled, onDone }: { at: number; scheduled: boolean; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((at - now) / 1000));
  const cancel = async () => {
    setBusy(true);
    try { await api.cancelRestartLater(); toast('Restart cancelled'); } catch (err) { toast((err as Error).message, 'error'); }
    setBusy(false);
    onDone();
  };
  return (
    <Block className="blk-warn" icon={<Timer size={16} />} title={`Restarting in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}
      right={<Button busy={busy} onClick={cancel}>{scheduled ? 'Skip this one' : 'Cancel'}</Button>}>
      <p>{scheduled ? 'This is your scheduled restart.' : 'You asked for this.'} Players are warned at 15, 5 and 1 minutes.</p>
    </Block>
  );
}

// ---------------------------------------------------------------- forms
function PickField({ field, value, ctx, onChange }: { field: Extract<FieldDef, { kind: 'pick' }>; value: string; ctx: Ctx; onChange: (v: string | undefined) => void }) {
  const options = useMemo(() => {
    if (field.source === 'items') return (ctx.shared?.items || []).map((i) => ({ name: i.name, label: i.label }));
    if (field.source === 'vehicles') return (ctx.shared?.vehicles || []).map((c) => ({ name: c.model, label: `${c.name}${c.brand ? ` (${c.brand})` : ''}` }));
    return ctx.resources.map((r) => ({ name: r.name, label: r.name }));
  }, [field.source, ctx.shared, ctx.resources]);
  const current = options.find((o) => o.name === value);
  const [text, setText] = useState(current ? current.label : value || '');
  useEffect(() => { if (current && normalize(text) !== normalize(current.label)) setText(current.label); /* a value set by typing */ }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const listId = `pick-${field.key}`;
  const resolve = (t: string) => {
    setText(t);
    const exact = options.find((o) => normalize(o.label) === normalize(t) || normalize(o.name) === normalize(t));
    const found = exact || (t.trim().length >= 2 ? findNamed(t, options) : null);
    // Cars can be any model name, even one the list doesn't have.
    onChange(found?.name || (field.source === 'vehicles' && /^[a-z0-9_]{2,}$/i.test(t.trim()) ? t.trim().toLowerCase() : undefined));
  };
  return (
    <label className="form-field">
      <span className="input-label">{field.label}</span>
      <input className="input" list={listId} value={text} placeholder={field.placeholder} onChange={(e) => resolve(e.target.value)} autoComplete="off" spellCheck={false} />
      <datalist id={listId}>{options.slice(0, 400).map((o) => <option key={o.name} value={o.label} />)}</datalist>
      {value && current && normalize(current.label) !== normalize(text) && <small className="muted-note">Using {current.label}</small>}
      {value && !current && field.source === 'vehicles' && <small className="muted-note">Spawns the model "{value}"</small>}
    </label>
  );
}

function ActionForm({ action, initial, ctx, mode, ensure, onCancel, onDone }: {
  action: ActionDef; initial: Values; ctx: Ctx; mode: Mode; ensure: () => void;
  onCancel: () => void; onDone: (outcome: Outcome, values: Values) => void;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const set = (key: string, v: Values[string]) => setValues((old) => ({ ...old, [key]: v }));
  useEffect(() => { ensure(); }, [ensure]);
  const missing = action.missing?.(values, ctx) || blockedBy(action, ctx);
  const submit = async () => {
    if (missing || !action.run) return;
    const ask = action.confirm?.(values, ctx);
    if (ask && !(await confirm({ title: ask.title, body: <p>{ask.body}</p>, confirm: ask.confirm, danger: action.danger }))) return;
    setBusy(true);
    try {
      const outcome = await action.run(values, ctx);
      onDone(outcome, values);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const firstText = action.fields?.find((f) => f.kind === 'text' && !f.optional);
  return (
    <Block className="blk-form" icon={action.icon} title={action.title} cmd={action.command === 'open' ? undefined : action.command}
      right={<button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}><X size={15} /></button>}>
      <form className="action-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {(action.fields || []).map((f) => {
          const v = values[f.key];
          if (f.kind === 'text') {
            return (
              <label key={f.key} className="form-field">
                <span className="input-label">{f.label}{f.optional && <small> (optional)</small>}</span>
                {f.multiline
                  ? <textarea className="input" rows={2} maxLength={f.max} placeholder={f.placeholder} value={String(v ?? '')} autoFocus={f === firstText} onChange={(e) => set(f.key, e.target.value)} />
                  : <input className="input" maxLength={f.max} placeholder={f.placeholder} value={String(v ?? '')} autoFocus={f === firstText} onChange={(e) => set(f.key, e.target.value)} />}
              </label>
            );
          }
          if (f.kind === 'player') {
            return (
              <label key={f.key} className="form-field">
                <span className="input-label">{f.label}</span>
                <select className="input" value={v === undefined ? '' : String(v)} onChange={(e) => set(f.key, e.target.value === 'all' ? 'all' : e.target.value ? Number(e.target.value) : undefined)}>
                  <option value="">{ctx.players.length ? 'Choose a player' : 'Nobody is online'}</option>
                  {f.everyone && <option value="all">Everyone</option>}
                  {ctx.players.map((p) => <option key={p.id} value={p.id}>{playerName(p)} ({p.name}, ID {p.id})</option>)}
                </select>
              </label>
            );
          }
          if (f.kind === 'pick') return <PickField key={f.key} field={f} value={String(v ?? '')} ctx={ctx} onChange={(nv) => set(f.key, nv)} />;
          if (f.kind === 'number') {
            return (
              <label key={f.key} className="form-field form-narrow">
                <span className="input-label">{f.label}</span>
                <input className="input input-number" type="number" min={f.min} max={f.max} value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />
              </label>
            );
          }
          if (f.kind === 'toggle') {
            return (
              <label key={f.key} className="form-toggle">
                <Toggle checked={Boolean(v)} onChange={(nv) => set(f.key, nv)} label={f.label} />
                <span><strong>{f.label}</strong>{f.help && <small>{f.help}</small>}</span>
              </label>
            );
          }
          return (
            <div key={f.key} className="form-field">
              <span className="input-label">{f.label}</span>
              <div className="choice-chips" role="radiogroup" aria-label={f.label}>
                {f.options.map((o) => (
                  <button key={o.value} type="button" role="radio" aria-checked={String(v) === o.value} className={`filter-chip ${String(v) === o.value ? 'active' : ''}`} onClick={() => set(f.key, o.value)}>{o.label}</button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="form-foot">
          <Button type="submit" variant={action.danger ? 'danger' : 'primary'} icon={action.icon} busy={busy} disabled={Boolean(missing)}>
            {action.button?.(values, ctx) || action.title}
          </Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {missing ? <span className="form-missing">{missing}</span>
            : mode === 'simple' && <span className="form-learn">Next time, you can just type <code>{action.usage}</code></span>}
        </div>
      </form>
    </Block>
  );
}

// ---------------------------------------------------------------- the live log
const JOIN_LINE = /\b(joined|connected|connecting)\b/i;
const NOT_A_PLAYER = /\b(database|mysql|mariadb|oxmysql|txadmin|cfx\.re|server|resource|http)\b/i;

function LiveLog({ mode, online }: { mode: Mode; online: boolean }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [open, setOpen] = useState(mode === 'pro');
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const offset = useRef<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { setOpen(mode === 'pro'); }, [mode]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const chunk = await api.console(offset.current);
        if (!alive) return;
        offset.current = chunk.offset;
        if (chunk.reset) setLines(chunk.lines.slice(-300));
        else if (chunk.lines.length) setLines((old) => [...old, ...chunk.lines].slice(-300));
      } catch { /* the block says what it has */ }
      if (alive) timer = setTimeout(tick, document.hidden ? 6000 : 1500);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const recent = lines.slice(-120);
  const errors = recent.filter((l) => l.level === 'error').length;
  const warnings = recent.filter((l) => l.level === 'warn').length;
  const joins = recent.filter((l) => JOIN_LINE.test(l.text) && !NOT_A_PLAYER.test(l.text)).length;
  const visible = lines.filter((l) => (level === 'all' ? true : level === 'warn' ? l.level !== 'info' : l.level === 'error')).slice(-80);
  useEffect(() => { if (open && box.current) box.current.scrollTop = box.current.scrollHeight; }, [visible.length, open]);

  const bits = [joins ? `${joins} player${joins === 1 ? '' : 's'} joined` : null, warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : null, errors ? `${errors} error${errors === 1 ? '' : 's'}` : null].filter(Boolean);
  const summary = !online && !lines.length ? 'The server is off' : errors ? bits.join(' · ') : `All good lately${bits.length ? ` · ${bits.join(' · ')}` : ''}`;

  return (
    <section className={`blk blk-log ${open ? 'is-open' : ''}`}>
      <header className="blk-head">
        <span className="blk-icon">{errors ? <AlertTriangle size={16} className="tone-text-warn" /> : <Terminal size={16} />}</span>
        <strong className="blk-title">Live log</strong>
        <span className="blk-summary">{summary}</span>
        <span className="blk-right">
          <button type="button" className="link-plain blk-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? <>Hide<ChevronUp size={14} /></> : <>Show the log<ChevronDown size={14} /></>}
          </button>
        </span>
      </header>
      {open && (
        <div className="blk-body">
          <div className="choice-chips">
            {([['all', 'All'], ['warn', `Warnings${warnings ? ` ${warnings}` : ''}`], ['error', `Errors${errors ? ` ${errors}` : ''}`]] as const).map(([value, label]) => (
              <button key={value} type="button" className={`filter-chip ${level === value ? 'active' : ''}`} onClick={() => setLevel(value)}>{label}</button>
            ))}
            <a className="link-plain small log-full" href="#console">Open the full console</a>
          </div>
          <div className="log-box" ref={box} role="log" aria-label="Server log">
            {visible.length === 0 && <div className="console-line muted-note">{lines.length ? 'Nothing matches this filter.' : 'Waiting for the server to say something...'}</div>}
            {visible.map((l, i) => <ConsoleRow key={`${lines.length}-${i}`} line={l} />)}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the live side panel
function loadWord(pct: number | null) {
  if (pct === null) return { word: 'Off', tone: '' };
  if (pct < 45) return { word: 'Light', tone: 'good' };
  if (pct < 80) return { word: 'Busy', tone: 'warn' };
  return { word: 'Very busy', tone: 'bad' };
}

function HomeSide({ data, dash, mode, onStart, refresh }: {
  data: OverviewData; dash: Dashboard | null; mode: Mode; onStart: (id: string) => void; refresh: () => void;
}) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [all, setAll] = useState(false);
  const hosted = data.hosted || null;
  const canPower = !hosted || hosted.capabilities.power;
  const online = data.state === 'online';
  const busy = ['starting', 'stopping', 'restarting', 'restoring'].includes(data.state);
  const { status, stats } = data;
  const cpu = online ? stats.cpuPct : null;
  const load = loadWord(cpu === null ? null : Math.round(cpu));
  const stateWord: Record<string, string> = {
    online: 'Online', stopped: 'Off', 'panel-only': 'Off', starting: 'Starting', restarting: 'Restarting', stopping: 'Stopping', restoring: 'Restoring', unreachable: 'Not answering',
  };
  const restartAt = data.schedule?.pendingRestart?.at || data.schedule?.nextRestart || null;
  return (
    <aside className="home-side" aria-label="Your server right now">
      <div className="side-state">
        <span className="side-k">Your server</span>
        <span className={`side-v state-${data.state}`}><i />{stateWord[data.state] || data.state}</span>
        <span className="side-d">
          {online && status ? `For ${formatUptime(status.uptimeSec)}` : busy ? 'Give it a moment' : hosted ? `On ${hosted.label}` : 'On this PC'}
          {restartAt && online ? ` · restarts by itself at ${hhmm(restartAt)}` : ''}
        </span>
        <div className="side-buttons">
          {(data.state === 'stopped' || data.state === 'panel-only') && canPower
            ? <Button variant="primary" icon={<Play size={14} />} onClick={() => onStart('start')}>Start</Button>
            : (
              <>
                <Button icon={<RotateCw size={14} />} disabled={busy || (!online && !canPower)} onClick={() => onStart('restart')}>Restart</Button>
                {canPower && <Button icon={<Square size={13} />} disabled={busy || data.state === 'stopped'} onClick={() => onStart('stop')}>Stop</Button>}
              </>
            )}
          {hosted?.panelUrl && <a className="btn btn-ghost" href={hosted.panelUrl} target="_blank" rel="noreferrer" title="Your host's panel"><ExternalLink size={14} /></a>}
        </div>
      </div>

      <a className="side-row" href="#players">
        <span className="side-k">Players</span>
        <span className="side-n">{status ? status.players : '-'}<small>{status ? ` of ${status.maxClients}${mode === 'simple' ? ' can join' : ''}` : ''}</small></span>
        {dash && <Sparkline values={dash.day.slice(-48).map((p) => p.v)} label="Players over the last day" />}
      </a>

      <div className="side-row">
        <span className="side-k">{mode === 'simple' ? `How hard ${hosted ? 'your server' : 'your PC'} is working` : 'CPU and memory'}</span>
        {mode === 'simple'
          ? <span className="side-n"><span className={load.tone ? `tone-text-${load.tone}` : ''}>{load.word}</span><small>{cpu !== null ? ` CPU ${Math.round(cpu)}% · memory ${formatBytes(stats.memBytes)}` : ''}</small></span>
          : <span className="side-n">{cpu !== null ? `${Math.round(cpu)}%` : '-'}<small>{` · ${formatBytes(stats.memBytes)}${stats.sysMemTotal ? ` of ${formatBytes(stats.sysMemTotal)}` : ''}`}</small></span>}
      </div>

      <div className="side-problems">
        <div className="side-sec">
          <span>Things to fix</span><span className="side-count">{data.problems.length || ''}</span>
        </div>
        {data.problems.length === 0 && <p className="side-ok"><CheckCircle2 size={15} />Nothing needs fixing</p>}
        {data.problems.slice(0, 3).map((p) => (
          <div key={p.id} className={`side-fix ${p.severity}`}>
            <strong>{p.severity === 'error' ? <XCircle size={15} /> : <AlertTriangle size={15} />}{p.title}</strong>
            <p>{p.what}</p>
            <button type="button" className="link-plain side-link" onClick={() => setProblem(p)}>{p.actions.some((a) => a.kind === 'fix') ? 'Fix it' : 'See how to fix it'}</button>
          </div>
        ))}
        {data.problems.length > 1 && <button type="button" className="link-plain side-link side-more" onClick={() => setAll(true)}>See all {data.problems.length}</button>}
      </div>

      {dash && dash.upcoming.length > 0 && (
        <div className="side-coming">
          <div className="side-sec"><span>Coming up</span></div>
          {dash.upcoming.slice(0, 4).map((u) => (
            <div key={`${u.kind}-${u.at}`} className="side-up"><span>{u.title}</span><time>{hhmm(u.at)}</time></div>
          ))}
        </div>
      )}

      {problem && (
        <Modal title={problem.title} onClose={() => setProblem(null)} wide>
          <ProblemCard problem={problem} onChanged={() => { setProblem(null); refresh(); }} />
        </Modal>
      )}
      {all && (
        <Modal title={`Things to fix (${data.problems.length})`} onClose={() => setAll(false)} wide>
          <p className="muted-note">From the server's latest start, most serious first. Each says what happened and how to fix it.</p>
          <ProblemList problems={data.problems} onChanged={refresh} />
          <RecentFixes onChanged={refresh} />
        </Modal>
      )}
    </aside>
  );
}
