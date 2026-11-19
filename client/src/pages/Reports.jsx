import { useState } from 'react';
import { Printer, TrendingUp, Scale, BookOpen, Boxes, CheckCircle2, AlertTriangle, CreditCard } from 'lucide-react';
import { MethodBadge, MethodFilter, METHOD_LABEL } from '../payment.jsx';
import { useFetch, useMoney, useApp, qty, fmtDate, today, KIND_LABEL } from '../lib.jsx';
import { Landmark as BankIcon } from 'lucide-react';
import { PageHead, Async, Tabs, Stat, DataTable, Alert } from '../components.jsx';
import { PnlStatement } from './Finance.jsx';

const TABS = [
  { value: 'pnl', label: 'Profit & Loss', icon: TrendingUp },
  { value: 'bs', label: 'Balance Sheet', icon: BankIcon },
  { value: 'tb', label: 'Trial Balance', icon: Scale },
  { value: 'journal', label: 'Day Book', icon: BookOpen },
  { value: 'methods', label: 'Payment Methods', icon: CreditCard },
  { value: 'stock', label: 'Stock Value', icon: Boxes },
];

export default function Reports() {
  const [tab, setTab] = useState('pnl');
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const { settings, fy } = useApp();
  return (
    <>
      <PageHead title="Reports" sub="All figures come straight from the accounting books."
        actions={<button className="btn ro-ok" onClick={() => window.print()}><Printer size={20} /> Print</button>} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab !== 'stock' && (
        <div className="card no-print" style={{ marginBottom: 18 }}>
          <div className="row">
            {!['tb', 'bs'].includes(tab) && <label className="row" style={{ gap: 8 }}><b>From</b><input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
            <label className="row" style={{ gap: 8 }}><b>{['tb', 'bs'].includes(tab) ? 'As on' : 'To'}</b><input className="input" type="date" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <div className="spacer" />
            <button className="btn btn-sm" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
            <button className="btn btn-sm" onClick={() => { setFrom(`${today().slice(0, 7)}-01`); setTo(today()); }}>This month</button>
            <button className="btn btn-sm" onClick={() => { setFrom(fy?.start_date || `${today().slice(0, 4)}-01-01`); setTo(today()); }}>Whole {fy?.name || 'year'}</button>
          </div>
        </div>
      )}
      <div className="print-only" style={{ marginBottom: 12 }}><h2>{settings.company_name} — {TABS.find((t) => t.value === tab).label}</h2></div>
      {tab === 'pnl' && <Pnl from={from} to={to} />}
      {tab === 'tb' && <TrialBalance to={to} />}
      {tab === 'bs' && <BalanceSheet to={to} />}
      {tab === 'journal' && <Journal from={from} to={to} />}
      {tab === 'methods' && <PaymentMethods from={from} to={to} />}
      {tab === 'stock' && <StockValue />}
    </>
  );
}

function Pnl({ from, to }) {
  const q = useFetch(`/reports/pnl?from=${from}&to=${to}`);
  const money = useMoney();
  return (
    <Async q={q}>{(p) => (
      <>
        <div className="grid grid-4">
          <Stat label="Sales" value={money(p.sales)} />
          <Stat label="Gross profit" value={money(p.gross_profit)} hint={p.sales ? `${((p.gross_profit / p.sales) * 100).toFixed(1)}% of sales` : undefined} />
          <Stat label="Expenses & payroll" value={money(p.total_expenses)} />
          <Stat label={p.net_profit >= 0 ? 'Net profit' : 'Net loss'} value={money(p.net_profit)} tone={p.net_profit >= 0 ? 'good' : 'bad'} />
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Profit &amp; Loss</h2>
          <div className="muted" style={{ marginBottom: 14 }}>{fmtDate(p.from)} – {fmtDate(p.to)} · compared with {fmtDate(p.previous.from)} – {fmtDate(p.previous.to)}</div>
          <PnlStatement p={p} prev={p.previous} prevLabel="Previous" />
        </div>
      </>
    )}</Async>
  );
}

