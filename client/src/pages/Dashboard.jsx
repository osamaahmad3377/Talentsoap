import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShoppingCart, Factory, Truck, UserCheck, Wallet, AlertTriangle, TrendingUp, TrendingDown, Banknote, Landmark,
  Users, Building2, Boxes, ArrowDownCircle, ArrowUpCircle, Receipt, Percent, PiggyBank, ArrowUpRight, ArrowDownRight, Minus,
} from 'lucide-react';
import { ChartCard, TrendChart, RankBars, SplitBar, SERIES } from '../charts.jsx';
import { useFetch, useMoney, useApp, qty, fmtDate, int, today } from '../lib.jsx';
import { Async, Stat, Badge, Empty, PayBadge } from '../components.jsx';

export default function Dashboard() {
  const q = useFetch('/dashboard');
  const { me, can, fy } = useApp();
  const pastYear = fy && fy.state !== 'active';
  const money = useMoney();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{pastYear ? `${fy.name} at a glance` : `${greet}, ${me.full_name.split(' ')[0]}`}</h1>
          <div className="sub">{pastYear ? `Figures as on ${fmtDate(today())} — the ${fy.state === 'upcoming' ? 'first' : 'last'} day of ${fy.name}` : new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </div>
      </div>

      <nav className="quick" aria-label="Quick actions">
        <Link to="/sales/new"><span className="ico"><ShoppingCart size={28} /></span>New Sale</Link>
        {can('manager') ? <Link to="/purchases/new"><span className="ico"><Truck size={28} /></span>New Purchase</Link>
          : <Link to="/stock"><span className="ico"><Boxes size={28} /></span>Check Stock</Link>}
        <Link to="/production/new"><span className="ico"><Factory size={28} /></span>Make a Batch</Link>
        {can('manager') ? <Link to="/expenses?new=1"><span className="ico"><Receipt size={28} /></span>Add Expense</Link>
          : <Link to="/trace"><span className="ico"><Boxes size={28} /></span>Product History</Link>}
        <Link to="/staff"><span className="ico"><UserCheck size={28} /></span>Attendance</Link>
      </nav>

      <Async q={q}>{(d) => (
        <>
          {d.low_stock.length > 0 && !pastYear && (
            <div className="notice notice-warn" role="status">
              <AlertTriangle size={16} />
              <span className="notice-text"><b>{d.low_stock.length} item{d.low_stock.length > 1 ? 's' : ''} running low</b> — order soon</span>
              <div className="notice-chips">
                {d.low_stock.map((i) => (
                  <Link key={i.id} to={`/stock/${i.id}`} className="chip">{i.name} <span className="num">{qty(i.stock, i.unit)}</span></Link>
                ))}
              </div>
              <Link to="/stock" className="notice-link">View stock</Link>
            </div>
          )}

          {can('manager') && d.month && (
            <>
              <h2 className="section-title-sm">{pastYear ? `On ${fmtDate(d.today)}` : 'Today'}</h2>
              <div className="grid grid-4 kpi">
                <Stat icon={ShoppingCart} label={pastYear ? 'Sales that day' : 'Sales today'} value={money(d.sales_today.total)} hint={`${d.sales_today.count} invoice${d.sales_today.count === 1 ? '' : 's'}`} to="/sales" />
                <Stat icon={ArrowDownCircle} label="Money received" value={money(d.cash_in_today)} tone="good" to="/cash" />
                <Stat icon={ArrowUpCircle} label="Money paid out" value={money(d.cash_out_today)} hint={`Expenses: ${money(d.expenses_today)}`} to="/cash" />
                <Stat icon={Banknote} label="Cash in hand" value={money(d.cash_in_hand)} tone={d.cash_in_hand < 0 ? 'bad' : ''} hint={`Bank: ${money(d.bank_balance)}`} to="/cash" />
              </div>
            </>
          )}

          <Analytics manager={can('manager')} />

          <div className="grid grid-2" style={{ marginTop: 18 }}>
            <div className="card">
              <div className="card-head"><h2>Latest batches</h2><Link to="/production">See all</Link></div>
              {d.recent_batches.length === 0 ? <Empty>No production yet</Empty> : (
                <div className="stack" style={{ gap: 0 }}>
                  {d.recent_batches.map((b) => (
                    <Link key={b.id} to={`/trace/lot/${b.lot_id}`} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', textDecoration: 'none', color: 'inherit' }}>
                      <div style={{ flex: 1 }}><b className="mono">{b.batch_no}</b> <span className="muted">· {b.product_name}</span><div className="small muted">{fmtDate(b.date)}</div></div>
                      {b.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <b className="num">{qty(b.qty_produced, b.unit)}</b>}
                    </Link>
                  ))}
                </div>
              )}
            </div>
{!pastYear && (
            <div className="card">
              <div className="card-head"><h2>Attendance today</h2><Link to="/staff">Mark now</Link></div>
              <div className="grid kpi kpi-flat" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <Stat label="Present" value={int(d.attendance.P)} tone="good" />
                <Stat label="Absent" value={int(d.attendance.A)} tone={d.attendance.A ? 'bad' : ''} />
                <Stat label="Half day / Leave" value={`${int(d.attendance.H)} / ${int(d.attendance.L)}`} />
                <Stat label="Not marked" value={int(d.attendance.total - (d.attendance.P || 0) - (d.attendance.A || 0) - (d.attendance.H || 0) - (d.attendance.L || 0))} hint={`of ${d.attendance.total} workers`} />
              </div>
            </div>
)}
          </div>

          {d.recent_sales && (
            <div className="card">
              <div className="card-head"><h2>Latest invoices</h2><Link to="/sales">See all</Link></div>
              {d.recent_sales.length === 0 ? <Empty>No sales yet</Empty> : d.recent_sales.map((s) => (
                <Link key={s.id} to={`/sales/${s.id}`} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ flex: 1 }}><b className="mono">{s.invoice_no}</b> <span className="muted">· {s.customer_name}</span><div className="small muted">{fmtDate(s.date)}</div></div>
                  {s.status === 'cancelled' ? <Badge tone="danger">Cancelled</Badge> : <PayBadge total={s.total} paid={s.paid} />}
                  <b className="num">{money(s.total)}</b>
                </Link>
              ))}
            </div>
          )}
        </>
      )}</Async>
    </>
  );
}


