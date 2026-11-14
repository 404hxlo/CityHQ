import {
  AlertTriangle, ArrowLeftRight, Check, CheckCircle2, CircleSlash, Loader2, Power, X, XCircle,
} from 'lucide-react';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode,
} from 'react';
import type { ServerState } from './api';

// ---------------------------------------------------------------- polling
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    try {
      const next = await loadRef.current();
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setError((err as Error).message);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    setLoading(true);
    refresh();
    if (!intervalMs) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, intervalMs);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);

  return { data, error, loading, refresh, setData };
}

// ---------------------------------------------------------------- toasts
type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; text: string }
const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = (id: number) => setItems((list) => list.filter((t) => t.id !== id));
  const push = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-3), { id, kind, text }]);
    // An error long enough to hold steps for fixing it stays until it is closed.
    if (kind !== 'error' || text.length <= 160) setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'error' ? <XCircle size={18} /> : t.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{t.text}</span>
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- confirm dialogs
interface ConfirmOptions { title: string; body?: ReactNode; confirm: string; danger?: boolean }
type ConfirmState = ConfirmOptions & { resolve: (ok: boolean) => void };
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (ok: boolean) => { state?.resolve(ok); setState(null); };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state && (
        <Modal
          title={state.title}
          onClose={() => close(false)}
          footer={(
            <>
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button autoFocus variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state.confirm}</Button>
            </>
          )}
        >
          {state.body}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

/** Runs an action, tracks it as busy, and reports failures as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(key);
    try {
      const result = await fn();
      if (success) toast(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (err) {
      toast((err as Error).message, 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}

// ---------------------------------------------------------------- basics
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  icon?: ReactNode;
  busy?: boolean;
}
export function Button({ variant = 'default', icon, busy, children, className = '', disabled, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 size={16} className="spin" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
    >
      <span className="toggle-knob">{checked && <Check size={11} strokeWidth={3} />}</span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        {children && <div className="modal-body">{children}</div>}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Asks before leaving a side panel that has unsaved edits in it. */
export function useCanLeave() {
  const confirm = useConfirm();
  return useCallback(async () => {
    if (!document.querySelector('.drawer .save-bar')) return true;
    return confirm({ title: 'Discard your changes?', body: <p>You have changes that are not saved yet.</p>, confirm: 'Discard', danger: true });
  }, [confirm]);
}

export function Drawer({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  const canLeave = useCanLeave();
  const close = async () => {
    // Esc leaves full screen or a dialog first; the panel stays open underneath.
    if (document.querySelector('.is-fullscreen, .modal')) return;
    if (await canLeave()) onClose();
  };
  useEscape(close);
  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label}>{children}</aside>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Notice({ kind = 'warn', children }: { kind?: 'warn' | 'error' | 'info'; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`}>
      {kind === 'error' ? <XCircle size={18} /> : <AlertTriangle size={18} />}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner-row"><Loader2 size={18} className="spin" /><span>{label}</span></div>;
}

// ---------------------------------------------------------------- status
const SERVER_STATES: Record<ServerState, { label: string; tone: string; icon: ReactNode }> = {
  online: { label: 'Online', tone: 'good', icon: <CheckCircle2 size={15} /> },
  starting: { label: 'Starting', tone: 'warn', icon: <Loader2 size={15} className="spin" /> },
  restarting: { label: 'Restarting', tone: 'warn', icon: <Loader2 size={15} className="spin" /> },
  restoring: { label: 'Restoring', tone: 'warn', icon: <Loader2 size={15} className="spin" /> },
  stopping: { label: 'Stopping', tone: 'warn', icon: <Loader2 size={15} className="spin" /> },
  stopped: { label: 'Stopped', tone: 'muted', icon: <Power size={15} /> },
  'panel-only': { label: 'Game server off', tone: 'muted', icon: <Power size={15} /> },
  // A hosted server CityHQ can't see right now (only its files are reachable, and it isn't answering).
  unreachable: { label: 'Not answering', tone: 'muted', icon: <Power size={15} /> },
};

export function ServerBadge({ state }: { state: ServerState }) {
  const s = SERVER_STATES[state];
  return <span className={`badge tone-${s.tone}`}>{s.icon}{s.label}</span>;
}

const RESOURCE_STATES: Record<string, { label: string; tone: string; icon: ReactNode }> = {
  started: { label: 'Running', tone: 'good', icon: <CheckCircle2 size={14} /> },
  starting: { label: 'Starting', tone: 'warn', icon: <Loader2 size={14} className="spin" /> },
  stopping: { label: 'Stopping', tone: 'warn', icon: <Loader2 size={14} className="spin" /> },
  stopped: { label: 'Stopped', tone: 'muted', icon: <CircleSlash size={14} /> },
  uninitialized: { label: 'Not loaded', tone: 'muted', icon: <CircleSlash size={14} /> },
  missing: { label: 'Not loaded', tone: 'muted', icon: <CircleSlash size={14} /> },
  unknown: { label: 'Not loaded', tone: 'muted', icon: <CircleSlash size={14} /> },
  offline: { label: 'Server off', tone: 'muted', icon: <Power size={14} /> },
  replaced: { label: 'Replaced', tone: 'muted', icon: <ArrowLeftRight size={14} /> },
};

export function ResourceBadge({ state, problem, title }: { state: string; problem?: string | null; title?: string }) {
  const s = RESOURCE_STATES[state] || RESOURCE_STATES.unknown;
  if (problem) return <span className="badge tone-bad" title={problem}><AlertTriangle size={14} />{state === 'started' ? 'Needs attention' : 'Problem'}</span>;
  return <span className={`badge tone-${s.tone}`} title={title}>{s.icon}{s.label}</span>;
}

// ---------------------------------------------------------------- formatting
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function formatUptime(sec: number | undefined): string {
  if (sec === undefined) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(sec)}s`;
}

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today at ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

export const formatMoney = (n: number | undefined) => (n === undefined ? '-' : `$${Math.round(n).toLocaleString()}`);

/** How long ago something was: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