function BalanceSheet({ to }) {
  const q = useFetch(`/reports/balance-sheet?to=${to}`);
  const money = useMoney();
  const Section = ({ title, rows, total }) => (
    <div className="card">
      <div className="card-head"><h2>{title}</h2><b className="num">{money(total)}</b></div>
      <table className="table"><tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="right num">{money(r.amount)}</td></tr>)}</tbody></table>
    </div>
  );
  return (
    <Async q={q}>{(b) => (
      <>
        {b.balanced ? <Alert type="ok">Balanced on {fmtDate(b.to)}: assets {money(b.total_assets)} = liabilities {money(b.total_liabilities)} + equity {money(b.total_equity)}.</Alert>
          : <Alert type="danger">Not balanced — please contact support.</Alert>}
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <Section title="What the business owns (assets)" rows={b.assets} total={b.total_assets} />
          <div>
            <Section title="What the business owes (liabilities)" rows={b.liabilities} total={b.total_liabilities} />
            <Section title="Owner's share (equity)" rows={b.equity} total={b.total_equity} />
          </div>
        </div>
      </>
    )}</Async>
  );
}

function TrialBalance({ to }) {
  const q = useFetch(`/reports/trial-balance?to=${to}`);
  const money = useMoney();
  return (
    <Async q={q}>{(t) => (
      <div className="card">
        <div className="card-head"><h2>Trial balance as on {fmtDate(t.to)}</h2>
          {Math.abs(t.total_debit - t.total_credit) < 0.01 ? <span className="badge badge-ok"><CheckCircle2 size={14} /> Books balanced</span> : <span className="badge badge-danger"><AlertTriangle size={14} /> Not balanced</span>}
        </div>
        <DataTable rows={t.rows} searchKeys={['name', 'code']} placeholder="Search account…"
          columns={[
            { key: 'code', label: 'Code', render: (r) => <span className="mono">{r.code}</span> },
            { key: 'name', label: 'Account', render: (r) => <b>{r.name}</b> },
            { key: 'type', label: 'Type', render: (r) => <span style={{ textTransform: 'capitalize' }}>{r.type}</span> },
            { key: 'debit', label: 'Debit', className: 'right', render: (r) => (r.debit ? <span className="num">{money(r.debit)}</span> : '') },
            { key: 'credit', label: 'Credit', className: 'right', render: (r) => (r.credit ? <span className="num">{money(r.credit)}</span> : '') },
          ]}
          footer={<tr><td colSpan={3}>Total</td><td className="right num">{money(t.total_debit)}</td><td className="right num">{money(t.total_credit)}</td></tr>} />
      </div>
    )}</Async>
  );
}

