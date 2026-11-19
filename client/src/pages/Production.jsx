import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Factory, CheckCircle2, XCircle, Trash2, Save, History } from 'lucide-react';
import { useFetch, useMoney, useApp, useAction, api, qty, fmtDate, today } from '../lib.jsx';
import { PageHead, Async, DataTable, Badge, Field, NumberInput, Picker, Alert, Empty, Loading } from '../components.jsx';

let lineKey = 0;
const newLine = (item_id = '', qty = '') => ({ key: ++lineKey, item_id, qty: qty === '' ? '' : String(qty) });

export function ProductionList() {
  const q = useFetch('/production');
  const money = useMoney();
  const { can } = useApp();
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Production" sub="Batches made for stock. Tap a batch to see its full history."
        actions={<Link to="/production/new" className="btn btn-primary btn-lg"><Factory size={22} /> Make a batch</Link>} />
      <div className="card">
        <Async q={q}>{(rows) => (
          <DataTable rows={rows} searchKeys={['batch_no', 'product_name', 'date']} placeholder="Search batch no. or product…"
            onRow={(b) => nav(`/trace/lot/${b.lot_id}`)} rowClass={(b) => (b.status === 'cancelled' ? 'cancelled' : '')}
            empty="No batches yet."
            columns={[
              { key: 'batch_no', label: 'Batch no.', render: (b) => <div><b className="mono">{b.batch_no}</b> {b.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}<div className="small muted">{b.product_name}</div></div> },
              { key: 'date', label: 'Date', render: (b) => fmtDate(b.date) },
              { key: 'qty_produced', label: 'Made', className: 'right', render: (b) => <b className="num">{qty(b.qty_produced, b.product_unit)}</b> },
              { key: 'qty_remaining', label: 'Still in stock', className: 'right', render: (b) => <span className="num">{b.status === 'cancelled' ? '—' : qty(b.qty_remaining, b.product_unit)}</span> },
              ...(can('manager') ? [
                { key: 'total_cost', label: 'Batch cost', className: 'right', render: (b) => <span className="num">{money(b.total_cost)}</span> },
                { key: 'unit_cost', label: 'Cost / unit', className: 'right', render: (b) => <span className="num">{money(b.unit_cost)}</span> },
              ] : []),
            ]} />
        )}</Async>
      </div>
    </>
  );
}

/**
 * Make a batch. The recipe changes from batch to batch, so the ingredients are
 * entered here for each batch: they start from the last batch of the same
 * product, and every line can be changed, added or removed.
 */
