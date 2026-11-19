import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UserCheck, Users, HandCoins, Calculator, CalendarDays, Plus, Minus, Save, Printer, CheckCheck, ChevronLeft, ChevronRight,
  Clock, Settings2, AlertTriangle, CalendarOff, Sun, Briefcase,
} from 'lucide-react';
import { useFetch, useMoney, useApp, useAction, api, fmtDate, today, thisMonth, monthName } from '../lib.jsx';
import { PageHead, Async, Tabs, DataTable, Field, NumberInput, Modal, Badge, Stat, Alert, Empty, Picker } from '../components.jsx';
import { PaymentPicker, MethodBadge, emptyPayment, paymentBody } from '../payment.jsx';

const STATUS = [
  { k: 'P', label: 'Present' },
  { k: 'A', label: 'Absent' },
  { k: 'H', label: 'Half day' },
  { k: 'L', label: 'Leave' },
];
const TYPE_LABEL = { monthly: 'Monthly Salaried', daily: 'Daily Wager' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shift = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const hrs = (h) => `${+Number(h || 0).toFixed(2)} h`;
/** "17:00" -> "5:00 PM" */
export function clock(t, addHours = 0) {
  const [h, m] = t.split(':').map(Number);
  const total = (h * 60 + m + Math.round(addHours * 60)) % (24 * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

function TypeBadge({ type }) {
  return type === 'daily' ? <Badge tone="warn"><Sun size={13} /> Daily Wager</Badge> : <Badge tone="info"><Briefcase size={13} /> Monthly</Badge>;
}

export function Staff() {
  const { can } = useApp();
  const [tab, setTab] = useState('att');
  const tabs = [
    { value: 'att', label: 'Mark Attendance', icon: UserCheck },
    { value: 'month', label: 'Monthly Sheet', icon: CalendarDays },
    ...(can('manager') ? [
      { value: 'payroll', label: 'Monthly Payroll', icon: Calculator },
      { value: 'advances', label: 'Advances & Loans', icon: HandCoins },
      { value: 'emp', label: 'Employees', icon: Users },
    ] : []),
  ];
  return (
    <>
      <PageHead title="Staff & Attendance" sub="Mark attendance and overtime daily — salaries are calculated from it automatically." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'att' && <Attendance />}
      {tab === 'month' && <MonthSheet />}
      {tab === 'payroll' && <Payroll />}
      {tab === 'advances' && <Advances />}
      {tab === 'emp' && <Employees />}
    </>
  );
}

// =====================================================================
//  Daily attendance + overtime
// =====================================================================
function Attendance() {
  const [date, setDate] = useState(today());
  const q = useFetch(`/attendance?date=${date}`);
  const [marks, setMarks] = useState({}); // id -> { status, ot }
  const [run, busy] = useAction();
  useEffect(() => {
    if (q.data) setMarks(Object.fromEntries(q.data.rows.map((r) => [r.employee_id, { status: r.status || '', ot: r.overtime_hours || 0 }])));
  }, [q.data]);

  const rows = q.data?.rows || [];
  const rules = q.data?.rules;
  const setStatus = (id, k) => setMarks((m) => {
    const cur = m[id] || {};
    const status = cur.status === k ? '' : k;
    return { ...m, [id]: { status, ot: status === 'P' ? cur.ot : 0 } }; // overtime only on Present
  });
  const setOt = (id, v) => setMarks((m) => ({ ...m, [id]: { ...m[id], ot: Math.max(0, Math.min(16, Math.round(v * 2) / 2)) } }));
  const changed = rows.some((r) => (r.status || '') !== (marks[r.employee_id]?.status || '') || (r.overtime_hours || 0) !== (marks[r.employee_id]?.ot || 0));
  const vals = Object.values(marks);
  const count = (k) => vals.filter((v) => v.status === k).length;
  const totalOt = vals.reduce((s, v) => s + (v.ot || 0), 0);
  const save = () => run(() => api.put('/attendance', {
    date, records: Object.entries(marks).map(([id, v]) => ({ employee_id: Number(id), status: v.status, overtime_hours: v.ot })),
  }), 'Attendance saved').then((r) => r && q.reload());

  const groups = [
    { type: 'daily', title: 'Daily Wagers', hint: 'Paid only for days worked. Add overtime when they stay after the shift.' },
    { type: 'monthly', title: 'Monthly Salaried', hint: 'Fixed salary. Mark absences and leave.' },
  ];

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => setDate(shift(date, -1))} aria-label="Previous day"><ChevronLeft size={22} /></button>
        <input className="input" type="date" style={{ width: 'auto' }} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        <button className="btn" onClick={() => setDate(shift(date, 1))} disabled={date >= today()} aria-label="Next day"><ChevronRight size={22} /></button>
        <b style={{ fontSize: '1.1rem' }}>{q.data?.day_name}</b>
        <div className="spacer" />
        <button className="btn w" onClick={() => setMarks((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.status ? v : { status: 'P', ot: 0 }])))}><CheckCheck size={20} /> Mark rest present</button>
      </div>
      {rules && (
        <div className="row small" style={{ marginBottom: 10, gap: 8 }}>
          <Badge tone="gray"><Clock size={13} /> Shift {clock(rules.shift_start)} – {clock(rules.shift_end)} ({rules.shift_hours} h)</Badge>
          {['P', 'A', 'H', 'L'].map((k) => <Badge key={k} tone={{ P: 'ok', A: 'danger', H: 'warn', L: 'info' }[k]}>{STATUS.find((s) => s.k === k).label}: {count(k)}</Badge>)}
          {totalOt > 0 && <Badge tone="info"><Clock size={13} /> Overtime: {hrs(totalOt)}</Badge>}
          {vals.some((v) => !v.status) && <Badge>Not marked: {vals.filter((v) => !v.status).length}</Badge>}
        </div>
      )}
      {q.data?.is_off_day && <div style={{ marginBottom: 12 }}><Alert type="info"><CalendarOff size={16} style={{ verticalAlign: -3 }} /> {q.data.day_name} is the weekly off day. Only mark people who came to work.</Alert></div>}

      <Async q={q}>{() => rows.length === 0 ? <Empty>No employees yet.</Empty> : (
        <>
          {groups.map((g) => {
            const list = rows.filter((r) => r.salary_type === g.type);
            if (!list.length) return null;
            return (
              <div key={g.type} style={{ marginTop: 8 }}>
                <div className="row" style={{ marginTop: 10 }}><h2>{g.title}</h2><span className="muted small">{g.hint}</span></div>
                {list.map((r) => {
                  const m = marks[r.employee_id] || {};
                  const opts = r.salary_type === 'daily' ? STATUS.filter((s) => s.k !== 'L') : STATUS;
                  return (
                    <div key={r.employee_id} className="att-row">
                      <div className="att-name"><b style={{ fontSize: '1.08rem' }}>{r.name}</b><div className="small muted">{r.designation}</div></div>
                      <div className="att-btns" role="radiogroup" aria-label={`Attendance for ${r.name}`}>
                        {opts.map((s) => (
                          <button key={s.k} role="radio" aria-checked={m.status === s.k} className={`${s.k} ${m.status === s.k ? 'on' : ''}`} onClick={() => setStatus(r.employee_id, s.k)}>
                            <b>{s.k}</b>{s.label}
                          </button>
                        ))}
                      </div>
                      {r.overtime_eligible ? (
                        <div className={`ot ${m.status === 'P' ? '' : 'off'}`} aria-label={`Overtime for ${r.name}`}>
                          <span className="ot-label"><Clock size={16} /> Overtime</span>
                          <button disabled={m.status !== 'P' || !m.ot} onClick={() => setOt(r.employee_id, (m.ot || 0) - 0.5)} aria-label="Less overtime"><Minus size={20} /></button>
                          <b className="num">{hrs(m.ot)}</b>
                          <button disabled={m.status !== 'P'} onClick={() => setOt(r.employee_id, (m.ot || 0) + 0.5)} aria-label="More overtime"><Plus size={20} /></button>
                          <span className="small muted ot-hint">{m.status !== 'P' ? 'Mark Present first' : m.ot ? `left at ${clock(rules.shift_end, m.ot)}` : `after ${clock(rules.shift_end)}`}</span>
                        </div>
                      ) : <div className="ot-spacer" />}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <button className="btn btn-primary btn-lg btn-block w" style={{ marginTop: 16 }} disabled={busy || !changed} onClick={save}><Save size={22} /> {changed ? 'Save attendance' : 'Saved'}</button>
        </>
      )}</Async>
    </div>
  );
}

function MonthSheet() {
  const [month, setMonth] = useState(thisMonth());
  const q = useFetch(`/attendance/month?month=${month}`);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" type="month" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} />
        <span className="small muted">Small number = overtime hours that day. Grey columns = weekly off.</span>
        <div className="spacer" />
        <button className="btn no-print" onClick={() => window.print()}><Printer size={18} /> Print</button>
      </div>
      <Async q={q}>{(d) => (
        <div className="table-wrap">
          <table className="table grid-month">
            <thead><tr><th style={{ textAlign: 'left' }}>Employee</th>{Array.from({ length: d.days }, (_, i) => <th key={i} className={d.off_days.includes(i + 1) ? 'off-col' : ''}>{i + 1}</th>)}<th>P</th><th>A</th><th>½</th><th>L</th><th>OT h</th></tr></thead>
            <tbody>{d.employees.map((e) => (
              <tr key={e.id}>
                <td className="name">{e.name}<div className="small muted" style={{ fontWeight: 500 }}>{TYPE_LABEL[e.salary_type]}</div></td>
                {Array.from({ length: d.days }, (_, i) => {
                  const c = e.days[i + 1];
                  return <td key={i} className={`${c ? `cell-${c.s}` : ''} ${d.off_days.includes(i + 1) && !c ? 'off-col' : ''}`}>{c?.s || ''}{c?.ot ? <sup className="ot-sup">{+c.ot}</sup> : null}</td>;
                })}
                <td><b>{e.totals.P}</b></td><td><b>{e.totals.A}</b></td><td><b>{e.totals.H}</b></td><td><b>{e.totals.L}</b></td><td><b>{+e.totals.OT.toFixed(2)}</b></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}</Async>
    </div>
  );
}

// =====================================================================
//  Month-end payroll
// =====================================================================
/** Step-by-step salary sum in plain words — used in the edit dialog and on the payslip. */
export function SalaryBreakdown({ s, bonus = s.bonus, deduction = s.advance_deduction }) {
  const money = useMoney();
  const net = s.gross + Number(bonus || 0) - Number(deduction || 0);
  const daily = s.salary_type === 'daily';
  const unpaid = +(s.days_in_month - s.paid_days).toFixed(2);
  return (
    <div className="breakdown">
      {daily ? (
        <div className="b-row"><span>Days worked <span className="muted">({s.present} present{s.half_days ? ` + ${s.half_days} half` : ''})</span><br /><b>{s.paid_days} days × {money(s.base_salary)}</b></span><b className="num">{money(s.basic_pay)}</b></div>
      ) : (
        <div className="b-row"><span>Monthly salary {money(s.base_salary)}<br /><span className="muted">{unpaid > 0 ? `${unpaid} unpaid day(s) cut — paid for ${s.paid_days} of ${s.days_in_month} days` : 'Full month'}</span></span><b className="num">{money(s.basic_pay)}</b></div>
      )}
      {(s.overtime_hours > 0 || s.overtime_pay > 0) && (
        <div className="b-row"><span>Overtime<br /><b>{hrs(s.overtime_hours)} × {money(s.overtime_rate)}</b>{!s.overtime_rate && <span style={{ color: 'var(--danger)' }}> — rate not set!</span>}</span><b className="num">+ {money(s.overtime_pay)}</b></div>
      )}
      {Number(bonus) > 0 && <div className="b-row"><span>Bonus</span><b className="num">+ {money(bonus)}</b></div>}
      {Number(deduction) > 0 && <div className="b-row"><span>Advance / loan cut</span><b className="num" style={{ color: 'var(--danger)' }}>− {money(deduction)}</b></div>}
      <div className="b-row total"><span>Net payable</span><span className="num">{money(net)}</span></div>
    </div>
  );
}

function Payroll() {
  const [month, setMonth] = useState(thisMonth());
  const q = useFetch(`/payroll?month=${month}`);
  const cashQ = useFetch('/accounts/cash');
  const money = useMoney();
  const nav = useNavigate();
  const [run, busy] = useAction();
  const [edit, setEdit] = useState(null);
  const [payAll, setPayAll] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const generate = () => run(() => api.post('/payroll/generate', { month }), 'Payroll generated from attendance').then((r) => r && q.setData(r));
  const d = q.data;
  const rows = d?.rows || [];
  const drafts = rows.filter((r) => r.status === 'draft');
  const warnings = rows.filter((r) => r.status === 'draft' && (r.unmarked > 0 || (r.overtime_hours > 0 && !r.overtime_rate)));

  const open = (r) => (r.status === 'draft' ? setEdit(r) : nav(`/payroll/${r.id}`));
  const warnCell = (r) => (
    <>
      {r.unmarked > 0 && r.status === 'draft' && <div><Badge tone="danger"><AlertTriangle size={12} /> {r.unmarked} day{r.unmarked > 1 ? 's' : ''} not marked</Badge></div>}
      {r.overtime_hours > 0 && !r.overtime_rate && <div><Badge tone="danger"><AlertTriangle size={12} /> OT rate not set</Badge></div>}
    </>
  );
  const advCol = { key: 'advance_deduction', label: 'Advance due / cut', className: 'right', render: (r) => (r.advance_outstanding || r.advance_deduction ? <span className="num"><span className="muted small">{money(r.advance_outstanding)}</span><br /><span style={{ color: 'var(--danger)' }}>− {money(r.advance_deduction)}</span></span> : '—') };
  const netCol = { key: 'net', label: 'Net payable', className: 'right', render: (r) => (
    <div><b className="num" style={{ fontSize: '1.08rem' }}>{money(r.net)}</b>
      <div>{r.status === 'paid' ? <><Badge tone="ok">Paid {fmtDate(r.paid_date)}</Badge> <MethodBadge method={r.payment_method} small /></> : <Badge tone="warn">Not paid</Badge>}</div></div>) };
  const otCol = { key: 'overtime_hours', label: 'Overtime', className: 'right', render: (r) => (r.overtime_hours ? <span className="num">{hrs(r.overtime_hours)}<br /><span className="small muted">× {money(r.overtime_rate)} = {money(r.overtime_pay)}</span></span> : '—') };
  const attLine = (r, daily) => (
    <div className="small muted nowrap">
      <span style={{ color: 'var(--ok)' }}>{r.present} P</span> · <span style={{ color: 'var(--danger)' }}>{r.absent} A</span> · {r.half_days} ½{daily ? '' : ` · ${r.leave} L`}
    </div>
  );
  const nameCol = { key: 'name', label: 'Employee', render: (r) => <div style={{ minWidth: 140 }}><b>{r.name}</b><div className="small muted nowrap">{money(r.base_salary)} / {r.salary_type === 'daily' ? 'day' : 'month'}</div>{warnCell(r)}</div> };

  const dailyCols = [
    nameCol,
    { key: 'paid_days', label: 'Days worked', className: 'right', render: (r) => <div><b className="num" style={{ fontSize: '1.08rem' }}>{r.paid_days}</b>{attLine(r, true)}</div> },
    { key: 'basic_pay', label: 'Wages', className: 'right', render: (r) => <span className="num">{money(r.basic_pay)}</span> },
    otCol, advCol, netCol,
  ];
  const monthlyCols = [
    nameCol,
    { key: 'paid_days', label: 'Days paid', className: 'right', render: (r) => <div><b className="num">{r.paid_days} / {r.days_in_month}</b>{attLine(r, false)}</div> },
    { key: 'basic_pay', label: 'Salary', className: 'right', render: (r) => <span className="num">{money(r.basic_pay)}</span> },
    otCol, advCol, netCol,
  ];
  const foot = (list) => {
    const sum = (k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    return <tr><td colSpan={2}>Total ({list.length})</td><td className="right num">{money(sum('basic_pay'))}</td><td className="right num">{hrs(sum('overtime_hours'))}<br />{money(sum('overtime_pay'))}</td><td className="right num">− {money(sum('advance_deduction'))}</td><td className="right num">{money(sum('net'))}</td></tr>;
  };

  return (
    <>
      <div className="card">
        <div className="row">
          <input className="input" type="month" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
          <b style={{ fontSize: '1.1rem' }}>{monthName(month)}</b>
          <div className="spacer" />
          <button className="btn btn-primary btn-lg w" disabled={busy} onClick={generate}><Calculator size={22} /> {rows.length ? 'Re-generate Payroll' : 'Generate Monthly Payroll'}</button>
          {drafts.length > 0 && <button className="btn btn-in btn-lg w" onClick={() => setPayAll(true)}><HandCoins size={22} /> Pay all ({drafts.length})</button>}
        </div>
        {d?.rules && (
          <div className="row small" style={{ marginTop: 12, gap: 8 }}>
            <span className="muted">Rules:</span>
            <Badge tone="gray"><Clock size={13} /> Shift {clock(d.rules.shift_start)}–{clock(d.rules.shift_end)}</Badge>
            <Badge tone="gray">Overtime {d.rules.overtime_rate_per_hour ? `${money(d.rules.overtime_rate_per_hour)}/hour` : 'rate not set'}</Badge>
            <Badge tone="gray">Weekly off: {d.rules.weekly_off_day === null ? 'none' : DAYS[d.rules.weekly_off_day]}</Badge>
            <Badge tone="gray">Monthly staff: {d.rules.monthly_deduct_absent ? `absences cut, ${d.rules.paid_leaves_per_month} paid leave` : 'always full salary'}</Badge>
            <button className="btn btn-sm w" onClick={() => setRulesOpen(true)}><Settings2 size={16} /> Change rules</button>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="grid grid-4" style={{ marginTop: 18 }}>
          <Stat label="Wages & salaries" value={money(d.totals.basic_pay)} />
          <Stat label="Overtime" value={money(d.totals.overtime_pay)} hint={hrs(d.totals.overtime_hours)} />
          <Stat label="Advances cut" value={money(d.totals.advance_deduction)} />
          <Stat label="Still to pay" value={money(d.totals.unpaid_net)} hint={`${drafts.length} of ${rows.length} not paid`} tone={drafts.length ? '' : 'good'} />
        </div>
      )}
      {warnings.length > 0 && <div style={{ marginTop: 14 }}><Alert type="warn">Check before paying: {warnings.length} employee{warnings.length > 1 ? 's have' : ' has'} unmarked working days or overtime without a rate. Daily wagers are <b>not paid</b> for unmarked days. Fix attendance, then press <b>Re-generate Payroll</b>.</Alert></div>}

      <Async q={q}>{() => rows.length === 0 ? (
        <div className="card"><Empty icon={Calculator}>Press <b>Generate Monthly Payroll</b> to calculate pay for {monthName(month)} from attendance and overtime.</Empty></div>
      ) : (
        <>
          {[['daily', 'Daily Wagers', '(Days worked × daily rate) + overtime − advance = net payable', dailyCols], ['monthly', 'Monthly Salaried', 'Fixed salary + overtime − advance = net payable', monthlyCols]].map(([type, title, formula, cols]) => {
            const list = rows.filter((r) => r.salary_type === type);
            if (!list.length) return null;
            return (
              <div className="card" key={type}>
                <div className="card-head"><div><h2>{title}</h2><div className="small muted">{formula}</div></div></div>
                <DataTable wide rows={list} columns={cols} searchKeys={['name']} placeholder="Search employee…" onRow={open} footer={foot(list)} />
              </div>
            );
          })}
        </>
      )}</Async>

      {edit && <PayslipEdit slip={edit} cash={cashQ.data || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
      {payAll && <PayAll month={month} count={drafts.length} total={d.totals.unpaid_net} cash={cashQ.data || []} onClose={() => setPayAll(false)} onSaved={() => { setPayAll(false); q.reload(); }} />}
      {rulesOpen && <HrRules onClose={() => setRulesOpen(false)} onSaved={() => { setRulesOpen(false); q.reload(); }} />}
    </>
  );
}

function PayslipEdit({ slip, cash, onClose, onSaved }) {
  const money = useMoney();
  const [bonus, setBonus] = useState(String(slip.bonus || ''));
  const [ded, setDed] = useState(String(slip.advance_deduction || ''));
  const [payM, setPayM] = useState(emptyPayment);
  const [date, setDate] = useState(today());
  const [run, busy] = useAction();
  const net = slip.gross + (Number(bonus) || 0) - (Number(ded) || 0);
  const saveOnly = () => run(() => api.put(`/payroll/${slip.id}`, { bonus, advance_deduction: ded }), 'Saved').then((r) => r && onSaved());
  const pay = () => run(async () => { await api.put(`/payroll/${slip.id}`, { bonus, advance_deduction: ded }); await api.post(`/payroll/${slip.id}/pay`, { ...paymentBody(payM), date }); return true; }, 'Salary paid').then((r) => r && onSaved());
  return (
    <Modal title={`${slip.name} — ${TYPE_LABEL[slip.salary_type]}`} onClose={onClose}
      footer={<><button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.del(`/payroll/${slip.id}`), 'Draft deleted').then((r) => r && onSaved())}>Delete draft</button><div className="spacer" /><button className="btn" onClick={saveOnly} disabled={busy}>Save only</button><button className="btn btn-in" onClick={pay} disabled={busy || net < 0}>Pay {money(net)}</button></>}>
      <div className="stack">
        {slip.unmarked > 0 && <Alert type="warn">{slip.unmarked} working day{slip.unmarked > 1 ? 's are' : ' is'} not marked this month.{slip.salary_type === 'daily' ? ' Unmarked days are not paid.' : ''}</Alert>}
        <SalaryBreakdown s={slip} bonus={bonus} deduction={ded} />
        <div className="grid grid-2">
          <Field label="Bonus"><NumberInput value={bonus} onChange={setBonus} /></Field>
          <Field label="Advance / loan cut" help={`Owes ${money(slip.advance_outstanding)} in total`}><NumberInput value={ded} onChange={setDed} /></Field>
        </div>
        <PaymentPicker value={payM} onChange={setPayM} funds={cash} direction="out" amount={net} />
        <Field label="Payment date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function PayAll({ month, count, total, cash, onClose, onSaved }) {
  const money = useMoney();
  const [payM, setPayM] = useState(emptyPayment);
  const [date, setDate] = useState(today());
  const [run, busy] = useAction();
  return (
    <Modal title={`Pay all salaries — ${monthName(month)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-in" disabled={busy} onClick={() => run(() => api.post('/payroll/pay-all', { month, ...paymentBody(payM), date }), 'All salaries paid').then((r) => r && onSaved())}>Pay {money(total)}</button></>}>
      <div className="stack">
        <Alert type="warn">{count} salaries totalling <b>{money(total)}</b> will be marked paid. Attendance for {monthName(month)} will then be locked.</Alert>
        <PaymentPicker value={payM} onChange={setPayM} funds={cash} direction="out" amount={total} />
        <Field label="Payment date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** Factory-wide shift, overtime and leave rules. */
function HrRules({ onClose, onSaved }) {
  const q = useFetch('/hr/settings');
  const money = useMoney();
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (q.data) setF({ ...q.data, weekly_off_day: q.data.weekly_off_day ?? '' }); }, [q.data]);
  if (!f) return null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const hours = Math.max(0, (Number(f.shift_end.slice(0, 2)) * 60 + Number(f.shift_end.slice(3)) - Number(f.shift_start.slice(0, 2)) * 60 - Number(f.shift_start.slice(3))) / 60);
  return (
    <Modal title="Shift, overtime & leave rules" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.put('/hr/settings', f), 'Rules saved — press Re-generate Payroll to apply').then((r) => r && onSaved())}>Save rules</button></>}>
      <div className="stack">
        <h3>Standard working hours</h3>
        <div className="grid grid-2">
          <Field label="Shift starts"><input className="input" type="time" value={f.shift_start} onChange={set('shift_start')} /></Field>
          <Field label="Shift ends" help="Work after this time is overtime"><input className="input" type="time" value={f.shift_end} onChange={set('shift_end')} /></Field>
        </div>
        <div className="muted small">Standard day: <b>{hours} hours</b></div>
        <Field label="Weekly off day">
          <select className="input" value={f.weekly_off_day} onChange={set('weekly_off_day')}>
            <option value="">No weekly off</option>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </Field>
        <h3>Overtime</h3>
        <Field label="Factory standard overtime rate (per hour)" help="Used for anyone who does not have their own rate"><NumberInput className="big" value={f.overtime_rate_per_hour} onChange={set('overtime_rate_per_hour')} /></Field>
        <h3>Monthly salaried staff</h3>
        <Field label="Cut salary for absent days?">
          <div className="choice">
            <button className={`btn ${f.monthly_deduct_absent ? 'on' : ''}`} onClick={() => setF({ ...f, monthly_deduct_absent: true })}>Yes — cut absent days</button>
            <button className={`btn ${!f.monthly_deduct_absent ? 'on' : ''}`} onClick={() => setF({ ...f, monthly_deduct_absent: false })}>No — always full salary</button>
          </div>
        </Field>
        {f.monthly_deduct_absent && <Field label="Paid leaves per month" help="Leaves above this number are cut from salary"><NumberInput value={f.paid_leaves_per_month} onChange={set('paid_leaves_per_month')} /></Field>}
        <div className="small muted">Example daily wager: 26 days × {money(1000)} + 10 h overtime × {money(f.overtime_rate_per_hour || 0)} = <b>{money(26000 + 10 * (Number(f.overtime_rate_per_hour) || 0))}</b></div>
      </div>
    </Modal>
  );
}

// =====================================================================
//  Advances & loans
// =====================================================================
function Advances() {
  const q = useFetch('/advances');
  const empQ = useFetch('/employees');
  const cashQ = useFetch('/accounts/cash');
  const money = useMoney();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        {(empQ.data || []).filter((e) => e.advance_balance > 0).map((e) => <Stat key={e.id} label={e.name} value={money(e.advance_balance)} hint="still to recover" />)}
      </div>
      <div className="card">
        <div className="card-head"><h2>Advances &amp; loans given</h2><button className="btn btn-primary w" onClick={() => setOpen(true)}><Plus size={20} /> Give advance / loan</button></div>
        <Async q={q}>{(rows) => (
          <DataTable rows={rows} searchKeys={['employee_name', 'note']} placeholder="Search…" empty="No advances given."
            columns={[
              { key: 'employee_name', label: 'Employee', render: (a) => <b>{a.employee_name}</b> },
              { key: 'date', label: 'Date', render: (a) => fmtDate(a.date) },
              { key: 'type', label: 'Type', render: (a) => (a.type === 'loan' ? <Badge tone="info">Loan · {money(a.monthly_installment)}/month</Badge> : <Badge tone="warn">Advance · cut next salary</Badge>) },
              { key: 'amount', label: 'Amount', className: 'right', render: (a) => <b className="num">{money(a.amount)}</b> },
              { key: 'note', label: 'Note' },
            ]} />
        )}</Async>
      </div>
      {open && <AdvanceForm employees={empQ.data || []} cash={cashQ.data || []} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); q.reload(); empQ.reload(); }} />}
    </>
  );
}

function AdvanceForm({ employees, cash, onClose, onSaved }) {
  const [f, setF] = useState({ employee_id: '', type: 'advance', amount: '', monthly_installment: '', date: today(), note: '' });
  const [payM, setPayM] = useState(emptyPayment);
  const [run, busy] = useAction();
  return (
    <Modal title="Give advance / loan" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-out" disabled={busy || !f.employee_id || !(Number(f.amount) > 0)} onClick={() => run(() => api.post('/advances', { ...f, ...paymentBody(payM) }), 'Saved').then((r) => r && onSaved())}>Give money</button></>}>
      <div className="stack">
        <Field label="Employee"><Picker options={employees.map((e) => ({ value: e.id, label: e.name, sub: `${TYPE_LABEL[e.salary_type]} · ${e.designation || ''}` }))} value={f.employee_id} onChange={(v) => setF({ ...f, employee_id: v })} /></Field>
        <div className="choice">
          <button className={`btn ${f.type === 'advance' ? 'on' : ''}`} onClick={() => setF({ ...f, type: 'advance' })}>Salary advance<br /><span className="small">cut in full next salary</span></button>
          <button className={`btn ${f.type === 'loan' ? 'on' : ''}`} onClick={() => setF({ ...f, type: 'loan' })}>Loan<br /><span className="small">cut in monthly installments</span></button>
        </div>
        <Field label="Amount"><NumberInput className="big" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        {f.type === 'loan' && <Field label="Cut per month"><NumberInput value={f.monthly_installment} onChange={(v) => setF({ ...f, monthly_installment: v })} /></Field>}
        <PaymentPicker value={payM} onChange={setPayM} funds={cash} direction="out" amount={Number(f.amount) || 0} />
        <Field label="Date"><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// =====================================================================
//  Employees
// =====================================================================
function Employees() {
  const q = useFetch('/employees?all=1');
  const rulesQ = useFetch('/hr/settings');
  const money = useMoney();
  const [edit, setEdit] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Employees</h2>
        <div className="row">
          <button className="btn" onClick={() => setRulesOpen(true)}><Settings2 size={18} /> Shift &amp; overtime rules</button>
          <button className="btn btn-primary w" onClick={() => setEdit({})}><Plus size={20} /> Add employee</button>
        </div>
      </div>
      <Async q={q}>{(rows) => (
        <DataTable rows={rows} searchKeys={['name', 'designation', 'phone', 'cnic', (e) => TYPE_LABEL[e.salary_type]]} placeholder="Search employee…" onRow={setEdit}
          rowClass={(e) => (e.active ? '' : 'cancelled')}
          columns={[
            { key: 'name', label: 'Name', render: (e) => <div><b>{e.name}</b><div className="small muted">{e.designation}</div></div> },
            { key: 'salary_type', label: 'Type', render: (e) => <TypeBadge type={e.salary_type} /> },
            { key: 'salary_amount', label: 'Pay', className: 'right', render: (e) => <span className="num">{money(e.salary_amount)} <span className="muted small">/{e.salary_type === 'daily' ? 'day' : 'month'}</span></span> },
            { key: 'overtime', label: 'Overtime', className: 'right', render: (e) => (!e.overtime_eligible ? <span className="muted">No</span>
              : <span className="num">{money(e.effective_overtime_rate)}/h{e.overtime_rate === null && <div className="small muted">factory rate</div>}</span>) },
            { key: 'advance_balance', label: 'Advance due', className: 'right', render: (e) => (e.advance_balance ? <span className="num">{money(e.advance_balance)}</span> : '—') },
          ]} />
      )}</Async>
      {edit && <EmployeeForm emp={edit} factoryRate={rulesQ.data?.overtime_rate_per_hour || 0} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
      {rulesOpen && <HrRules onClose={() => setRulesOpen(false)} onSaved={() => { setRulesOpen(false); rulesQ.reload(); q.reload(); }} />}
    </div>
  );
}

function EmployeeForm({ emp, factoryRate, onClose, onSaved }) {
  const isNew = !emp.id;
  const money = useMoney();
  const [f, setF] = useState(() => ({
    name: '', phone: '', cnic: '', designation: '', salary_type: '', salary_amount: '', join_date: today(), active: 1,
    ...emp,
    overtime_eligible: emp.id ? !!emp.overtime_eligible : true,
    overtime_rate: emp.overtime_rate ?? '',
  }));
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const pickType = (t) => setF({ ...f, salary_type: t, overtime_eligible: isNew ? t === 'daily' : f.overtime_eligible });
  const save = () => run(() => (isNew ? api.post('/employees', f) : api.put(`/employees/${emp.id}`, f)), 'Saved').then((r) => r && onSaved());
  const daily = f.salary_type === 'daily';
  return (
    <Modal title={isNew ? 'New employee' : f.name} onClose={onClose}
      footer={<>{!isNew && <button className="btn btn-ghost" onClick={() => run(() => api.put(`/employees/${emp.id}`, { ...f, active: f.active ? 0 : 1 }), f.active ? 'Marked as left' : 'Re-activated').then((r) => r && onSaved())}>{f.active ? 'Mark as left' : 'Re-activate'}</button>}
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.name || !f.salary_type || !(Number(f.salary_amount) > 0)} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Employment type" className="full">
          <div className="type-cards">
            <button className={`type-card ${f.salary_type === 'monthly' ? 'on' : ''}`} onClick={() => pickType('monthly')}>
              <Briefcase size={28} /><b>Monthly Salaried</b><span>Fixed salary every month</span>
            </button>
            <button className={`type-card ${daily ? 'on' : ''}`} onClick={() => pickType('daily')}>
              <Sun size={28} /><b>Daily Wager</b><span>Paid only for days worked</span>
            </button>
          </div>
        </Field>
        {f.salary_type && <>
          <Field label="Name" className="full"><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
          <Field label={daily ? 'Per day wage rate' : 'Monthly salary'} help={daily ? 'Paid for each full day present; half for a half day' : undefined}>
            <NumberInput className="big" value={f.salary_amount} onChange={set('salary_amount')} />
          </Field>
          <Field label="Job"><input className="input" value={f.designation || ''} onChange={set('designation')} placeholder="e.g. Packing" /></Field>
          <Field label="Gets overtime pay?" className="full">
            <div className="choice">
              <button className={`btn ${f.overtime_eligible ? 'on' : ''}`} onClick={() => setF({ ...f, overtime_eligible: true })}>Yes</button>
              <button className={`btn ${!f.overtime_eligible ? 'on' : ''}`} onClick={() => setF({ ...f, overtime_eligible: false })}>No</button>
            </div>
          </Field>
          {f.overtime_eligible && (
            <Field label="Overtime rate per hour" className="full" help={`Leave empty to use the factory standard rate (${money(factoryRate)} per hour)`}>
              <NumberInput value={f.overtime_rate} onChange={set('overtime_rate')} placeholder={`Factory rate: ${money(factoryRate)}`} />
            </Field>
          )}
          <Field label="Phone"><input className="input" type="tel" value={f.phone || ''} onChange={set('phone')} /></Field>
          <Field label="Joining date"><input className="input" type="date" value={f.join_date || ''} onChange={set('join_date')} /></Field>
          <Field label="ID card no." className="full"><input className="input" value={f.cnic || ''} onChange={set('cnic')} /></Field>
        </>}
      </div>
    </Modal>
  );
}

// =====================================================================
//  Printable payslip
// =====================================================================
export function Payslip() {
  const { id } = useParams();
  const q = useFetch(`/payroll/${id}`);
  const money = useMoney();
  return (
    <Async q={q}>{(p) => (
      <>
        <PageHead back="/staff" title={`Payslip — ${p.name}`} actions={<button className="btn btn-primary btn-lg ro-ok" onClick={() => window.print()}><Printer size={22} /> Print</button>} />
        <div className="doc">
          <div className="doc-head">
            <div><div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{p.company.company_name}</div><div className="muted">{p.company.company_address}</div></div>
            <div style={{ textAlign: 'right' }}><div className="doc-title">PAYSLIP</div><div>{monthName(p.month)}</div></div>
          </div>
          <div className="grid grid-2">
            <div><b style={{ fontSize: '1.15rem' }}>{p.name}</b><div className="muted">{p.designation} · {TYPE_LABEL[p.salary_type]}</div>{p.cnic && <div className="muted">ID: {p.cnic}</div>}</div>
            <div style={{ textAlign: 'right' }}>{p.status === 'paid' ? <span className="stamp" style={{ color: 'var(--ok)' }}>PAID {fmtDate(p.paid_date)}</span> : <Badge tone="warn">Not paid</Badge>}</div>
          </div>
          <table>
            <tbody>
              <tr><td>Attendance</td><td className="right num">{p.present} present · {p.absent} absent · {p.half_days} half day{p.salary_type === 'monthly' ? ` · ${p.leave} leave` : ''}</td></tr>
              <tr><td>Working days in month</td><td className="right num">{p.working_days || p.days_in_month}</td></tr>
              <tr><td>Overtime</td><td className="right num">{hrs(p.overtime_hours)} (shift {clock(p.rules.shift_start)}–{clock(p.rules.shift_end)})</td></tr>
            </tbody>
          </table>
          <SalaryBreakdown s={p} />
          <div className="muted" style={{ marginTop: 12 }}>Advance / loan still to recover: <b>{money(p.advance_balance)}</b></div>
          <div className="foot"><div className="sign">Employee signature</div><div className="sign">Authorised signature</div></div>
        </div>
      </>
    )}</Async>
  );
}
