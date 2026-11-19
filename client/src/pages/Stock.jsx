import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plus, Pencil, Scale, Droplets, Package, ShoppingBag, AlertTriangle, History, Factory, Truck, Tags, Eye, EyeOff, Receipt, Trash2, RotateCcw, CheckCircle2, ExternalLink, PackagePlus, Lock } from 'lucide-react';
import { useFetch, useMoney, useApp, useAction, api, qty, fmtDate, today, KIND_LABEL } from '../lib.jsx';
import { PageHead, Async, DataTable, Badge, Stat, Modal, Field, Tabs, NumberInput, Empty, Alert } from '../components.jsx';

const KIND_TABS = [
  { value: 'raw', label: 'Raw Materials', icon: Droplets },
  { value: 'finished', label: 'Finished Goods', icon: Package },
  { value: 'trading', label: 'Trading Items', icon: ShoppingBag },
];

const MOVE_LABEL = {
  purchase: 'Purchased', opening: 'Opening / found', adjustment: 'Removed (damage/loss)', production_out: 'Used in production',
  production_in: 'Produced', sale: 'Sold', sale_cancel: 'Invoice cancelled', sale_return: 'Returned by customer', sale_return_cancel: 'Return cancelled', purchase_cancel: 'Purchase cancelled', production_cancel: 'Batch cancelled',
};

export function StockList() {
  const [kind, setKind] = useState(() => sessionStorage.getItem('stockTab') || 'raw');
  const q = useFetch(`/items?kind=${kind}`);
  const money = useMoney();
  const { can } = useApp();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState('');
  const [manage, setManage] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const catQ = useFetch(`/item-categories?kind=${kind}`);
  const delQ = useFetch(can('manager') ? `/items-deleted?kind=${kind}` : null);
  const change = (k) => { setKind(k); setCat(''); try { sessionStorage.setItem('stockTab', k); } catch { /* ignore */ } };

  const cols = [
    { key: 'name', label: 'Item', render: (r) => <div><b>{r.name}</b>{r.low && <> <Badge tone="danger"><AlertTriangle size={14} /> LOW</Badge></>}<div className="small muted">{r.category_name || r.category}{r.container ? ` · ${r.container}` : ''}</div></div> },
    { key: 'stock', label: 'In stock', className: 'right', render: (r) => <b className="num" style={{ color: r.low ? 'var(--danger)' : undefined, fontSize: '1.08rem' }}>{qty(r.stock, r.unit)}</b> },
    { key: 'reorder_level', label: 'Alert below', className: 'right', render: (r) => <span className="num muted">{r.reorder_level ? qty(r.reorder_level, r.unit) : '—'}</span> },
  ];
  if (can('manager')) {
    cols.push({ key: 'unit_cost', label: kind === 'raw' ? 'Avg cost' : 'Cost / unit', className: 'right', render: (r) => <span className="num">{money(r.unit_cost)}<span className="muted small"> /{r.unit}</span></span> });
    cols.push({ key: 'value', label: 'Stock value', className: 'right', render: (r) => <b className="num">{money(r.value)}</b> });
  }
  if (kind !== 'raw') cols.push({ key: 'sale_price', label: 'Sale price', className: 'right', render: (r) => <span className="num">{money(r.sale_price)}</span> });

  return (
    <>
      <PageHead title="Stock" sub="Live stock levels. Tap an item to see its full history."
        actions={can('manager') && <>
          <button className="btn" onClick={() => setManage(true)}><Tags size={20} /> Categories</button>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={20} /> Add item</button>
        </>} />
      <Tabs tabs={KIND_TABS} value={kind} onChange={change} />
      {kind === 'raw' && <Alert type="info">Raw materials are kept in shared tanks and containers, so they use <b>weighted average cost</b>. Every purchase updates the average automatically.</Alert>}
      <div className="card" style={{ marginTop: 14 }}>
        <Async q={q}>{(all) => {
          const rows = cat ? all.filter((r) => r.category_id === Number(cat)) : all;
          const used = (catQ.data || []).filter((c) => all.some((r) => r.category_id === c.id));
          return (<>
          {used.length > 1 && (
            <div className="choice seg" style={{ marginBottom: 12 }} role="radiogroup" aria-label="Category filter">
              <button className={`btn btn-sm ${!cat ? 'on' : ''}`} onClick={() => setCat('')}>All ({all.length})</button>
              {used.map((c) => <button key={c.id} className={`btn btn-sm ${Number(cat) === c.id ? 'on' : ''}`} onClick={() => setCat(String(c.id))}>{c.name} ({all.filter((r) => r.category_id === c.id).length})</button>)}
            </div>
          )}
          <DataTable rows={rows} columns={cols} searchKeys={['name', 'category_name', 'container']} placeholder="Search items…"
            onRow={(r) => nav(`/stock/${r.id}`)} rowClass={(r) => (r.low ? 'low' : '')}
            empty="No items yet. Tap “Add item” to start."
            footer={can('manager') && rows.length > 0 && <tr><td colSpan={cols.length - (kind !== 'raw' ? 2 : 1)}>Total stock value</td><td className="right num">{money(rows.reduce((s, r) => s + r.value, 0))}</td>{kind !== 'raw' && <td />}</tr>} />
          </>);
        }}</Async>
      </div>
      {can('manager') && (delQ.data || []).length > 0 && (
        <div className="row no-print" style={{ marginTop: 12 }}>
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowDeleted(true)}><Trash2 size={16} /> Deleted items ({delQ.data.length})</button>
        </div>
      )}
      {showDeleted && <DeletedItems kind={kind} onClose={() => { setShowDeleted(false); delQ.reload(); q.reload(); }} />}
      {adding && <ItemForm kind={kind} onClose={() => setAdding(false)} onSaved={(id) => nav(`/stock/${id}`)} />}
      {manage && <ItemCategoryManager kind={kind} onClose={() => { setManage(false); catQ.reload(); q.reload(); }} />}
    </>
  );
}