export function NewBatch() {
  const productsQ = useFetch('/items?kind=finished');
  const rawsQ = useFetch('/items?kind=raw');
  const money = useMoney();
  const { can } = useApp();
  const nav = useNavigate();
  const [productId, setProductId] = useState(null);
  const [start, setStart] = useState(null);
  const [loadingStart, setLoadingStart] = useState(false);
  const [lines, setLines] = useState([]);
  const [f, setF] = useState({ qty_produced: '', other_cost: '', date: today(), notes: '' });
  const [run, busy] = useAction();

  const products = productsQ.data || [];
  const product = products.find((p) => p.id === productId);
  const raws = rawsQ.data || [];
  const rawById = useMemo(() => new Map(raws.map((r) => [r.id, r])), [raws]);

  const choose = (id) => {
    setProductId(id);
    setStart(null);
    setLoadingStart(true);
    api.get(`/production/start?product_id=${id}`)
      .then((st) => {
        setStart(st);
        setLines(st.lines.length ? st.lines.map((l) => newLine(l.item_id, l.need)) : [newLine()]);
        setF((x) => ({ ...x, qty_produced: st.expected_qty ? String(st.expected_qty) : '' }));
      })
      .catch(() => { setStart({ lines: [], source: null }); setLines([newLine()]); })
      .finally(() => setLoadingStart(false));
  };

  const setLine = (key, k, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)));
  const removeLine = (key) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : [newLine()]));

  // live check of every line against what is in the tanks now
  const checked = lines.map((l) => {
    const it = rawById.get(Number(l.item_id));
    const need = Number(l.qty) || 0;
    if (!it) return { ...l, it: null, need };
    const enough = it.stock + 1e-6 >= need;
    return { ...l, it, need, enough, short: +(need - it.stock).toFixed(3), cost: need * (it.avg_cost || 0) };
  });
  const filled = checked.filter((l) => l.it && l.need > 0);
  const incomplete = checked.some((l) => (l.it && !(l.need > 0)) || (!l.it && Number(l.qty) > 0));
  const anyShort = filled.some((l) => !l.enough);
  const materialCost = filled.reduce((s, l) => s + l.cost, 0);
  const totals = useMemo(() => {
    const m = new Map();
    for (const l of filled) m.set(l.it.unit, (m.get(l.it.unit) || 0) + l.need);
    return [...m.entries()];
  }, [filled]);

  const otherCost = Number(f.other_cost) || 0;
  const made = Number(f.qty_produced) || 0;
  const canSave = filled.length > 0 && !incomplete && !anyShort && made > 0 && !busy;

  const save = () => run(() => api.post('/production', {
    product_id: productId, items: filled.map((l) => ({ item_id: l.it.id, qty: l.need })), ...f,
  }), 'Batch saved — stock updated').then((b) => b && nav(`/trace/lot/${b.lot_id}`));

  const src = start?.source;
  return (
    <>
      <PageHead back="/production" title="Make a batch" sub="Choose the soap, put in what you used this time, and save. Raw materials are taken from the tanks." />
      {productsQ.loading || rawsQ.loading ? <Loading /> : products.length === 0 ? (
        <div className="card"><Empty>No finished goods yet. {can('manager') ? <Link to="/stock">Add the soap under Stock first</Link> : 'Ask a manager to add the soap under Stock.'}</Empty></div>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          <div className="card">
            <h2 style={{ marginBottom: 12 }}>1. Which soap?</h2>
            <div className="choice">
              {products.map((p) => <button key={p.id} className={`btn btn-lg ${productId === p.id ? 'on' : ''}`} onClick={() => choose(p.id)}>{p.name}</button>)}
            </div>
          </div>

          {product && (loadingStart ? <Loading /> : start && (
            <div className="card">
              <div className="card-head">
                <h2>2. What did you put in?</h2>
                {filled.length > 0 && (anyShort ? <Badge tone="danger"><XCircle size={16} /> Not enough stock</Badge> : <Badge tone="ok"><CheckCircle2 size={16} /> All in stock</Badge>)}
              </div>
              <div className="batch-src">
                <History size={18} />
                <span>{src?.type === 'last_batch'
                  ? <>Filled in from your last batch <b className="mono">{src.batch_no}</b> ({fmtDate(src.date)}). Change the quantities, add or remove anything for this batch.</>
                  : src?.type === 'recipe'
                    ? <>Filled in from the saved recipe <b>{src.name}</b>. Change anything for this batch.</>
                    : <>First batch of {product.name}. Add each material and how much you used. Next time this list fills in by itself.</>}</span>
              </div>
              <div className="lines" style={{ marginTop: 14 }}>
                {checked.map((l) => {
                  const taken = new Set(lines.filter((x) => x.key !== l.key).map((x) => Number(x.item_id)));
                  const options = raws.filter((r) => !taken.has(r.id)).map((r) => ({ value: r.id, label: r.name, sub: `${qty(r.stock, r.unit)} in stock${r.container ? ` · ${r.container}` : ''}` }));
                  return (
                    <div key={l.key} className={`line batch-line ${l.it && l.need > 0 && !l.enough ? 'short' : ''}`}>
                      <Field label="Material"><Picker options={options} value={l.item_id} onChange={(v) => setLine(l.key, 'item_id', v)} placeholder="Choose material…" /></Field>
                      <Field label={`Quantity${l.it ? ` (${l.it.unit})` : ''}`}><NumberInput className="big" value={l.qty} onChange={(v) => setLine(l.key, 'qty', v)} aria-label={`Quantity of ${l.it?.name || 'material'}`} /></Field>
                      <div className="batch-stock">
                        {l.it ? <>
                          <span className="small muted">In stock {qty(l.it.stock, l.it.unit)}</span>
                          {l.need > 0 && (l.enough ? <Badge tone="ok">✓ OK</Badge> : <Badge tone="danger">Short {qty(l.short, l.it.unit)}</Badge>)}
                          {can('manager') && l.need > 0 && <span className="small muted num">{money(l.cost)}</span>}
                        </> : <span className="small muted">—</span>}
                      </div>
                      <button className="btn btn-ghost" aria-label="Remove material" onClick={() => removeLine(l.key)}><Trash2 size={20} /></button>
                    </div>
                  );
                })}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus size={20} /> Add material</button>
                <div className="spacer" />
                {totals.length > 0 && <div className="muted">Total mix: <b className="num">{totals.map(([u, n]) => qty(+n.toFixed(3), u)).join(' + ')}</b></div>}
              </div>
              {anyShort && <div style={{ marginTop: 12 }}><Alert type="danger">Not enough of some material. Reduce the quantity or buy more stock first.</Alert></div>}
              {incomplete && <div style={{ marginTop: 12 }}><Alert type="warn">Every line needs a material and a quantity. Remove empty lines you don’t need.</Alert></div>}
            </div>
          ))}

          {product && start && !loadingStart && (
            <div className="card">
              <h2 style={{ marginBottom: 12 }}>3. Finish</h2>
              <div className="form-grid">
                <Field label={`How much was made (${product.unit})`} help={src ? 'Last time’s amount is filled in. Change it to the real count.' : 'Count what came out of this batch'}><NumberInput className="big" value={f.qty_produced} onChange={(v) => setF((x) => ({ ...x, qty_produced: v }))} /></Field>
                <Field label="Date"><input className="input" type="date" value={f.date} max={today()} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} /></Field>
                {can('manager') && <Field label="Labour / power cost for this batch" help="Optional. Added to the batch cost."><NumberInput value={f.other_cost} onChange={(v) => setF((x) => ({ ...x, other_cost: v }))} /></Field>}
                <Field label="Notes" className={can('manager') ? '' : 'full'}><input className="input" value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} placeholder="Optional" /></Field>
              </div>
              {can('manager') && made > 0 && filled.length > 0 && (
                <div className="totals" style={{ marginTop: 16 }}>
                  <div className="t-row"><span>Materials</span><b className="num">{money(materialCost)}</b></div>
                  <div className="t-row"><span>Labour / power</span><b className="num">{money(otherCost)}</b></div>
                  <div className="t-row grand"><span>Cost per {product.unit}</span><span className="num">{money((materialCost + otherCost) / made)}</span></div>
                </div>
              )}
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 18 }} disabled={!canSave} onClick={save}>
                <Save size={22} /> Save batch &amp; add to stock
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
