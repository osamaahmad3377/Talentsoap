// Employees, attendance (with overtime), advances/loans and attendance-linked payroll
//
// Two employment types:
//   Monthly Salaried ('monthly') : fixed salary; absences are cut only if the
//                                  factory rule "cut salary for absent days" is on.
//   Daily Wager      ('daily')   : paid only for days worked:
//        (present days + ½ per half day) x per-day rate
//      + overtime hours x overtime rate per hour
//      − advance / loan deduction
//      = net payable
import { Router } from 'express';
import { db, tx, r2, today, audit, getSettings } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { post, balance, ACC, accId, resolveFund } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';

const r = Router();
const STATUSES = ['P', 'A', 'H', 'L'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const checkMonth = (m) => { if (!/^\d{4}-\d{2}$/.test(m || '')) throw bad('Choose a month'); return m; };
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const dow = (d) => new Date(`${d}T12:00:00`).getDay();

/** Factory-wide HR rules from Settings. */
export function hrRules() {
  const s = getSettings();
  const shiftHours = Math.max(0, (toMin(s.shift_end || '17:00') - toMin(s.shift_start || '08:00')) / 60);
  return {
    shift_start: s.shift_start || '08:00',
    shift_end: s.shift_end || '17:00',
    shift_hours: shiftHours,
    weekly_off_day: s.weekly_off_day === '' || s.weekly_off_day === undefined ? null : Number(s.weekly_off_day),
    overtime_rate_per_hour: Number(s.overtime_rate_per_hour) || 0,
    paid_leaves_per_month: Number(s.paid_leaves_per_month) || 0,
    monthly_deduct_absent: s.monthly_deduct_absent !== '0',
  };
}

/** Employee's own overtime rate, or the factory standard rate. */
export const overtimeRateFor = (emp, rules = hrRules()) => (emp.overtime_rate ?? rules.overtime_rate_per_hour) || 0;

function getEmployee(id) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));
  if (!e) throw notFound('Employee');
  return e;
}

// ---------- HR rules (shift, overtime, weekly off) -------------------
r.get('/hr/settings', requireRole('staff'), (req, res) => res.json(hrRules()));

r.put('/hr/settings', requireRole('manager'), (req, res) => {
  const b = req.body || {};
  const time = (v, label) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '')) throw bad(`Enter a valid ${label}`); return v; };
  const start = time(b.shift_start, 'shift start time');
  const end = time(b.shift_end, 'shift end time');
  if (toMin(end) <= toMin(start)) throw bad('Shift must end after it starts');
  const off = b.weekly_off_day === '' || b.weekly_off_day === null ? '' : String(Number(b.weekly_off_day));
  if (off !== '' && !(Number(off) >= 0 && Number(off) <= 6)) throw bad('Choose a weekly off day');
  const vals = {
    shift_start: start, shift_end: end, weekly_off_day: off,
    overtime_rate_per_hour: String(num(b.overtime_rate_per_hour ?? 0, 'overtime rate', { allowZero: true })),
    paid_leaves_per_month: String(Math.floor(num(b.paid_leaves_per_month ?? 0, 'number of paid leaves', { allowZero: true }))),
    monthly_deduct_absent: b.monthly_deduct_absent ? '1' : '0',
  };
  const up = db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => { for (const [k, v] of Object.entries(vals)) up.run(k, v); });
  audit(req.user.id, 'update', 'hr_settings', null, vals);
  res.json(hrRules());
});

// ---------- employees -------------------------------------------------
r.get('/employees', requireRole('staff'), (req, res) => {
  const rules = hrRules();
  const rows = db.prepare(`SELECT e.*, COALESCE((SELECT SUM(debit - credit) FROM journal_lines WHERE employee_id = e.id AND account_id = ?), 0) AS advance_balance
    FROM employees e WHERE e.active = 1 OR ? = 1 ORDER BY e.name`).all(accId(ACC.ADVANCES), req.query.all ? 1 : 0);
  if (req.user.role === 'staff') return res.json(rows.map(({ id, name, designation, active, salary_type }) => ({ id, name, designation, active, salary_type })));
  res.json(rows.map((e) => ({ ...e, advance_balance: r2(e.advance_balance), effective_overtime_rate: overtimeRateFor(e, rules) })));
});

