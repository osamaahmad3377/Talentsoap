// Cash & Bank: live balances of every cash box and bank account, the fund ledger,
// internal transfers, money in/out and cheque clearing.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, Plus, Trash2, Wallet, Landmark, Pencil, CheckCircle2, XCircle, Printer, ChevronLeft, ChevronRight, FileCheck2,
} from 'lucide-react';
import { useFetch, useMoney, useAction, api, fmtDate, today, thisMonth, fyStartMonth, monthName } from '../lib.jsx';
import { PageHead, Async, Stat, Field, NumberInput, Modal, Confirm, Empty, Badge, Alert } from '../components.jsx';
import { PaymentPicker, MethodBadge, MethodFilter, emptyPayment, paymentBody } from '../payment.jsx';

const shiftMonth = (m, n) => { const d = new Date(`${m}-15T12:00:00`); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-CA').slice(0, 7); };
const LINK = { sale: (id) => `/sales/${id}`, sale_return: (id) => `/returns/${id}`, sale_return_cancel: (id) => `/returns/${id}`, purchase: (id) => `/purchases/${id}`, payment: null, expense: () => '/expenses', payroll: () => '/staff' };
const DELETABLE = ['cash', 'payment', 'transfer', 'expense'];
const masked = (n) => (n ? `•••• ${String(n).slice(-4)}` : '');

export default function CashBank() {
  const fundsQ = useFetch('/funds');
  const money = useMoney();
  const [account, setAccount] = useState(''); // '' = all accounts
  const [modal, setModal] = useState(null); // 'transfer' | 'in' | 'out' | 'add' | {edit}
  const reloadAll = () => { fundsQ.reload(); setTick((t) => t + 1); };
  const [tick, setTick] = useState(0);

  return (
    <>
      <PageHead title="Cash & Bank" sub="Live balance of every cash box and bank account. Every sale, purchase, expense and salary updates it automatically."
        actions={<>
          <button className="btn btn-primary btn-lg" onClick={() => setModal('transfer')}><ArrowLeftRight size={22} /> Transfer money</button>
          <button className="btn btn-in" onClick={() => setModal('in')}><ArrowDownCircle size={20} /> Money in</button>
          <button className="btn btn-out" onClick={() => setModal('out')}><ArrowUpCircle size={20} /> Money out</button>
        </>} />

      <Async q={fundsQ}>{({ accounts, totals }) => {
        const pending = accounts.reduce((s, a) => s + a.pending_count, 0);
        return (
          <>
            <div className="grid grid-3">
              <Stat icon={Wallet} label="Total cash in hand" value={money(totals.cash)} tone={totals.cash < 0 ? 'bad' : ''} />
              <Stat icon={Landmark} label="Total in bank" value={money(totals.bank)} tone={totals.bank < 0 ? 'bad' : ''} hint={pending ? `${pending} cheque${pending > 1 ? 's' : ''} not cleared yet` : undefined} />
              <Stat label="All money" value={money(totals.all)} hint="cash + bank" />
            </div>

            <div className="fund-cards">
              <button className={`fund-card all ${account === '' ? 'on' : ''}`} onClick={() => setAccount('')}>
                <div className="fc-name">All accounts</div>
                <div className="fc-bal num">{money(totals.all)}</div>
                <div className="small muted">{accounts.length} accounts</div>
              </button>
              {accounts.map((a) => (
                <div key={a.id} className={`fund-card ${String(account) === String(a.id) ? 'on' : ''}`} role="button" tabIndex={0}
                  onClick={() => setAccount(a.id)} onKeyDown={(e) => e.key === 'Enter' && setAccount(a.id)}>
                  <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    {a.fund_type === 'cash' ? <Wallet size={20} /> : <Landmark size={20} />}
                    <div className="fc-name" style={{ flex: 1 }}>{a.name}</div>
                    <button className="btn btn-ghost btn-sm w" aria-label={`Edit ${a.name}`} onClick={(e) => { e.stopPropagation(); setModal({ edit: a }); }}><Pencil size={16} /></button>
                  </div>
                  {a.fund_type === 'bank' && (a.bank_name || a.account_number) && <div className="small muted">{a.bank_name} {masked(a.account_number)}</div>}
                  <div className="fc-bal num" style={{ color: a.balance < 0 ? 'var(--danger)' : undefined }}>{money(a.balance)}</div>
                  <div className="small"><span style={{ color: 'var(--ok)' }}>+{money(a.today_in)}</span> · <span style={{ color: 'var(--danger)' }}>−{money(a.today_out)}</span> <span className="muted">today</span></div>
                  {a.pending_count > 0 && <div style={{ marginTop: 4 }}><Badge tone="warn"><FileCheck2 size={12} /> {a.pending_count} cheque{a.pending_count > 1 ? 's' : ''} {money(Math.abs(a.pending_cheques))} not cleared</Badge></div>}
                </div>
              ))}
              <button className="fund-card add w" onClick={() => setModal('add')}><Plus size={26} /><div className="fc-name">Add account</div><div className="small muted">bank or cash box</div></button>
            </div>

            {pending > 0 && <PendingCheques account={account} money={money} onDone={reloadAll} key={`p${tick}`} />}
            <Ledger account={account} accounts={accounts} money={money} onChanged={reloadAll} key={`l${tick}`} />

            {modal === 'transfer' && <TransferModal accounts={accounts} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); }} />}
            {(modal === 'in' || modal === 'out') && <MoneyInOut direction={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); }} />}
            {modal === 'add' && <AccountForm onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); }} />}
            {modal?.edit && <AccountForm account={modal.edit} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadAll(); }} />}
          </>
        );
      }}</Async>
    </>
  );
}

