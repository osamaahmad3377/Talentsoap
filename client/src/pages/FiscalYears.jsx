// Financial years: switcher, banner, year list, close & carry-forward wizard, opening balances.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarRange, ChevronDown, Lock, Unlock, CheckCircle2, XCircle, AlertTriangle, ArrowRight, Plus, Pencil, Trash2, Eye, Info,
  Wallet, Landmark, Users, Building2, Boxes, TrendingUp, PartyPopper,
} from 'lucide-react';
import { useApp, useFetch, useMoney, useAction, api, fmtDate, qty, KIND_LABEL } from '../lib.jsx';
import { PageHead, Async, Badge, Stat, Modal, Field, Alert, Empty, Confirm, Tabs, Loading } from '../components.jsx';

const STATE = {
  active: { label: 'Active', tone: 'ok', icon: CheckCircle2 },
  upcoming: { label: 'Upcoming', tone: 'info', icon: CalendarRange },
  ended: { label: 'Ended — not closed', tone: 'warn', icon: AlertTriangle },
  closed: { label: 'Closed / Locked', tone: 'gray', icon: Lock },
};
export function FyBadge({ state }) {
  const s = STATE[state] || STATE.active;
  return <Badge tone={s.tone}><s.icon size={13} /> {s.label}</Badge>;
}
const range = (y) => `${fmtDate(y.start_date)} – ${fmtDate(y.end_date)}`;

/** Year switcher shown in the top bar / sidebar. */
export function FySwitcher({ dark }) {
  const { fy, years, switchFY, can } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const nav = useNavigate();
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!fy) return null;
  const pick = (id) => { setOpen(false); if (id !== fy.id) { switchFY(id); nav('/'); } };
  return (
    <div className={`fy-switch ${dark ? 'dark' : ''}`} ref={ref}>
      <button className="fy-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Change financial year">
        <CalendarRange size={18} />
        <span className="fy-name">{fy.name}</span>
        <span className={`fy-dot ${fy.state}`} aria-hidden />
        <span className="fy-state">{fy.readOnly ? 'Locked' : STATE[fy.state]?.label}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="fy-menu" role="listbox">
          <div className="fy-menu-head">Financial year</div>
          {years.map((y) => (
            <button key={y.id} role="option" aria-selected={y.id === fy.id} className={y.id === fy.id ? 'on' : ''} onClick={() => pick(y.id)}>
              <div><b>{y.name}</b><div className="small muted">{range(y)}</div></div>
              <FyBadge state={y.state} />
            </button>
          ))}
          {can('manager') && <Link to="/financial-years" className="fy-manage" onClick={() => setOpen(false)}><CalendarRange size={16} /> Manage financial years</Link>}
        </div>
      )}
    </div>
  );
}

/** Warning strip when looking at a year other than the current one. */
export function FyBanner() {
  const { fy, years, currentFyId, switchFY } = useApp();
  const nav = useNavigate();
  if (!fy || fy.id === currentFyId) return null;
  const current = years.find((y) => y.id === currentFyId);
  const back = () => { switchFY(currentFyId); nav('/'); };
  return (
    <div className={`fy-banner ${fy.readOnly ? 'locked' : ''} no-print`} role="status">
      {fy.readOnly ? <Lock size={20} /> : <Info size={20} />}
      <div style={{ flex: 1 }}>
        <b>You are viewing {fy.name}</b> ({range(fy)}){fy.readOnly ? ' — closed and locked. Read-only: nothing can be changed.' : ' — not the current year.'}
      </div>
      {current && <button className="btn btn-sm" onClick={back}>Back to {current.name}</button>}
    </div>
  );
}

