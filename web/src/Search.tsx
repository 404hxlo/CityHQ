import { Boxes, FileText, Search as SearchIcon, User } from 'lucide-react';
import {
  useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { api, type Player, type Resource } from './api';
import { openPlayer, openResourcePanel } from './nav';

interface Hit { key: string; kind: 'page' | 'player' | 'resource'; label: string; sub: string; icon: ReactNode; go: () => void }

/** Search pages, online players and resources from anywhere. Ctrl+K jumps here. */
export function GlobalSearch({ pages }: { pages: { id: string; label: string }[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [players, setPlayers] = useState<Player[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(0);
  const loadedAt = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const load = () => {
    if (Date.now() - loadedAt.current < 30000) return;
    loadedAt.current = Date.now();
    setLoading(2);
    const done = () => setLoading((n) => Math.max(0, n - 1));
    api.players().then(setPlayers).catch(() => setPlayers([])).finally(done);
    api.resources().then((r) => setResources(r.resources)).catch(() => setResources([])).finally(done);
  };

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Hit[] = [];
    for (const p of pages) {
      if (p.label.toLowerCase().includes(q)) out.push({ key: `page:${p.id}`, kind: 'page', label: p.label, sub: 'Page', icon: <FileText size={15} />, go: () => { window.location.hash = p.id; } });
    }
    for (const p of players) {
      const name = p.character?.trim() || p.name;
      if (name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
        out.push({ key: `player:${p.id}`, kind: 'player', label: name, sub: `${p.name} · online`, icon: <User size={15} />, go: () => openPlayer(p.id) });
      }
    }
    for (const r of resources) {
      if (r.name.toLowerCase().includes(q)) out.push({ key: `res:${r.name}`, kind: 'resource', label: r.name, sub: `Resource · ${r.state}`, icon: <Boxes size={15} />, go: () => openResourcePanel(r.name) });
    }
    return out.slice(0, 9);
  }, [query, pages, players, resources]);

  const choose = (hit: Hit) => {
    hit.go();
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="global-search">
      <div className="search">
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          placeholder="Search players, resources and pages"
          aria-label="Search"
          value={query}
          onFocus={() => { setOpen(true); load(); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter' && hits[active]) choose(hits[active]);
            if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur(); }
          }}
        />
        <kbd>Ctrl K</kbd>
      </div>
      {open && query.trim() && (
        <ul className="search-results" role="listbox">
          {hits.length === 0 && <li className="muted-note search-empty">{loading > 0 ? 'Searching...' : `Nothing matches "${query.trim()}"`}</li>}
          {hits.map((h, i) => (
            <li key={h.key}>
              <button role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); choose(h); }}>
                <span className={`search-icon kind-${h.kind}`}>{h.icon}</span>
                <span className="search-main"><strong>{h.label}</strong><span className="muted-note">{h.sub}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
