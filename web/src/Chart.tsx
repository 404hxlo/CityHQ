import { useMemo, useRef, useState } from 'react';
import type { HistoryPoint } from './api';

interface Props {
  title: string;
  points: HistoryPoint[];
  value: (p: HistoryPoint) => number | null;
  format: (n: number) => string;
  /** Lowest top-of-chart value, so an idle server does not look busy. */
  minTop: number;
  niceStep: number;
  current: string;
  detail?: string;
}

const W = 520;
const H = 150;
const M = { top: 10, right: 12, bottom: 22, left: 58 };

/** A single-series line: hairline grid, 2px line, end dot, and a hover crosshair. */
export function LineChart({ title, points, value, format, minTop, niceStep, current, detail }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { series, top, x, y } = useMemo(() => {
    const values = points.map(value);
    const max = Math.max(minTop, ...values.filter((v): v is number => v !== null));
    const niceTop = Math.ceil((max * 1.1) / niceStep) * niceStep;
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const xOf = (i: number) => M.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW);
    const yOf = (v: number) => M.top + innerH - (v / niceTop) * innerH;
    return { series: values, top: niceTop, x: xOf, y: yOf };
  }, [points, value, minTop, niceStep]);

  const segments: string[] = [];
  let area = '';
  let run: string[] = [];
  const baseline = H - M.bottom;
  const flush = () => {
    if (run.length > 1) {
      segments.push(`M${run.join('L')}`);
      const firstX = run[0].split(',')[0];
      const lastX = run[run.length - 1].split(',')[0];
      area += `M${firstX},${baseline}L${run.join('L')}L${lastX},${baseline}Z`;
    }
    run = [];
  };
  series.forEach((v, i) => {
    if (v === null) flush();
    else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  flush();

  let lastIndex = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) { lastIndex = i; break; }
  }
  const defined = series.filter((v): v is number => v !== null);
  const summary = defined.length
    ? `${title}. Now ${current}. Lowest ${format(Math.min(...defined))}, highest ${format(Math.max(...defined))} over the last few minutes.`
    : `${title}. No data yet.`;

  const onMove = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || points.length < 2) return;
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const ratio = (svgX - M.left) / (W - M.left - M.right);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };

  const hovered = hover !== null ? points[hover] : null;
  const hoveredValue = hover !== null ? series[hover] : null;
  const spanMin = points.length > 1 ? Math.max(1, Math.round((points[points.length - 1].t - points[0].t) / 60000)) : 0;

  return (
    <section className="card chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
        <div className="chart-value">{current}</div>
        {detail && <div className="chart-detail">{detail}</div>}
      </div>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label={summary}
          onMouseMove={(e) => onMove(e.clientX)}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => onMove(e.touches[0].clientX)}
          onTouchMove={(e) => onMove(e.touches[0].clientX)}
          onTouchEnd={() => setHover(null)}
        >
          <line className="grid" x1={M.left} x2={W - M.right} y1={y(top)} y2={y(top)} />
          <line className="grid" x1={M.left} x2={W - M.right} y1={y(top / 2)} y2={y(top / 2)} />
          <line className="grid" x1={M.left} x2={W - M.right} y1={baseline} y2={baseline} />
          <text className="axis" x={M.left - 8} y={y(top) + 4} textAnchor="end">{format(top)}</text>
          <text className="axis" x={M.left - 8} y={y(top / 2) + 4} textAnchor="end">{format(top / 2)}</text>
          <text className="axis" x={M.left - 8} y={baseline + 4} textAnchor="end">{format(0)}</text>
          {spanMin > 0 && <text className="axis" x={M.left} y={H - 5}>{spanMin} min ago</text>}
          <text className="axis" x={W - M.right} y={H - 5} textAnchor="end">now</text>
          <path className="series-area" d={area} />
          {segments.map((d) => <path key={d} className="series-line" d={d} />)}
          {lastIndex >= 0 && hover === null && (
            <circle className="series-dot" cx={x(lastIndex)} cy={y(series[lastIndex] as number)} r={4} />
          )}
          {hover !== null && (
            <g>
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={M.top} y2={baseline} />
              {hoveredValue !== null && <circle className="series-dot" cx={x(hover)} cy={y(hoveredValue)} r={4} />}
            </g>
          )}
        </svg>
        {hovered && (
          <div
            className="chart-tip"
            style={{ left: `${(x(hover as number) / W) * 100}%`, transform: `translateX(${(hover as number) > points.length / 2 ? '-105%' : '5%'})` }}
          >
            <strong>{hoveredValue === null ? 'Server off' : format(hoveredValue)}</strong>
            <span>{new Date(hovered.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
          </div>
        )}
      </div>
    </section>
  );
}