// =====================================================================
//  Year list (/financial-years)
// =====================================================================
export function FiscalYears() {
  const q = useFetch('/financial-years');
  const { can, switchFY, reloadYears } = useApp();
  const money = useMoney();
  const nav = useNavigate();
  const [edit, setEdit] = useState(null);
  const [reopen, setReopen] = useState(null);
  const [del, setDel] = useState(null);
  const [run, busy] = useAction();
  const refresh = () => { q.reload(); reloadYears(); };

  return (
    <>
      <PageHead title="Financial Years" sub="Each year runs from its start to its end date. Closing a year locks it and carries every balance into the next year."
        actions={can('admin') && <button className="btn btn-primary ro-ok" onClick={() => setEdit({})}><Plus size={20} /> Add year</button>} />
      <Async q={q}>{(d) => {
        const latestClosed = d.years.find((y) => y.status === 'closed');
        return (
          <>
            {d.years.filter((y) => y.state === 'ended').map((y) => (
              <div key={y.id} style={{ marginBottom: 14 }}>
                <Alert type="warn"><b>{y.name} has ended.</b> When all its sales, purchases, expenses and salaries are entered, close it to lock it and carry balances forward.
                  {can('manager') && <> <Link to={`/financial-years/${y.id}/close`}>Close {y.name} now →</Link></>}</Alert>
              </div>
            ))}
            <div className="fy-list">
              {d.years.map((y) => (
                <div key={y.id} className={`card fy-card ${y.id === d.current_id ? 'current' : ''}`}>
                  <div className="row">
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div className="row" style={{ gap: 8 }}><h2>{y.name}</h2><FyBadge state={y.state} />{y.id === d.current_id && <Badge tone="info">Current year</Badge>}</div>
                      <div className="muted">{range(y)} · {y.entries} accounting entries</div>
                    </div>
                    <div className="right">
                      {y.status === 'closed'
                        ? <><div className="small muted">Profit moved to Retained Earnings</div><b className="num" style={{ fontSize: '1.3rem', color: y.net_profit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{money(y.net_profit)}</b></>
                        : <><div className="small muted">Profit so far</div><b className="num" style={{ fontSize: '1.3rem' }}>{money(y.profit_so_far)}</b></>}
                    </div>
                  </div>
                  {y.status === 'closed' && y.closing_summary && (
                    <div className="row small muted" style={{ marginTop: 8, gap: 14 }}>
                      <span>Closed {fmtDate(y.closed_at?.slice(0, 10))}</span>
                      <span>Cash {money(y.closing_summary.cash)}</span><span>Bank {money(y.closing_summary.bank)}</span>
                      <span>Customers owe {money(y.closing_summary.receivable)}</span><span>Stock {money(y.closing_summary.stock_raw + y.closing_summary.stock_goods)}</span>
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 12, gap: 8 }}>
                    <button className="btn btn-sm ro-ok" onClick={() => { switchFY(y.id); nav('/'); }}><Eye size={16} /> View this year</button>
                    {y.opening_balances > 0 && <Link className="btn btn-sm ro-ok" to={`/financial-years/${y.id}/opening`}><ArrowRight size={16} /> Opening balances</Link>}
                    {y.status === 'open' && can('manager') && <Link className="btn btn-sm ro-ok" to={`/financial-years/${y.id}/close`}><Lock size={16} /> Close year…</Link>}
                    {y.status === 'closed' && can('admin') && latestClosed?.id === y.id && <button className="btn btn-sm btn-ghost ro-ok" onClick={() => setReopen(y)}><Unlock size={16} /> Reopen</button>}
                    {y.status === 'open' && can('admin') && <button className="btn btn-sm btn-ghost ro-ok" onClick={() => setEdit(y)}><Pencil size={16} /> Edit dates</button>}
                    {y.status === 'open' && can('admin') && y.entries === 0 && <button className="btn btn-sm btn-ghost ro-ok" onClick={() => setDel(y)}><Trash2 size={16} /> Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      }}</Async>
      {edit && <YearForm year={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {reopen && <Confirm title={`Reopen ${reopen.name}?`} danger busy={busy} confirmLabel="Yes, reopen"
        message="The year-end closing entry and the carried-forward balances will be removed and the year unlocked for corrections. Close it again when you are done."
        onClose={() => setReopen(null)} onConfirm={() => run(() => api.post(`/financial-years/${reopen.id}/reopen`), `${reopen.name} reopened`).then((r) => { setReopen(null); if (r) refresh(); })} />}
      {del && <Confirm title={`Delete ${del.name}?`} danger busy={busy} confirmLabel="Delete" message="This year has no entries and will be removed."
        onClose={() => setDel(null)} onConfirm={() => run(() => api.del(`/financial-years/${del.id}`), 'Year deleted').then((r) => { setDel(null); if (r) refresh(); })} />}
    </>
  );
}

function YearForm({ year, onClose, onSaved }) {
  const isNew = !year.id;
  const [f, setF] = useState({ name: year.name || '', start_date: year.start_date || '', end_date: year.end_date || '' });
  const [run, busy] = useAction();
  const save = () => run(() => (isNew ? api.post('/financial-years', f) : api.put(`/financial-years/${year.id}`, f)), 'Saved').then((r) => r && onSaved());
  return (
    <Modal title={isNew ? 'Add financial year' : `Edit ${year.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.start_date || !f.end_date} onClick={save}>Save</button></>}>
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Starts on"><input className="input" type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
          <Field label="Ends on"><input className="input" type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
        </div>
        <Field label="Name" help="Leave empty for automatic, e.g. FY 2026-27"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="FY 2026-27" /></Field>
        <div className="small muted">Pakistan's usual year is 1 July – 30 June. Years cannot overlap.</div>
      </div>
    </Modal>
  );
}

// =====================================================================
//  Close & carry-forward wizard (/financial-years/:id/close)
// =====================================================================
export function CloseYearWizard() {
  const { id } = useParams();
  const q = useFetch(`/financial-years/${id}/closing-preview`);
  const money = useMoney();
  const { reloadYears, switchFY, currentFyId } = useApp();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [confirm, setConfirm] = useState('');
  const [ticks, setTicks] = useState({ a: false, b: false, c: false });
  const [nextEnd, setNextEnd] = useState('');
  const [done, setDone] = useState(null);
  const [run, busy] = useAction();

  if (q.loading && !q.data) return <Loading />;
  return (
    <Async q={q}>{(d) => {
      const y = d.year, t = d.position.totals;
      if (done) {
        return (
          <>
            <PageHead title={`${done.closed} is closed`} back="/financial-years" />
            <div className="card center" style={{ padding: 32 }}>
              <PartyPopper size={48} style={{ color: 'var(--ok)' }} />
              <h2 style={{ margin: '10px 0' }}>{done.closed} is locked. {done.next_year} has started with all balances carried forward.</h2>
              <p className="muted">{done.net_profit >= 0 ? 'Profit' : 'Loss'} of <b>{money(done.net_profit)}</b> moved to Retained Earnings.</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn btn-primary btn-lg" onClick={() => { switchFY(done.next_year_id); nav('/'); }}>Go to {done.next_year}</button>
                <Link className="btn btn-lg" to={`/financial-years/${done.next_year_id}/opening`}>See opening balances</Link>
              </div>
            </div>
          </>
        );
      }
      const canClose = d.blockers.length === 0;
      const ready = canClose && ticks.a && ticks.b && ticks.c && confirm.trim().toUpperCase() === y.name.toUpperCase();
      const nextName = d.next.name;
      return (
        <>
          <PageHead back="/financial-years" title={`Close ${y.name} & start ${nextName}`} sub={`${range(y)} · ${y.entries} entries`} />
          <div className="wizard-steps">
            {['Check', 'Review balances', 'Confirm'].map((s, i) => (
              <button key={s} className={`ws ${step === i + 1 ? 'on' : ''} ${step > i + 1 ? 'done' : ''}`} onClick={() => (i + 1 < step || canClose) && setStep(i + 1)} disabled={i + 1 > step && !canClose}>
                <span className="ws-n">{step > i + 1 ? '✓' : i + 1}</span>{s}
              </button>
            ))}
          </div>

          {step === 1 && (
            <div className="card stack">
              <h2>1. Is the year ready to close?</h2>
              {d.blockers.map((b, i) => <div key={i} className="check bad"><XCircle size={22} /><span>{b}</span></div>)}
              {d.warnings.map((w, i) => <div key={i} className="check warn"><AlertTriangle size={22} /><span>{w}</span></div>)}
              {canClose && <div className="check ok"><CheckCircle2 size={22} /><span>No blocking problems found. The books balance (Dr {money(t.trial_debit)} = Cr {money(t.trial_credit)}).</span></div>}
              <div className="check info"><Info size={22} /><span>{d.next.exists ? <>Balances will be carried into <b>{nextName}</b> ({range(d.next)}), which already exists.</> : <><b>{nextName}</b> will be created automatically starting {fmtDate(d.next.start_date)}.</>}</span></div>
              <div className="row"><div className="spacer" /><button className="btn btn-primary btn-lg" disabled={!canClose} onClick={() => setStep(2)}>Next: review balances <ArrowRight size={20} /></button></div>
            </div>
          )}

          {step === 2 && (
            <>
              <Alert type="info">These are the balances on <b>{fmtDate(y.end_date)}</b>. They become the <b>opening balances of {nextName}</b>.</Alert>
              <div className="grid grid-3" style={{ marginTop: 14 }}>
                <Stat icon={TrendingUp} label={`${d.position.net_profit >= 0 ? 'Profit' : 'Loss'} → Retained Earnings`} value={money(d.position.net_profit)} tone={d.position.net_profit >= 0 ? 'good' : 'bad'}
                  hint={`Sales ${money(d.position.pnl.sales)} − cost ${money(d.position.pnl.cogs)} − expenses ${money(d.position.pnl.operating.total)} − salaries ${money(d.position.pnl.payroll.total)}`} />
                <Stat icon={Wallet} label="Cash in hand" value={money(t.cash)} />
                <Stat icon={Landmark} label="Bank" value={money(t.bank)} />
                <Stat icon={Users} label="Customers owe us" value={money(t.receivable)} />
                <Stat icon={Building2} label="We owe suppliers" value={money(t.payable)} />
                <Stat icon={Boxes} label="Stock value" value={money(t.stock_raw + t.stock_goods)} hint={`Raw ${money(t.stock_raw)} · Goods ${money(t.stock_goods)}`} />
              </div>
              <CarryTables pos={d.position} money={money} />
              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn btn-lg" onClick={() => setStep(1)}>Back</button><div className="spacer" />
                <button className="btn btn-primary btn-lg" onClick={() => setStep(3)}>Next: confirm <ArrowRight size={20} /></button>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="card stack">
              <h2>3. Confirm</h2>
              {!d.next.exists && (
                <Field label={`${nextName} will run from ${fmtDate(d.next.start_date)} to`} help="Change only if your next year has different dates">
                  <input className="input" type="date" style={{ maxWidth: 260 }} value={nextEnd || d.next.end_date} min={d.next.start_date} onChange={(e) => setNextEnd(e.target.value)} />
                </Field>
              )}
              {[['a', `All sales, purchases, expenses and salaries for ${y.name} are entered.`],
                ['b', `I checked the balances on the previous step.`],
                ['c', `I understand ${y.name} will be locked: nothing dated inside it can be added, changed or deleted.`]].map(([k, label]) => (
                <label key={k} className="tick"><input type="checkbox" checked={ticks[k]} onChange={(e) => setTicks({ ...ticks, [k]: e.target.checked })} /><span>{label}</span></label>
              ))}
              <Field label={`Type ${y.name} to confirm`}><input className="input big" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={y.name} style={{ maxWidth: 320 }} autoComplete="off" /></Field>
              <div className="row">
                <button className="btn btn-lg" onClick={() => setStep(2)}>Back</button><div className="spacer" />
                <button className="btn btn-danger btn-lg" disabled={!ready || busy}
                  onClick={() => run(() => api.post(`/financial-years/${y.id}/close`, { confirm, next_end_date: nextEnd || undefined }), `${y.name} closed`)
                    .then((r) => { if (r) { setDone(r); reloadYears(); } })}>
                  <Lock size={20} /> Close {y.name} &amp; start {nextName}
                </button>
              </div>
              {currentFyId === y.id && <div className="small muted">After closing you will continue in {nextName}.</div>}
            </div>
          )}
        </>
      );
    }}</Async>
  );
}

/** The detail tables of what is carried forward (used in the wizard). */
function CarryTables({ pos, money }) {
  const [tab, setTab] = useState('funds');
  const customers = pos.parties.filter((p) => p.type === 'customer'), suppliers = pos.parties.filter((p) => p.type === 'supplier');
  const tabs = [
    { value: 'funds', label: `Cash & bank (${pos.funds.length})` },
    { value: 'cust', label: `Customers (${customers.length})` },
    { value: 'supp', label: `Suppliers (${suppliers.length})` },
    { value: 'stock', label: `Stock (${pos.items.length})` },
    { value: 'lots', label: `Batches (${pos.lots.length})` },
  ];
  const T = ({ head, rows, total }) => (
    <div className="table-wrap"><table className="table responsive">
      <thead><tr>{head.map((h, i) => <th key={i} className={i ? 'right' : ''}>{h}</th>)}</tr></thead>
      <tbody>{rows.length ? rows : <tr><td colSpan={head.length}><Empty>Nothing to carry forward</Empty></td></tr>}</tbody>
      {total && <tfoot>{total}</tfoot>}
    </table></div>
  );
  const sum = (l, k = 'amount') => l.reduce((s, x) => s + x[k], 0);
  return (
    <div className="card">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'funds' && <T head={['Account', 'Type', 'Closing balance']} rows={pos.funds.map((f) => (
        <tr key={f.id}><td><b>{f.name}</b>{f.pending_cheques ? <div className="small muted">{f.pending_cheques} cheque(s) not cleared</div> : null}</td><td data-label="Type" className="right">{f.fund_type}</td><td data-label="Balance" className="right num"><b>{money(f.amount)}</b></td></tr>))}
        total={<tr><td colSpan={2}>Total</td><td className="right num">{money(sum(pos.funds))}</td></tr>} />}
      {tab === 'cust' && <T head={['Customer', 'Owes us']} rows={customers.map((p) => <tr key={p.id}><td><b>{p.name}</b></td><td data-label="Owes us" className="right num">{money(p.amount)}</td></tr>)}
        total={<tr><td>Total receivable</td><td className="right num">{money(sum(customers))}</td></tr>} />}
      {tab === 'supp' && <T head={['Supplier', 'We owe']} rows={suppliers.map((p) => <tr key={p.id}><td><b>{p.name}</b></td><td data-label="We owe" className="right num">{money(p.amount)}</td></tr>)}
        total={<tr><td>Total payable</td><td className="right num">{money(sum(suppliers))}</td></tr>} />}
      {tab === 'stock' && <T head={['Item', 'Quantity', 'Weighted avg cost', 'Value']} rows={pos.items.map((i) => (
        <tr key={i.id}><td><b>{i.name}</b><div className="small muted">{KIND_LABEL[i.kind]}{i.container ? ` · ${i.container}` : ''}</div></td>
          <td data-label="Qty" className="right num">{qty(i.qty, i.unit)}</td><td data-label="Avg cost" className="right num">{money(i.unit_cost)}</td><td data-label="Value" className="right num"><b>{money(i.value)}</b></td></tr>))}
        total={<tr><td colSpan={3}>Total stock value</td><td className="right num">{money(sum(pos.items, 'value'))}</td></tr>} />}
      {tab === 'lots' && <T head={['Batch', 'Quantity', 'Cost / unit', 'Value']} rows={pos.lots.map((l) => (
        <tr key={l.id}><td><b className="mono">{l.lot_code}</b><div className="small muted">{l.name}</div></td>
          <td data-label="Qty" className="right num">{qty(l.qty, l.unit)}</td><td data-label="Cost" className="right num">{money(l.unit_cost)}</td><td data-label="Value" className="right num">{money(l.value)}</td></tr>))} />}
    </div>
  );
}

// =====================================================================
//  Opening balances of a year (/financial-years/:id/opening)
// =====================================================================
export function OpeningBalances() {
  const { id } = useParams();
  const q = useFetch(`/financial-years/${id}/opening-balances`);
  const money = useMoney();
  const GROUPS = [
    ['fund', 'Cash & bank accounts'], ['party', 'Customers & suppliers'], ['item', 'Stock (quantity × weighted average cost)'],
    ['lot', 'Finished-goods batches'], ['account', 'All accounts (trial balance)'],
  ];
  return (
    <Async q={q}>{(d) => (
      <>
        <PageHead back="/financial-years" title={`Opening balances — ${d.year.name}`} sub={d.from_year ? `Carried forward from ${d.from_year.name} (closing on ${fmtDate(d.from_year.end_date)})` : 'No closed year before this one'}
          actions={<button className="btn ro-ok" onClick={() => window.print()}>Print</button>} />
        {d.rows.length === 0 ? <div className="card"><Empty>No balances have been carried into this year yet. They appear after the previous year is closed.</Empty></div> : (
          <>
            {d.all_match ? <Alert type="ok">Every carried-forward balance matches the books on {fmtDate(d.year.start_date)}.</Alert>
              : <Alert type="danger">Some balances differ from the books — the previous year may have been changed after closing.</Alert>}
            {GROUPS.map(([kind, title]) => {
              const rows = d.rows.filter((r) => r.kind === kind);
              if (!rows.length) return null;
              return (
                <div className="card" key={kind}>
                  <h2 style={{ marginBottom: 12 }}>{title}</h2>
                  <div className="table-wrap"><table className="table responsive">
                    <thead><tr><th>Name</th><th>Type</th>{(kind === 'item' || kind === 'lot') && <><th className="right">Quantity</th><th className="right">Unit cost</th></>}<th className="right">{kind === 'party' ? 'Owed (+) / advance (−)' : kind === 'account' ? 'Balance (Dr / Cr)' : 'Amount'}</th><th>Check</th></tr></thead>
                    <tbody>{rows.map((r) => (
                      <tr key={r.id}>
                        <td><b>{r.name}</b></td><td data-label="Type">{r.category}</td>
                        {(kind === 'item' || kind === 'lot') && <><td data-label="Qty" className="right num">{qty(r.qty)}</td><td data-label="Unit cost" className="right num">{money(r.unit_cost)}</td></>}
                        <td data-label="Amount" className="right num"><b>{kind === 'account' ? `${money(Math.abs(r.amount))} ${r.amount >= 0 ? 'Dr' : 'Cr'}` : money(r.amount)}</b></td>
                        <td data-label="Check">{r.matches ? <Badge tone="ok"><CheckCircle2 size={13} /> matches</Badge> : <Badge tone="danger">books: {money(r.books)}</Badge>}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                </div>
              );
            })}
          </>
        )}
      </>
    )}</Async>
  );
}
