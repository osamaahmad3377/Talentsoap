import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Plus, Trash2, Printer, Ban, Save, UserPlus, MessageCircle, ChevronLeft, ChevronRight, Lock, Undo2 } from 'lucide-react';
import { ReturnModal, InvoiceReturns } from './Returns.jsx';
import { PaymentPicker, MethodBadge, MethodFilter, emptyPayment, paymentBody, useFunds, METHOD_LABEL, METHOD_ICON } from '../payment.jsx';
import { useFetch, useMoney, useApp, useAction, api, qty, fmtDate, today, thisMonth, fyStartMonth, payLabel } from '../lib.jsx';
import { PageHead, Async, DataTable, Badge, Field, NumberInput, Picker, Alert, Loading, Modal, Confirm, PayBadge, Stat } from '../components.jsx';

export function SalesList() {
  const [month, setMonth] = useState(thisMonth());
  const [method, setMethod] = useState('');
  const q = useFetch(`/sales?month=${month}${method ? `&method=${method}` : ''}`);
  const money = useMoney();
  const nav = useNavigate();
  return (
    <>
      <PageHead title="Sales & Invoices" sub="Every invoice is billed from finished stock."
        actions={<>
          <Link to="/returns" className="btn ro-ok"><Undo2 size={20} /> Returns</Link>
          <Link to="/sales/new" className="btn btn-primary btn-lg"><Plus size={22} /> New sale</Link>
        </>} />
      <div className="card no-print">
        <div className="row">
          <MonthNav month={month} setMonth={setMonth} />
          <MethodFilter value={method} onChange={setMethod} withCredit />
        </div>
      </div>
      <Async q={q}>{({ rows, summary }) => (
        <>
          <div className="grid grid-4" style={{ marginTop: 18 }}>
            <Stat label={`Sales${method ? ` · ${METHOD_LABEL[method]}` : ''}`} value={money(summary.total)} hint={`${summary.count} invoice${summary.count === 1 ? '' : 's'}`} />
            <Stat icon={METHOD_ICON.cash} label="Received in cash" value={money(summary.by_method.cash)} />
            <Stat icon={METHOD_ICON.bank_transfer} label="Bank transfer + cheque" value={money(summary.by_method.bank_transfer + summary.by_method.cheque)} hint={`Cheques ${money(summary.by_method.cheque)}`} />
            <Stat label="Still on credit" value={money(summary.unpaid)} hint="not paid at the time of sale" />
          </div>
          <div className="card">
            <DataTable rows={rows} searchKeys={['invoice_no', 'customer_name', 'date']} placeholder="Search invoice no. or customer…"
              onRow={(s) => nav(`/sales/${s.id}`)} rowClass={(s) => (s.status === 'cancelled' ? 'cancelled' : '')} empty="No invoices for this filter."
              columns={[
                { key: 'invoice_no', label: 'Invoice', render: (s) => <div><b className="mono">{s.invoice_no}</b><div className="small muted">{s.customer_name}</div></div> },
                { key: 'date', label: 'Date', render: (s) => fmtDate(s.date) },
                { key: 'type', label: 'Payment', render: (s) => (s.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <div><PayBadge total={s.total} paid={s.paid} />{s.payment_method && <div style={{ marginTop: 4 }}><MethodBadge method={s.payment_method} small /></div>}</div>) },
                { key: 'total', label: 'Total', className: 'right', render: (s) => <b className="num">{money(s.total)}</b> },
                { key: 'paid', label: 'Received', className: 'right', render: (s) => <span className="num">{money(s.paid)}</span> },
              ]} />
          </div>
        </>
      )}</Async>
    </>
  );
}

