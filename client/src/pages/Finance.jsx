import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Receipt, ChevronLeft, ChevronRight, Printer, Trash2, Save, TrendingUp, TrendingDown, Equal, Minus,
  Pencil, Eye, EyeOff, Wallet, Landmark, CalendarRange, Tags, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { useFetch, useMoney, useAction, api, fmtDate, today, thisMonth, fyStartMonth, monthName } from '../lib.jsx';
import { PageHead, Async, DataTable, Field, NumberInput, Modal, Badge, Stat, Alert, Empty, Tabs, Confirm } from '../components.jsx';
import { PaymentPicker, MethodBadge, MethodFilter, emptyPayment, paymentBody, METHOD_LABEL, METHOD_ICON, PAY_METHODS } from '../payment.jsx';

const shiftMonth = (m, n) => { const d = new Date(`${m}-15T12:00:00`); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-CA').slice(0, 7); };
const shortMonth = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });

/** "Rs 4,000 more than October" — plain-language change line. */
function Change({ now, before, label, goodWhenUp = true }) {
  const money = useMoney();
  const diff = Math.round((now - before) * 100) / 100;
  if (!before && !now) return null;
  if (Math.abs(diff) < 0.5) return <span className="muted">Same as {label}</span>;
  const up = diff > 0;
  const good = up === goodWhenUp;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ color: good ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>
      <Icon size={15} style={{ verticalAlign: -3 }} /> {money(Math.abs(diff))} {up ? 'more' : 'less'} than {label}
    </span>
  );
}