function Journal({ from, to }) {
  const [method, setMethod] = useState('');
  const q = useFetch(`/reports/journal?from=${from}&to=${to}${method ? `&method=${method}` : ''}`);
  const money = useMoney();
  return (
    <Async q={q}>{(j) => (
      <div className="card">
        <div className="card-head"><h2>Day book (all accounting entries)</h2><MethodFilter value={method} onChange={setMethod} withTransfer /></div>
        {j.entries.length === 0 ? <Alert>No entries in this period.</Alert> : j.entries.map((e) => (
          <div key={e.id} className="material">
            <div className="row"><b>{e.memo}</b>{(e.methods || '').split(',').filter(Boolean).map((m) => <MethodBadge key={m} method={m} small />)}<div className="spacer" /><span className="muted small">{fmtDate(e.date)} · #{e.id}{e.user_name ? ` · ${e.user_name}` : ''}</span></div>
            <table className="table" style={{ marginTop: 8 }}>
              <tbody>{e.lines.map((l) => (
                <tr key={l.id}>
                  <td style={{ paddingLeft: l.credit ? 36 : 14 }}>{l.account_name}{(l.party_name || l.employee_name) && <span className="muted"> · {l.party_name || l.employee_name}</span>}</td>
                  <td className="right num" style={{ width: 150 }}>{l.debit ? money(l.debit) : ''}</td>
                  <td className="right num" style={{ width: 150 }}>{l.credit ? money(l.credit) : ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
      </div>
    )}</Async>
  );
}

function PaymentMethods({ from, to }) {
  const q = useFetch(`/reports/payment-methods?from=${from}&to=${to}`);
  const money = useMoney();
  const COLS = ['cash', 'bank_transfer', 'cheque'];
  return (
    <Async q={q}>{(d) => (
      <>
        <div className="grid grid-3">
          {COLS.map((m) => {
            const x = d.methods.find((r) => r.method === m) || { in: 0, out: 0, count: 0 };
            return <Stat key={m} label={METHOD_LABEL[m]} value={<span><span style={{ color: 'var(--ok)' }}>+{money(x.in)}</span><br /><span style={{ color: 'var(--danger)', fontSize: '.8em' }}>−{money(x.out)}</span></span>} hint={`${x.count} transaction${x.count === 1 ? '' : 's'}`} />;
          })}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>Money in and out by method</h2>
          <div className="muted small" style={{ marginBottom: 12 }}>{fmtDate(d.from)} – {fmtDate(d.to)} · + money in, − money out</div>
          {d.purposes.length === 0 ? <Alert>No money movement in this period.</Alert> : (
            <div className="table-wrap"><table className="table responsive">
              <thead><tr><th>For</th>{COLS.map((m) => <th key={m} className="right">{METHOD_LABEL[m]}</th>)}<th className="right">Transfers</th></tr></thead>
              <tbody>{d.purposes.map((p) => (
                <tr key={p.purpose}>
                  <td><b>{p.purpose}</b></td>
                  {COLS.map((m) => <td key={m} data-label={METHOD_LABEL[m]} className="right num" style={{ color: p[m] > 0 ? 'var(--ok)' : p[m] < 0 ? 'var(--danger)' : 'var(--text-3)' }}>{p[m] ? `${p[m] > 0 ? '+' : '−'}${money(Math.abs(p[m]))}` : '—'}</td>)}
                  <td data-label="Transfers" className="right num muted">{p.transfer ? money(Math.abs(p.transfer)) : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>By account</h2>
          <div className="table-wrap"><table className="table responsive">
            <thead><tr><th>Account</th><th className="right">Money in</th><th className="right">Money out</th><th className="right">Net</th></tr></thead>
            <tbody>{d.accounts.map((a) => (
              <tr key={a.id}><td><b>{a.name}</b> <span className="muted small">{a.fund_type}</span></td>
                <td data-label="Money in" className="right num" style={{ color: 'var(--ok)' }}>{money(a.in)}</td>
                <td data-label="Money out" className="right num" style={{ color: 'var(--danger)' }}>{money(a.out)}</td>
                <td data-label="Net" className="right num"><b>{money(a.in - a.out)}</b></td></tr>
            ))}</tbody>
          </table></div>
        </div>
      </>
    )}</Async>
  );
}

function StockValue() {
  const q = useFetch('/reports/stock-valuation');
  const money = useMoney();
  return (
    <Async q={q}>{(s) => {
      const ok = Math.abs(s.raw.register - s.raw.books) < 1 && Math.abs(s.goods.register - s.goods.books) < 1;
      return (
        <>
          <div className="grid grid-3">
            <Stat label="Raw materials (weighted avg)" value={money(s.raw.register)} />
            <Stat label="Finished & trading goods" value={money(s.goods.register)} />
            <Stat label="Total stock value" value={money(s.raw.register + s.goods.register)} />
          </div>
          <div style={{ marginTop: 14 }}>{ok ? <Alert type="ok">Stock registers match the accounting books.</Alert>
            : <Alert type="warn">Stock register and books differ (raw {money(s.raw.register - s.raw.books)}, goods {money(s.goods.register - s.goods.books)}). This is usually small rounding.</Alert>}</div>
          <div className="card">
            <DataTable rows={s.items} searchKeys={['name', 'kind', 'container']} placeholder="Search items…"
              columns={[
                { key: 'name', label: 'Item', render: (i) => <div><b>{i.name}</b><div className="small muted">{KIND_LABEL[i.kind]}{i.container ? ` · ${i.container}` : ''}</div></div> },
                { key: 'stock', label: 'Qty', className: 'right', render: (i) => <span className="num">{qty(i.stock, i.unit)}</span> },
                { key: 'unit_cost', label: 'Cost / unit', className: 'right', render: (i) => <span className="num">{money(i.unit_cost)}</span> },
                { key: 'value', label: 'Value', className: 'right', render: (i) => <b className="num">{money(i.value)}</b> },
              ]} />
          </div>
        </>
      );
    }}</Async>
  );
}