export function ItemDetail() {
  const { id } = useParams();
  const q = useFetch(`/items/${id}`);
  const money = useMoney();
  const { can } = useApp();
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [del, setDel] = useState(false);
  const [editOpening, setEditOpening] = useState(null);
  const [run, busy] = useAction();

  return (
    <Async q={q}>{(it) => (
      <>
        <PageHead back="/stock" title={<>{it.name}{!it.active && <> <Badge tone="danger">Deleted</Badge></>}</>}
          sub={<>{KIND_LABEL[it.kind]} · {it.category_name || it.category}{it.container && <> · <b>{it.container}</b></>}</>}
          actions={can('manager') && (it.active ? <>
            <button className="btn" onClick={() => setEdit(true)}><Pencil size={18} /> Edit</button>
            <button className="btn btn-primary" onClick={() => setAdjust(true)}><Scale size={18} /> Adjust stock</button>
          </> : <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.post(`/items/${it.id}/restore`), 'Item restored').then((r) => r && q.reload())}><RotateCcw size={18} /> Restore item</button>)} />

        {!it.active && (
          <div style={{ marginBottom: 16 }}>
            <Alert type="danger">
              <b>This item was deleted</b>{it.deleted_at && <> on {fmtDate(it.deleted_at.slice(0, 10))}</>}{it.deleted_by_name && <> by {it.deleted_by_name}</>}.
              {' '}It no longer appears in stock lists or on new invoices, purchases and batches. Its old invoices, purchases, batches and reports still show it, and its full history is kept below.
            </Alert>
          </div>
        )}

        {it.historic && <div style={{ marginBottom: 16 }}><Alert type="info">Showing stock on <b>{fmtDate(it.as_of)}</b> (end of the selected year): <b>{qty(it.historic.qty, it.unit)}</b> worth {money(it.historic.value)} at {money(it.historic.unit_cost)} per {it.unit}. Live stock today is {qty(it.stock, it.unit)}.</Alert></div>}
        {it.low && !!it.active && !it.historic && <div style={{ marginBottom: 16 }}><Alert type="danger">Stock is low: only <b>{qty(it.stock, it.unit)}</b> left (alert level {qty(it.reorder_level, it.unit)}). Please re-order.</Alert></div>}

        <div className="grid grid-4">
          <Stat label="In stock" value={qty(it.stock, it.unit)} tone={it.low ? 'bad' : ''} />
          {can('manager') && <Stat label={it.kind === 'raw' ? 'Weighted avg cost' : 'Avg cost'} value={money(it.unit_cost)} hint={`per ${it.unit}`} />}
          {can('manager') && <Stat label="Stock value" value={money(it.value)} />}
          {it.kind !== 'raw' ? <Stat label="Sale price" value={money(it.sale_price)} hint={`per ${it.unit}`} /> : <Stat label="Alert below" value={it.reorder_level ? qty(it.reorder_level, it.unit) : 'Not set'} />}
        </div>

        {it.kind === 'raw' ? <RawDetail it={it} money={money} can={can} /> : <GoodsDetail it={it} money={money} can={can} />}

        {can('manager') && it.opening_entries?.length > 0 && <OpeningStockCard it={it} money={money} onEdit={setEditOpening} />}

        <div className="card">
          <div className="card-head"><h2><History size={20} style={{ verticalAlign: -3 }} /> {it.kind === 'raw' ? 'Tank history' : 'Stock history'}</h2>
            {it.opening && <span className="small muted">Brought forward on {fmtDate(it.opening.date)}: <b>{qty(it.opening.qty, it.unit)}</b>{can('manager') && <> @ {money(it.opening.unit_cost)} = {money(it.opening.value)}</>}</span>}</div>
          <DataTable rows={it.movements} searchKeys={['type', 'party_name', 'lot_code', 'note', 'date']} placeholder="Search history…"
            columns={[
              { key: 'date', label: 'Date', render: (m) => fmtDate(m.date) },
              { key: 'type', label: 'What happened', render: (m) => <span>{MOVE_LABEL[m.type] || m.type}{m.party_name && <span className="muted"> · {m.party_name}</span>}{m.lot_code && <span className="muted mono"> · {m.lot_code}</span>}</span> },
              { key: 'qty', label: 'Qty', className: 'right', render: (m) => <b className="num" style={{ color: m.qty > 0 ? 'var(--ok)' : 'var(--danger)' }}>{m.qty > 0 ? '+' : ''}{qty(m.qty, it.unit)}</b> },
              ...(can('manager') ? [{ key: 'unit_cost', label: 'Rate', className: 'right', render: (m) => <span className="num">{money(m.unit_cost)}</span> }] : []),
              ...(it.kind === 'raw' ? [
                { key: 'qty_after', label: 'Tank after', className: 'right', render: (m) => <span className="num">{qty(m.qty_after, it.unit)}</span> },
                ...(can('manager') ? [{ key: 'avg_cost_after', label: 'Avg after', className: 'right', render: (m) => <span className="num">{money(m.avg_cost_after)}</span> }] : []),
              ] : []),
            ]} />
        </div>

        {can('manager') && !!it.active && !it.historic && (
          <div className="row no-print w" style={{ marginTop: 16 }}>
            <div className="spacer" />
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setDel(true)}><Trash2 size={18} /> Delete this item</button>
          </div>
        )}

        {edit && <ItemForm item={it} kind={it.kind} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); q.reload(); }} />}
        {editOpening && <EditOpeningModal item={it} entry={editOpening} onClose={() => setEditOpening(null)} onSaved={() => { setEditOpening(null); q.reload(); }} />}
        {adjust && <AdjustModal item={it} onClose={() => setAdjust(false)} onSaved={() => { setAdjust(false); q.reload(); }} />}
        {del && <DeleteItemModal item={it} onClose={() => setDel(false)} onDeleted={() => nav('/stock')}
          onAdjust={() => { setDel(false); setAdjust(true); }} />}
      </>
    )}</Async>
  );
}