// =====================================================================
//  Profit & Loss overview (/finance)
// =====================================================================
export function FinanceOverview() {
  const [month, setMonth] = useState(thisMonth());
  const q = useFetch(`/finance/overview?month=${month}`);
  const money = useMoney();
  const nav = useNavigate();
  const prevLabel = monthName(shiftMonth(month, -1)).split(' ')[0];

  return (
    <>
      <PageHead title="Profit & Loss" sub="How the business did this month — in plain numbers."
        actions={<>
          <Link to="/expenses?new=1" className="btn btn-primary btn-lg"><Plus size={22} /> Add expense</Link>
          <button className="btn ro-ok" onClick={() => window.print()}><Printer size={20} /> Print</button>
        </>} />

      <div className="card no-print">
        <div className="row">
          <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= fyStartMonth()} aria-label="Previous month"><ChevronLeft size={22} /></button>
          <input className="input" type="month" style={{ width: 'auto' }} value={month} min={fyStartMonth()} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
          <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label="Next month"><ChevronRight size={22} /></button>
          <b style={{ fontSize: '1.15rem' }}>{monthName(month)}</b>
          <div className="spacer" />
          <Link to="/reports" className="btn btn-ghost"><CalendarRange size={18} /> Any date range</Link>
        </div>
      </div>

      <Async q={q}>{(d) => {
        const c = d.current, p = d.previous;
        const profit = c.net_profit >= 0;
        return (
          <>
            {/* Sales − Costs = Profit */}
            <div className="equation" style={{ marginTop: 18 }}>
              <div className="eq-tile">
                <div className="label"><TrendingUp size={20} /> Total sales</div>
                <div className="value">{money(c.sales)}</div>
                <Change now={c.sales} before={p.sales} label={prevLabel} />
              </div>
              <div className="eq-op" aria-hidden><Minus size={30} /></div>
              <div className="eq-tile">
                <div className="label"><Receipt size={20} /> Total costs &amp; expenses</div>
                <div className="value">{money(c.total_costs)}</div>
                <div className="small muted">Soap cost {money(c.cogs)} · Expenses {money(c.operating.total)} · Salaries {money(c.payroll.total)}</div>
                <Change now={c.total_costs} before={p.total_costs} label={prevLabel} goodWhenUp={false} />
              </div>
              <div className="eq-op" aria-hidden><Equal size={30} /></div>
              <div className={`eq-tile ${profit ? 'eq-profit' : 'eq-loss'}`}>
                <div className="label">{profit ? <TrendingUp size={20} /> : <TrendingDown size={20} />} {profit ? 'Net profit' : 'Net loss'}</div>
                <div className="value">{money(c.net_profit)}</div>
                {c.other_income.total !== 0 && <div className="small muted">includes other income {money(c.other_income.total)}</div>}
                <Change now={c.net_profit} before={p.net_profit} label={prevLabel} />
              </div>
            </div>

            <div className="card">
              <SalesBreakdown p={c} money={money} />
            </div>

            <div style={{ marginTop: 18 }}>
              <div className="card">
                <div className="card-head"><h2>Where expense money went</h2><Link to={`/expenses?month=${month}`}>See all expenses</Link></div>
                {d.expenses_by_category.length === 0 ? <Empty icon={Receipt}>No expenses recorded in {monthName(month)}.</Empty> : (
                  <CategoryBars compact rows={d.expenses_by_category.map((x) => ({ key: x.id, label: x.name, amount: x.amount, count: x.count }))} money={money}
                    onPick={(id) => nav(`/expenses?month=${month}&category_id=${id}`)} />
                )}
              </div>
            </div>

            <div className="card">
                <div className="card-head"><h2>Last 6 months</h2></div>
                <div className="table-wrap"><table className="table responsive">
                  <thead><tr><th>Month</th><th className="right">Sales</th><th className="right">Costs</th><th className="right">Profit / loss</th></tr></thead>
                  <tbody>{d.trend.map((t) => {
                    const costs = t.cogs + t.operating + t.payroll;
                    return (
                      <tr key={t.month} className={t.month === month ? 'row-hl' : 'clickable'} onClick={() => setMonth(t.month)}>
                        <td className="nowrap"><b>{shortMonth(t.month)} {t.month.slice(0, 4)}</b></td>
                        <td data-label="Sales" className="right num">{money(t.sales)}</td>
                        <td data-label="Costs" className="right num">{money(costs)}</td>
                        <td data-label="Profit" className="right num"><b style={{ color: t.net_profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{money(t.net_profit)}</b></td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </div>

            <div className="card">
              <div className="card-head"><h2>Profit &amp; Loss statement — {monthName(month)}</h2></div>
              <PnlStatement p={c} prev={p} prevLabel={prevLabel} />
            </div>
          </>
        );
      }}</Async>
    </>
  );
}

/**
 * "Where each Rs 100 of sales went": one part-to-whole bar.
 * Fixed series order (palette slots 1–4), 2px gaps, values labelled in the legend.
 */
function SalesBreakdown({ p, money }) {
  const parts = [
    { key: 'cogs', label: 'Cost of soap sold', hint: 'raw materials + batch labour', value: p.cogs, color: 'var(--series-1)' },
    { key: 'op', label: 'Operational expenses', hint: 'rent, bills, repairs…', value: p.operating.total, color: 'var(--series-2)' },
    { key: 'pay', label: 'Salaries & wages', hint: 'incl. overtime', value: p.payroll.total, color: 'var(--series-3)' },
  ];
  const profit = p.net_profit;
  if (profit > 0) parts.push({ key: 'profit', label: 'Profit', hint: 'kept by the business', value: profit, color: 'var(--series-4)' });
  const costs = p.cogs + p.operating.total + p.payroll.total;
  const scale = Math.max(p.sales + Math.max(0, p.other_income.total), costs, 1);
  const per100 = (v) => (p.sales > 0 ? Math.round((v / p.sales) * 100) : 0);

  if (p.sales <= 0 && costs <= 0) return <Empty>No sales or costs in this month yet.</Empty>;
  return (
    <>
      <div className="card-head">
        <h2>{p.sales > 0 ? `Where each ${money(100)} of sales went` : 'Costs this month'}</h2>
        {profit < 0 && <Badge tone="danger">Costs were {money(-profit)} more than sales</Badge>}
      </div>
      <div className="stack-bar" role="img" aria-label="Breakdown of sales into costs and profit">
        {parts.filter((x) => x.value > 0).map((x) => (
          <span key={x.key} style={{ width: `${(x.value / scale) * 100}%`, background: x.color }} title={`${x.label}: ${money(x.value)}`} />
        ))}
        {profit < 0 && p.sales > 0 && <i className="sales-marker" style={{ left: `${(p.sales / scale) * 100}%` }}><b>Sales</b></i>}
      </div>
      <div className="stack-legend">
        {parts.map((x) => (
          <div key={x.key}>
            <i style={{ background: x.color }} />
            <div>
              <div className="lg-label">{x.label}</div>
              <div className="lg-value num">{money(x.value)}</div>
              <div className="small muted">{p.sales > 0 ? `${money(per100(x.value))} of every ${money(100)} · ` : ''}{x.hint}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Single-series horizontal bars, labelled directly. */
function CategoryBars({ rows, money, onPick, activeKey, compact }) {
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className={`hbars ${compact ? 'compact' : ''}`}>
      {rows.map((r) => (
        <button key={r.key} className={`hbar ${activeKey && String(activeKey) === String(r.key) ? 'on' : ''}`} onClick={() => onPick && onPick(r.key)} title={`${r.label}: ${money(r.amount)}`}>
          <span className="hbar-label">{r.label}{r.count ? <span className="muted small"> · {r.count}</span> : null}</span>
          <span className="hbar-track"><span style={{ width: `${(r.amount / max) * 100}%` }} /></span>
          <span className="hbar-value num"><b>{money(r.amount)}</b><span className="muted small"> {total ? Math.round((r.amount / total) * 100) : 0}%</span></span>
        </button>
      ))}
    </div>
  );
}

/**
 * The statement itself:  Revenue − COGS = Gross profit − Operating − Payroll (+ other income) = Net.
 * Used on the Profit & Loss page and in Reports (any date range).
 */
export function PnlStatement({ p, prev, prevLabel = 'previous' }) {
  const money = useMoney();
  const pct = (v) => (p.sales ? `${((v / p.sales) * 100).toFixed(1)}%` : '—');
  const Row = ({ label, sub, value, before, sign = '', strong, indent, tone }) => (
    <tr className={strong ? 'pl-strong' : ''}>
      <td style={{ paddingLeft: indent ? 34 : undefined }}>{strong ? <b>{label}</b> : label}{sub && <div className="small muted">{sub}</div>}</td>
      <td data-label="Amount" className="right num" style={{ color: tone }}>{sign}{strong ? <b>{money(sign ? Math.abs(value) : value)}</b> : money(sign ? Math.abs(value) : value)}</td>
      <td data-label="% of sales" className="right num muted">{pct(value)}</td>
      {prev && <td data-label={prevLabel} className="right num muted">{before === undefined ? '' : money(before)}</td>}
    </tr>
  );
  const prevOp = (code) => prev?.operating.lines.find((x) => x.code === code)?.amount ?? 0;
  const pay = p.payroll;
  const pp = prev?.payroll;
  return (
    <>
      <div className="table-wrap"><table className="table responsive pl">
        <thead><tr><th>Step</th><th className="right">Amount</th><th className="right">% of sales</th>{prev && <th className="right">{prevLabel}</th>}</tr></thead>
        <tbody>
          <Row label="Gross revenue (sales)" sub="Finished goods, trading items and raw materials invoiced" value={p.sales} before={prev?.sales} strong />
          <Row label="Cost of goods sold" sub="Weighted-average raw material + batch labour of the soap that was sold" value={p.cogs} before={prev?.cogs} sign="− " />
          <Row label="= Gross profit" value={p.gross_profit} before={prev?.gross_profit} strong />

          <tr className="pl-section"><td colSpan={prev ? 4 : 3}>Operational expenses</td></tr>
          {p.operating.lines.length === 0 && <tr><td colSpan={prev ? 4 : 3} className="muted" style={{ paddingLeft: 34 }}>None</td></tr>}
          {p.operating.lines.map((l) => (
            <Row key={l.code} indent label={l.name} sub={l.note} value={l.amount} before={prev ? prevOp(l.code) : undefined} sign={l.amount < 0 ? '+ ' : '− '} />
          ))}
          <Row label="Total operational expenses" value={p.operating.total} before={prev?.operating.total} sign="− " strong />

          <tr className="pl-section"><td colSpan={prev ? 4 : 3}>Payroll</td></tr>
          <Row indent label="Monthly salaries" value={pay.monthly} before={pp?.monthly} sign="− " />
          <Row indent label="Daily wages" value={pay.daily} before={pp?.daily} sign="− " />
          <Row indent label="Overtime" value={pay.overtime} before={pp?.overtime} sign="− " />
          {pay.other !== 0 && <Row indent label="Other wages" value={pay.other} before={pp?.other} sign="− " />}
          <Row label="Total payroll" value={pay.total} before={pp?.total} sign="− " strong />

          {p.other_income.lines.map((l) => <Row key={l.name} label={l.name} sub="Other income" value={l.amount} sign="+ " />)}
        </tbody>
        <tfoot>
          <tr className={p.net_profit >= 0 ? 'pl-profit' : 'pl-loss'}>
            <td>{p.net_profit >= 0 ? '= NET PROFIT' : '= NET LOSS'}</td>
            <td className="right num">{money(p.net_profit)}</td>
            <td className="right num">{pct(p.net_profit)}</td>
            {prev && <td className="right num">{money(prev.net_profit)}</td>}
          </tr>
        </tfoot>
      </table></div>
      {p.materials_used_in_production > 0 && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Raw materials used in production in this period: <b>{money(p.materials_used_in_production)}</b>. Only the part inside soap that was <b>sold</b> is counted as cost of goods sold; the rest is still in stock and will count when it is sold.
        </p>
      )}
    </>
  );
}

// =====================================================================
//  Expenses (/expenses)
// =====================================================================
export function Expenses() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState(params.get('from') ? 'range' : 'month');
  const [month, setMonth] = useState(params.get('month') || thisMonth());
  const [from, setFrom] = useState(params.get('from') || `${thisMonth()}-01`);
  const [to, setTo] = useState(params.get('to') || today());
  const [category, setCategory] = useState(params.get('category_id') || '');
  const [method, setMethod] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('cat');
  const [form, setForm] = useState(params.get('new') ? {} : null);
  const [cats, setCats] = useState(false);
  const money = useMoney();
  const cashQ = useFetch('/accounts/cash');
  const catQ = useFetch('/expense-categories?all=1');

  const qs = new URLSearchParams(mode === 'month' ? { month } : { from, to });
  if (category) qs.set('category_id', category);
  if (method) qs.set('method', method);
  if (search.trim()) qs.set('q', search.trim());
  const q = useFetch(`/expenses?${qs}`);

  useEffect(() => { if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const periodLabel = mode === 'month' ? monthName(month) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const prevLabel = mode === 'month' ? monthName(shiftMonth(month, -1)).split(' ')[0] : 'the period before';
  const catName = catQ.data?.find((c) => String(c.id) === String(category))?.name;
  const reload = () => { q.reload(); catQ.reload(); cashQ.reload(); };

  return (
    <>
      <PageHead title="Expenses" sub="Rent, bills, repairs, transport… every expense reduces the cash book straight away."
        actions={<>
          <button className="btn btn-primary btn-lg" onClick={() => setForm({})}><Plus size={22} /> Add expense</button>
          <button className="btn" onClick={() => setCats(true)}><Tags size={20} /> Categories</button>
          <button className="btn ro-ok" onClick={() => window.print()}><Printer size={20} /> Print</button>
        </>} />

      {/* Filters */}
      <div className="card no-print">
        <div className="row">
          <div className="choice seg">
            <button className={`btn btn-sm ${mode === 'month' ? 'on' : ''}`} onClick={() => setMode('month')}>By month</button>
            <button className={`btn btn-sm ${mode === 'range' ? 'on' : ''}`} onClick={() => setMode('range')}>By dates</button>
          </div>
          {mode === 'month' ? (
            <>
              <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= fyStartMonth()} aria-label="Previous month"><ChevronLeft size={22} /></button>
              <input className="input" type="month" style={{ width: 'auto' }} value={month} min={fyStartMonth()} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
              <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label="Next month"><ChevronRight size={22} /></button>
            </>
          ) : (
            <>
              <input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
              <span>to</span>
              <input className="input" type="date" style={{ width: 'auto' }} value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              <button className="btn btn-sm" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
            </>
          )}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <select className="input" style={{ width: 'auto', minWidth: 220 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {(catQ.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (hidden)'}</option>)}
          </select>
          <MethodFilter value={method} onChange={setMethod} />
          <input className="input" type="search" style={{ flex: '1 1 200px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search note, paid to, bill no…" aria-label="Search expenses" />
        </div>
        {(category || method) && <div style={{ marginTop: 10 }}><button className="btn btn-sm btn-ghost" onClick={() => { setCategory(''); setMethod(''); }}>✕ Clear filters</button></div>}
      </div>

      <div className="print-only"><h2>Expenses — {periodLabel}{catName ? ` — ${catName}` : ''}</h2></div>

      <Async q={q}>{(d) => (
        <>
          <div className="grid grid-4" style={{ marginTop: 18 }}>
            <Stat label={`Total spent${catName ? ` on ${catName}` : ''}`} value={money(d.total)} hint={<Change now={d.total} before={d.previous.total} label={prevLabel} goodWhenUp={false} />} />
            <Stat label="Number of expenses" value={d.count} hint={periodLabel} />
            <Stat icon={METHOD_ICON.cash} label="Paid in cash" value={money(d.by_method.find((x) => x.key === 'cash')?.amount || 0)} />
            <Stat icon={METHOD_ICON.bank_transfer} label="Paid by bank / cheque" value={money((d.by_method.find((x) => x.key === 'bank_transfer')?.amount || 0) + (d.by_method.find((x) => x.key === 'cheque')?.amount || 0))}
              hint={`Cheques ${money(d.by_method.find((x) => x.key === 'cheque')?.amount || 0)}`} />
          </div>

          {d.count > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Where the money went</h2>
                <Tabs value={view} onChange={setView} tabs={[{ value: 'cat', label: 'By category' }, { value: 'day', label: 'By day' }]} />
              </div>
              {view === 'cat'
                ? <CategoryBars rows={d.by_category} money={money} activeKey={category} onPick={(k) => setCategory(String(k) === String(category) ? '' : String(k))} />
                : <CategoryBars rows={d.by_day.map((x) => ({ ...x, label: fmtDate(x.key) }))} money={money} />}
              {view === 'cat' && <div className="small muted" style={{ marginTop: 8 }}>Tap a category to see only its expenses.</div>}
            </div>
          )}

          <div className="card">
            <div className="card-head"><h2>{d.count} expense{d.count === 1 ? '' : 's'} — {periodLabel}</h2></div>
            <DataTable rows={d.rows} searchKeys={false} onRow={(x) => setForm(x)} empty={`No expenses in ${periodLabel}. Tap “Add expense” to record one.`}
              columns={[
                { key: 'date', label: 'Date', render: (x) => <span className="nowrap"><b>{fmtDate(x.date)}</b><div className="small muted mono">{x.expense_no}</div></span> },
                { key: 'category_name', label: 'Category', render: (x) => <Badge tone="info">{x.category_name}</Badge> },
                { key: 'note', label: 'Details', render: (x) => <div>{x.note || <span className="muted">—</span>}{(x.paid_to || x.bill_no) && <div className="small muted">{x.paid_to && `Paid to ${x.paid_to}`}{x.paid_to && x.bill_no && ' · '}{x.bill_no && `Bill ${x.bill_no}`}</div>}</div> },
                { key: 'payment_method', label: 'Paid by', render: (x) => <div><MethodBadge method={x.payment_method} chequeNo={x.cheque_no} status={x.cheque_status} small /><div className="small muted">{x.pay_account_name}{x.reference ? ` · Ref ${x.reference}` : ''}</div></div> },
                { key: 'amount', label: 'Amount', className: 'right', render: (x) => <b className="num" style={{ fontSize: '1.05rem' }}>{money(x.amount)}</b> },
              ]}
              footer={d.count > 0 && <tr><td colSpan={4}>Total</td><td className="right num">{money(d.total)}</td></tr>} />
          </div>
        </>
      )}</Async>

      {form && <ExpenseForm expense={form.id ? form : null} cash={cashQ.data || []} onClose={() => setForm(null)} onSaved={(again) => { reload(); setForm(again ? {} : null); }} />}
      {cats && <CategoryManager onClose={() => { setCats(false); reload(); }} />}
    </>
  );
}

/** Add / edit an expense. Big category buttons, big amount, Cash or Bank. */
export function ExpenseForm({ expense, cash, onClose, onSaved }) {
  const isNew = !expense;
  const money = useMoney();
  const catQ = useFetch('/expense-categories');
  const [f, setF] = useState(() => (expense
    ? { category_id: expense.category_id, amount: String(expense.amount), date: expense.date, note: expense.note || '', paid_to: expense.paid_to || '', bill_no: expense.bill_no || '' }
    : { category_id: '', amount: '', date: today(), note: '', paid_to: '', bill_no: '' }));
  const [pay, setPay] = useState(() => (expense
    ? { payment_method: expense.payment_method || 'cash', account_id: expense.pay_account_id, cheque_no: expense.cheque_no || '', cheque_date: expense.cheque_date || '', bank_name: expense.bank_name || '', reference: expense.reference || '' }
    : emptyPayment()));
  const [newCat, setNewCat] = useState(null);
  const [del, setDel] = useState(false);
  const [run, busy] = useAction();
  const amount = Number(f.amount) || 0;
  const valid = f.category_id && amount > 0 && f.date;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));

  const save = (again) => run(async () => {
    const body = { ...f, ...paymentBody(pay) };
    if (isNew) await api.post('/expenses', body); else await api.put(`/expenses/${expense.id}`, body);
    return true;
  }, isNew ? 'Expense saved — cash book updated' : 'Expense updated').then((ok) => {
    if (!ok) return;
    if (again) setF((x) => ({ ...x, amount: '', note: '', paid_to: '', bill_no: '' }));
    onSaved(again);
  });
  const addCat = () => run(async () => {
    const c = await api.post('/expense-categories', { name: newCat });
    setNewCat(null); catQ.reload(); setF((x) => ({ ...x, category_id: c.id }));
    return true;
  }, 'Category added');

  // keep the edited expense's category selectable even if it was hidden later
  const options = catQ.data || [];

  return (
    <Modal title={isNew ? 'Add expense' : `Edit ${expense.expense_no}`} onClose={onClose} wide
      footer={<>
        {!isNew && <button className="btn btn-ghost" onClick={() => setDel(true)}><Trash2 size={18} /> Delete</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        {isNew && <button className="btn" disabled={!valid || busy} onClick={() => save(true)}>Save &amp; add another</button>}
        <button className="btn btn-primary" disabled={!valid || busy} onClick={() => save(false)}><Save size={20} /> {isNew ? `Save ${amount ? money(amount) : ''}` : 'Save changes'}</button>
      </>}>
      <div className="stack">
        <Field label="1. What was it for?">
          <div className="cat-grid">
            {options.map((c) => (
              <button key={c.id} type="button" className={`btn ${Number(f.category_id) === c.id ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, category_id: c.id }))} title={c.description || ''}>
                {c.name}
              </button>
            ))}
            {newCat === null
              ? <button type="button" className="btn btn-ghost" onClick={() => setNewCat('')}><Plus size={18} /> New category</button>
              : (
                <div className="row" style={{ gridColumn: '1 / -1' }}>
                  <input className="input" style={{ flex: 1 }} autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="e.g. Diesel, Security guard, Internet" onKeyDown={(e) => e.key === 'Enter' && newCat.trim() && addCat()} />
                  <button className="btn btn-primary" disabled={!newCat.trim() || busy} onClick={addCat}>Add</button>
                  <button className="btn btn-ghost" onClick={() => setNewCat(null)}>Cancel</button>
                </div>
              )}
          </div>
        </Field>
        <div className="grid grid-2">
          <Field label="2. Amount"><NumberInput className="big" value={f.amount} onChange={set('amount')} autoFocus={!isNew} /></Field>
          <Field label="3. Date"><input className="input big" type="date" value={f.date} max={today()} onChange={set('date')} /></Field>
        </div>
        <PaymentPicker value={pay} onChange={setPay} funds={cash} direction="out" amount={isNew ? amount : 0} label="4. How was it paid?" />
        <Field label="Short note"><input className="input" value={f.note} onChange={set('note')} placeholder="e.g. October electricity bill" /></Field>
        <div className="grid grid-2">
          <Field label="Paid to (optional)"><input className="input" value={f.paid_to} onChange={set('paid_to')} placeholder="e.g. K-Electric" /></Field>
          <Field label="Bill / receipt no. (optional)"><input className="input" value={f.bill_no} onChange={set('bill_no')} /></Field>
        </div>
      </div>
      {del && <Confirm title="Delete this expense?" danger busy={busy} confirmLabel="Delete" message={`${money(expense.amount)} will be removed from expenses, the cash book and Profit & Loss.`}
        onClose={() => setDel(false)} onConfirm={() => run(() => api.del(`/expenses/${expense.id}`), 'Expense deleted').then((r) => r && onSaved(false))} />}
    </Modal>
  );
}

/** Add, rename and hide expense categories. */
function CategoryManager({ onClose }) {
  const q = useFetch('/expense-categories?all=1');
  const money = useMoney();
  const [name, setName] = useState('');
  const [edit, setEdit] = useState(null); // { id, name }
  const [run, busy] = useAction();
  const add = () => run(async () => { await api.post('/expense-categories', { name }); setName(''); q.reload(); return true; }, 'Category added');
  const rename = () => run(async () => { await api.put(`/expense-categories/${edit.id}`, { name: edit.name }); setEdit(null); q.reload(); return true; }, 'Renamed');
  const toggle = (c) => run(async () => { await api.put(`/expense-categories/${c.id}`, { active: !c.active }); q.reload(); return true; }, c.active ? 'Hidden from the expense form' : 'Shown again');
  return (
    <Modal title="Expense categories" onClose={onClose} wide footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        <div className="row">
          <input className="input" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Security Guard" onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} />
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={add}><Plus size={18} /> Add</button>
        </div>
        <div className="small muted">Hiding a category removes it from the expense form. Its past expenses stay in reports.</div>
        <Async q={q}>{(rows) => (
          <div className="table-wrap"><table className="table responsive">
            <thead><tr><th>Category</th><th className="right">This month</th><th className="right">Times used</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'cancelled'}>
                <td>{edit?.id === c.id
                  ? <div className="row"><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && rename()} /><button className="btn btn-primary btn-sm" onClick={rename} disabled={busy || !edit.name.trim()}>Save</button></div>
                  : <><b>{c.name}</b>{!c.active && <> <Badge>Hidden</Badge></>}{c.description && <div className="small muted">{c.description}</div>}</>}</td>
                <td data-label="This month" className="right num">{money(c.this_month)}</td>
                <td data-label="Times used" className="right num">{c.uses}</td>
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

