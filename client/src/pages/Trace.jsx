import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Building2, Droplets, Factory, Users, Printer, Package, Receipt, Truck } from 'lucide-react';
import { useFetch, useMoney, useApp, api, qty, fmtDate } from '../lib.jsx';
import { PageHead, Async, Badge, Empty, Stat, Alert, SearchBox } from '../components.jsx';

export function TraceSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState([]);
  const recent = useFetch('/production');
  const nav = useNavigate();
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(() => api.get(`/trace/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => setRes([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const ICON = { batch: Package, invoice: Receipt, purchase: Truck };
  return (
    <>
      <PageHead title="Product History" sub="Type a batch number (printed on the carton), invoice number or supplier to see the full story." />
      <div className="card">
        <SearchBox value={q} onChange={setQ} placeholder="e.g. B2611-001, INV-00012, Karachi Oil…" />
        {res.length > 0 && (
          <div className="stack" style={{ gap: 0, marginTop: 12 }}>
            {res.map((r) => { const I = ICON[r.kind]; return (
              <Link key={`${r.kind}${r.id}`} to={r.link} className="row" style={{ padding: '12px 4px', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
                <I size={22} /><div style={{ flex: 1 }}><b className="mono">{r.title}</b><div className="small muted">{r.sub}</div></div>
                <Badge tone="gray">{r.kind}</Badge>
              </Link>
            ); })}
          </div>
        )}
        {q.trim().length >= 2 && res.length === 0 && <Empty>No match</Empty>}
      </div>
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Recent batches</h2>
        <Async q={recent}>{(rows) => rows.length === 0 ? <Empty>No batches yet</Empty> : (
          <div className="grid grid-3">
            {rows.filter((b) => b.status === 'active').slice(0, 9).map((b) => (
              <button key={b.id} className="btn" style={{ minHeight: 72, flexDirection: 'column', alignItems: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => nav(`/trace/lot/${b.lot_id}`)}>
                <span className="mono">{b.batch_no}</span><span className="small muted" style={{ fontWeight: 600 }}>{b.product_name} · {fmtDate(b.date)}</span>
              </button>
            ))}
          </div>
        )}</Async>
      </div>
    </>
  );
}

/** Deep-linkable full history of one batch: /trace/lot/:id */
export function LotTrace() {
  const { id } = useParams();
  const q = useFetch(`/trace/lot/${id}`);
  const money = useMoney();
  const { can } = useApp();
  const showMoney = can('manager');

  return (
    <Async q={q}>{(t) => {
      const { lot, batch, summary } = t;
      const made = t.origin === 'production';
      const supplierCount = made ? t.suppliers.length : t.purchase ? 1 : 0;
      return (
        <>
          <PageHead back={lot.kind === 'finished' ? '/production' : `/stock/${lot.item_id}`}
            title={<>Batch <span className="mono">{lot.lot_code}</span></>}
            sub={<><Link to={`/stock/${lot.item_id}`}>{lot.item_name}</Link> · {made ? `Made on ${fmtDate(lot.date)}` : t.origin === 'purchase' ? `Bought on ${fmtDate(lot.date)}` : `Opening stock ${fmtDate(lot.date)}`}</>}
            actions={<button className="btn ro-ok" onClick={() => window.print()}><Printer size={20} /> Print history</button>} />
          {batch?.status === 'cancelled' && <div style={{ marginBottom: 16 }}><Alert type="danger">This batch was cancelled. Its materials were returned to the tanks.</Alert></div>}

          <div className="trace-flow">
            <div className="trace-step"><div className="ic"><Building2 size={20} /></div><div className="n">{supplierCount}</div><div className="l">Supplier{supplierCount === 1 ? '' : 's'}</div></div>
            <div className="trace-step"><div className="ic"><Droplets size={20} /></div><div className="n">{made ? t.materials.length : '—'}</div><div className="l">Raw materials</div></div>
            <div className="trace-step"><div className="ic"><Factory size={20} /></div><div className="n">{qty(summary.qty_in)}</div><div className="l">{lot.unit} {made ? 'made' : 'bought'}</div></div>
            <div className="trace-step"><div className="ic"><Users size={20} /></div><div className="n">{summary.customers}</div><div className="l">Customer{summary.customers === 1 ? '' : 's'}</div></div>
          </div>

          {/* 1. Batch facts */}
          <div className="card">
            <div className="section-title"><span className="dot" style={{ background: '#ea580c' }}><Factory size={18} /></span><h2>{made ? 'Manufacturing batch' : 'Where this stock came from'}</h2></div>
            {made && (
              <div className="grid grid-4">
                <Stat label="Batch ID" value={<span className="mono" style={{ fontSize: '1.2rem' }}>{batch.batch_no}</span>} hint={batch.recipe_name} />
                <Stat label="Production date" value={<span style={{ fontSize: '1.2rem' }}>{fmtDate(batch.date)}</span>} hint={batch.made_by ? `Entered by ${batch.made_by}` : undefined} />
                <Stat label="Quantity produced" value={qty(batch.qty_produced, lot.unit)} hint={`${batch.runs} mix${batch.runs === 1 ? '' : 'es'}`} />
                <Stat label="Still in stock" value={qty(summary.remaining, lot.unit)} hint={`${qty(summary.sold)} sold`} />
              </div>
            )}
            {made && showMoney && (
              <div className="grid grid-4" style={{ marginTop: 16 }}>
                <Stat label="Material cost" value={money(batch.material_cost)} />
                <Stat label="Labour / power" value={money(batch.other_cost)} />
                <Stat label="Total batch cost" value={money(batch.total_cost)} />
                <Stat label="Cost per unit" value={money(batch.unit_cost)} />
              </div>
            )}
            {t.origin === 'purchase' && t.purchase && (
              <div className="grid grid-3">
                <Stat label="Supplier" value={<span style={{ fontSize: '1.15rem' }}>{t.purchase.supplier_name}</span>} to={showMoney ? `/parties/${t.purchase.supplier_id}` : undefined} />
                <Stat label="Purchase" value={<span className="mono" style={{ fontSize: '1.15rem' }}>{t.purchase.purchase_no}</span>} hint={`${fmtDate(t.purchase.date)}${t.purchase.supplier_bill_no ? ` · Bill ${t.purchase.supplier_bill_no}` : ''}`} to={showMoney ? `/purchases/${t.purchase.id}` : undefined} />
                <Stat label="Quantity" value={qty(t.purchase.qty, lot.unit)} hint={showMoney ? `@ ${money(t.purchase.unit_cost)}` : undefined} />
              </div>
            )}
            {t.origin === 'opening' && <Alert>This was opening stock entered when the system was set up.</Alert>}
            {batch?.notes && <p className="muted" style={{ marginBottom: 0 }}><b>Notes:</b> {batch.notes}</p>}
          </div>

          {/* 2. Raw materials & suppliers */}
          {made && (
            <div className="card">
              <div className="section-title"><span className="dot" style={{ background: '#a16207' }}><Droplets size={18} /></span><h2>Raw materials used &amp; their suppliers</h2></div>
              <div className="small muted" style={{ marginBottom: 12 }}>
                Cost is the <b>weighted average</b> in the tank on production day. Supplier shares are estimated from the tank mix (each delivery’s portion of the tank at that moment).
              </div>
              {t.materials.map((m) => (
                <div key={m.id} className="material">
                  <div className="row">
                    <div style={{ flex: 1 }}><Link to={`/stock/${m.item_id}`}><b style={{ fontSize: '1.05rem' }}>{m.name}</b></Link>{m.container && <span className="muted small"> · {m.container}</span>}</div>
                    <b className="num">{qty(m.qty, m.unit)}</b>
                    {showMoney && <span className="num muted">@ {money(m.avg_cost)}</span>}
                    {showMoney && <b className="num" style={{ minWidth: 110, textAlign: 'right' }}>{money(m.amount)}</b>}
                  </div>
                  {m.sources.length > 0 ? (
                    <div className="sources">
                      {m.sources.map((s, i) => (
                        <div key={i} className="source">
                          <span><b>{s.supplier_name || (s.receipt_type === 'opening' ? 'Opening stock' : 'Returned stock')}</b>
                            <div className="small muted">{s.purchase_no ? (showMoney ? <Link to={`/purchases/${s.purchase_id}`}>{s.purchase_no}</Link> : s.purchase_no) : '—'} · received {fmtDate(s.received_date)}</div></span>
                          <span className="small">{showMoney && s.purchase_rate !== undefined ? <>bought @ {money(s.purchase_rate)}</> : null}</span>
                          <span className="num right">≈ {qty(s.qty, m.unit)}</span>
                          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><span className="share-bar" style={{ flex: 1 }}><span style={{ width: `${s.share_pct}%` }} /></span><b className="num small">{Math.round(s.share_pct)}%</b></span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="small muted" style={{ marginTop: 6 }}>No supplier record (opening stock).</div>}
                </div>
              ))}
              {showMoney && (
                <div className="totals" style={{ marginTop: 14 }}>
                  <div className="t-row grand"><span>Total material cost</span><span className="num">{money(batch.material_cost)}</span></div>
                </div>
              )}
            </div>
          )}

          {/* 3. Sales distribution */}
          <div className="card">
            <div className="section-title"><span className="dot" style={{ background: '#1d4ed8' }}><Users size={18} /></span><h2>Who bought from this batch</h2></div>
            {t.sales.length === 0 ? <Empty icon={Users}>Nothing sold from this batch yet.</Empty> : (
              <div className="table-wrap"><table className="table responsive">
                <thead><tr><th>Customer</th><th>Invoice</th><th>Date</th><th className="right">Qty</th>{showMoney && <th className="right">Price</th>}{showMoney && <th className="right">Amount</th>}<th>Payment</th></tr></thead>
                <tbody>{t.sales.map((s, i) => (
                  <tr key={i} className={s.status === 'cancelled' ? 'cancelled' : ''}>
                    <td><b>{s.customer_name}</b></td>
                    <td data-label="Invoice"><Link to={`/sales/${s.sale_id}`} className="mono">{s.invoice_no}</Link></td>
                    <td data-label="Date">{fmtDate(s.date)}</td>
                    <td data-label="Qty" className="right num"><b>{qty(s.qty, lot.unit)}</b>{s.returned_qty > 0 && <div className="small" style={{ color: 'var(--info)' }}>{qty(s.returned_qty)} returned</div>}</td>
                    {showMoney && <td data-label="Price" className="right num">{money(s.unit_price)}</td>}
                    {showMoney && <td data-label="Amount" className="right num">{money(s.amount)}</td>}
                    <td data-label="Payment">{s.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <Badge tone={s.payment === 'Cash' ? 'ok' : s.payment === 'Credit' ? 'info' : 'warn'}>{s.payment}</Badge>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {showMoney && summary.sold > 0 && (
              <div className="grid grid-3" style={{ marginTop: 16 }}>
                <Stat label="Sales from this batch" value={money(summary.revenue)} />
                <Stat label="Cost of units sold" value={money(summary.cost_of_sold)} />
                <Stat label="Profit on this batch" value={money(summary.profit)} tone={summary.profit >= 0 ? 'good' : 'bad'} />
              </div>
            )}
          </div>
        </>
      );
    }}</Async>
  );
}