/** Cheques recorded but not yet confirmed by the bank. */
function PendingCheques({ account, money, onDone }) {
  const q = useFetch(`/funds/transactions?cheque=pending${account ? `&account_id=${account}` : ''}`);
  const [act, setAct] = useState(null); // { f, kind }
  const [run, busy] = useAction();
  if (!q.data || q.data.rows.length === 0) return null;
  return (
    <div className="card">
      <div className="card-head"><h2><FileCheck2 size={20} style={{ verticalAlign: -3 }} /> Cheques not cleared yet</h2><span className="small muted">Mark each one when the bank confirms it</span></div>
      <div className="stack" style={{ gap: 0 }}>
        {q.data.rows.map((f) => (
          <div key={f.id} className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: '1 1 260px' }}>
              <b>{f.direction === 'in' ? 'Received' : 'Issued'} cheque{f.cheque_no ? ` #${f.cheque_no}` : ''}</b> <span className="muted">· {f.party_name || f.employee_name || f.purpose}</span>
              <div className="small muted">{fmtDate(f.date)} · {f.account_name}{f.bank_name ? ` · ${f.bank_name}` : ''}{f.cheque_date ? ` · cheque date ${fmtDate(f.cheque_date)}` : ''}</div>
            </div>
            <b className="num" style={{ color: f.direction === 'in' ? 'var(--ok)' : 'var(--danger)' }}>{f.direction === 'in' ? '+' : '−'}{money(f.amount)}</b>
            <button className="btn btn-sm btn-in w" onClick={() => setAct({ f, kind: 'clear' })}><CheckCircle2 size={16} /> Cleared</button>
            {['sale', 'purchase', 'payment'].includes(f.ref_type) && <button className="btn btn-sm w" onClick={() => setAct({ f, kind: 'bounce' })}><XCircle size={16} /> Bounced</button>}
          </div>
        ))}
      </div>
      {act && (
        <Confirm title={act.kind === 'clear' ? 'Cheque cleared?' : 'Cheque bounced?'} danger={act.kind === 'bounce'} busy={busy}
          confirmLabel={act.kind === 'clear' ? 'Yes, it cleared' : 'Yes, it bounced'}
          message={act.kind === 'clear'
            ? `Mark cheque${act.f.cheque_no ? ` #${act.f.cheque_no}` : ''} for ${money(act.f.amount)} as cleared by the bank.`
            : `${money(act.f.amount)} will be taken back out of ${act.f.account_name}${act.f.direction === 'in' ? ` and ${act.f.party_name || 'the customer'} will owe it again` : ` and you will owe ${act.f.party_name || 'the supplier'} again`}.`}
          onClose={() => setAct(null)}
          onConfirm={() => run(() => api.post(`/funds/transactions/${act.f.id}/${act.kind}`, { date: today() }), act.kind === 'clear' ? 'Cheque cleared' : 'Cheque marked bounced — payment reversed')
            .then((r) => { setAct(null); if (r) { q.reload(); onDone(); } })} />
      )}
    </div>
  );
}

