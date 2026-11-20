import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Plus, Trash2, Save, Ban, Building2, Factory, Users, ArrowRight } from 'lucide-react';
import { useFetch, useMoney, useAction, api, qty, fmtDate, today, thisMonth } from '../lib.jsx';
import { PageHead, Async, DataTable, Badge, Field, NumberInput, Picker, Alert, Loading, Confirm, PayBadge, Empty, Stat } from '../components.jsx';
import { QuickParty, MonthNav } from './Sales.jsx';
import { PaymentPicker, MethodBadge, MethodFilter, emptyPayment, paymentBody, useFunds, METHOD_LABEL, METHOD_ICON } from '../payment.jsx';

export function PurchaseList() {
  const [month, setMonth] = useState(thisMonth());
  const [method, setMethod] = useState('');
  const q = useFetch(`/purchases?month=${month}${method ? `&method=${method}` : ''}`);
  const money = useMoney();
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Purchases" sub="Raw materials go into their tank; the average cost updates automatically."
        actions={<Link to="/purchases/new" className="btn btn-primary btn-lg"><Plus size={22} /> New purchase</Link>} />
      <div className="card no-print">
        <div className="row"><MonthNav month={month} setMonth={setMonth} /><MethodFilter value={method} onChange={setMethod} withCredit /></div>
      </div>
      <Async q={q}>{({ rows, summary }) => (
        <>
          <div className="grid grid-4" style={{ marginTop: 18 }}>
            <Stat label={`Purchases${method ? ` · ${METHOD_LABEL[method]}` : ''}`} value={money(summary.total)} hint={`${summary.count} bill${summary.count === 1 ? '' : 's'}`} />
            <Stat icon={METHOD_ICON.cash} label="Paid in cash" value={money(summary.by_method.cash)} />
            <Stat icon={METHOD_ICON.bank_transfer} label="Bank transfer + cheque" value={money(summary.by_method.bank_transfer + summary.by_method.cheque)} hint={`Cheques ${money(summary.by_method.cheque)}`} />
            <Stat label="Still owed to suppliers" value={money(summary.unpaid)} hint="from these bills" />
          </div>
          <div className="card">
            <DataTable rows={rows} searchKeys={['purchase_no', 'supplier_name', 'supplier_bill_no', 'date']} placeholder="Search supplier or bill no…"
              onRow={(p) => nav(`/purchases/${p.id}`)} rowClass={(p) => (p.status === 'cancelled' ? 'cancelled' : '')} empty="No purchases for this filter."
              columns={[
                { key: 'purchase_no', label: 'Purchase', render: (p) => <div><b className="mono">{p.purchase_no}</b><div className="small muted">{p.supplier_name}{p.supplier_bill_no ? ` · Bill ${p.supplier_bill_no}` : ''}</div></div> },
                { key: 'date', label: 'Date', render: (p) => fmtDate(p.date) },
                { key: 'status', label: 'Payment', render: (p) => (p.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <div><PayBadge total={p.total} paid={p.paid} />{p.payment_method && <div style={{ marginTop: 4 }}><MethodBadge method={p.payment_method} small /></div>}</div>) },
                { key: 'total', label: 'Total', className: 'right', render: (p) => <b className="num">{money(p.total)}</b> },
                { key: 'paid', label: 'Paid', className: 'right', render: (p) => <span className="num">{money(p.paid)}</span> },
              ]} />
          </div>
        </>
      )}</Async>
    </>
  );
}

const blank = () => ({ item_id: '', qty: '', unit_cost: '' });