function readEmployee(b) {
  const type = b.salary_type === 'daily' ? 'daily' : 'monthly';
  const rate = b.overtime_rate === '' || b.overtime_rate === null || b.overtime_rate === undefined
    ? null : num(b.overtime_rate, 'overtime rate', { allowZero: true });
  return {
    name: required(b.name, 'Name'),
    phone: b.phone || null, cnic: b.cnic || null, designation: b.designation || null,
    salary_type: type,
    salary_amount: num(b.salary_amount, type === 'daily' ? 'per-day wage rate' : 'monthly salary'),
    overtime_eligible: (b.overtime_eligible === undefined ? type === 'daily' : !!Number(b.overtime_eligible) || b.overtime_eligible === true) ? 1 : 0,
    overtime_rate: rate,
    join_date: b.join_date || null,
  };
}

r.post('/employees', requireRole('manager'), (req, res) => {
  const e = readEmployee(req.body);
  const { id } = db.prepare(`INSERT INTO employees(name, phone, cnic, designation, salary_type, salary_amount, overtime_eligible, overtime_rate, join_date)
    VALUES (@name, @phone, @cnic, @designation, @salary_type, @salary_amount, @overtime_eligible, @overtime_rate, @join_date) RETURNING id`).get(e);
  audit(req.user.id, 'create', 'employee', id, e);
  res.json({ id });
});

r.put('/employees/:id', requireRole('manager'), (req, res) => {
  const old = getEmployee(req.params.id);
  const e = readEmployee({ ...old, ...req.body });
  db.prepare(`UPDATE employees SET name=@name, phone=@phone, cnic=@cnic, designation=@designation, salary_type=@salary_type,
    salary_amount=@salary_amount, overtime_eligible=@overtime_eligible, overtime_rate=@overtime_rate, join_date=@join_date, active=@active
    WHERE id=@id`)
    .run({ ...e, id: old.id, active: req.body.active === undefined ? old.active : req.body.active ? 1 : 0 });
  audit(req.user.id, 'update', 'employee', old.id, e);
  res.json({ ok: true });
});

r.get('/employees/:id', requireRole('manager'), (req, res) => {
  const e = getEmployee(req.params.id);
  res.json({
    ...e,
    effective_overtime_rate: overtimeRateFor(e),
    advance_balance: balance(ACC.ADVANCES, { employee_id: e.id }),
    advances: db.prepare('SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY date DESC, id DESC').all(e.id),
    payroll: db.prepare('SELECT * FROM payroll WHERE employee_id = ? ORDER BY month DESC LIMIT 24').all(e.id),
  });
});

// ---------- attendance & overtime -------------------------------------
r.get('/attendance', requireRole('staff'), (req, res) => {
  const d = date(req.query.date);
  const rules = hrRules();
  const rows = db.prepare(`SELECT e.id AS employee_id, e.name, e.designation, e.salary_type, e.overtime_eligible,
      a.status, COALESCE(a.overtime_hours, 0) AS overtime_hours
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
    WHERE e.active = 1 AND (e.join_date IS NULL OR e.join_date <= ?) ORDER BY e.salary_type DESC, e.name`).all(d, d);
  res.json({ date, rules, is_off_day: rules.weekly_off_day === dow(d), day_name: DAY_NAMES[dow(d)], rows });
});

/**
 * Save a day's attendance. records: [{ employee_id, status: 'P'|'A'|'H'|'L'|'' , overtime_hours }]
 * Rules: overtime only for Present + overtime-eligible staff; Leave only for monthly staff;
 * a paid month is locked.
 */