function RawDetail({ it, money, can }) {
  return (
    <>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <h2><Droplets size={20} style={{ verticalAlign: -3 }} /> What’s in {it.container || 'the tank'} now</h2>
          <span className="muted small">Estimated mix by supplier delivery</span>
        </div>
        {it.tank.length === 0 ? <Empty>Tank is empty</Empty> : (
          <div className="table-wrap"><table className="table responsive">
            <thead><tr><th>Delivery</th><th>Supplier</th><th className="right">Qty still in tank</th><th>Share</th></tr></thead>
            <tbody>{it.tank.map((p) => (
              <tr key={p.receipt_movement_id}>
                <td>{p.purchase_no ? <Link to={`/purchases/${p.ref_id}`} className="mono">{p.purchase_no}</Link> : <span className="muted">{MOVE_LABEL[p.type] || p.type}</span>}<div className="small muted">{fmtDate(p.date)}</div></td>
                <td data-label="Supplier">{p.supplier_name || '—'}</td>
                <td data-label="Qty in tank" className="right num">{qty(p.qty, it.unit)}</td>
                <td data-label="Share"><div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><div className="share-bar" style={{ flex: 1 }}><span style={{ width: `${p.share_pct}%` }} /></div><b className="num">{p.share_pct}%</b></div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="grid grid-2" style={{ marginTop: 18 }}>
        {can('manager') && (
          <div className="card">
            <div className="card-head"><h2><Truck size={20} style={{ verticalAlign: -3 }} /> Purchases</h2></div>
            {it.purchases.length === 0 ? <Empty>No purchases yet</Empty> : it.purchases.map((p) => (
              <Link key={p.id} to={`/purchases/${p.purchase_id}`} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none', opacity: p.status === 'cancelled' ? .5 : 1 }}>
                <div style={{ flex: 1 }}><b>{p.supplier_name}</b><div className="small muted">{p.purchase_no} · {fmtDate(p.date)}</div></div>
                <div className="right"><b className="num">{qty(p.qty, it.unit)}</b><div className="small muted num">@ {money(p.unit_cost)}</div></div>
              </Link>
            ))}
          </div>
        )}
        <div className="card">
          <div className="card-head"><h2><Factory size={20} style={{ verticalAlign: -3 }} /> Used in batches</h2></div>
          {it.used_in.length === 0 ? <Empty>Not used yet</Empty> : it.used_in.map((b) => (
            <Link key={b.id} to={`/trace/lot/${b.lot_id}`} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none', opacity: b.status === 'cancelled' ? .5 : 1 }}>
              <div style={{ flex: 1 }}><b className="mono">{b.batch_no}</b><div className="small muted">{b.product_name} · {fmtDate(b.date)}</div></div>
              <div className="right"><b className="num">{qty(b.qty, it.unit)}</b>{can('manager') && <div className="small muted num">@ {money(b.avg_cost)}</div>}</div>
            </Link>
          ))}
        </div>
        {(it.sold_to || []).length > 0 && (
          <div className="card">
            <div className="card-head"><h2><Receipt size={20} style={{ verticalAlign: -3 }} /> Sold to customers</h2></div>
            {it.sold_to.map((x) => (
              <Link key={`${x.sale_id}-${x.qty}`} to={`/sales/${x.sale_id}`} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none', opacity: x.status === 'cancelled' ? .5 : 1 }}>
                <div style={{ flex: 1 }}><b>{x.customer_name}</b><div className="small muted">{x.invoice_no} · {fmtDate(x.date)}{x.status === 'cancelled' ? ' · cancelled' : ''}</div></div>
                <div className="right"><b className="num">{qty(x.qty, it.unit)}</b>{can('manager') && x.unit_price != null && <div className="small muted num">@ {money(x.unit_price)}</div>}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function GoodsDetail({ it, money, can }) {
  const nav = useNavigate();
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <h2><Package size={20} style={{ verticalAlign: -3 }} /> Batches in stock</h2>
        {it.kind === 'finished' && <Link to="/production/new" className="btn btn-sm"><Factory size={18} /> Make more</Link>}
      </div>
      <DataTable rows={it.lots} searchKeys={['lot_code', 'supplier_name', 'date']} placeholder="Search batch number…"
        onRow={(l) => nav(`/trace/lot/${l.id}`)} empty="No stock. Make a batch or buy stock."
        columns={[
          { key: 'lot_code', label: 'Batch no.', render: (l) => <div><b className="mono">{l.lot_code}</b><div className="small muted">{l.source_type === 'production' ? 'Made here' : l.source_type === 'purchase' ? `From ${l.supplier_name}` : 'Opening stock'}</div></div> },
          { key: 'date', label: 'Date', render: (l) => fmtDate(l.date) },
          { key: 'qty_in', label: 'Made / bought', className: 'right', render: (l) => <span className="num">{qty(l.qty_in, it.unit)}</span> },
          { key: 'qty_remaining', label: 'Left', className: 'right', render: (l) => <b className="num">{qty(l.qty_remaining, it.unit)}</b> },
          ...(can('manager') ? [{ key: 'unit_cost', label: 'Cost / unit', className: 'right', render: (l) => <span className="num">{money(l.unit_cost)}</span> }] : []),
        ]} />
    </div>
  );
}

export function ItemForm({ item, kind, onClose, onSaved }) {
  const isNew = !item;
  const money = useMoney();
  // on edit, "Stock you have now" / "Cost per unit" show the opening stock entered with the item (its first opening entry)
  const op = item?.opening_entries?.length ? item.opening_entries[item.opening_entries.length - 1] : null;
  const [f, setF] = useState(() => (item
    ? { ...item, opening_qty: op ? String(op.qty) : '', opening_cost: op ? String(op.unit_cost) : '' }
    : { kind, name: '', category_id: '', unit: kind === 'raw' ? 'kg' : 'pcs', container: '', reorder_level: '', sale_price: '', opening_qty: '', opening_cost: '' }));
  const [run, busy] = useAction();
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const qtyLocked = !isNew && op && !op.can_edit;
  const costLocked = !isNew && op && !op.can_edit_cost;
  // a past opening entry cannot become empty; a new one is optional
  const openingBad = !isNew && op && !(Number(f.opening_qty) > 0);
  const belowUsed = !isNew && op && Number(f.opening_qty) < op.min_qty - 1e-9;
  const save = () => run(async () => {
    if (isNew) { const r = await api.post('/items', f); onSaved(r.id); return; }
    const body = { ...f };
    const sameQty = op ? Math.abs(Number(f.opening_qty) - op.qty) < 1e-9 : !(Number(f.opening_qty) > 0);
    const sameCost = op ? Math.abs((Number(f.opening_cost) || 0) - op.unit_cost) < 1e-9 : true;
    if (sameQty && sameCost) { delete body.opening_qty; delete body.opening_cost; } // only touch stock when it was changed
    await api.put(`/items/${item.id}`, body); onSaved(item.id);
  }, isNew ? 'Item added' : 'Saved');

  return (
    <Modal title={isNew ? `New ${KIND_LABEL[f.kind].toLowerCase()}` : 'Edit item'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.name || openingBad || belowUsed} onClick={save}>Save</button></>}>
      <div className="form-grid">
        {isNew && (
          <Field label="Type" className="full">
            <div className="choice">
              {Object.entries(KIND_LABEL).map(([k, l]) => <button type="button" key={k} className={`btn ${f.kind === k ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, kind: k, unit: k === 'raw' ? 'kg' : 'pcs', category_id: '' }))}>{l}</button>)}
            </div>
          </Field>
        )}
        <Field label="Name" className="full"><input className="input" autoFocus value={f.name} onChange={set('name')} placeholder={f.kind === 'raw' ? 'e.g. Palm Oil' : 'e.g. Rose Soap 100g'} /></Field>
        <Field label="Category" className="full" help={f.category_id ? undefined : 'Not chosen: the item goes under “Other”'}>
          <CategoryPicker key={f.kind} kind={f.kind} value={f.category_id} current={item && { id: item.category_id, name: item.category_name }} onChange={(id) => setF((x) => ({ ...x, category_id: id }))} />
        </Field>
        <Field label="Unit">
          <select className="input" value={f.unit} onChange={set('unit')}>
            {['kg', 'litre', 'g', 'pcs', 'dozen', 'carton', 'drum', 'bag'].map((u) => <option key={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="Low-stock alert below" help="Warn me when stock falls to this"><NumberInput value={f.reorder_level} onChange={set('reorder_level')} /></Field>
        {!isNew && !op && item.stock > 0 ? null : isNew || !op ? <>
          <Field label="Stock you have now" help="Optional opening stock"><NumberInput value={f.opening_qty} onChange={set('opening_qty')} /></Field>
          <Field label="Cost per unit" help="For the opening stock"><NumberInput value={f.opening_cost} onChange={set('opening_cost')} /></Field>
        </> : <>
          <Field label="Stock you have now" help={belowUsed ? `At least ${qty(op.min_qty, f.unit)} — already sold or used` : `Opening stock entered on ${fmtDate(op.date)}`}>
            <NumberInput value={f.opening_qty} onChange={set('opening_qty')} disabled={qtyLocked} style={belowUsed || openingBad ? { borderColor: 'var(--danger)' } : undefined} />
          </Field>
          <Field label="Cost per unit" help={Number(f.opening_qty) > 0 && f.opening_cost !== '' ? `Opening value ${money(Number(f.opening_qty) * Number(f.opening_cost))}` : 'For the opening stock'}>
            <NumberInput value={f.opening_cost} onChange={set('opening_cost')} disabled={costLocked} />
          </Field>
          {(qtyLocked || costLocked) && <div className="full"><Alert type={qtyLocked ? 'info' : 'warn'}><Lock size={14} style={{ verticalAlign: -2 }} /> {op.locked_reason}</Alert></div>}
          {item.opening_entries.length > 1 && <div className="full small muted">This is the first opening entry. Later ones can be corrected in the “Opening stock” box on the item page.</div>}
        </>}
      </div>
    </Modal>
  );
}

/** Opening stock entries of an item, each correctable (qty / price) until it is used. */
function OpeningStockCard({ it, money, onEdit }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2><PackagePlus size={20} style={{ verticalAlign: -3 }} /> Opening stock</h2>
        <span className="small muted">Entered wrongly? Correct the quantity or price here.</span>
      </div>
      <div className="table-wrap"><table className="table responsive">
        <thead><tr><th>Date</th>{it.kind !== 'raw' && <th>Batch</th>}<th className="right">Qty</th><th className="right">Cost per {it.unit}</th><th className="right">Value</th><th>Status</th><th className="right"></th></tr></thead>
        <tbody>{it.opening_entries.map((e) => (
          <tr key={e.id}>
            <td data-label="Date">{fmtDate(e.date)}</td>
            {it.kind !== 'raw' && <td data-label="Batch" className="mono small">{e.lot_code}</td>}
            <td data-label="Qty" className="right num"><b>{qty(e.qty, it.unit)}</b>{e.used_qty > 0 && <div className="small muted">{qty(e.used_qty)} used</div>}</td>
            <td data-label="Cost" className="right num">{money(e.unit_cost)}</td>
            <td data-label="Value" className="right num">{money(e.value)}</td>
            <td data-label="Status">
              {!e.can_edit ? <span title={e.locked_reason}><Badge tone="gray"><Lock size={12} /> Locked</Badge></span>
                : !e.can_edit_cost ? <span title={e.locked_reason}><Badge tone="warn">Qty only</Badge></span>
                : <Badge tone="ok">Can be edited</Badge>}
            </td>
            <td className="right">{e.can_edit && <button className="btn btn-sm w" onClick={() => onEdit(e)}><Pencil size={16} /> Edit</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {it.opening_entries.some((e) => !e.can_edit) && (
        <div className="small muted" style={{ marginTop: 8 }}>{it.opening_entries.find((e) => !e.can_edit).locked_reason}</div>
      )}
    </div>
  );
}

function EditOpeningModal({ item, entry, onClose, onSaved }) {
  const money = useMoney();
  const [f, setF] = useState({ qty: String(entry.qty), unit_cost: String(entry.unit_cost) });
  const [run, busy] = useAction();
  const q = Number(f.qty), c = Number(f.unit_cost);
  const tooLow = q < entry.min_qty - 1e-9;
  const valid = q > 0 && c >= 0 && f.unit_cost !== '' && !tooLow;
  const save = () => run(() => api.put(`/items/${item.id}/opening/${entry.id}`, { qty: f.qty, unit_cost: f.unit_cost }), 'Opening stock corrected').then((r) => r && onSaved());
  return (
    <Modal title={`Edit opening stock — ${item.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid || busy} onClick={save}>Save correction</button></>}>
      <div className="stack">
        <div className="muted">Entered on <b>{fmtDate(entry.date)}</b>{entry.lot_code && <> · batch <span className="mono">{entry.lot_code}</span></>}: {qty(entry.qty, item.unit)} @ {money(entry.unit_cost)} = <b>{money(entry.value)}</b></div>
        <Field label={`Correct quantity (${item.unit})`} help={entry.min_qty > 0 ? `At least ${qty(entry.min_qty, item.unit)} — that much has already been sold or used` : undefined}>
          <NumberInput className="big" value={f.qty} onChange={(v) => setF((x) => ({ ...x, qty: v }))} autoFocus style={tooLow ? { borderColor: 'var(--danger)' } : undefined} />
        </Field>
        <Field label={`Correct cost per ${item.unit}`}>
          <NumberInput value={f.unit_cost} onChange={(v) => setF((x) => ({ ...x, unit_cost: v }))} disabled={!entry.can_edit_cost} />
        </Field>
        {!entry.can_edit_cost && <Alert type="warn">{entry.locked_reason}</Alert>}
        {valid && <div className="t-row" style={{ display: 'flex', justifyContent: 'space-between' }}><span>New opening value</span><b className="num">{money(q * c)}</b></div>}
        <div className="small muted">
          The original entry is corrected on its own date. {item.kind === 'raw' ? 'The tank quantity and weighted average cost are recalculated.' : 'The batch quantity and cost are updated.'} Stock value and the books change with it.
        </div>
      </div>
    </Modal>
  );
}

function AdjustModal({ item, onClose, onSaved }) {
  const [mode, setMode] = useState('remove');
  const [f, setF] = useState({ qty: '', unit_cost: '', reason: '', date: today() });
  const money = useMoney();
  const [run, busy] = useAction();
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const save = () => run(() => api.post(`/items/${item.id}/adjust`, {
    qty: mode === 'add' ? Number(f.qty) : -Number(f.qty), unit_cost: mode === 'add' ? f.unit_cost : undefined,
    reason: f.reason || (mode === 'add' ? 'Opening stock / stock found' : 'Damaged / wastage'), date: f.date,
  }), 'Stock updated').then((r) => r && onSaved());

  return (
    <Modal title={`Adjust stock — ${item.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${mode === 'add' ? 'btn-in' : 'btn-out'}`} disabled={busy || !(Number(f.qty) > 0)} onClick={save}>{mode === 'add' ? 'Add stock' : 'Remove stock'}</button></>}>
      <div className="stack">
        <div className="choice">
          <button className={`btn ${mode === 'remove' ? 'btn-out' : ''}`} onClick={() => setMode('remove')}>− Remove (damage / loss)</button>
          <button className={`btn ${mode === 'add' ? 'btn-in' : ''}`} onClick={() => setMode('add')}>+ Add (found / opening)</button>
        </div>
        <div className="muted">In stock now: <b>{qty(item.stock, item.unit)}</b></div>
        <Field label={`Quantity (${item.unit})`}><NumberInput className="big" value={f.qty} onChange={set('qty')} autoFocus /></Field>
        {mode === 'add' && <Field label="Cost per unit" help={item.kind === 'raw' ? `Leave empty to use the current average (${money(item.unit_cost)})` : undefined}><NumberInput value={f.unit_cost} onChange={set('unit_cost')} /></Field>}
        <Field label="Reason"><input className="input" value={f.reason} onChange={set('reason')} placeholder={mode === 'add' ? 'e.g. Physical count' : 'e.g. Spilled, expired'} /></Field>
        <Field label="Date"><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
      </div>
    </Modal>
  );
}

/** Big category buttons for one item type, with "+ New category" (managers). */
function CategoryPicker({ kind, value, current, onChange }) {
  const q = useFetch(`/item-categories?kind=${kind}`);
  const { can } = useApp();
  const [name, setName] = useState(null);
  const [run, busy] = useAction();
  const list = q.data || [];
  // an item already in a hidden category keeps showing it
  const shown = current?.id && !list.some((c) => c.id === current.id) ? [...list, { id: current.id, name: `${current.name} (hidden)` }] : list;
  const add = () => run(async () => {
    const c = await api.post('/item-categories', { kind, name });
    setName(null); q.reload(); onChange(c.id);
    return true;
  }, 'Category added');
  return (
    <div className="cat-grid">
      {shown.map((c) => (
        <button key={c.id} type="button" className={`btn ${Number(value) === c.id ? 'on' : ''}`} onClick={() => onChange(c.id)}>{c.name}</button>
      ))}
      {can('manager') && (name === null
        ? <button type="button" className="btn btn-ghost" onClick={() => setName('')}><Plus size={18} /> New category</button>
        : (
          <div className="row" style={{ gridColumn: '1 / -1' }}>
            <input className="input" style={{ flex: 1 }} autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'raw' ? 'e.g. Essential Oils, Colours' : kind === 'finished' ? 'e.g. Bath Soap, Laundry Soap' : 'e.g. Shampoo, Toothpaste'}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
            <button type="button" className="btn btn-primary" disabled={!name.trim() || busy} onClick={add}>Add</button>
            <button type="button" className="btn btn-ghost" onClick={() => setName(null)}>Cancel</button>
          </div>
        ))}
    </div>
  );
}

/** Add, rename and hide item categories — one list per item type. */
function ItemCategoryManager({ kind: startKind, onClose }) {
  const [kind, setKind] = useState(startKind);
  const q = useFetch(`/item-categories?kind=${kind}&all=1`);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  const add = () => run(async () => { await api.post('/item-categories', { kind, name }); setName(''); q.reload(); return true; }, 'Category added');
  const rename = () => run(async () => { await api.put(`/item-categories/${edit.id}`, { name: edit.name }); setEdit(null); q.reload(); return true; }, 'Renamed');
  const toggle = (c) => run(async () => { await api.put(`/item-categories/${c.id}`, { active: !c.active }); q.reload(); return true; }, c.active ? 'Hidden from the Add item form' : 'Shown again');
  return (
    <Modal title="Item categories" onClose={onClose} wide footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        <Tabs tabs={KIND_TABS} value={kind} onChange={(k) => { setKind(k); setEdit(null); }} />
        <div className="row">
          <input className="input" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)}
            placeholder={`New ${KIND_LABEL[kind].toLowerCase()} category`} onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={add}><Plus size={18} /> Add</button>
        </div>
        <div className="small muted">Each type of item has its own list. Hiding a category removes it from the Add item form; items already in it keep it.</div>
        <Async q={q}>{(rows) => (
          <div className="table-wrap"><table className="table responsive">
            <thead><tr><th>Category</th><th className="right">Items</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'cancelled'}>
                <td>{edit?.id === c.id
                  ? <div className="row"><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && edit.name.trim() && rename()} />
                    <button className="btn btn-primary btn-sm" onClick={rename} disabled={busy || !edit.name.trim()}>Save</button></div>
                  : <><b>{c.name}</b>{!c.active && <> <Badge>Hidden</Badge></>}</>}</td>
                <td data-label="Items" className="right num">{c.items}</td>
                <td className="right nowrap" data-label="">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEdit({ id: c.id, name: c.name })}><Pencil size={16} /> Rename</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggle(c)}>{c.active ? <><EyeOff size={16} /> Hide</> : <><Eye size={16} /> Show</>}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}</Async>
      </div>
    </Modal>
  );
}

/** Deleting is deliberate: shows where the item appears, lists anything blocking it, and needs the word DELETE typed. */
function DeleteItemModal({ item, onClose, onDeleted, onAdjust }) {
  const q = useFetch(`/items/${item.id}/delete-check`);
  const [word, setWord] = useState('');
  const [run, busy] = useAction();
  const ok = word.trim().toUpperCase() === 'DELETE';
  const c = q.data;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const kept = c ? [
    c.used.invoices && plural(c.used.invoices, 'invoice', 'invoices'),
    c.used.purchases && plural(c.used.purchases, 'purchase', 'purchases'),
    c.used.batches_made && plural(c.used.batches_made, 'production batch', 'production batches'),
    c.used.batches_used_in && `used in ${plural(c.used.batches_used_in, 'batch', 'batches')}`,
  ].filter(Boolean) : [];
  const del = () => run(() => api.post(`/items/${item.id}/delete`, { confirm: word }), `“${item.name}” deleted`).then((r) => r && onDeleted());

  return (
    <Modal title={`Delete “${item.name}”?`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>No, keep it</button>
        <button className="btn btn-danger" disabled={!c?.can_delete || !ok || busy} onClick={del}><Trash2 size={18} /> Delete item</button>
      </>}>
      <Async q={q}>{() => (
        <div className="stack">
          {c.blockers.length > 0 ? (
            <Alert type="danger">
              <b>This item cannot be deleted yet:</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>{c.blockers.map((b) => <li key={b.code} style={{ marginTop: 4 }}>{b.message}</li>)}</ul>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                {c.blockers.some((b) => b.code === 'stock') && <button className="btn btn-sm" onClick={onAdjust}><Scale size={16} /> Adjust stock now</button>}
              </div>
            </Alert>
          ) : (
            <>
              <div className="del-facts">
                <div><Trash2 size={18} /> <span>It will be <b>removed from stock lists</b> and from the item choices on new sales, purchases and batches.</span></div>
                <div><CheckCircle2 size={18} /> <span>{kept.length
                  ? <>Old records <b>stay exactly as they are</b>: {kept.join(', ')}, plus ledgers and reports. Printed invoices still show its name.</>
                  : <>It has no invoices, purchases or batches. Its history and reports stay as they are.</>}</span></div>
                <div><RotateCcw size={18} /> <span>You can bring it back any time from <b>Stock → Deleted items</b>.</span></div>
              </div>
              <Field label={<>Type <b className="mono">DELETE</b> to confirm</>}>
                <input className="input" autoFocus value={word} onChange={(e) => setWord(e.target.value)} placeholder="DELETE"
                  autoCapitalize="characters" autoComplete="off" spellCheck={false}
                  onKeyDown={(e) => e.key === 'Enter' && ok && c.can_delete && !busy && del()} />
              </Field>
            </>
          )}
        </div>
      )}</Async>
    </Modal>
  );
}

function DeletedItems({ kind, onClose }) {
  const q = useFetch(`/items-deleted?kind=${kind}`);
  const [run, busy] = useAction();
  const nav = useNavigate();
  return (
    <Modal title={`Deleted items · ${KIND_LABEL[kind]}`} onClose={onClose}
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p className="muted" style={{ marginTop: 0 }}>These items are hidden from lists and forms. Their old invoices and history are kept. Restore an item to use it again.</p>
      <Async q={q}>{(rows) => rows.length === 0 ? <Empty>No deleted items</Empty> : (
        <div className="stack" style={{ gap: 0 }}>
          {rows.map((r) => (
            <div key={r.id} className="row" style={{ padding: '12px 0', borderBottom: '1px solid var(--border)', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <b>{r.name}</b>
                <div className="small muted">{r.category_name}{r.deleted_at && ` · deleted ${fmtDate(r.deleted_at.slice(0, 10))}`}{r.deleted_by_name && ` by ${r.deleted_by_name}`}{r.invoices > 0 && ` · on ${r.invoices} invoice${r.invoices > 1 ? 's' : ''}`}</div>
              </div>
              <button className="btn btn-sm" onClick={() => nav(`/stock/${r.id}`)}><ExternalLink size={16} /> Open</button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.post(`/items/${r.id}/restore`), `“${r.name}” restored`).then((x) => x && q.reload())}><RotateCcw size={16} /> Restore</button>
            </div>
          ))}
        </div>
      )}</Async>
    </Modal>
  );
}