export function NewPurchase() {
  const itemsQ = useFetch('/items');
  const supQ = useFetch('/parties?type=supplier');
  const funds = useFunds();
  const money = useMoney();
  const nav = useNavigate();
  const [f, setF] = useState({ supplier_id: '', supplier_bill_no: '', date: today(), notes: '' });
  const [lines, setLines] = useState([blank()]);
  const [payMode, setPayMode] = useState('credit');
  const [paidPart, setPaidPart] = useState('');
  const [pay, setPay] = useState(emptyPayment);
  const [newSup, setNewSup] = useState(null); // null = closed, otherwise the typed name
  const [run, busy] = useAction();

  const items = (itemsQ.data || []).filter((i) => i.kind !== 'finished');
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const options = items.map((i) => ({ value: i.id, label: i.name, sub: `${i.kind === 'raw' ? (i.container || 'Raw material') : 'Trading item'} · stock ${qty(i.stock, i.unit)}`, right: i.kind === 'raw' ? `avg ${money(i.unit_cost)}` : '' }));
  const suppliers = (supQ.data || []).map((s) => ({ value: s.id, label: s.name, sub: s.phone || '', right: s.balance ? `We owe ${money(s.balance)}` : '' }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0);
  const paid = payMode === 'cash' ? total : payMode === 'credit' ? 0 : Number(paidPart) || 0;
  const valid = f.supplier_id && lines.some((l) => l.item_id && Number(l.qty) > 0) && paid <= total;
  const save = () => run(() => api.post('/purchases', {
    ...f, paid, ...paymentBody(pay),
    items: lines.filter((l) => l.item_id && Number(l.qty) > 0),
  }), 'Purchase saved — stock updated').then((r) => r && nav(`/purchases/${r.id}`));

  if (itemsQ.loading || supQ.loading) return <Loading />;
  return (
    <>
      <PageHead back="/purchases" title="New purchase" sub="Enter the supplier bill. Stock and the supplier account update automatically." />
      <div className="stack" style={{ gap: 18 }}>
        <div className="card">
          <div className="form-grid">
            <Field label="Supplier">
              <Picker options={suppliers} value={f.supplier_id} onChange={(v) => setF({ ...f, supplier_id: v })} placeholder="Search supplier…" autoFocus noun="supplier" onCreate={(name) => setNewSup(name)} />
            </Field>
            <Field label="Supplier bill no."><input className="input" value={f.supplier_bill_no} onChange={(e) => setF({ ...f, supplier_bill_no: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Date"><input className="input" type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Notes"><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Optional (vehicle, driver…)" /></Field>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Items received</h2>
          <div className="lines">
            {lines.map((l, i) => {
              const it = byId[l.item_id];
              const q = Number(l.qty) || 0, c = Number(l.unit_cost) || 0;
              const newAvg = it && it.kind === 'raw' && q > 0 ? (it.stock * it.unit_cost + q * c) / (it.stock + q) : null;
              return (
                <div key={i}>
                  <div className="line">
                    <Field label="Item"><Picker options={options} value={l.item_id} onChange={(v) => setLine(i, { item_id: v })} placeholder="Search item…" /></Field>
                    <Field label={`Qty ${it?.unit || ''}`}><NumberInput value={l.qty} onChange={(v) => setLine(i, { qty: v })} /></Field>
                    <Field label="Rate"><NumberInput value={l.unit_cost} onChange={(v) => setLine(i, { unit_cost: v })} /></Field>
                    <div className="field"><label>Amount</label><div className="amount num">{money(q * c)}</div></div>
                    <button className="btn btn-ghost" aria-label="Remove" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [blank()]))}><Trash2 size={20} /></button>
                  </div>
                  {newAvg !== null && c > 0 && (
                    <div className="small" style={{ padding: '6px 4px' }}>
                      <span className="muted">{it.container || 'Tank'}: {qty(it.stock, it.unit)} @ {money(it.unit_cost)}</span>
                      <ArrowRight size={14} style={{ verticalAlign: -2, margin: '0 6px' }} />
                      <b>{qty(+(it.stock + q).toFixed(3), it.unit)} @ {money(newAvg)}</b> <span className="muted">new average</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blank()])}><Plus size={20} /> Add another item</button>
        </div>

        <div className="card">
          <div className="grid grid-2">
            <div className="stack">
              <h2>Payment to supplier</h2>
              <div className="choice">
                <button className={`btn ${payMode === 'credit' ? 'on' : ''}`} onClick={() => setPayMode('credit')}>On credit — pay later</button>
                <button className={`btn ${payMode === 'cash' ? 'on' : ''}`} onClick={() => setPayMode('cash')}>Paid in full</button>
                <button className={`btn ${payMode === 'part' ? 'on' : ''}`} onClick={() => setPayMode('part')}>Part payment</button>
              </div>
              {payMode === 'part' && <Field label="Amount paid now"><NumberInput className="big" value={paidPart} onChange={setPaidPart} /></Field>}
              {paid > 0 && <PaymentPicker value={pay} onChange={setPay} funds={funds} direction="out" amount={paid} />}
            </div>
            <div className="totals">
              <div className="t-row grand"><span>Bill total</span><span className="num">{money(total)}</span></div>
              <div className="t-row"><span>Paid now</span><b className="num">{money(paid)}</b></div>
              <div className="t-row"><span>Added to supplier account</span><b className="num">{money(total - paid)}</b></div>
            </div>
          </div>
          {paid > total && <div style={{ marginTop: 14 }}><Alert type="danger">Paid amount is more than the bill.</Alert></div>}
          <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 18 }} disabled={!valid || busy} onClick={save}><Save size={22} /> Save purchase</button>
        </div>
      </div>
      {newSup !== null && <QuickParty type="supplier" initialName={newSup} onClose={() => setNewSup(null)} onSaved={(id) => { setNewSup(null); supQ.reload(); setF((x) => ({ ...x, supplier_id: id })); }} />}
    </>
  );
}

export function PurchaseDetail() {
  const { id } = useParams();
  const q = useFetch(`/trace/purchase/${id}`);
  const money = useMoney();
  const [cancel, setCancel] = useState(false);
  const [run, busy] = useAction();

  return (
    <Async q={q}>{({ purchase: p, lines, customers, payments }) => (
      <>
        <PageHead back="/purchases" title={`Purchase ${p.purchase_no}`}
          sub={<><Link to={`/parties/${p.supplier_id}`}>{p.supplier_name}</Link> · {fmtDate(p.date)}{p.supplier_bill_no ? ` · Supplier bill ${p.supplier_bill_no}` : ''}</>}
          actions={p.status !== 'cancelled' && <button className="btn btn-ghost" onClick={() => setCancel(true)}><Ban size={18} /> Cancel purchase</button>} />
        {p.status === 'cancelled' && <div style={{ marginBottom: 16 }}><Alert type="danger">This purchase was cancelled. Stock and the supplier account were reversed.</Alert></div>}

        <div className="card">
          <div className="card-head"><h2><Building2 size={20} style={{ verticalAlign: -3 }} /> Items</h2><PayBadge total={p.total} paid={p.paid} /></div>
          <div className="table-wrap"><table className="table responsive">
            <thead><tr><th>Item</th><th>Stored in</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}>
                <td><Link to={`/stock/${l.item_id}`}><b>{l.name}</b></Link></td>
                <td data-label="Stored in">{l.kind === 'raw' ? (l.container || 'Tank') : <span className="mono">Lot {l.lot_code}</span>}</td>
                <td data-label="Qty" className="right num">{qty(l.qty, l.unit)}</td>
                <td data-label="Rate" className="right num">{money(l.unit_cost)}</td>
                <td data-label="Amount" className="right num"><b>{money(l.amount)}</b></td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={4}>Total · Paid {money(p.paid)}</td><td className="right num">{money(p.total)}</td></tr></tfoot>
          </table></div>
          {(payments || []).length > 0 && (
            <div className="stack" style={{ gap: 6, marginTop: 12 }}>
              {payments.map((f) => (
                <div key={f.id} className="row small" style={{ gap: 8 }}>
                  <MethodBadge method={f.method} chequeNo={f.cheque_no} status={f.reverses_id ? null : f.cheque_status} reference={f.reference} />
                  <span className="muted">{f.direction === 'out' ? 'paid from' : 'returned to'} {f.account_name} · {fmtDate(f.date)}</span>
                  <b className="num" style={{ marginLeft: 'auto' }}>{money(f.amount)}</b>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2><Factory size={20} style={{ verticalAlign: -3 }} /> Where did this material go?</h2>
            <span className="muted small">Use this for product recalls</span>
          </div>
          {lines.map((l) => (
            <div key={l.id} className="material">
              <b>{l.name}</b>
              {l.batches && (l.batches.length === 0 ? (!(l.direct_sales || []).length && <div className="muted small" style={{ marginTop: 6 }}>Not used in any batch yet — still in {l.container || 'the tank'}.</div>) : (
                <div className="sources">{l.batches.map((b) => (
                  <Link key={b.id} to={`/trace/lot/${b.lot_id}`} className="source" style={{ textDecoration: 'none', color: 'inherit', opacity: b.status === 'cancelled' ? .5 : 1 }}>
                    <span><b className="mono">{b.batch_no}</b> · {b.product_name}<div className="small muted">{fmtDate(b.date)}</div></span>
                    <span className="small">{b.sales.filter((s) => s.status === 'active').map((s) => s.customer_name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || <span className="muted">Not sold yet</span>}</span>
                    <span className="num right">≈ {qty(b.qty_used, l.unit)}</span>
                    <span className="num right muted">{b.share_pct}% of mix</span>
                  </Link>
                ))}</div>
              ))}
              {(l.direct_sales || []).length > 0 && (
                <>
                  <div className="small muted" style={{ marginTop: 8, fontWeight: 700 }}>Sold as raw material</div>
                  <div className="sources">{l.direct_sales.map((s, k) => (
                    <Link key={k} to={`/sales/${s.sale_id}`} className="source" style={{ textDecoration: 'none', color: 'inherit', opacity: s.status === 'cancelled' ? .5 : 1 }}>
                      <span><b>{s.customer_name}</b><div className="small muted">{s.invoice_no} · {fmtDate(s.date)}{s.status === 'cancelled' ? ' · cancelled' : ''}</div></span>
                      <span>{s.payment}</span>
                      <span className="num right">≈ {qty(s.qty, l.unit)}</span>
                      <span className="num right muted">{s.share_pct}% of tank</span>
                    </Link>
                  ))}</div>
                </>
              )}
              {l.sales && (l.sales.length === 0 ? <div className="muted small" style={{ marginTop: 6 }}>Not sold yet.</div> : (
                <div className="sources">{l.sales.map((s, k) => (
                  <Link key={k} to={`/sales/${s.sale_id}`} className="source" style={{ textDecoration: 'none', color: 'inherit' }}>
                    <span><b>{s.customer_name}</b><div className="small muted">{s.invoice_no} · {fmtDate(s.date)}</div></span>
                    <span>{s.payment}</span><span className="num right">{qty(s.qty, l.unit)}</span><span className="num right">{money(s.unit_price)}</span>
                  </Link>
                ))}</div>
              ))}
            </div>
          ))}
          <div style={{ marginTop: 14 }}>
            {customers.length === 0 ? <Empty icon={Users}>No customer has received this material, or goods made from it, yet.</Empty>
              : <Alert type="warn"><b>{customers.length} customer{customers.length > 1 ? 's' : ''}</b> received this material or goods containing it: {customers.map((c) => c.name).join(', ')}</Alert>}
          </div>
        </div>
        {cancel && <Confirm title="Cancel this purchase?" danger busy={busy} confirmLabel="Yes, cancel purchase"
          message="The stock will be removed and the supplier account reversed. This is only possible if the material has not already been used."
          onClose={() => setCancel(false)} onConfirm={() => run(() => api.post(`/purchases/${p.id}/cancel`), 'Purchase cancelled').then(() => { setCancel(false); q.reload(); })} />}
      </>
    )}</Async>
  );
}
