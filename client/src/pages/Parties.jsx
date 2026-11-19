import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Plus, Printer, HandCoins, Pencil, Phone, MapPin } from 'lucide-react';
import { useFetch, useMoney, useApp, useAction, api, fmtDate, today } from '../lib.jsx';
import { PageHead, Async, DataTable, Stat, Field, NumberInput, Modal, Badge } from '../components.jsx';
import { QuickParty } from './Sales.jsx';
import { PaymentPicker, MethodBadge, emptyPayment, paymentBody, useFunds } from '../payment.jsx';

export function PartyList({ type }) {
  const q = useFetch(`/parties?type=${type}`);
  const money = useMoney();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const isC = type === 'customer';
  return (
    <>
      <PageHead title={isC ? 'Customers' : 'Suppliers'} sub={isC ? 'Who owes us money (receivable).' : 'Who we owe money to (payable).'}
        actions={<button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={20} /> {isC ? 'New customer' : 'New supplier'}</button>} />
      <div className="card">
        <Async q={q}>{(rows) => (
          <DataTable rows={rows} searchKeys={['name', 'phone', 'address']} placeholder="Search name or phone…"
            onRow={(p) => nav(`/parties/${p.id}`)} empty="No one added yet."
            columns={[
              { key: 'name', label: 'Name', render: (p) => <div><b>{p.name}</b>{p.address && <div className="small muted">{p.address}</div>}</div> },
              { key: 'phone', label: 'Phone', render: (p) => p.phone || '—' },
              { key: 'balance', label: isC ? 'They owe us' : 'We owe them', className: 'right', render: (p) => (
                <b className="num" style={{ color: p.balance > 0 ? 'var(--danger)' : p.balance < 0 ? 'var(--ok)' : 'var(--text-3)' }}>
                  {p.balance < 0 ? `${money(-p.balance)} advance` : money(p.balance)}
                </b>) },
            ]}
            footer={rows.length > 0 && <tr><td colSpan={2}>Total</td><td className="right num">{money(rows.reduce((s, p) => s + p.balance, 0))}</td></tr>} />
        )}</Async>
      </div>
      {adding && <QuickParty type={type} onClose={() => setAdding(false)} onSaved={(id) => nav(`/parties/${id}`)} />}
    </>
  );
}

const DOC_LINK = { sale: (id) => `/sales/${id}`, purchase: (id) => `/purchases/${id}`, sale_cancel: (id) => `/sales/${id}`, sale_return: (id) => `/returns/${id}`, sale_return_cancel: (id) => `/returns/${id}`, purchase_cancel: (id) => `/purchases/${id}` };

