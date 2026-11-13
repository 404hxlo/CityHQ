// The box on Home (and behind Ctrl K everywhere else) where someone types what they want to do.
// Suggestions update as they type; Enter runs or opens the best one, Tab completes it.
import { Boxes, CornerDownLeft, Search, Terminal, User } from 'lucide-react';
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject,
} from 'react';
import { api, type Player, type Resource, type Shared } from './api';
import {
  ACTIONS, valuesFor, type ActionDef, type Ctx, type Mode, type Values,
} from './actions';
import { matchActions, normalize, playerName } from './commands';
import { rememberTyped, typedHistory } from './mode';
import { openPlayer, openResourcePanel } from './nav';

/** Online players, the server's items and cars, and its scripts, for understanding what's typed. */
export function useActionCtx(base: Omit<Ctx, 'players' | 'shared' | 'resources'>, active: boolean) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [shared, setShared] = useState<Shared | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const loadedAt = useRef({ shared: 0, resources: 0 });

  useEffect(() => {
    if (!active || !base.online) { setPlayers([]); return undefined; }
    let alive = true;
    const load = () => { if (!document.hidden) api.players().then((p) => { if (alive) setPlayers(p); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, base.online]);

  /** The item, car and script lists are bigger, so they load the first time the box is used. */
  const ensure = useCallback(() => {
    const now = Date.now();
    if (base.online && now - loadedAt.current.shared > 300000) {
      loadedAt.current.shared = now;
      api.shared().then(setShared).catch(() => { loadedAt.current.shared = 0; });
    }
    if (now - loadedAt.current.resources > 120000) {
      loadedAt.current.resources = now;
      api.resources().then((r) => setResources(r.resources)).catch(() => { loadedAt.current.resources = 0; });
    }
  }, [base.online]);

  const ctx: Ctx = useMemo(() => ({ ...base, players, shared, resources }), [base, players, shared, resources]);
  return { ctx, ensure };
}

type Suggestion =
  | { key: string; kind: 'action'; action: ActionDef; values: Values; title: string; missing: string | null }
  | { key: string; kind: 'player'; player: Player }
  | { key: string; kind: 'resource'; resource: Resource }
  | { key: string; kind: 'raw'; text: string };

/** What an action means for what was typed, following "restart qb-garages" to the script action. */
function understand(action: ActionDef, rest: string, ctx: Ctx, raw: string): { action: ActionDef; values: Values } {
  const to = action.redirect?.(rest, ctx);
  const target = to ? ACTIONS.find((a) => a.id === to) || action : action;
  return { action: target, values: valuesFor(target, rest, ctx, raw) };
}

function titleFor(action: ActionDef, values: Values, ctx: Ctx) {
  const player = ctx.players.find((p) => p.id === Number(values.player));
  if (player) return `${action.title}: ${playerName(player)}`;
  if (values.player === 'all') return `${action.title}: everyone`;
  return action.title;
}

export function suggestionsFor(text: string, ctx: Ctx, mode: Mode): Suggestion[] {
  const q = normalize(text);
  if (!q) return [];
  const out: Suggestion[] = [];
  const found = matchActions(ACTIONS, text, 8);
  // With a clear match, loose ones ("make it rain" also starts like "make a backup") are noise.
  const cut = (found[0]?.score ?? 0) >= 90 ? 70 : 0;
  const matches = found.filter((m) => m.score >= cut && (mode === 'pro' || !m.action.pro || m.score >= 90));
  const seen = new Set<string>();
  for (const m of matches) {
    const { action, values } = understand(m.action, m.rest, ctx, text);
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    out.push({ key: `a:${action.id}`, kind: 'action', action, values, title: titleFor(action, values, ctx), missing: action.missing?.(values, ctx) || null });
  }
  const strong = matches.some((m) => m.score >= 90);
  if (!strong && q.length >= 2) {
    for (const p of ctx.players) {
      if (normalize(playerName(p)).includes(q) || normalize(p.name).includes(q)) out.push({ key: `p:${p.id}`, kind: 'player', player: p });
    }
    if (!q.includes(' ')) {
      for (const r of ctx.resources) if (r.name.toLowerCase().includes(q)) out.push({ key: `r:${r.name}`, kind: 'resource', resource: r });
    }
  }
  const top = out.slice(0, 7);
  // Anything else can be sent to the server's own console, like typing it into txAdmin.
  if (ctx.online) {
    const raw: Suggestion = { key: 'raw', kind: 'raw', text: text.trim() };
    if (mode === 'pro' && !strong) top.unshift(raw); else top.push(raw);
  }
  return top;
}

interface Props {
  ctx: Ctx;
  mode: Mode;
  onAction: (action: ActionDef, values: Values) => void;
  onRaw: (text: string) => void;
  onFocus?: () => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /** Ctrl K's box on other pages: the list opens below instead of above. */
  below?: boolean;
  onEscape?: () => void;
  trailing?: ReactNode;
}

export function CommandBox({ ctx, mode, onAction, onRaw, onFocus, placeholder, inputRef, autoFocus, below, onEscape, trailing }: Props) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef || ownRef;
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const historyAt = useRef(-1);
  const list = useMemo(() => suggestionsFor(text, ctx, mode), [text, ctx, mode]);
  const shown = open && list.length > 0;

  useEffect(() => { setActive(0); }, [text]);

  const choose = (s: Suggestion | undefined) => {
    if (!s) return;
    const typed = text.trim();
    if (typed) rememberTyped(typed);
    historyAt.current = -1;
    setText('');
    if (s.kind === 'action') onAction(s.action, s.values);
    else if (s.kind === 'player') openPlayer(s.player.id);
    else if (s.kind === 'resource') openResourcePanel(s.resource.name);
    else onRaw(s.text);
  };

  const complete = () => {
    const s = list[active];
    if (!s || s.kind !== 'action') return;
    const a = s.action;
    const lead = a.command === 'open' || a.command === 'help' || a.command === 'tour' ? a.words[0] : a.command;
    const player = ctx.players.find((p) => p.id === Number(s.values.player));
    setText(`${lead} ${player ? `${playerName(player)} ` : ''}`);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && shown) { e.preventDefault(); setActive((i) => Math.min(list.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp' && shown) { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !shown) {
      // Earlier commands, like a terminal.
      const past = typedHistory();
      const next = historyAt.current + (e.key === 'ArrowUp' ? 1 : -1);
      if (next < -1 || next >= past.length) return;
      e.preventDefault();
      historyAt.current = next;
      setText(next === -1 ? '' : past[next]);
      setOpen(false);
      return;
    }
    if (e.key === 'Tab' && shown) { e.preventDefault(); complete(); return; }
    if (e.key === 'Enter') { e.preventDefault(); choose(list[active]); return; }
    if (e.key === 'Escape') {
      if (text) setText('');
      else onEscape?.();
      ref.current?.blur();
    }
  };

  return (
    <div className={`cmdbox ${below ? 'cmdbox-below' : ''}`}>
      {shown && (
        <ul className="cmd-list" role="listbox" aria-label="Suggestions">
          {list.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              >
                <SuggestionRow s={s} mode={mode} active={i === active} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="cmd-input">
        <Search size={17} className="cmd-search" />
        <input
          ref={ref}
          value={text}
          placeholder={placeholder}
          aria-label="What do you want to do?"
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onFocus={() => { setOpen(true); onFocus?.(); }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { setText(e.target.value); setOpen(true); historyAt.current = -1; }}
          onKeyDown={onKey}
        />
        {trailing}
        <kbd className="cmd-enter"><CornerDownLeft size={12} />Enter</kbd>
      </div>
    </div>
  );
}

function SuggestionRow({ s, mode, active }: { s: Suggestion; mode: Mode; active: boolean }) {
  if (s.kind === 'action') {
    return (
      <>
        <span className="cmd-icon">{s.action.icon}</span>
        <span className="cmd-main">
          <strong>{s.title}</strong>
          <span>{s.missing && s.action.fields ? `${s.action.hint}. ${s.missing}.` : s.action.hint}</span>
        </span>
        {(mode === 'pro' || active) && <code className="cmd-usage">{s.action.usage}</code>}
        {active && <span className="cmd-keys">{s.action.go ? 'Open' : s.missing || s.action.danger || !s.action.instant ? 'Fill in' : 'Run'}</span>}
      </>
    );
  }
  if (s.kind === 'player') {
    return (
      <>
        <span className="cmd-icon"><User size={16} /></span>
        <span className="cmd-main"><strong>{playerName(s.player)}</strong><span>{s.player.name} · ID {s.player.id} · open the player</span></span>
      </>
    );
  }
  if (s.kind === 'resource') {
    return (
      <>
        <span className="cmd-icon"><Boxes size={16} /></span>
        <span className="cmd-main"><strong>{s.resource.name}</strong><span>Script · {s.resource.state === 'started' ? 'running' : s.resource.state}</span></span>
      </>
    );
  }
  return (
    <>
      <span className="cmd-icon"><Terminal size={16} /></span>
      <span className="cmd-main"><strong>Run as a server command</strong><span>Sends <code>{s.text}</code> to the server's console, like typing it in txAdmin</span></span>
    </>
  );
}