const PERIODS = [
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'quarter', label: 'Last 3 months' },
  { value: 'year', label: 'This year' },
];
/** Keep the biggest n rows; fold the rest into one "Other" row (never more bars than a reader can compare). */
const topWithOther = (rows, n) => (rows.length <= n ? rows : [
  ...rows.slice(0, n - 1),
  { key: 'other', label: `Other (${rows.length - n + 1} more)`, amount: rows.slice(n - 1).reduce((s, r) => s + r.amount, 0) },
]);
const monthName = (m, style = 'short') => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-GB', style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' });
const dayLabel = (d) => String(new Date(`${d}T12:00:00`).getDate());

/** "▲ 12% vs last month": arrow + words, so the colour is never the only signal. */
function Change({ now, before, goodWhenUp = true, vs }) {
  if (before === null || before === undefined) return null;
  if (Math.abs(before) < 0.005) return now ? <span className="chg">New this period</span> : <span className="chg">No change {vs}</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="chg"><span className="chg-num"><Minus size={14} /> Same</span> <span className="muted">as {vs}</span></span>;
  const up = pct > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`chg ${good ? 'chg-good' : 'chg-bad'}`}>
      <span className="chg-num">{up ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{up ? 'Up' : 'Down'} {Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%</span> <span className="muted">vs {vs}</span>
    </span>
  );
}