export function PartyLedger() {
  const { id } = useParams();
  const q = useFetch(`/parties/${id}`);
  const money = useMoney();
  const { can, settings } = useApp();
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);

  return (
    <Async q={q}>{(p) => {
      const isC = p.type === 'customer';
      // plain-language columns instead of Debit / Credit
      const plus = isC ? 'Bill / owed' : 'Bill / owed';
      const minus = isC ? 'Received' : 'Paid';
      return (
        <>
          <PageHead back={isC ? '/customers' : '/suppliers'} title={p.name}
            sub={<span className="row" style={{ gap: 14 }}>{p.phone && <span><Phone size={15} style={{ verticalAlign: -2 }} /> {p.phone}</span>}{p.address && <span><MapPin size={15} style={{ verticalAlign: -2 }} /> {p.address}</span>}<Badge>{isC ? 'Customer' : 'Supplier'}</Badge></span>}
            actions={<>
              {can('manager') && <button className="btn btn-primary btn-lg" onClick={() => setPay(true)}><HandCoins size={22} /> {isC ? 'Receive payment' : 'Pay supplier'}</button>}
              <button className="btn ro-ok" onClick={() => window.print()}><Printer size={20} /> Print statement</button>
              {can('manager') && <button className="btn btn-ghost" onClick={() => setEdit(true)}><Pencil size={18} /> Edit</button>}
            </>} />

          <div className="print-only" style={{ marginBottom: 16 }}>
            <h2>{settings.company_name} — Account statement</h2>
            <div>{p.name} · printed {fmtDate(today())}</div>
          </div>

          <div className="grid grid-3">
            <Stat label={isC ? 'They owe us' : 'We owe them'} value={money(Math.abs(p.balance))} tone={p.balance > 0 ? 'bad' : 'good'}
              hint={p.balance < 0 ? (isC ? 'Customer has paid in advance' : 'We have paid in advance') : p.balance === 0 ? 'All settled' : undefined} />
            <Stat label={`Total ${isC ? 'billed' : 'purchased'}`} value={money(p.ledger.reduce((s, l) => s + (isC ? l.debit : l.credit), 0))} />
            <Stat label={`Total ${minus.toLowerCase()}`} value={money(p.ledger.reduce((s, l) => s + (isC ? l.credit : l.debit), 0))} />
          </div>

          <div className="card">
            <div className="card-head"><h2>Account ledger</h2>{p.period && <span className="small muted">{fmtDate(p.period.from)} – {fmtDate(p.period.to)}</span>}</div>
            <DataTable rows={[...[...p.ledger].reverse(), ...(p.opening_balance ? [{ entry_id: 'ob', date: p.period.from, memo: 'Opening balance brought forward from last year', debit: 0, credit: 0, balance: p.opening_balance }] : [])]}
              searchKeys={['memo', 'date']} placeholder="Search entries…" empty="No entries in this financial year."
              columns={[
                { key: 'date', label: 'Date', render: (l) => <span className="nowrap">{fmtDate(l.date)}</span> },
                { key: 'memo', label: 'Details', render: (l) => (
                  <div>{DOC_LINK[l.ref_type] ? <Link to={DOC_LINK[l.ref_type](l.ref_id)}>{l.memo}</Link> : l.memo}
                    {l.method && <div style={{ marginTop: 4 }}><MethodBadge method={l.method} chequeNo={l.cheque_no} status={l.cheque_status} reference={l.reference} /> <span className="small muted">{l.fund_account}</span></div>}</div>) },
                { key: 'plus', label: plus, className: 'right', render: (l) => { const v = isC ? l.debit : l.credit; return v ? <span className="num">{money(v)}</span> : ''; } },
                { key: 'minus', label: minus, className: 'right', render: (l) => { const v = isC ? l.credit : l.debit; return v ? <span className="num" style={{ color: 'var(--ok)' }}>{money(v)}</span> : ''; } },
                { key: 'balance', label: 'Balance', className: 'right', render: (l) => <b className="num">{money(l.balance)}</b> },
              ]} />
          </div>
          {pay && <PaymentModal party={p} onClose={() => setPay(false)} onSaved={() => { setPay(false); q.reload(); }} />}
          {edit && <EditParty party={p} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); q.reload(); }} />}
        </>
      );
    }}</Async>
  );
}

function PaymentModal({ party, onClose, onSaved }) {
  const isC = party.type === 'customer';
  const funds = useFunds();
  const money = useMoney();
  const [f, setF] = useState({ amount: party.balance > 0 ? String(party.balance) : '', date: today(), note: '' });
  const [pay, setPay] = useState(emptyPayment);
  const [run, busy] = useAction();
  const save = () => run(() => api.post(`/parties/${party.id}/payment`, { ...f, ...paymentBody(pay) }), isC ? 'Payment received' : 'Payment recorded').then((r) => r && onSaved());
  return (
    <Modal title={isC ? `Receive from ${party.name}` : `Pay ${party.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${isC ? 'btn-in' : 'btn-out'}`} disabled={busy || !(Number(f.amount) > 0)} onClick={save}>{isC ? 'Save — money received' : 'Save — money paid'}</button></>}>
      <div className="stack">
        <div className="muted">Current balance: <b>{money(party.balance)}</b></div>
        <Field label="Amount"><NumberInput className="big" autoFocus value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <PaymentPicker value={pay} onChange={setPay} funds={funds} direction={isC ? 'in' : 'out'} amount={Number(f.amount) || 0} />
        <Field label="Date"><input className="input" type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Optional" /></Field>
      </div>
    </Modal>
  );
}

function EditParty({ party, onClose, onSaved }) {
  const [f, setF] = useState({ name: party.name, phone: party.phone || '', address: party.address || '', notes: party.notes || '' });
  const [run, busy] = useAction();
  return (
    <Modal title="Edit details" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.name} onClick={() => run(() => api.put(`/parties/${party.id}`, f), 'Saved').then((r) => r && onSaved())}>Save</button></>}>
      <div className="stack">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Notes"><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