/** Account statement with filters: month or dates, method, in/out, search. */
function Ledger({ account, accounts, money, onChanged }) {
  const [mode, setMode] = useState('month');
  const [month, setMonth] = useState(thisMonth());
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [method, setMethod] = useState('');
  const [direction, setDirection] = useState('');
  const [search, setSearch] = useState('');
  const [del, setDel] = useState(null);
  const [run, busy] = useAction();
  const qs = new URLSearchParams(mode === 'month' ? { month } : { from, to });
  if (account) qs.set('account_id', account);
  if (method) qs.set('method', method);
  if (direction) qs.set('direction', direction);
  if (search.trim()) qs.set('q', search.trim());
  const q = useFetch(`/funds/transactions?${qs}`);
  const acc = accounts.find((a) => String(a.id) === String(account));
  const title = `${acc ? acc.name : 'All accounts'} — ${mode === 'month' ? monthName(month) : `${fmtDate(from)} – ${fmtDate(to)}`}`;

  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <button className="btn btn-sm no-print" onClick={() => window.print()}><Printer size={16} /> Print</button>
      </div>
      <div className="no-print">
        <div className="row">
          <div className="choice seg">
            <button className={`btn btn-sm ${mode === 'month' ? 'on' : ''}`} onClick={() => setMode('month')}>By month</button>
            <button className={`btn btn-sm ${mode === 'range' ? 'on' : ''}`} onClick={() => setMode('range')}>By dates</button>
          </div>
          {mode === 'month' ? (
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= fyStartMonth()} aria-label="Previous month"><ChevronLeft size={22} /></button>
              <input className="input" type="month" style={{ width: 'auto' }} value={month} min={fyStartMonth()} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
              <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label="Next month"><ChevronRight size={22} /></button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} aria-label="From" />
              <span>to</span>
              <input className="input" type="date" style={{ width: 'auto' }} value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              <button className="btn btn-sm" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <MethodFilter value={method} onChange={setMethod} withTransfer />
          <div className="choice seg">
            {[['', 'In & out'], ['in', 'Money in'], ['out', 'Money out']].map(([v, l]) => <button key={v || 'both'} className={`btn btn-sm ${direction === v ? 'on' : ''}`} onClick={() => setDirection(v)}>{l}</button>)}
          </div>
          <input className="input" type="search" style={{ flex: '1 1 200px' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, cheque no., reference…" aria-label="Search transactions" />
        </div>
      </div>

      <Async q={q}>{(d) => (
        <>
          <div className="grid grid-4" style={{ margin: '14px 0' }}>
            <Stat label="Opening balance" value={d.opening === null ? '—' : money(d.opening)} hint={d.opening === null ? 'not shown when filtered' : `on ${fmtDate(d.from)}`} />
            <Stat label="Money in" value={money(d.total_in)} tone="good" />
            <Stat label="Money out" value={money(d.total_out)} tone="bad" />
            <Stat label="Closing balance" value={d.closing === null ? '—' : money(d.closing)} hint={d.closing === null ? 'clear filters to see' : `on ${fmtDate(d.to)}`} />
          </div>
          {d.by_method.length > 1 && (
            <div className="row small" style={{ gap: 8, marginBottom: 12 }}>
              {d.by_method.map((m) => <span key={m.method} className="method-sum"><MethodBadge method={m.method} small /> <span style={{ color: 'var(--ok)' }}>+{money(m.in)}</span> <span style={{ color: 'var(--danger)' }}>−{money(m.out)}</span></span>)}
            </div>
          )}
          {d.rows.length === 0 ? <Empty>No money movement for this filter.</Empty> : (
            <div className="table-wrap"><table className="table responsive responsive-lg">
              <thead><tr><th>Date</th><th style={{ width: '38%' }}>Details</th><th>Method</th><th className="right">In</th><th className="right">Out</th>{d.closing !== null && <th className="right">Balance</th>}<th className="no-print" /></tr></thead>
              <tbody>{d.rows.map((f) => {
                const link = LINK[f.ref_type]?.(f.ref_id) ?? (f.ref_type === 'payment' && f.party_id ? `/parties/${f.party_id}` : null);
                return (
                  <tr key={f.id}>
                    <td className="nowrap"><b>{fmtDate(f.date)}</b></td>
                    <td data-label="Details">{link ? <Link to={link}>{f.memo}</Link> : f.memo}<div className="small muted">{f.purpose}{f.party_name ? ` · ${f.party_name}` : ''}{f.employee_name ? ` · ${f.employee_name}` : ''}</div></td>
                    <td data-label="Method"><MethodBadge method={f.method} chequeNo={f.cheque_no} status={f.reverses_id ? null : f.cheque_status} reference={f.reference} />
                      <div className="small muted">{!account && f.account_name}{!account && f.bank_name ? ' · ' : ''}{f.bank_name}</div></td>
                    <td data-label="In" className="right num" style={{ color: 'var(--ok)', fontWeight: 700 }}>{f.direction === 'in' ? money(f.amount) : ''}</td>
                    <td data-label="Out" className="right num" style={{ color: 'var(--danger)', fontWeight: 700 }}>{f.direction === 'out' ? money(f.amount) : ''}</td>
                    {d.closing !== null && <td data-label="Balance" className="right num"><b>{money(f.balance)}</b></td>}
                    <td className="no-print right" data-label="">{DELETABLE.includes(f.ref_type) && f.cheque_status !== 'bounced' && <button className="btn btn-ghost btn-sm w" aria-label="Delete entry" onClick={() => setDel(f)}><Trash2 size={18} /></button>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </>
      )}</Async>
      {del && <Confirm title="Delete this entry?" danger busy={busy} confirmLabel="Delete"
        message={`“${del.memo}” (${money(del.amount)}) will be removed from ${del.ref_type === 'transfer' ? 'both accounts' : 'the books'}.`}
        onClose={() => setDel(null)} onConfirm={() => run(() => api.del(`/cash/${del.entry_id}`), 'Entry deleted').then(() => { setDel(null); q.reload(); onChanged(); })} />}
    </div>
  );
}

/** Move money between own accounts. */
function TransferModal({ accounts, onClose, onSaved }) {
  const money = useMoney();
  const open = accounts.filter((a) => a.active);
  const cash = open.find((a) => a.fund_type === 'cash');
  const bank = open.find((a) => a.fund_type === 'bank');
  const [f, setF] = useState({ from_account_id: cash?.id || '', to_account_id: bank?.id || '', amount: '', date: today(), note: '', reference: '' });
  const [run, busy] = useAction();
  const from = open.find((a) => a.id === Number(f.from_account_id));
  const to = open.find((a) => a.id === Number(f.to_account_id));
  const amount = Number(f.amount) || 0;
  const tooMuch = from && amount > from.balance + 0.005;
  const preset = (fromType, toType) => setF((x) => ({ ...x, from_account_id: open.find((a) => a.fund_type === fromType)?.id || '', to_account_id: open.find((a) => a.fund_type === toType)?.id || '' }));
  const Pick = ({ label, value, onPick, exclude }) => (
    <Field label={label}>
      <div className="choice">{open.filter((a) => a.id !== exclude).map((a) => (
        <button key={a.id} type="button" className={`btn ${Number(value) === a.id ? 'on' : ''}`} onClick={() => onPick(a.id)}>
          {a.fund_type === 'cash' ? <Wallet size={18} /> : <Landmark size={18} />} {a.name}<span className="small" style={{ opacity: .8 }}>&nbsp;{money(a.balance)}</span>
        </button>
      ))}</div>
    </Field>
  );
  return (
    <Modal title="Transfer money between accounts" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !from || !to || from.id === to.id || !(amount > 0) || tooMuch}
          onClick={() => run(() => api.post('/funds/transfer', f), 'Transfer saved').then((r) => r && onSaved())}><ArrowLeftRight size={20} /> Transfer {amount ? money(amount) : ''}</button></>}>
      <div className="stack">
        <div className="choice">
          <button type="button" className="btn" onClick={() => preset('cash', 'bank')}>Deposit cash into bank</button>
          <button type="button" className="btn" onClick={() => preset('bank', 'cash')}>Withdraw cash from bank</button>
        </div>
        <Pick label="From" value={f.from_account_id} onPick={(id) => setF((x) => ({ ...x, from_account_id: id, to_account_id: Number(x.to_account_id) === id ? '' : x.to_account_id }))} />
        <Pick label="To" value={f.to_account_id} exclude={Number(f.from_account_id)} onPick={(id) => setF((x) => ({ ...x, to_account_id: id }))} />
        <div className="grid grid-2">
          <Field label="Amount"><NumberInput className="big" value={f.amount} onChange={(v) => setF((x) => ({ ...x, amount: v }))} /></Field>
          <Field label="Date"><input className="input big" type="date" value={f.date} max={today()} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} /></Field>
        </div>
        {tooMuch && <Alert type="danger">Only {money(from.balance)} is in {from.name}.</Alert>}
        {from && to && amount > 0 && !tooMuch && <div className="muted">{from.name}: {money(from.balance)} → <b>{money(from.balance - amount)}</b> · {to.name}: {money(to.balance)} → <b>{money(to.balance + amount)}</b></div>}
        <div className="grid grid-2">
          <Field label="Note (optional)"><input className="input" value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} placeholder="e.g. Daily cash deposit" /></Field>
          <Field label="Deposit slip / reference (optional)"><input className="input" value={f.reference} onChange={(e) => setF((x) => ({ ...x, reference: e.target.value }))} /></Field>
        </div>
      </div>
    </Modal>
  );
}

/** Other money in (owner investment, other income) or out (expense, owner withdrawal). */
function MoneyInOut({ direction, onClose, onSaved }) {
  const catQ = useFetch('/cash/categories');
  const fundsQ = useFetch('/accounts/cash');
  const [f, setF] = useState({ category_id: '', amount: '', date: today(), note: '' });
  const [pay, setPay] = useState(emptyPayment);
  const [run, busy] = useAction();
  const isIn = direction === 'in';
  const cats = catQ.data ? (isIn ? catQ.data.in : catQ.data.out) : [];
  return (
    <Modal title={isIn ? 'Money in' : 'Money out'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${isIn ? 'btn-in' : 'btn-out'}`} disabled={busy || !f.category_id || !(Number(f.amount) > 0)}
          onClick={() => run(() => api.post('/cash', { ...f, direction, ...paymentBody(pay) }), 'Saved').then((r) => r && onSaved())}>Save</button></>}>
      <div className="stack">
        <Field label="Amount"><NumberInput className="big" autoFocus value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label={isIn ? 'Where did it come from?' : 'What was it for?'}>
          <div className="choice">{cats.map((c) => <button key={c.id} className={`btn ${Number(f.category_id) === c.id ? 'on' : ''}`} onClick={() => setF({ ...f, category_id: c.id })}>{c.name}</button>)}</div>
        </Field>
        <PaymentPicker value={pay} onChange={setPay} funds={fundsQ.data || []} direction={direction} amount={Number(f.amount) || 0} />
        <Field label="Date"><input className="input" type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Optional" /></Field>
        <div className="small muted">Customer and supplier payments are entered from their own screens. To move money between your own accounts use <b>Transfer money</b>.</div>
      </div>
    </Modal>
  );
}

/** Open a new bank account / cash box, or rename / close one. */
function AccountForm({ account, onClose, onSaved }) {
  const isNew = !account;
  const [f, setF] = useState(account
    ? { name: account.name, bank_name: account.bank_name || '', account_number: account.account_number || '' }
    : { fund_type: 'bank', name: '', bank_name: '', account_number: '', opening_balance: '', opening_date: today() });
  const [run, busy] = useAction();
  const type = account?.fund_type || f.fund_type;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const save = () => run(() => (isNew ? api.post('/funds', f) : api.put(`/funds/${account.id}`, f)), isNew ? 'Account added' : 'Saved').then((r) => r && onSaved());
  const close = () => run(() => api.put(`/funds/${account.id}`, { active: false }), 'Account closed').then((r) => r && onSaved());
  return (
    <Modal title={isNew ? 'Add account' : `Edit ${account.name}`} onClose={onClose}
      footer={<>{!isNew && <button className="btn btn-ghost" disabled={busy} onClick={close}>Close account</button>}<div className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.name?.trim()} onClick={save}>Save</button></>}>
      <div className="stack">
        {isNew && (
          <div className="type-cards">
            <button className={`type-card ${type === 'bank' ? 'on' : ''}`} onClick={() => setF({ ...f, fund_type: 'bank' })}><Landmark size={28} /><b>Bank account</b><span>Transfers and cheques</span></button>
            <button className={`type-card ${type === 'cash' ? 'on' : ''}`} onClick={() => setF({ ...f, fund_type: 'cash' })}><Wallet size={28} /><b>Cash box</b><span>e.g. petty cash, gate cash</span></button>
          </div>
        )}
        <Field label="Account name"><input className="input" autoFocus value={f.name} onChange={set('name')} placeholder={type === 'bank' ? 'e.g. Meezan Current' : 'e.g. Petty Cash'} /></Field>
        {type === 'bank' && (
          <div className="grid grid-2">
            <Field label="Bank"><input className="input" value={f.bank_name} onChange={set('bank_name')} placeholder="e.g. Meezan Bank" /></Field>
            <Field label="Account no. / IBAN"><input className="input" value={f.account_number} onChange={set('account_number')} /></Field>
          </div>
        )}
        {isNew && (
          <div className="grid grid-2">
            <Field label="Money in it now (opening balance)"><NumberInput value={f.opening_balance} onChange={set('opening_balance')} /></Field>
            <Field label="As on date"><input className="input" type="date" value={f.opening_date} onChange={set('opening_date')} /></Field>
          </div>
        )}
        {!isNew && <div className="small muted">An account can be closed only when its balance is zero. Its history is kept.</div>}
      </div>
    </Modal>
  );
}
