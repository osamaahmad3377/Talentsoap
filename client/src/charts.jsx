// Small, dependency-free charts for the dashboard.
// Rules (dataviz method): one y-axis, colour follows the series (never its rank),
// thin marks with 4px rounded data-ends anchored to the baseline, 2px lines,
// 8px markers with a surface ring, hover tooltip on every chart, a table view,
// and text in text colours (never the series colour).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Table2, BarChart3 } from 'lucide-react';

export const SERIES = {
  sales: 'var(--series-1)', // money in / sales
  cost: 'var(--series-2)', // money out / costs
  gross: 'var(--series-3)', // gross profit
  net: 'var(--series-4)', // net profit
};

/** Width of a container, so SVG text stays 11px on phones instead of shrinking. */
export function useWidth(deps = []) {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [ref, w];
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((s) => (
        <span key={s.label}>
          {s.type === 'line' ? <i className="lg-line" style={{ background: s.color }} /> : <i style={{ background: s.color }} />}
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Card with a title, optional legend and a Chart / Table switch. */
export function ChartCard({ title, sub, legend, table, children, link, className = '' }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className={`card chart-card ${className}`}>
      <div className="chart-head">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {sub && <div className="small muted">{sub}</div>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {link}
          {table && (
            <button className="btn btn-sm" onClick={() => setShowTable((x) => !x)} aria-pressed={showTable}>
              {showTable ? <><BarChart3 size={16} /> Chart</> : <><Table2 size={16} /> Table</>}
            </button>
          )}
        </div>
      </div>
      {legend && !showTable && <div style={{ margin: '-4px 0 10px' }}><Legend items={legend} /></div>}
      {showTable ? <div className="table-wrap">{table}</div> : children}
    </div>
  );
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
export const shortNum = (v) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}${+(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${s}${+(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${s}${+(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${s}${+a.toFixed(0)}`;
};

/**
 * Bars and/or lines over time on one shared money axis (handles losses below zero).
 *  rows:  [{...}]   bars/lines: [{ key, label, color }]
 *  xLabel(row) short axis text, title(row) tooltip heading, fmt(v) value text
 */
export function TrendChart({ rows, bars = [], lines = [], xLabel, title, fmt, ariaLabel, height }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState(null);
  const H = height || (W < 520 ? 210 : 250);
  const L = 46, R = 8, T = 14, B = 26;
  const keys = [...bars, ...lines].map((s) => s.key);
  const vals = rows.flatMap((r) => keys.map((k) => r[k] || 0));
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const step = niceStep(Math.max(hi - lo, 1) / 4);
  const top = Math.ceil(hi / step) * step || step;
  const bottom = Math.floor(lo / step) * step;
  const y = (v) => T + (H - T - B) * ((top - v) / (top - bottom));
  const ticks = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(v);
  const n = rows.length;
  const gw = (W - L - R) / n;
  const nb = bars.length;
  const bw = nb ? Math.max(3, Math.min(18, (gw * 0.72 - 2 * (nb - 1)) / nb)) : 0;
  const cx = (i) => L + i * gw + gw / 2;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 46))));

  const bar = (x, v, color, k) => {
    const y0 = y(0), y1 = y(v);
    const h = Math.abs(y0 - y1);
    if (h < 0.5) return null;
    const r = Math.min(4, h, bw / 2);
    // rounded at the data end, square where it meets the zero line
    const d = v >= 0
      ? `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z`
      : `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 - r} V${y0} Z`;
    return <path key={k} d={d} fill={color} />;
  };
  const tipRow = hover !== null ? rows[hover] : null;
  const tipLeft = hover !== null ? (cx(hover) / W) * 100 : 0;
  const tipShift = tipLeft < 22 ? '0%' : tipLeft > 78 ? '-100%' : '-50%';

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'zero-line' : 'grid-line'} x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={L - 8} y={y(t) + 4} textAnchor="end">{shortNum(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={i}>
            <rect className={`hit ${hover === i ? 'on' : ''}`} x={L + i * gw} y={T} width={gw} height={H - T - B}
              onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
            <g pointerEvents="none">
              {bars.map((s, j) => bar(cx(i) - (nb * bw + 2 * (nb - 1)) / 2 + j * (bw + 2), r[s.key] || 0, s.color, s.key))}
            </g>
            {(n - 1 - i) % labelEvery === 0 && <text className="axis-label" x={cx(i)} y={H - 8} textAnchor="middle">{xLabel(r)}</text>}
          </g>
        ))}
        {lines.map((s) => (
          <g key={s.key} pointerEvents="none">
            <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              points={rows.map((r, i) => `${cx(i)},${y(r[s.key] || 0)}`).join(' ')} />
            {rows.map((r, i) => (
              <circle key={i} cx={cx(i)} cy={y(r[s.key] || 0)} r={hover === i ? 5 : 4} fill={s.color} stroke="var(--surface)" strokeWidth="2" />
            ))}
          </g>
        ))}
      </svg>
      {tipRow && (
        <div className="tooltip" style={{ left: `${tipLeft}%`, top: `${(y(Math.max(0, ...keys.map((k) => tipRow[k] || 0))) / H) * 100}%`, marginTop: -10, transform: `translate(${tipShift}, -100%)` }}>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>{title(tipRow)}</div>
          {[...bars, ...lines].map((s) => (
            <div key={s.key} className="tip-row"><span><span className="sw" style={{ background: s.color }} />{s.label}</span><b>{fmt(tipRow[s.key] || 0)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars (label + value on one line, bar under it: readable on phones). */
export function RankBars({ rows, fmt, color = 'var(--series-1)', empty = 'Nothing yet' }) {
  if (!rows.length) return <div className="muted center" style={{ padding: '28px 0' }}>{empty}</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="rank-bars">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="rb-top">
              <span className="rb-label">{r.label}{r.sub && <span className="rb-sub">{r.sub}</span>}</span>
              <span className="rb-value num"><b>{fmt(r.value)}</b>{r.right && <span className="rb-sub">{r.right}</span>}</span>
            </div>
            <div className="rb-track" title={`${r.label}: ${fmt(r.value)}`}><span style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: color }} /></div>
          </>
        );
        return r.to ? <Link key={r.key} to={r.to} className="rb-row">{inner}</Link> : <div key={r.key} className="rb-row">{inner}</div>;
      })}
    </div>
  );
}

/** One bar split into parts (part-to-whole), with a legend that carries the numbers. */
export function SplitBar({ parts, fmt, label }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}`}>
        {total > 0 ? parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.label} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${fmt(p.value)} (${Math.round((p.value / total) * 100)}%)`} />
        )) : <span className="split-empty" />}
      </div>
      <div className="split-legend">
        {parts.map((p) => (
          <div key={p.label}>
            <i style={{ background: p.color }} />
            <div>
              <div className="small muted">{p.label}</div>
              <div className="num"><b>{fmt(p.value)}</b> <span className="muted small">{total > 0 ? `${Math.round((Math.max(0, p.value) / total) * 100)}%` : ''}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
