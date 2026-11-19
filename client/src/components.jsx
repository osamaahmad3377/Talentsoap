import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, X, ArrowLeft, Inbox, AlertTriangle, Loader2, CheckCircle2, Info } from 'lucide-react';

export function PageHead({ title, sub, back, actions }) {
  return (
    <>
      {back && <Link className="back no-print" to={back}><ArrowLeft size={20} /> Back</Link>}
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {actions && <div className="actions no-print">{actions}</div>}
      </div>
    </>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="empty"><Loader2 size={28} className="spin" style={{ animation: 'spin 1s linear infinite' }} /><div>{label}</div>
    <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style></div>;
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="alert alert-danger"><AlertTriangle size={22} />
      <div style={{ flex: 1 }}>{error}</div>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Alert({ type = 'info', children }) {
  const Icon = { danger: AlertTriangle, warn: AlertTriangle, ok: CheckCircle2, info: Info }[type];
  return <div className={`alert alert-${type}`}><Icon size={22} /><div>{children}</div></div>;
}

export function Empty({ children = 'Nothing here yet', icon: Icon = Inbox }) {
  return <div className="empty"><Icon size={36} /><div>{children}</div></div>;
}

/** Wrapper that handles loading + error for a useFetch() result. */
export function Async({ q, children }) {
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return null;
  return children(q.data);
}

export function Stat({ label, value, hint, icon: Icon, tone, to }) {
  const inner = (
    <>
      <div className="label">{Icon && <Icon size={18} />}{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </>
  );
  return to ? <Link to={to} className={`stat ${tone || ''}`}>{inner}</Link> : <div className={`stat ${tone || ''}`}>{inner}</div>;
}

export function Badge({ tone = 'gray', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }) {
  return status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : null;
}

export function PayBadge({ total, paid }) {
  if (paid >= total - 0.005) return <Badge tone="ok">Cash / Paid</Badge>;
  if (paid > 0) return <Badge tone="warn">Partly paid</Badge>;
  return <Badge tone="info">Credit</Badge>;
}

export function Field({ label, help, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      <label>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(820px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={22} /> Close</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title, message, confirmLabel = 'Yes, continue', danger, onConfirm, onClose, busy }) {
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>No, go back</button>
      <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
    </>}>
      <p style={{ margin: 0, fontSize: '1.05rem' }}>{message}</p>
    </Modal>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs no-print" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'on' : ''} onClick={() => onChange(t.value)}>
          {t.icon && <t.icon size={18} />}{t.label}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="search">
      <Search size={20} />
      <input className="input" type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

/**
 * Data table with inline search. On phones it turns into stacked cards.
 * columns: [{ key, label, render?, className?, search? (fn -> text) }]
 */
export function DataTable({ rows, columns, onRow, rowClass, searchKeys, placeholder, empty = 'Nothing found', tools, footer, pageSize = 100, wide = false }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => (searchKeys || columns.map((c) => c.key)).some((k) => String(typeof k === 'function' ? k(r) : r[k] ?? '').toLowerCase().includes(s)));
  }, [q, rows, columns, searchKeys]);
  return (
    <div>
      {(searchKeys !== false || tools) && (
        <div className="table-tools no-print">
          {searchKeys !== false && <SearchBox value={q} onChange={setQ} placeholder={placeholder} />}
          <div className="spacer" />
          {tools}
        </div>
      )}
      <div className="table-wrap">
        {filtered.length === 0 ? <Empty>{q ? `No match for “${q}”` : empty}</Empty> : (
          <table className={`table responsive ${wide ? 'responsive-lg' : ''}`}>
            <thead><tr>{columns.map((c) => <th key={c.key} className={c.className}>{c.label}</th>)}</tr></thead>
            <tbody>
              {filtered.slice(0, limit).map((r, i) => (
                <tr key={r.id ?? i} className={`${onRow ? 'clickable' : ''} ${rowClass ? rowClass(r) : ''}`}
                  onClick={onRow ? () => onRow(r) : undefined}
                  tabIndex={onRow ? 0 : undefined}
                  onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
                  {columns.map((c) => <td key={c.key} data-label={c.label} className={c.className}>{c.render ? c.render(r) : r[c.key]}</td>)}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot>{footer}</tfoot>}
          </table>
        )}
      </div>
      {filtered.length > limit && (
        <div className="center" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setLimit((l) => l + pageSize)}>Show more ({filtered.length - limit} left)</button>
        </div>
      )}
    </div>
  );
}

/**
 * Big searchable dropdown — easier than a native <select> with 100 entries.
 * options: [{ value, label, sub?, right? }]
 */
export function Picker({ options, value, onChange, placeholder = 'Tap to choose…', autoFocus }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const ref = useRef(null);
  const selected = options.find((o) => String(o.value) === String(value));
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.sub || ''}`.toLowerCase().includes(s)) : options;
  }, [q, options]);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const pick = (o) => { onChange(o.value, o); setOpen(false); setQ(''); };
  return (
    <div className="picker" ref={ref}>
      <input
        className="input" autoFocus={autoFocus}
        value={open ? q : selected?.label || ''}
        placeholder={selected ? selected.label : placeholder}
        onFocus={() => { setOpen(true); setHl(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' && open && list[hl]) { e.preventDefault(); pick(list[hl]); }
          if (e.key === 'Escape') setOpen(false);
        }}
        role="combobox" aria-expanded={open}
      />
      {open && (
        <div className="picker-list" role="listbox">
          {list.length === 0 && <div className="empty small">No match</div>}
          {list.slice(0, 60).map((o, i) => (
            <button type="button" key={o.value} className={i === hl ? 'hl' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              <span><b>{o.label}</b>{o.sub && <div className="small muted">{o.sub}</div>}</span>
              {o.right && <span className="small muted num">{o.right}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useGo() {
  const nav = useNavigate();
  return (to) => nav(to);
}

export function NumberInput({ value, onChange, className = '', ...rest }) {
  return <input className={`input num ${className}`} type="number" inputMode="decimal" step="any" min="0"
    value={value} onChange={(e) => onChange(e.target.value)} onWheel={(e) => e.currentTarget.blur()} {...rest} />;
}
