// Shared dashboard pieces: the banner artwork, small trend lines, the players chart,
// the calendar and a player picker.
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import {
  useId, useMemo, useRef, useState,
} from 'react';
import type { Dashboard, KnownPlayer, SeriesPoint } from './api';

/** Rounds up to a tidy chart top, never below `min`. */
export function niceTop(max: number, min = 4) {
  const target = Math.max(min, max * 1.15);
  const step = target <= 10 ? 2 : target <= 25 ? 5 : target <= 60 ? 10 : 25;
  return Math.ceil(target / step) * step;
}

/** A smooth path through points (Catmull-Rom turned into curves), for one unbroken run. */
function smoothPath(pts: [number, number][]) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Splits a series into unbroken runs of [x, y] points. */
function runsOf(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null) { if (run.length) runs.push(run); run = []; } else run.push([x(i), y(v)]);
  });
  if (run.length) runs.push(run);
  return runs;
}

/** A tiny trend line for a stat card. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const id = useId().replace(/:/g, '');
  const W = 120;
  const H = 40;
  const defined = values.filter((v): v is number => v !== null);
  const top = Math.max(1, ...defined);
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * W : W);
  const y = (v: number) => H - 3 - (v / top) * (H - 8);
  const runs = runsOf(values, x, y);
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--series)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--series)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {runs.map((run) => {
        const line = smoothPath(run.length > 1 ? run : [run[0], [run[0][0] + 0.1, run[0][1]]]);
        return (
          <g key={`${run[0][0]}`}>
            <path d={`${line}L${run[run.length - 1][0].toFixed(1)},${H}L${run[0][0].toFixed(1)},${H}Z`} fill={`url(#sg${id})`} />
            <path d={line} className="sparkline-line" />
          </g>
        );
      })}
    </svg>
  );
}

const hourLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });
const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short' });

/** The players-online chart, with a soft glow under the line and a hover readout. */
export function AreaChart({ points, range }: { points: SeriesPoint[]; range: 'day' | 'week' }) {
  const id = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 230;
  const M = { top: 14, right: 14, bottom: 28, left: 34 };
  const values = points.map((p) => p.v);
  const defined = values.filter((v): v is number => v !== null);
  const top = niceTop(defined.length ? Math.max(...defined) : 0);
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const x = (i: number) => M.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW);
  const y = (v: number) => M.top + innerH - (v / top) * innerH;
  const runs = useMemo(() => runsOf(values, x, y), [points, top]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseline = M.top + innerH;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f));

  // Labels every 4 hours for a day, and once a day for a week.
  const labels: { i: number; text: string }[] = [];
  points.forEach((p, i) => {
    const d = new Date(p.t);
    if (range === 'day' && d.getMinutes() === 0 && d.getHours() % 4 === 0) labels.push({ i, text: hourLabel(p.t) });
    if (range === 'week' && d.getHours() === 12) labels.push({ i, text: dayLabel(p.t) });
  });

  const onMove = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || points.length < 2) return;
    const ratio = (((clientX - rect.left) / rect.width) * W - M.left) / innerW;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };
  const hovered = hover !== null ? points[hover] : null;
  const summary = defined.length
    ? `Players online over the last ${range === 'day' ? '24 hours' : '7 days'}. Highest ${Math.max(...defined)}.`
    : 'Players online. No history yet.';

  return (
    <div className="area-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="area-chart"
        role="img"
        aria-label={summary}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`ag${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#8066A8" stopOpacity="0.55" />
            <stop offset="0.6" stopColor="#5b4a8a" stopOpacity="0.16" />
            <stop offset="1" stopColor="#3b2f63" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`al${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#6f5aa0" />
            <stop offset="1" stopColor="#b9a3ea" />
          </linearGradient>
        </defs>
        {grid.map((g) => (
          <g key={g}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(g)} y2={y(g)} />
            <text className="axis" x={M.left - 8} y={y(g) + 4} textAnchor="end">{g}</text>
          </g>
        ))}
        {labels.map((l) => <text key={l.i} className="axis" x={x(l.i)} y={H - 8} textAnchor="middle">{l.text}</text>)}
        {runs.map((run) => {
          const line = smoothPath(run.length > 1 ? run : [run[0], [run[0][0] + 0.1, run[0][1]]]);
          return (
            <g key={`${run[0][0]}`}>
              <path d={`${line}L${run[run.length - 1][0].toFixed(1)},${baseline}L${run[0][0].toFixed(1)},${baseline}Z`} fill={`url(#ag${id})`} />
              <path d={line} fill="none" stroke={`url(#al${id})`} strokeWidth="2.5" strokeLinecap="round" />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={M.top} y2={baseline} />
            {values[hover] !== null && <circle className="area-dot" cx={x(hover)} cy={y(values[hover] as number)} r={5} />}
          </g>
        )}
      </svg>
      {hovered && (
        <div className="chart-tip area-tip" style={{ left: `${(x(hover as number) / W) * 100}%`, transform: `translateX(${(hover as number) > points.length / 2 ? '-108%' : '8%'})` }}>
          <span>{range === 'day' ? new Date(hovered.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(hovered.t).toLocaleString([], { weekday: 'short', hour: 'numeric' })}</span>
          <strong>{hovered.v === null ? 'No record' : `${hovered.v} player${hovered.v === 1 ? '' : 's'}`}</strong>
        </div>
      )}
      {!defined.length && <div className="area-empty">History starts building now. Check back after the server has been running for a while.</div>}
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const keyOf = (d: Date) => d.toLocaleDateString('en-CA');

/** A month at a glance: past backups, crashes and restarts, and what is scheduled. */
export function Calendar({ history, schedule }: { history: Dashboard['history']; schedule: Dashboard['schedule'] }) {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [picked, setPicked] = useState(keyOf(today));
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const todayKey = keyOf(today);
  const scheduled = (key: string) => key >= todayKey && (schedule.restarts.length > 0 || Boolean(schedule.backup));

  const pickedHistory = history[picked] || {};
  const pickedItems: string[] = [];
  if (pickedHistory.backup) pickedItems.push(`${pickedHistory.backup} backup${pickedHistory.backup > 1 ? 's' : ''} made`);
  if (pickedHistory.restart) pickedItems.push(`${pickedHistory.restart} restart${pickedHistory.restart > 1 ? 's' : ''}`);
  if (pickedHistory.crash) pickedItems.push(`${pickedHistory.crash} crash${pickedHistory.crash > 1 ? 'es' : ''} or unexpected stop${pickedHistory.crash > 1 ? 's' : ''}`);
  if (picked >= todayKey) {
    schedule.restarts.forEach((t) => pickedItems.push(`Restart at ${t}`));
    if (schedule.backup) pickedItems.push(`Backup at ${schedule.backup}`);
  }

  return (
    <div className="calendar">
      <div className="calendar-head">
        <strong>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>
        <div className="calendar-nav">
          <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
          <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
        </div>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map((d) => <span key={d} className="calendar-weekday">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const key = keyOf(d);
          const h = history[key] || {};
          return (
            <button
              key={key}
              className={`calendar-day${key === todayKey ? ' today' : ''}${key === picked ? ' picked' : ''}${key < todayKey ? ' past' : ''}`}
              onClick={() => setPicked(key)}
              aria-label={d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            >
              {d.getDate()}
              <span className="calendar-marks">
                {h.backup ? <i className="mark-backup" /> : null}
                {h.restart ? <i className="mark-restart" /> : null}
                {h.crash ? <i className="mark-crash" /> : null}
                {!h.backup && !h.restart && !h.crash && scheduled(key) ? <i className="mark-planned" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="calendar-detail">
        <strong>{new Date(`${picked}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
        {pickedItems.length ? <ul>{pickedItems.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted-note">Nothing recorded or planned.</p>}
      </div>
      <div className="calendar-legend">
        <span><i className="mark-backup" />Backup</span>
        <span><i className="mark-restart" />Restart</span>
        <span><i className="mark-crash" />Crash</span>
        <span><i className="mark-planned" />Planned</span>
      </div>
    </div>
  );
}

/** A night skyline with the CityHQ seal glowing above it, for the welcome banner. */
export function HeroArt() {
  const buildings: [number, number, number][] = [
    [8, 96, 26], [36, 70, 22], [60, 108, 18], [80, 52, 30], [112, 84, 20], [134, 38, 26], [162, 74, 22],
    [186, 58, 30], [218, 92, 20], [240, 46, 24], [266, 80, 22], [290, 100, 18], [310, 64, 26], [338, 88, 22],
  ];
  return (
    <svg className="hero-art" viewBox="0 0 360 200" aria-hidden="true">
      <defs>
        <linearGradient id="hb" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#5e4a8f" />
          <stop offset="1" stopColor="#1c1630" />
        </linearGradient>
        <radialGradient id="hg" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#a68bdc" stopOpacity="0.6" />
          <stop offset="1" stopColor="#a68bdc" stopOpacity="0" />
        </radialGradient>
        <filter id="hblur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <circle cx="200" cy="70" r="72" fill="url(#hg)" />
      {buildings.map(([x, top, w]) => (
        <g key={x}>
          <rect x={x} y={top} width={w} height={200 - top} rx="2" fill="url(#hb)" opacity="0.92" />
          {Array.from({ length: Math.floor((200 - top - 14) / 14) }, (_, row) => (
            [0, 1].map((col) => ((row * 3 + col + x) % 4 === 0 ? (
              <rect key={`${row}-${col}`} x={x + 5 + col * (w - 14)} y={top + 9 + row * 14} width="4" height="5" rx="1" fill="#cbb8f0" opacity="0.75" />
            ) : null))
          ))}
        </g>
      ))}
      <g transform="translate(160 26) scale(1.25)" filter="url(#hblur)" opacity="0.8">
        <path d="M34.95 46.74A17 17 0 0 0 29.05 13.26A17 17 0 0 0 34.95 46.74Q42 45.4 49.5 43.2" fill="none" stroke="#b9a3ea" strokeWidth="5" strokeLinecap="round" />
      </g>
      <g transform="translate(160 26) scale(1.25)">
        <path d="M34.95 46.74A17 17 0 0 0 29.05 13.26A17 17 0 0 0 34.95 46.74Q42 45.4 49.5 43.2" fill="none" stroke="#d9cbff" strokeWidth="3.4" strokeLinecap="round" />
        <rect x="25.6" y="23" width="3.6" height="14" rx="1.8" fill="#d9cbff" />
        <rect x="34.8" y="23" width="3.6" height="14" rx="1.8" fill="#d9cbff" />
        <rect x="25.6" y="28.2" width="12.8" height="3.6" rx="1.8" fill="#d9cbff" />
      </g>
    </svg>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${(hash % 60) + 250} 32% 30%)` }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Search everyone who has played, by player name or character name. */
export function PlayerPicker({ players, onPick, exclude = [], placeholder = 'Search by player or character name' }: {
  players: KnownPlayer[]; onPick: (p: KnownPlayer) => void; exclude?: string[]; placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = players
    .filter((p) => !exclude.some((id) => p.ids.includes(id)))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.characters.some((c) => c.name.toLowerCase().includes(q)))
    .slice(0, 8);
  return (
    <div className="picker">
      <div className="search">
        <Search size={15} />
        <input placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search players" />
      </div>
      {matches.length === 0 ? <p className="muted-note">{players.length ? 'Nobody matches that name.' : 'Nobody has joined the server yet.'}</p> : (
        <ul className="picker-list">
          {matches.map((p) => (
            <li key={p.license}>
              <button onClick={() => { onPick(p); setQuery(''); }}>
                <Avatar name={p.name} size={30} />
                <span className="picker-main">
                  <strong>{p.name}</strong>
                  <span className="muted-note">{p.characters.length ? p.characters.map((c) => c.name).join(', ') : 'No character yet'}</span>
                </span>
                <span className="picker-when">{p.lastSeen ? new Date(p.lastSeen).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