function Analytics({ manager }) {
  const [period, setPeriod] = useState(() => { try { return localStorage.getItem('dashPeriod') || 'month'; } catch { return 'month'; } });
  const q = useFetch(`/dashboard/analytics?period=${period}`);
  const money = useMoney();
  const pick = (v) => { setPeriod(v); try { localStorage.setItem('dashPeriod', v); } catch { /* ignore */ } };
  const vs = { month: 'last month', last_month: 'the month before', quarter: 'previous 3 months', year: 'same time last year' }[period];

  return (
    <section style={{ marginTop: 24 }}>
      <div className="dash-head">
        <div>
          <h2>Business performance</h2>
          {q.data && <div className="small muted">{fmtDate(q.data.period.from)} – {fmtDate(q.data.period.to)}</div>}
        </div>
        {manager && (
          <div className="choice seg" role="radiogroup" aria-label="Period">
            {PERIODS.map((p) => <button key={p.value} role="radio" aria-checked={period === p.value} className={`btn btn-sm ${period === p.value ? 'on' : ''}`} onClick={() => pick(p.value)}>{p.label}</button>)}
          </div>
        )}
      </div>
      <Async q={q}>{(a) => (manager ? <ManagerAnalytics a={a} money={money} vs={vs} /> : <ProductionChart rows={a.production} />)}</Async>
    </section>
  );
}

