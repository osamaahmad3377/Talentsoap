// Sales returns: return form (from an invoice), printable credit note, list
import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Printer, Ban, Undo2, Lock, PackageCheck, PackageX, FileText } from 'lucide-react';
import { PaymentPicker, MethodBadge, emptyPayment, paymentBody, useFunds } from '../payment.jsx';
import { useFetch, useMoney, useApp, useAction, api, qty, fmtDate, today, thisMonth } from '../lib.jsx';
import { PageHead, Async, DataTable, Badge, Field, NumberInput, Alert, Modal, Confirm, Stat } from '../components.jsx';
import { MonthNav } from './Sales.jsx';

/** "Return items" form opened from an invoice. */
export function ReturnModal({ sale, onClose, onSaved }) {
  const money = useMoney();
  const funds = useFunds();
  const [run, busy] = useAction();
  const open = sale.items.filter((it) => it.returnable_qty > 0);
  const [lines, setLines] = useState(() => Object.fromEntries(open.map((it) => [it.id, { qty: '', restock: true }])));
  const [date, setDate] = useState(today() < sale.date ? sale.date : today());
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState('account');
  const [refund, setRefund] = useState('');
  const [pay, setPay] = useState(emptyPayment);

  const set = (id, patch) => setLines((ls) => ({ ...ls, [id]: { ...ls[id], ...patch } }));
  const chosen = open.filter((it) => Number(lines[it.id].qty) > 0);
  const tooMany = open.filter((it) => Number(lines[it.id].qty) > it.returnable_qty + 1e-9);
  const subtotal = chosen.reduce((s, it) => s + Number(lines[it.id].qty) * it.unit_price, 0);
  const discount = sale.discount > 0 && sale.subtotal > 0 ? subtotal * (sale.discount / sale.subtotal) : 0;
  const credit = Math.max(0, subtotal - discount);
  const refundAmt = mode === 'cash' ? (refund === '' ? credit : Number(refund) || 0) : 0;
  const valid = chosen.length > 0 && tooMany.length === 0 && refundAmt <= credit + 0.005;

  const save = () => run(() => api.post(`/sales/${sale.id}/returns`, {
    date, reason, refund: refundAmt, ...(refundAmt > 0 ? paymentBody(pay) : {}),
    items: chosen.map((it) => ({ sale_item_id: it.id, qty: lines[it.id].qty, restock: lines[it.id].restock })),
  }), 'Return saved').then((r) => r && onSaved(r));

  return (
    <Modal wide title={`Return items · ${sale.invoice_no}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} onClick={save}><Undo2 size={18} /> Save return</button>
      </>}>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Enter how many of each item {sale.customer_name} brought back.</span>
          <button className="btn btn-sm" onClick={() => setLines((ls) => Object.fromEntries(open.map((it) => [it.id, { ...ls[it.id], qty: String(it.returnable_qty) }])))}>Return everything</button>
        </div>

        <div className="ret-lines">
          {open.map((it) => {
            const l = lines[it.id];
            const over = Number(l.qty) > it.returnable_qty + 1e-9;
            return (
              <div key={it.id} className={`ret-line ${Number(l.qty) > 0 ? 'on' : ''}`}>
                <div className="ret-name">
                  <b>{it.name}</b>
                  <div className="small muted">
                    Sold {qty(it.qty, it.unit)} @ {money(it.unit_price)}
                    {it.returned_qty > 0 && <> · already returned {qty(it.returned_qty)}</>}
                    {' · '}<b>can return {qty(it.returnable_qty, it.unit)}</b>
                  </div>
                </div>
                <Field label={`Qty returned ${it.unit}`}>
                  <NumberInput value={l.qty} onChange={(v) => set(it.id, { qty: v })} style={over ? { borderColor: 'var(--danger)' } : undefined} aria-label={`Quantity of ${it.name} returned`} />
                </Field>
                <div className="field">
                  <label>Condition</label>
                  <div className="choice seg ret-cond" role="radiogroup" aria-label={`Condition of ${it.name}`}>
                    <button type="button" role="radio" aria-checked={l.restock} className={`btn btn-sm ${l.restock ? 'on' : ''}`} onClick={() => set(it.id, { restock: true })}><PackageCheck size={16} /> Back to stock</button>
                    <button type="button" role="radio" aria-checked={!l.restock} className={`btn btn-sm ${!l.restock ? 'on danger' : ''}`} onClick={() => set(it.id, { restock: false })}><PackageX size={16} /> Damaged</button>
                  </div>
                </div>
                {over && <div className="ret-msg"><Badge tone="danger">Only {qty(it.returnable_qty, it.unit)} can be returned</Badge></div>}
                {Number(l.qty) > 0 && !over && (
                  <div className="ret-msg small muted">
                    {l.restock
                      ? (it.kind === 'raw' ? `Goes back into ${it.container || 'the tank'}.` : `Goes back into batch ${it.batches.map((b) => b.lot_code).join(', ')}.`)
                      : 'Will not be added to stock — counted as a loss (damaged stock).'}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid grid-2">
          <div className="stack">
            <Field label="Return date"><input className="input" type="date" value={date} min={sale.date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Reason (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged in transport, wrong item, expired" /></Field>
          </div>
          <div className="totals">
            <div className="t-row"><span>Value of returned items</span><b className="num">{money(subtotal)}</b></div>
            {discount > 0.004 && <div className="t-row"><span>Less invoice discount share</span><span className="num">− {money(discount)}</span></div>}
            <div className="t-row grand"><span>Credit to customer</span><span className="num">{money(credit)}</span></div>
          </div>
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <div className="label" style={{ fontWeight: 700 }}>What happens to the money?</div>
          <div className="choice">
            <button className={`btn ${mode === 'account' ? 'on' : ''}`} onClick={() => setMode('account')}>Reduce the customer's balance</button>
            <button className={`btn ${mode === 'cash' ? 'on' : ''}`} onClick={() => setMode('cash')}>Pay the money back now</button>
          </div>
          {mode === 'account'
            ? <div className="small muted">{money(credit)} comes off what {sale.customer_name} owes (or stays as their advance for the next bill).</div>
            : (
              <>
                <Field label="Amount paid back"><NumberInput value={refund === '' ? (credit ? String(Math.round(credit * 100) / 100) : '') : refund} onChange={setRefund} /></Field>
                {refundAmt > credit + 0.005 && <Alert type="danger">Cannot pay back more than the credit ({money(credit)}).</Alert>}
                {refundAmt > 0 && <PaymentPicker value={pay} onChange={setPay} funds={funds} direction="out" amount={refundAmt} label="How is it paid back?" />}
              </>
            )}
        </div>
        {tooMany.length > 0 && <Alert type="danger">Some quantities are more than what can still be returned on this invoice.</Alert>}
      </div>
    </Modal>
  );
}

/** Returns booked against an invoice — shown on the invoice screen, never printed on it. */
export function InvoiceReturns({ sale, money }) {
  if (!sale.returns?.length) return null;
  return (
    <div className="card no-print returns-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Undo2 size={20} /> Returns on this invoice</h2>
        {sale.returned_total > 0 && <span className="muted">Returned <b className="num">{money(sale.returned_total)}</b> · net sale <b className="num">{money(sale.total - sale.returned_total)}</b></span>}
      </div>
      <div className="table-wrap"><table className="table responsive">
        <thead><tr><th>Return</th><th>Date</th><th>Reason</th><th className="right">Credit</th><th className="right">Paid back</th></tr></thead>
        <tbody>{sale.returns.map((x) => (
          <tr key={x.id} className={x.status === 'cancelled' ? 'cancelled' : ''}>
            <td><Link to={`/returns/${x.id}`} className="mono"><b>{x.return_no}</b></Link>{x.status === 'cancelled' && <> <Badge tone="danger">Cancelled</Badge></>}</td>
            <td data-label="Date">{fmtDate(x.date)}</td>
            <td data-label="Reason" className="muted">{x.reason || '—'}</td>
            <td data-label="Credit" className="right num"><b>{money(x.total)}</b></td>
            <td data-label="Paid back" className="right num">{x.refund > 0 ? money(x.refund) : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

/** Printable credit note for one return. */
export function CreditNote() {
  const { id } = useParams();
  const q = useFetch(`/returns/${id}`);
  const money = useMoney();
  const { can } = useApp();
  const [cancel, setCancel] = useState(false);
  const [run, busy] = useAction();
  return (
    <Async q={q}>{(r) => {
      const c = r.company;
      const refunds = (r.payments || []).filter((f) => f.direction === 'out' && !f.reverses_id);
      return (
        <>
          <PageHead back={`/sales/${r.sale_id}`} title={`Return ${r.return_no}`}
            actions={<>
              <button className="btn btn-primary btn-lg ro-ok" onClick={() => window.print()}><Printer size={22} /> Print / Save PDF</button>
              <Link className="btn ro-ok" to={`/sales/${r.sale_id}`}><FileText size={18} /> Invoice {r.invoice_no}</Link>
              {can('manager') && r.status !== 'cancelled' && <button className="btn btn-ghost" onClick={() => setCancel(true)}><Ban size={18} /> Cancel return</button>}
            </>} />
          {r.status === 'cancelled' && <div className="no-print" style={{ marginBottom: 16 }}><Alert type="danger">This return was cancelled. The goods left stock again and the customer's account was reversed.</Alert></div>}
          {can('manager') && r.status !== 'cancelled' && r.cost_restocked !== undefined && (
            <div className="profit-strip no-print">
              <div className="ps-main">
                <span className="pb-title"><Lock size={14} /> Stock effect · only for you, not printed</span>
                <span className="ps-figs">
                  <span>Back into stock at cost <b className="num">{money(r.cost_restocked)}</b></span>
                  {r.cost_damaged > 0 && <span>Damaged, written off <b className="num" style={{ color: 'var(--danger)' }}>{money(r.cost_damaged)}</b></span>}
                </span>
              </div>
            </div>
          )}

          <div className="doc">
            <div className="doc-head">
              <div>
                <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{c.company_name}</div>
                <div className="muted">{c.company_address}</div>
                {c.company_phone && <div className="muted">Phone: {c.company_phone}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="doc-title">CREDIT NOTE</div>
                <div className="small muted" style={{ marginTop: -4, marginBottom: 4 }}>Sales return</div>
                <div><b>No:</b> <span className="mono">{r.return_no}</span></div>
                <div><b>Date:</b> {fmtDate(r.date)}</div>
                <div><b>Against invoice:</b> <span className="mono">{r.invoice_no}</span> ({fmtDate(r.invoice_date)})</div>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="small muted" style={{ textTransform: 'uppercase', fontWeight: 700 }}>Customer</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>{r.customer_name}</div>
                {r.customer_address && <div className="muted">{r.customer_address}</div>}
                {r.customer_phone && <div className="muted">{r.customer_phone}</div>}
              </div>
              <div className="stamp" style={{ color: r.status === 'cancelled' ? 'var(--danger)' : 'var(--info)' }}>{r.status === 'cancelled' ? 'CANCELLED' : 'RETURNED'}</div>
            </div>
            <div className="doc-table"><table>
              <thead><tr><th>#</th><th>Item</th><th>Batch</th><th>Condition</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th></tr></thead>
              <tbody>{r.items.map((it, i) => (
                <tr key={it.id}>
                  <td>{i + 1}</td><td><b>{it.name}</b></td>
                  <td className={`small ${it.kind === 'raw' ? 'muted' : 'mono'}`}>{it.kind === 'raw' ? (it.container || 'Tank') : it.batches.map((b) => b.lot_code).join(', ')}</td>
                  <td className="small">{it.restock ? 'Good' : 'Damaged'}</td>
                  <td className="right num">{qty(it.qty, it.unit)}</td><td className="right num">{money(it.unit_price)}</td><td className="right num">{money(it.amount)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="totals">
              <div className="t-row"><span>Value of returned items</span><span className="num">{money(r.subtotal)}</span></div>
              {r.discount > 0 && <div className="t-row"><span>Less invoice discount</span><span className="num">− {money(r.discount)}</span></div>}
              <div className="t-row grand"><span>Credit to customer</span><span className="num">{money(r.total)}</span></div>
              {r.refund > 0 && <div className="t-row"><span>Paid back</span><span className="num">{money(r.refund)}</span></div>}
              {refunds.map((f) => (
                <div key={f.id} className="t-row small"><span><MethodBadge method={f.method} chequeNo={f.cheque_no} small />{f.reference ? ` · Ref ${f.reference}` : ''}</span><span className="num muted">{money(f.amount)} from {f.account_name}</span></div>
              ))}
              {r.total - r.refund > 0.005 && <div className="t-row"><span>Adjusted in customer account</span><span className="num">{money(r.total - r.refund)}</span></div>}
              <div className="t-row muted"><span>Customer total balance</span><span className="num">{money(r.customer_balance)}</span></div>
            </div>
            {r.reason && <p><b>Reason:</b> {r.reason}</p>}
            <div className="foot">
              <div>{c.invoice_footer}<div className="small">Prepared by {r.created_by_name || '—'}</div></div>
              <div className="sign">Authorised signature</div>
            </div>
          </div>
          {cancel && <Confirm title="Cancel this return?" danger busy={busy} confirmLabel="Yes, cancel return"
            message="The returned goods will leave stock again and the customer's account will go back to what it was. Any money paid back will be shown as received again."
            onClose={() => setCancel(false)} onConfirm={() => run(() => api.post(`/returns/${r.id}/cancel`), 'Return cancelled').then(() => { setCancel(false); q.reload(); })} />}
        </>
      );
    }}</Async>
  );
}

/** All returns, month by month. */
export function ReturnsList() {
  const [month, setMonth] = useState(thisMonth());
  const q = useFetch(`/returns?month=${month}`);
  const money = useMoney();
  const nav = useNavigate();
  return (
    <>
      <PageHead back="/sales" title="Sales returns" sub="Goods customers brought back. To book a return, open the invoice and tap “Return items”." />
      <div className="card no-print"><MonthNav month={month} setMonth={setMonth} /></div>
      <Async q={q}>{({ rows, summary }) => (
        <>
          <div className="grid grid-3" style={{ marginTop: 18 }}>
            <Stat label="Returns" value={summary.count} />
            <Stat label="Credited to customers" value={money(summary.total)} />
            <Stat label="Money paid back" value={money(summary.refunded)} />
          </div>
          <div className="card">
            <DataTable rows={rows} searchKeys={['return_no', 'invoice_no', 'customer_name', 'reason']} placeholder="Search return, invoice or customer…"
              onRow={(x) => nav(`/returns/${x.id}`)} rowClass={(x) => (x.status === 'cancelled' ? 'cancelled' : '')} empty="No returns in this month."
              columns={[
                { key: 'return_no', label: 'Return', render: (x) => <div><b className="mono">{x.return_no}</b><div className="small muted">{x.customer_name}</div></div> },
                { key: 'invoice_no', label: 'Invoice', render: (x) => <span className="mono">{x.invoice_no}</span> },
                { key: 'date', label: 'Date', render: (x) => fmtDate(x.date) },
                { key: 'reason', label: 'Reason', render: (x) => (x.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <span className="muted">{x.reason || '—'}</span>) },
                { key: 'total', label: 'Credit', className: 'right', render: (x) => <b className="num">{money(x.total)}</b> },
                { key: 'refund', label: 'Paid back', className: 'right', render: (x) => <span className="num">{x.refund > 0 ? money(x.refund) : '—'}</span> },
              ]} />
          </div>
        </>
      )}</Async>
    </>
  );
}