r.put('/attendance', requireRole('staff'), (req, res) => {
  const d = date(req.body.date);
  if (d > today()) throw bad('Cannot mark attendance for a future date');
  assertOpenDate(d, 'Attendance');
  const rules = hrRules();
  const maxOt = Math.min(16, 24 - rules.shift_hours);
  const recs = (req.body.records || []).filter((x) => x.employee_id);
  const locked = db.prepare("SELECT 1 FROM payroll WHERE employee_id = ? AND month = ? AND status = 'paid'");
  const up = db.prepare(`INSERT INTO attendance(employee_id, date, status, overtime_hours) VALUES (?,?,?,?)
    ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status, overtime_hours = excluded.overtime_hours`);
  const del = db.prepare('DELETE FROM attendance WHERE employee_id = ? AND date = ?');
  tx(() => {
    for (const x of recs) {
      const emp = getEmployee(x.employee_id);
      if (locked.get(emp.id, d.slice(0, 7))) throw bad(`Salary for ${emp.name} is already paid for this month — attendance is locked`);
      if (!x.status) { del.run(emp.id, d); continue; }
      if (!STATUSES.includes(x.status)) throw bad('Invalid attendance status');
      if (x.status === 'L' && emp.salary_type === 'daily') throw bad(`Leave is not used for daily wagers — mark ${emp.name} Absent`);
      const ot = Math.round((Number(x.overtime_hours) || 0) * 4) / 4; // quarter-hour steps
      if (ot < 0) throw bad('Overtime cannot be negative');
      if (ot > 0 && x.status !== 'P') throw bad(`Overtime can only be added when ${emp.name} is Present`);
      if (ot > 0 && !emp.overtime_eligible) throw bad(`${emp.name} is not set up for overtime pay`);
      if (ot > maxOt) throw bad(`Overtime for ${emp.name} cannot be more than ${maxOt} hours in a day`);
      up.run(emp.id, d, x.status, ot);
    }
  });
  res.json({ ok: true, saved: recs.length });
});

/** Month grid: one row per employee, one column per day, with overtime. */
r.get('/attendance/month', requireRole('staff'), (req, res) => {
  const month = checkMonth(req.query.month || today().slice(0, 7));
  const days = daysIn(month);
  const rules = hrRules();
  const emps = db.prepare('SELECT id, name, designation, salary_type, overtime_eligible FROM employees WHERE active = 1 ORDER BY salary_type DESC, name').all();
  const rows = db.prepare('SELECT employee_id, date, status, overtime_hours FROM attendance WHERE date LIKE ?').all(`${month}-%`);
  const map = {};
  for (const x of rows) (map[x.employee_id] ||= {})[Number(x.date.slice(8))] = { s: x.status, ot: x.overtime_hours };
  const offDays = Array.from({ length: days }, (_, i) => i + 1).filter((day) => dow(`${month}-${String(day).padStart(2, '0')}`) === rules.weekly_off_day);
  res.json({
    month, days, off_days: offDays,
    employees: emps.map((e) => {
      const d = map[e.id] || {};
      const v = Object.values(d);
      const totals = Object.fromEntries(STATUSES.map((s) => [s, v.filter((x) => x.s === s).length]));
      totals.OT = v.reduce((s, x) => s + (x.ot || 0), 0);
      return { ...e, days: d, totals };
    }),
  });
});