function ManagerAnalytics({ a, money, vs }) {
  const k = a.kpi, p = a.prev, pos = a.position;
  const margin = (v) => (k.sales ? `${((v / k.sales) * 100).toFixed(1)}% of sales` : '');
  const fmt = (v) => money(v);
  const stockTotal = pos.stock.raw + pos.stock.finished + pos.stock.trading;
  const trendTable = (
    <table className="table responsive">
      <thead><tr><th>Month</th><th className="right">Sales</th><th className="right">Cost of goods</th><th className="right">Gross profit</th><th className="right">Expenses</th><th className="right">Net profit</th></tr></thead>
      <tbody>{a.trend.map((r) => (
        <tr key={r.month}><td>{monthName(r.month, 'long')}</td>
          <td data-label="Sales" className="right num">{money(r.sales)}</td><td data-label="Cost of goods" className="right num">{money(r.cogs)}</td>
          <td data-label="Gross profit" className="right num">{money(r.gross_profit)}</td><td data-label="Expenses" className="right num">{money(r.expenses)}</td>
          <td data-label="Net profit" className="right num"><b>{money(r.net_profit)}</b></td></tr>
      ))}</tbody>
    </table>
  );

  return (
    <>
      <div className="grid grid-4 kpi kpi-hero">
        <Stat icon={TrendingUp} label="Sales" value={money(k.sales)} to="/sales"
          hint={<><Change now={k.sales} before={p.sales} vs={vs} /><div>{k.invoices} invoice{k.invoices === 1 ? '' : 's'} · avg {money(k.avg_invoice)}</div></>} />
        <Stat icon={Percent} label="Gross profit" value={money(k.gross_profit)} to="/finance"
          hint={<><Change now={k.gross_profit} before={p.gross_profit} vs={vs} /><div>{margin(k.gross_profit)}</div></>} />
        <Stat icon={TrendingDown} label="Expenses & salaries" value={money(k.total_expenses)} to="/expenses"
          hint={<><Change now={k.total_expenses} before={p.total_expenses} goodWhenUp={false} vs={vs} /><div>Expenses {money(k.operating)} · Salaries {money(k.payroll)}</div></>} />
        <Stat icon={k.net_profit >= 0 ? PiggyBank : TrendingDown} label={k.net_profit >= 0 ? 'Net profit' : 'Net loss'} value={money(k.net_profit)} tone={k.net_profit >= 0 ? 'good' : 'bad'} to="/finance"
          hint={<><Change now={k.net_profit} before={p.net_profit} vs={vs} /><div>{margin(k.net_profit)}</div></>} />
      </div>
      <div className="grid grid-4 kpi" style={{ marginTop: 12 }}>
        <Stat icon={Wallet} label="Cash & bank" value={money(pos.cash + pos.bank)} hint={`Cash ${money(pos.cash)} · Bank ${money(pos.bank)}`} to="/cash" tone={pos.cash + pos.bank < 0 ? 'bad' : ''} />
        <Stat icon={Users} label="Customers owe us" value={money(pos.receivable)} hint={`${a.receivables.length} customer${a.receivables.length === 1 ? '' : 's'} with a balance`} to="/customers" />
        <Stat icon={Building2} label="We owe suppliers" value={money(pos.payable)} to="/suppliers" />
        <Stat icon={Boxes} label="Stock value" value={money(stockTotal)} hint={`Raw ${money(pos.stock.raw)} · Goods ${money(pos.stock.finished + pos.stock.trading)}`} to="/stock" />
      </div>

      <ChartCard title="Sales and profit — last 12 months" sub="Monthly sales with gross profit (after cost of goods) and net profit (after all expenses and salaries)"
        legend={[{ label: 'Sales', color: SERIES.sales }, { label: 'Gross profit', color: SERIES.gross, type: 'line' }, { label: 'Net profit', color: SERIES.net, type: 'line' }]}
        table={trendTable} link={<Link to="/finance" className="btn btn-sm">Profit & Loss</Link>}>
        <TrendChart rows={a.trend} xLabel={(r) => monthName(r.month)} title={(r) => monthName(r.month, 'long')} fmt={fmt}
          bars={[{ key: 'sales', label: 'Sales', color: SERIES.sales }]}
          lines={[{ key: 'gross_profit', label: 'Gross profit', color: SERIES.gross }, { key: 'net_profit', label: 'Net profit', color: SERIES.net }]}
          ariaLabel="Monthly sales, gross profit and net profit for the last 12 months" />
      </ChartCard>

      <div className="grid grid-2 dash-grid">
        <ChartCard title="Daily sales — last 30 days" sub={`Average ${money(a.daily.reduce((s, r) => s + r.sales, 0) / 30)} a day`}
          table={<table className="table responsive"><thead><tr><th>Date</th><th className="right">Invoices</th><th className="right">Sales</th></tr></thead>
            <tbody>{[...a.daily].reverse().map((r) => <tr key={r.date}><td>{fmtDate(r.date)}</td><td data-label="Invoices" className="right num">{r.invoices}</td><td data-label="Sales" className="right num">{money(r.sales)}</td></tr>)}</tbody></table>}>
          <TrendChart rows={a.daily} xLabel={(r) => dayLabel(r.date)} title={(r) => `${fmtDate(r.date)} · ${r.invoices} invoice${r.invoices === 1 ? '' : 's'}`} fmt={fmt}
            bars={[{ key: 'sales', label: 'Sales', color: SERIES.sales }]} ariaLabel="Sales per day for the last 30 days" />
        </ChartCard>
        <ChartCard title="Money in vs money out" sub="Cash and bank, per month (transfers between accounts not counted)"
          legend={[{ label: 'Money in', color: SERIES.sales }, { label: 'Money out', color: SERIES.cost }]}
          table={<table className="table responsive"><thead><tr><th>Month</th><th className="right">In</th><th className="right">Out</th><th className="right">Net</th></tr></thead>
            <tbody>{a.trend.map((r) => <tr key={r.month}><td>{monthName(r.month, 'long')}</td><td data-label="In" className="right num">{money(r.money_in)}</td><td data-label="Out" className="right num">{money(r.money_out)}</td><td data-label="Net" className="right num"><b>{money(r.money_in - r.money_out)}</b></td></tr>)}</tbody></table>}
          link={<Link to="/cash" className="btn btn-sm">Cash & Bank</Link>}>
          <TrendChart rows={a.trend} xLabel={(r) => monthName(r.month)} title={(r) => `${monthName(r.month, 'long')} · net ${money(r.money_in - r.money_out)}`} fmt={fmt}
            bars={[{ key: 'money_in', label: 'Money in', color: SERIES.sales }, { key: 'money_out', label: 'Money out', color: SERIES.cost }]}
            ariaLabel="Money received and paid each month" />
        </ChartCard>
      </div>

      <div className="grid grid-2 dash-grid">
        <ChartCard title="Best-selling items" sub={`${a.period.label} · by sales value`}>
          <RankBars fmt={fmt} empty="No sales in this period"
            rows={a.top_products.map((r) => ({ key: r.id, label: r.name, value: r.revenue, to: `/stock/${r.id}`,
              sub: `${qty(r.qty, r.unit)} sold`, right: r.margin_pct !== null ? `${r.margin_pct}% margin` : '' }))} />
        </ChartCard>
        <ChartCard title="Top customers" sub={`${a.period.label} · by sales value`}>
          <RankBars fmt={fmt} empty="No sales in this period"
            rows={a.top_customers.map((r) => ({ key: r.id, label: r.name, value: r.sales, to: `/parties/${r.id}`,
              sub: `${r.invoices} invoice${r.invoices === 1 ? '' : 's'}`, right: r.owes > 0 ? `owes ${money(r.owes)}` : 'nothing due' }))} />
        </ChartCard>
      </div>

      <div className="grid grid-2 dash-grid">
        <ChartCard title="Where the money went" sub={`${a.period.label} · expenses and salaries (cost of goods not included)`}
          link={<Link to="/expenses" className="btn btn-sm">Expenses</Link>}>
          <RankBars fmt={fmt} color={SERIES.cost} empty="No expenses in this period"
            rows={topWithOther(a.expenses, 6).map((r) => ({ key: r.key, label: r.label, value: r.amount, right: k.total_expenses ? `${Math.round((r.amount / k.total_expenses) * 100)}%` : '' }))} />
        </ChartCard>
        <ChartCard title="Customers who owe us most" sub={`Total due ${money(pos.receivable)}`} link={<Link to="/customers" className="btn btn-sm">Customers</Link>}>
          <RankBars fmt={fmt} color={SERIES.cost} empty="No customer owes anything"
            rows={a.receivables.map((r) => ({ key: r.id, label: r.name, value: r.owes, to: `/parties/${r.id}`,
              right: pos.receivable > 0 ? `${Math.round((r.owes / pos.receivable) * 100)}% of all dues` : '' }))} />
        </ChartCard>
      </div>

      <div className="grid grid-2 dash-grid">
        <ChartCard title="Where the stock value is" sub={`Total ${money(stockTotal)}`}>
          <SplitBar label="Stock value by type" fmt={fmt} parts={[
            { label: 'Raw materials', value: pos.stock.raw, color: 'var(--series-1)' },
            { label: 'Finished goods', value: pos.stock.finished, color: 'var(--series-3)' },
            { label: 'Trading items', value: pos.stock.trading, color: 'var(--series-4)' },
          ]} />
          <h3 className="split-title">Sales collected vs on credit <span className="muted small">· {a.period.label.toLowerCase()}</span></h3>
          <SplitBar label="Sales collected versus on credit" fmt={fmt} parts={[
            { label: 'Received on the invoice', value: a.collection.received, color: 'var(--series-1)' },
            { label: 'Given on credit', value: a.collection.on_credit, color: 'var(--series-2)' },
          ]} />
        </ChartCard>
        <ProductionChart rows={a.production} money={money} />
      </div>
    </>
  );
}

function ProductionChart({ rows, money }) {
  return (
    <ChartCard title="Production — last 12 months" sub={`${rows.reduce((s, r) => s + r.batches, 0)} batches · ${int(rows.reduce((s, r) => s + r.units, 0))} units made`}
      link={<Link to="/production" className="btn btn-sm">Production</Link>}
      table={<table className="table responsive"><thead><tr><th>Month</th><th className="right">Batches</th><th className="right">Units made</th>{money && <th className="right">Cost</th>}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.month}><td>{monthName(r.month, 'long')}</td><td data-label="Batches" className="right num">{r.batches}</td><td data-label="Units made" className="right num">{int(r.units)}</td>{money && <td data-label="Cost" className="right num">{money(r.cost)}</td>}</tr>)}</tbody></table>}>
      <TrendChart rows={rows} xLabel={(r) => monthName(r.month)} title={(r) => `${monthName(r.month, 'long')} · ${r.batches} batch${r.batches === 1 ? '' : 'es'}`} fmt={(v) => int(v)}
        bars={[{ key: 'units', label: 'Units made', color: SERIES.gross }]} ariaLabel="Units produced each month for the last 12 months" />
    </ChartCard>
  );
}