/** ‹ Month › selector used by lists. */
export function MonthNav({ month, setMonth }) {
  const shift = (n) => { const d = new Date(`${month}-15T12:00:00`); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-CA').slice(0, 7); };
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <button className="btn" onClick={() => setMonth(shift(-1))} disabled={month <= fyStartMonth()} aria-label="Previous month"><ChevronLeft size={22} /></button>
      <input className="input" type="month" style={{ width: 'auto' }} value={month} min={fyStartMonth()} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
      <button className="btn" onClick={() => setMonth(shift(1))} disabled={month >= thisMonth()} aria-label="Next month"><ChevronRight size={22} /></button>
    </div>
  );
}

const blankLine = () => ({ item_id: '', qty: '', unit_price: '', lot_id: '', lots: null, stock: null, unit: '', kind: '' });
const KIND_TAG = { finished: 'Finished goods', trading: 'Trading item', raw: 'Raw material' };

/**
 * Estimated cost of a line, the same way the server will cost it when saved:
 * raw material at the tank's weighted average; goods from the chosen batch first, then oldest batch first.
 */
function estCost(l) {
  const q = Number(l.qty) || 0;
  if (!q) return 0;
  if (l.kind === 'raw' || !l.lots || !l.lots.length) return q * (l.cost || 0);
  const lots = [...l.lots].sort((a, b) => (String(b.id) === String(l.lot_id)) - (String(a.id) === String(l.lot_id)) || a.date.localeCompare(b.date) || a.id - b.id);
  let left = q, c = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.qty_remaining);
    c += take * lot.unit_cost;
    left -= take;
  }
  return c + Math.max(0, left) * (l.cost || 0);
}
const pctOf = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');