// ---------- advances & loans -----------------------------------------
r.get('/advances', requireRole('manager'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, e.name AS employee_name FROM employee_advances a JOIN employees e ON e.id = a.employee_id
    ORDER BY a.date DESC, a.id DESC LIMIT 300`).all());
});

/** Give an advance or loan: Dr Employee Advances / Cr Cash. Recovered later through payroll. */
r.post('/advances', requireRole('manager'), (req, res) => {
  const e = getEmployee(req.body.employee_id);
  const type = req.body.type === 'loan' ? 'loan' : 'advance';
  const amount = r2(num(req.body.amount, 'amount'));
  const inst = type === 'loan' ? r2(num(req.body.monthly_installment, 'monthly installment')) : null;
  if (inst && inst > amount) throw bad('Installment cannot be more than the loan');
  const pay = resolveFund(req.body);
  const cash = pay.account;
  const d = date(req.body.date);
  assertOpenDate(d, 'An advance');
  const id = tx(() => {
    const { id } = db.prepare(`INSERT INTO employee_advances(employee_id, date, type, amount, monthly_installment, pay_account_id, note)
      VALUES (?,?,?,?,?,?,?) RETURNING id`).get(e.id, d, type, amount, inst, cash, req.body.note || null);
    post({
      date: d, memo: `${type === 'loan' ? 'Loan' : 'Salary advance'} to ${e.name}`, ref_type: 'advance', ref_id: id, user_id: req.user.id, payment: pay.meta,
      lines: [{ account: ACC.ADVANCES, employee_id: e.id, debit: amount }, { account: cash, credit: amount }],
    });
    return id;
  });
  audit(req.user.id, 'create', 'advance', id, { amount, type });
  res.json({ id });
});

// ---------- payroll calculation --------------------------------------
/**
 * Suggested advance/loan recovery for a month.
 * Recoveries already made are matched to advances oldest-first; then:
 *   advance -> recover whatever is still outstanding
 *   loan    -> recover one monthly installment (or what is left)
 */
function suggestedDeduction(employeeId, monthEnd) {
  const recs = db.prepare('SELECT * FROM employee_advances WHERE employee_id = ? AND date <= ? ORDER BY date, id').all(employeeId, monthEnd);
  let recovered = db.prepare('SELECT COALESCE(SUM(credit),0) c FROM journal_lines WHERE employee_id = ? AND account_id = ?')
    .get(employeeId, accId(ACC.ADVANCES)).c;
  let due = 0;
  for (const a of recs) {
    const used = Math.min(recovered, a.amount);
    recovered -= used;
    const left = a.amount - used;
    if (left <= 0.005) continue;
    due += a.type === 'loan' ? Math.min(a.monthly_installment || left, left) : left;
  }
  return r2(Math.min(due, balance(ACC.ADVANCES, { employee_id: employeeId })));
}

/**
 * Pay for one employee for one month, from attendance.
 *
 * Daily Wager:
 *   days worked = present + ½ x half days        (absent, leave and unmarked days are not paid)
 *   basic pay   = days worked x per-day rate
 * Monthly Salaried:
 *   full salary; if "cut salary for absent days" is on:
 *   unpaid days = absent + ½ x half days + leave above the paid allowance
 *   basic pay   = salary ÷ days in month x (days in month − unpaid days)
 *   (days before the joining date are never paid)
 * Both:
 *   overtime pay = overtime hours (on Present days) x overtime rate per hour
 *   gross        = basic pay + overtime pay
 */
export function calcSalary(emp, month, rules = hrRules()) {
  const days = daysIn(month);
  const att = db.prepare('SELECT date, status, overtime_hours FROM attendance WHERE employee_id = ? AND date LIKE ?').all(emp.id, `${month}-%`);
  const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const marked = new Set();
  let otHours = 0;
  for (const a of att) {
    n[a.status] += 1;
    marked.add(a.date);
    if (a.status === 'P') otHours += a.overtime_hours || 0;
  }
  if (!emp.overtime_eligible) otHours = 0;

  // Calendar: weekly offs, days before joining, and working days still unmarked
  const lastDay = today() < `${month}-01` ? null : (today().slice(0, 7) === month ? today() : `${month}-${String(days).padStart(2, '0')}`);
  let preJoin = 0, workingDays = 0, unmarked = 0;
  for (let i = 1; i <= days; i++) {
    const d = `${month}-${String(i).padStart(2, '0')}`;
    if (emp.join_date && d < emp.join_date) { preJoin++; continue; }
    if (rules.weekly_off_day === dow(d)) continue;
    workingDays++;
    if (lastDay && d <= lastDay && !marked.has(d)) unmarked++;
  }

  let paidDays, basic;
  if (emp.salary_type === 'daily') {
    paidDays = n.P + n.H * 0.5;
    basic = r2(emp.salary_amount * paidDays);
  } else {
    const cut = rules.monthly_deduct_absent ? n.A + n.H * 0.5 + Math.max(0, n.L - rules.paid_leaves_per_month) : 0;
    paidDays = Math.max(0, days - preJoin - cut);
    basic = r2((emp.salary_amount / days) * paidDays);
  }
  const otRate = emp.overtime_eligible ? overtimeRateFor(emp, rules) : 0;
  const otPay = r2(otHours * otRate);
  return {
    salary_type: emp.salary_type, days_in_month: days, working_days: workingDays,
    present: n.P, absent: n.A, half_days: n.H, leave: n.L, unmarked,
    paid_days: paidDays, base_salary: emp.salary_amount, basic_pay: basic,
    overtime_hours: otHours, overtime_rate: otRate, overtime_pay: otPay,
    gross: r2(basic + otPay),
  };
}

const payrollRows = (month) => db.prepare(`SELECT p.*, e.name, e.designation, e.overtime_eligible, COALESCE(p.salary_type, e.salary_type) AS salary_type,
    (SELECT f.method FROM fund_transactions f WHERE f.ref_type = 'payroll' AND f.ref_id = p.id AND f.direction = 'out' ORDER BY f.id DESC LIMIT 1) AS payment_method
  FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.month = ? ORDER BY COALESCE(p.salary_type, e.salary_type) DESC, e.name`).all(month);

function payrollResponse(month) {
  const rows = payrollRows(month);
  const sum = (k) => r2(rows.reduce((s, x) => s + (x[k] || 0), 0));
  return {
    month, rules: hrRules(), rows,
    totals: {
      basic_pay: sum('basic_pay'), overtime_hours: sum('overtime_hours'), overtime_pay: sum('overtime_pay'), bonus: sum('bonus'),
      gross: sum('gross'), advance_deduction: sum('advance_deduction'), net: sum('net'),
      unpaid_net: r2(rows.filter((x) => x.status === 'draft').reduce((s, x) => s + x.net, 0)),
    },
  };
}

r.get('/payroll', requireRole('manager'), (req, res) => {
  res.json(payrollResponse(checkMonth(req.query.month || today().slice(0, 7))));
});

/** "Generate Monthly Payroll": create or refresh draft slips for every active employee (paid slips are never touched). */
r.post('/payroll/generate', requireRole('manager'), (req, res) => {
  const month = checkMonth(req.body.month);
  const monthEnd = `${month}-${String(daysIn(month)).padStart(2, '0')}`;
  assertOpenDate(`${month}-01`, 'Payroll');
  const rules = hrRules();
  tx(() => {
    const emps = db.prepare('SELECT * FROM employees WHERE active = 1 AND (join_date IS NULL OR join_date <= ?)').all(monthEnd);
    const upsert = db.prepare(`INSERT INTO payroll(employee_id, month, salary_type, days_in_month, working_days, present, absent, half_days, leave,
        unmarked, paid_days, base_salary, basic_pay, overtime_hours, overtime_rate, overtime_pay, gross, bonus, advance_outstanding, advance_deduction, net)
      VALUES (@employee_id, @month, @salary_type, @days_in_month, @working_days, @present, @absent, @half_days, @leave,
        @unmarked, @paid_days, @base_salary, @basic_pay, @overtime_hours, @overtime_rate, @overtime_pay, @gross, @bonus, @advance_outstanding, @advance_deduction, @net)
      ON CONFLICT(employee_id, month) DO UPDATE SET salary_type=excluded.salary_type, days_in_month=excluded.days_in_month,
        working_days=excluded.working_days, present=excluded.present, absent=excluded.absent, half_days=excluded.half_days,
        leave=excluded.leave, unmarked=excluded.unmarked, paid_days=excluded.paid_days, base_salary=excluded.base_salary,
        basic_pay=excluded.basic_pay, overtime_hours=excluded.overtime_hours, overtime_rate=excluded.overtime_rate,
        overtime_pay=excluded.overtime_pay, gross=excluded.gross, advance_outstanding=excluded.advance_outstanding,
        advance_deduction=excluded.advance_deduction, net=excluded.net`);
    for (const e of emps) {
      const existing = db.prepare('SELECT * FROM payroll WHERE employee_id = ? AND month = ?').get(e.id, month);
      if (existing?.status === 'paid') continue;
      const c = calcSalary(e, month, rules);
      const bonus = existing?.bonus || 0;
      const outstanding = balance(ACC.ADVANCES, { employee_id: e.id });
      const ded = Math.min(suggestedDeduction(e.id, monthEnd), r2(c.gross + bonus));
      upsert.run({ ...c, employee_id: e.id, month, bonus, advance_outstanding: outstanding, advance_deduction: ded, net: r2(c.gross + bonus - ded) });
    }
  });
  audit(req.user.id, 'generate', 'payroll', null, { month });
  res.json(payrollResponse(month));
});

/** Adjust bonus or advance deduction on a draft slip. */
r.put('/payroll/:id', requireRole('manager'), (req, res) => {
  const p = db.prepare('SELECT * FROM payroll WHERE id = ?').get(Number(req.params.id));
  if (!p) throw notFound('Payslip');
  if (p.status === 'paid') throw bad('This salary is already paid');
  assertOpenDate(`${p.month}-01`, 'Payroll');
  const bonus = r2(Number(req.body.bonus ?? p.bonus) || 0);
  const ded = r2(Number(req.body.advance_deduction ?? p.advance_deduction) || 0);
  if (bonus < 0 || ded < 0) throw bad('Amounts cannot be negative');
  if (ded > balance(ACC.ADVANCES, { employee_id: p.employee_id }) + 0.005) throw bad('Deduction is more than the advance balance');
  if (ded > p.gross + bonus) throw bad('Deduction is more than the salary');
  db.prepare('UPDATE payroll SET bonus = ?, advance_deduction = ?, net = ? WHERE id = ?').run(bonus, ded, r2(p.gross + bonus - ded), p.id);
  res.json({ ok: true });
});

/**
 * Pay a slip. The salary cost belongs to the salary MONTH, the cash leaves on the PAYMENT day.
 *
 * Paid within the month:      one entry on the payment date
 *   Dr Salaries & Wages (basic + bonus), Dr Overtime Wages
 *   Cr Employee Advances (deduction),    Cr Cash/Bank (net)
 *
 * Paid after month-end (usual): the cost is booked on the last day of the salary month,
 *   Dr Salaries & Wages, Dr Overtime Wages / Cr Employee Advances, Cr Salaries Payable
 * and the payment on the day it is made,
 *   Dr Salaries Payable / Cr Cash/Bank
 * so each month's Profit & Loss carries its own payroll.
 */
function paySlip(id, pay, d, userId) {
  const cash = pay.account;
  const p = db.prepare('SELECT p.*, e.name FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?').get(id);
  if (!p) throw notFound('Payslip');
  if (p.status === 'paid') return false;
  const salaryMonthEnd = `${p.month}-${String(daysIn(p.month)).padStart(2, '0')}`;
  const cost = [
    { account: ACC.SALARIES, debit: p.gross - p.overtime_pay + p.bonus },
    { account: ACC.OVERTIME, debit: p.overtime_pay },
    { account: ACC.ADVANCES, employee_id: p.employee_id, credit: p.advance_deduction },
  ];
  if (d <= salaryMonthEnd) {
    post({ date: d, memo: `Salary ${p.month}: ${p.name}`, ref_type: 'payroll', ref_id: p.id, user_id: userId, payment: pay.meta,
      lines: [...cost, { account: cash, credit: p.net }] });
  } else {
    post({ date: salaryMonthEnd, memo: `Salary ${p.month} due: ${p.name}`, ref_type: 'payroll', ref_id: p.id, user_id: userId,
      lines: [...cost, { account: ACC.SALARIES_PAYABLE, credit: p.net }] });
    post({ date: d, memo: `Salary ${p.month} paid: ${p.name}`, ref_type: 'payroll', ref_id: p.id, user_id: userId, payment: pay.meta,
      lines: [{ account: ACC.SALARIES_PAYABLE, debit: p.net }, { account: cash, credit: p.net }] });
  }
  db.prepare("UPDATE payroll SET status = 'paid', paid_date = ?, pay_account_id = ? WHERE id = ?").run(d, cash, p.id);
  return true;
}

r.post('/payroll/:id/pay', requireRole('manager'), (req, res) => {
  const pay = resolveFund(req.body);
  tx(() => paySlip(Number(req.params.id), pay, date(req.body.date), req.user.id));
  audit(req.user.id, 'pay', 'payroll', Number(req.params.id));
  res.json({ ok: true });
});

/** Delete an unpaid (draft) slip — e.g. before closing a financial year. */
r.delete('/payroll/:id', requireRole('manager'), (req, res) => {
  const p = db.prepare('SELECT * FROM payroll WHERE id = ?').get(Number(req.params.id));
  if (!p) throw notFound('Payslip');
  if (p.status === 'paid') throw bad('A paid salary cannot be deleted');
  assertOpenDate(`${p.month}-01`, 'Payroll');
  db.prepare('DELETE FROM payroll WHERE id = ?').run(p.id);
  audit(req.user.id, 'delete', 'payroll', p.id, { month: p.month, employee_id: p.employee_id });
  res.json({ ok: true });
});

r.post('/payroll/pay-all', requireRole('manager'), (req, res) => {
  const month = checkMonth(req.body.month);
  const pay = resolveFund(req.body);
  const d = date(req.body.date);
  const n = tx(() => db.prepare("SELECT id FROM payroll WHERE month = ? AND status = 'draft'").all(month)
    .filter((p) => paySlip(p.id, pay, d, req.user.id)).length);
  audit(req.user.id, 'pay_all', 'payroll', null, { month, n });
  res.json({ paid: n });
});

r.get('/payroll/:id', requireRole('manager'), (req, res) => {
  const p = db.prepare(`SELECT p.*, e.name, e.designation, e.cnic, COALESCE(p.salary_type, e.salary_type) AS salary_type
    FROM payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`).get(Number(req.params.id));
  if (!p) throw notFound('Payslip');
  res.json({ ...p, advance_balance: balance(ACC.ADVANCES, { employee_id: p.employee_id }), company: getSettings(), rules: hrRules() });
});

export default r;