export function NewSale() {
  const itemsQ = useFetch('/items');
  const custQ = useFetch('/parties?type=customer');
  const funds = useFunds();
  const money = useMoney();
  const { can } = useApp();
  const nav = useNavigate();
  const [customer, setCustomer] = useState('');
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState([blankLine()]);
  const [discount, setDiscount] = useState('');
  const [payMode, setPayMode] = useState('cash');
  const [paidPart, setPaidPart] = useState('');
  const [pay, setPay] = useState(emptyPayment);
  const [notes, setNotes] = useState('');
  const [newCust, setNewCust] = useState(false);
  const [run, busy] = useAction();

  // finished goods first, then trading items, then raw materials (sold occasionally)
  const KIND_ORDER = { finished: 0, trading: 1, raw: 2 };
  const goods = [...(itemsQ.data || [])].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
  const options = goods.map((i) => ({
    value: i.id, label: i.name,
    sub: `${KIND_TAG[i.kind]} · ${i.stock > 0 ? `In stock: ${qty(i.stock, i.unit)}` : 'OUT OF STOCK'}`,
    right: i.sale_price ? money(i.sale_price) : '',
  }));
  const customers = (custQ.data || []).map((c) => ({ value: c.id, label: c.name, sub: c.phone || '', right: c.balance ? `Owes ${money(c.balance)}` : '' }));

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = async (i, id) => {
    const it = goods.find((g) => g.id === id);
    setLine(i, { item_id: id, unit_price: String(it?.sale_price || ''), stock: it?.stock, unit: it?.unit, kind: it?.kind, container: it?.container, cost: it?.unit_cost, lot_id: '', lots: null });
    if (it?.kind === 'raw') return; // tank stock has no batches
    const detail = await api.get(`/items/${id}`).catch(() => null);
    if (detail) setLine(i, { lots: detail.lots.filter((l) => l.qty_remaining > 0) });
  };

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const total = Math.max(0, subtotal - (Number(discount) || 0));
  const paid = payMode === 'cash' ? total : payMode === 'credit' ? 0 : Number(paidPart) || 0;
  const over = lines.filter((l) => l.item_id && Number(l.qty) > (l.stock ?? Infinity));
  const valid = customer && lines.some((l) => l.item_id && Number(l.qty) > 0) && over.length === 0 && paid <= total;
  const walkIn = custQ.data?.find((c) => c.name === 'Walk-in Customer');

  const save = () => run(() => api.post('/sales', {
    customer_id: customer, date, discount, notes, paid, ...paymentBody(pay),
    items: lines.filter((l) => l.item_id && Number(l.qty) > 0).map((l) => ({ item_id: l.item_id, qty: l.qty, unit_price: l.unit_price, lot_id: l.lot_id || undefined })),
  }), 'Invoice saved').then((r) => r && nav(`/sales/${r.id}`));

  if (itemsQ.loading || custQ.loading) return <Loading />;
  return (
    <>
      <PageHead back="/sales" title="New sale" sub="Choose the customer, add soap, trading items or raw materials from stock, and save." />
      <div className="stack" style={{ gap: 18 }}>
        <div className="card">
          <div className="form-grid">
            <Field label="Customer">
              <Picker options={customers} value={customer} onChange={setCustomer} placeholder="Search customer…" autoFocus />
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                {walkIn && <button className="btn btn-sm" onClick={() => { setCustomer(walkIn.id); setPayMode('cash'); }}>Walk-in (cash)</button>}
                <button className="btn btn-sm" onClick={() => setNewCust(true)}><UserPlus size={16} /> New customer</button>
              </div>
            </Field>
            <Field label="Date"><input className="input" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Items</h2>
          <div className="lines">
            {lines.map((l, i) => {
              const amount = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
              const short = l.item_id && Number(l.qty) > (l.stock ?? Infinity);
              return (
                <div key={i}>
                  <div className="line">
                    <Field label="Item"><Picker options={options} value={l.item_id} onChange={(v) => pickItem(i, v)} placeholder="Search soap, item or raw material…" /></Field>
                    <Field label={`Qty ${l.unit}`}><NumberInput value={l.qty} onChange={(v) => setLine(i, { qty: v })} style={short ? { borderColor: 'var(--danger)' } : undefined} /></Field>
                    <Field label="Price"><NumberInput value={l.unit_price} onChange={(v) => setLine(i, { unit_price: v })} /></Field>
                    <div className="field"><label>Amount</label><div className="amount num">{money(amount)}</div></div>
                    <button className="btn btn-ghost" aria-label="Remove" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [blankLine()]))}><Trash2 size={20} /></button>
                  </div>
                  {l.item_id && (
                    <div className="row small" style={{ padding: '6px 4px', gap: 8 }}>
                      {l.kind === 'raw' && <Badge tone="info">Raw material · from {l.container || 'tank'}</Badge>}
                      <span className="muted">In stock: <b>{qty(l.stock, l.unit)}</b></span>
                      {can('manager') && Number(l.qty) > 0 && !short && (() => {
                        const c = estCost(l), pr = amount - c;
                        return (
                          <span className="muted no-print">· Cost ≈ <b className="num">{money(c)}</b> · {pr >= 0 ? 'Profit' : 'Loss'}{' '}
                            <b className="num" style={{ color: pr >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{money(pr)}</b>{amount > 0 && ` (${pctOf(pr, amount)})`}</span>
                        );
                      })()}
                      {can('manager') && Number(l.unit_price) > 0 && Number(l.qty) > 0 && !short && estCost(l) / Number(l.qty) > Number(l.unit_price) + 0.005 && <Badge tone="warn">Price is below cost</Badge>}
                      {short && <Badge tone="danger">Not enough stock</Badge>}
                      {l.lots && l.lots.length > 1 && (
                        <label className="row" style={{ gap: 6 }}>
                          <span className="muted">Batch:</span>
                          <select className="input" style={{ minHeight: 40, padding: '4px 8px', width: 'auto', fontSize: '.92rem' }} value={l.lot_id} onChange={(e) => setLine(i, { lot_id: e.target.value })}>
                            <option value="">Oldest first (automatic)</option>
                            {l.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.lot_code} — {qty(lot.qty_remaining)} left</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus size={20} /> Add another item</button>
        </div>

        <div className="card">
          <div className="grid grid-2">
            <div className="stack">
              <h2>Payment</h2>
              <div className="choice">
                <button className={`btn ${payMode === 'cash' ? 'on' : ''}`} onClick={() => setPayMode('cash')}>Paid in full</button>
                <button className={`btn ${payMode === 'credit' ? 'on' : ''}`} onClick={() => setPayMode('credit')}>Credit — pay later</button>
                <button className={`btn ${payMode === 'part' ? 'on' : ''}`} onClick={() => setPayMode('part')}>Part payment</button>
              </div>
              {payMode === 'part' && <Field label="Amount received now"><NumberInput className="big" value={paidPart} onChange={setPaidPart} /></Field>}
              {paid > 0 && <PaymentPicker value={pay} onChange={setPay} funds={funds} direction="in" amount={paid} />}
              <Field label="Notes"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional (vehicle no., delivery note…)" /></Field>
            </div>
            <div className="totals">
              <div className="t-row"><span>Subtotal</span><b className="num">{money(subtotal)}</b></div>
              <div className="t-row"><span>Discount</span><NumberInput style={{ maxWidth: 170 }} value={discount} onChange={setDiscount} /></div>
              <div className="t-row grand"><span>Total</span><span className="num">{money(total)}</span></div>
              <div className="t-row"><span>Received now</span><b className="num">{money(paid)}</b></div>
              <div className="t-row"><span>Goes to customer account</span><b className="num" style={{ color: total - paid > 0 ? 'var(--danger)' : undefined }}>{money(total - paid)}</b></div>
              {can('manager') && total > 0 && over.length === 0 && (() => {
                const cost = lines.filter((l) => l.item_id).reduce((s, l) => s + estCost(l), 0);
                const pr = total - cost;
                return (
                  <div className="profit-box no-print">
                    <div className="pb-title"><Lock size={14} /> Only for you · not printed</div>
                    <div className="t-row"><span>Cost of goods ≈</span><span className="num">{money(cost)}</span></div>
                    <div className="t-row pb-main"><span>{pr >= 0 ? 'Your profit' : 'Your loss'}</span>
                      <b className="num" style={{ color: pr >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{money(pr)} <span className="pb-pct">{pctOf(pr, total)}</span></b></div>
                  </div>
                );
              })()}
            </div>
          </div>
          {over.length > 0 && <div style={{ marginTop: 14 }}><Alert type="danger">Some items do not have enough stock. Reduce the quantity, or make or buy more first.</Alert></div>}
          {paid > total && <div style={{ marginTop: 14 }}><Alert type="danger">Received amount is more than the total.</Alert></div>}
          <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 18 }} disabled={!valid || busy} onClick={save}><Save size={22} /> Save invoice</button>
          {!can('manager') && <div className="small muted center" style={{ marginTop: 8 }}>Only a manager can cancel an invoice after saving.</div>}
        </div>
      </div>
      {newCust && <QuickParty type="customer" onClose={() => setNewCust(false)} onSaved={(id) => { setNewCust(false); custQ.reload(); setCustomer(id); }} />}
    </>
  );
}

export function QuickParty({ type, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', phone: '', address: '', opening_balance: '' });
  const [run, busy] = useAction();
  const save = () => run(() => api.post('/parties', { ...f, type }), 'Saved').then((r) => r && onSaved(r.id));
  return (
    <Modal title={type === 'customer' ? 'New customer' : 'New supplier'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.name || busy} onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Name"><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Old balance (optional)" help={type === 'customer' ? 'Amount this customer already owes you' : 'Amount you already owe this supplier'}>
          <NumberInput value={f.opening_balance} onChange={(v) => setF({ ...f, opening_balance: v })} />
        </Field>
      </div>
    </Modal>
  );
}

export function Invoice() {
  const { id } = useParams();
  const q = useFetch(`/sales/${id}`);
  const money = useMoney();
  const { can } = useApp();
  const [cancel, setCancel] = useState(false);
  const [ret, setRet] = useState(false);
  const [run, busy] = useAction();
  const nav = useNavigate();

  return (
    <Async q={q}>{(s) => {
      const canReturn = can('manager') && s.status !== 'cancelled' && s.items.some((it) => it.returnable_qty > 0);
      const c = s.company;
      const due = Math.max(0, s.total - s.paid);
      const type = payLabel(s.total, s.paid);
      const waText = encodeURIComponent(`${c.company_name}\nInvoice ${s.invoice_no} (${fmtDate(s.date)})\nTotal: ${money(s.total)}\nPaid: ${money(s.paid)}\nBalance on this bill: ${money(due)}\nYour total balance: ${money(s.customer_balance)}\n${c.invoice_footer || ''}`);
      const waPhone = (s.customer_phone || '').replace(/\D/g, '').replace(/^0/, '92');
      return (
        <>
          <PageHead back="/sales" title={`Invoice ${s.invoice_no}`}
            actions={<>
              <button className="btn btn-primary btn-lg ro-ok" onClick={() => window.print()}><Printer size={22} /> Print / Save PDF</button>
              {s.customer_phone && <a className="btn ro-ok" href={`https://wa.me/${waPhone}?text=${waText}`} target="_blank" rel="noreferrer"><MessageCircle size={20} /> WhatsApp</a>}
              {canReturn && <button className="btn" onClick={() => setRet(true)}><Undo2 size={18} /> Return items</button>}
              {can('manager') && s.status !== 'cancelled' && <button className="btn btn-ghost" onClick={() => setCancel(true)}><Ban size={18} /> Cancel invoice</button>}
            </>} />
          {s.status === 'cancelled' && <div className="no-print" style={{ marginBottom: 16 }}><Alert type="danger">This invoice was cancelled. Stock was returned and the customer account was reversed.</Alert></div>}
          {s.profit && s.status !== 'cancelled' && <InvoiceProfit p={s.profit} money={money} />}
          <InvoiceReturns sale={s} money={money} />

          <div className="doc">
            <div className="doc-head">
              <div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{c.company_name}</div>
                <div className="muted">{c.company_address}</div>
                {c.company_phone && <div className="muted">Phone: {c.company_phone}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="doc-title">INVOICE</div>
                <div><b>No:</b> <span className="mono">{s.invoice_no}</span></div>
                <div><b>Date:</b> {fmtDate(s.date)}</div>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="small muted" style={{ textTransform: 'uppercase', fontWeight: 700 }}>Bill to</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{s.customer_name}</div>
                {s.customer_address && <div className="muted">{s.customer_address}</div>}
                {s.customer_phone && <div className="muted">{s.customer_phone}</div>}
              </div>
              <div className="stamp" style={{ color: s.status === 'cancelled' ? 'var(--danger)' : type === 'Cash' ? 'var(--ok)' : type === 'Credit' ? 'var(--info)' : 'var(--warn)' }}>
                {s.status === 'cancelled' ? 'CANCELLED' : type === 'Cash' ? 'PAID' : type === 'Credit' ? 'CREDIT' : 'PART PAID'}
              </div>
            </div>
            <div className="doc-table"><table>
              <thead><tr><th>#</th><th>Item</th><th>Batch</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr></thead>
              <tbody>{s.items.map((it, i) => (
                <tr key={it.id}>
                  <td>{i + 1}</td><td><b>{it.name}</b>{it.returned_qty > 0 && <div className="small no-print" style={{ color: 'var(--info)' }}><Undo2 size={12} /> {qty(it.returned_qty, it.unit)} returned</div>}</td>
                  <td className={`small ${it.kind === 'raw' ? 'muted' : 'mono'}`}>{it.kind === 'raw' ? (it.container || 'Tank') : it.batches.map((b) => b.lot_code).join(', ')}</td>
                  <td className="right num">{qty(it.qty, it.unit)}</td><td className="right num">{money(it.unit_price)}</td><td className="right num">{money(it.amount)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="totals">
              <div className="t-row"><span>Subtotal</span><span className="num">{money(s.subtotal)}</span></div>
              {s.discount > 0 && <div className="t-row"><span>Discount</span><span className="num">− {money(s.discount)}</span></div>}
              <div className="t-row grand"><span>Total</span><span className="num">{money(s.total)}</span></div>
              <div className="t-row"><span>Paid</span><span className="num">{money(s.paid)}</span></div>
              {(s.payments || []).filter((f) => f.direction === 'in' && !f.reverses_id).map((f) => (
                <div key={f.id} className="t-row small"><span><MethodBadge method={f.method} chequeNo={f.cheque_no} status={f.cheque_status} small />{f.bank_name ? ` ${f.bank_name}` : ''}{f.reference ? ` · Ref ${f.reference}` : ''}</span><span className="num muted">{money(f.amount)} → {f.account_name}</span></div>
              ))}
              <div className="t-row"><b>Balance on this invoice</b><b className="num">{money(due)}</b></div>
              <div className="t-row muted"><span>Customer total balance</span><span className="num">{money(s.customer_balance)}</span></div>
            </div>
            {s.notes && <p><b>Notes:</b> {s.notes}</p>}
            <div className="foot">
              <div>{c.invoice_footer}<div className="small">Prepared by {s.created_by_name || '—'}</div></div>
              <div className="sign">Authorised signature</div>
            </div>
          </div>
          {cancel && <Confirm title="Cancel this invoice?" danger busy={busy} confirmLabel="Yes, cancel invoice"
            message="Stock will go back into its batches and the customer's account will be reversed. Any cash received on this invoice will be shown as refunded."
            onClose={() => setCancel(false)} onConfirm={() => run(() => api.post(`/sales/${s.id}/cancel`), 'Invoice cancelled').then(() => { setCancel(false); q.reload(); })} />}
          {ret && <ReturnModal sale={s} onClose={() => setRet(false)} onSaved={(r) => { setRet(false); nav(`/returns/${r.id}`); }} />}
        </>
      );
    }}</Async>
  );
}

/** Profit on a saved invoice: for the owner on screen only (class no-print, never on the customer's copy). */
function InvoiceProfit({ p, money }) {
  const [open, setOpen] = useState(false);
  const good = p.profit >= 0;
  return (
    <div className="profit-strip no-print">
      <div className="ps-main">
        <span className="pb-title"><Lock size={14} /> Profit on this invoice · only for you, not printed</span>
        <span className="ps-figs">
          <span>{p.returned > 0 ? 'Sale after returns' : 'Sale'} <b className="num">{money(p.revenue)}</b></span>
          <span>Cost <b className="num">{money(p.cost)}</b></span>
          <span>{good ? 'Profit' : 'Loss'} <b className="num" style={{ color: good ? 'var(--ok)' : 'var(--danger)' }}>{money(p.profit)}</b></span>
          <span className={`badge ${good ? 'badge-ok' : 'badge-danger'}`}>{p.margin_pct === null ? '—' : `${p.margin_pct}%`} margin</span>
        </span>
        {p.lines.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>{open ? 'Hide' : 'Per item'}</button>}
      </div>
      {open && (
        <div className="ps-lines">
          {p.lines.map((l) => (
            <div key={l.id} className="row" style={{ gap: 10 }}>
              <span style={{ flex: 1, minWidth: 120 }}>{l.name}</span>
              <span className="muted small num">sale {money(l.revenue)} · cost {money(l.cost)}</span>
              <b className="num" style={{ color: l.profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{money(l.profit)}</b>
              <span className="muted small num" style={{ minWidth: 52, textAlign: 'right' }}>{l.margin_pct === null ? '—' : `${l.margin_pct}%`}</span>
            </div>
          ))}
          {p.discount > 0 && <div className="small muted">Invoice discount of {money(p.discount)} is taken off the total profit.</div>}
          {p.returned > 0 && <div className="small muted">Returned goods are taken off. Damaged returns stay in the cost as a loss.</div>}
        </div>
      )}
    </div>
  );
}
