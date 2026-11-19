// Cash book, dashboard and financial reports — all derived from the journal
import { Router } from 'express';
import { db, tx, r2, today, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { post, balance, ACC, accId, fundAccount, resolveFund, fundTotal, METHODS } from '../accounting.js';
import { transferFunds } from './funds.js';
import { assertOpenDate } from '../fiscal.js';

// Year-end closing entries move income/expense into Retained Earnings; profit reports ignore them.
const NOT_CLOSING = "(je.ref_type IS NULL OR je.ref_type <> 'year_close')";
import { listItemsWithStock } from '../inventory.js';
import { createExpense, deleteExpense, createCategory } from './expenses.js';

const r = Router();

const monthStart = (d) => `${d.slice(0, 7)}-01`;
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };

// ---------- accounts --------------------------------------------------
r.get('/accounts', requireRole('manager'), (req, res) => {
  res.json(db.prepare(`SELECT a.*, COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id GROUP BY a.id ORDER BY a.code`).all()
    .map((a) => ({ ...a, balance: r2(a.balance) })));
});

/** Open cash & bank accounts for payment pickers (balances only for managers). */
r.get('/accounts/cash', (req, res) => {
  const rows = db.prepare(`SELECT id, code, name, fund_type, bank_name, account_number FROM accounts
    WHERE is_cash = 1 AND active = 1 ORDER BY fund_type DESC, code`).all();
  res.json(req.user.role === 'staff' ? rows : rows.map((a) => ({ ...a, balance: balance(a.id) })));
});

/** Add a new expense category (e.g. "Packaging Labour"). */
r.post('/accounts', requireRole('manager'), (req, res) => {
  const c = createCategory(req.body.name, req.body.description);
  audit(req.user.id, 'create', 'expense_category', c.id, { name: req.body.name });
  res.json(c);
});

// ---------- cash book -------------------------------------------------
/** Categories offered in the Cash In / Cash Out forms. */
r.get('/cash/categories', requireRole('manager'), (req, res) => {
  const q = (where) => db.prepare(`SELECT id, code, name FROM accounts WHERE ${where} ORDER BY name`).all();
  res.json({
    in: q(`code IN ('${ACC.OTHER_INCOME}', '${ACC.CAPITAL}')`),
    out: [...q('is_expense_category = 1 AND active = 1'), ...q(`code = '${ACC.DRAWINGS}'`)],
    transfer: q('is_cash = 1 AND active = 1'),
  });
});

/**
 * Cash book for one Cash/Bank account between two dates.
 * Every journal line touching the account is a row; the "against" column
 * names the other side (e.g. "Electricity & Gas", "Customer: Ali Traders").
 */
r.get('/cash', requireRole('manager'), (req, res) => {
  const account_id = fundAccount(req.query.account_id || accId(ACC.CASH)).id;
  const from = date(req.query.from || today());
  const to = date(req.query.to || from);
  const opening = r2(db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) b FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ? AND je.date < ?`).get(account_id, from).b);
  const rows = db.prepare(`
    SELECT je.id AS entry_id, je.date, je.memo, je.ref_type, je.ref_id, jl.debit AS cash_in, jl.credit AS cash_out,
      (SELECT GROUP_CONCAT(COALESCE(p.name, e.name, a.name), ', ') FROM journal_lines o
         JOIN accounts a ON a.id = o.account_id LEFT JOIN parties p ON p.id = o.party_id LEFT JOIN employees e ON e.id = o.employee_id
         WHERE o.entry_id = je.id AND o.account_id <> jl.account_id) AS against
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = ? AND je.date BETWEEN ? AND ? ORDER BY je.date, je.id`).all(account_id, from, to);
  let run = opening;
  const entries = rows.map((x) => { run = r2(run + x.cash_in - x.cash_out); return { ...x, balance: run }; });
  res.json({
    account_id, from, to, opening, entries, closing: run,
    total_in: r2(rows.reduce((s, x) => s + x.cash_in, 0)),
    total_out: r2(rows.reduce((s, x) => s + x.cash_out, 0)),
  });
});

/**
 * Simple money in / out (Cash, Bank transfer or Cheque).
 *  in : Dr Cash|Bank / Cr (Other Income | Owner's Capital)
 *  out: Dr (Expense category | Owner Withdrawals) / Cr Cash|Bank
 *  category = another cash/bank account  -> internal transfer
 */
r.post('/cash', requireRole('manager'), (req, res) => {
  const direction = req.body.direction === 'in' ? 'in' : 'out';
  const cat0 = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.body.category_id));
  if (cat0?.is_cash) {
    const own = fundAccount(req.body.account_id || req.body.pay_account_id || accId(ACC.CASH)).id;
    const [from, to] = direction === 'in' ? [cat0.id, own] : [own, cat0.id];
    const entry = tx(() => transferFunds({ from_account_id: from, to_account_id: to, amount: req.body.amount, date: req.body.date, note: req.body.note, reference: req.body.reference }, req.user.id));
    audit(req.user.id, 'transfer', 'fund', entry, req.body);
    return res.json({ entry_id: entry });
  }
  const pay = resolveFund(req.body);
  const cash = pay.account;
  const amount = r2(num(req.body.amount, 'amount'));
  const d = date(req.body.date);
  const cat = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.body.category_id));
  if (!cat) throw bad('Choose a category');
  const allowedIn = [ACC.OTHER_INCOME, ACC.CAPITAL];
  const okOut = cat.is_expense_category || cat.code === ACC.DRAWINGS || (cat.is_cash && cat.id !== cash);
  if (direction === 'in' ? !(allowedIn.includes(cat.code) || (cat.is_cash && cat.id !== cash)) : !okOut) throw bad('That category is not allowed here');
  const note = String(req.body.note || '').trim();
  // Operational expenses go through the expense register (same voucher as "Add Expense")
  if (direction === 'out' && cat.is_expense_category) {
    const x = tx(() => createExpense({ ...req.body, category_id: cat.id, amount, date: d, note, account_id: cash, payment_method: pay.meta.method }, req.user.id));
    audit(req.user.id, 'create', 'expense', x.id, { amount, category: cat.name });
    return res.json({ entry_id: x.journal_entry_id, expense_id: x.id });
  }
  const memo = `${cat.name}${note ? ' — ' + note : ''}`;
  const id = tx(() => post({
    date: d, memo, ref_type: 'cash', user_id: req.user.id, payment: pay.meta,
    lines: direction === 'in'
      ? [{ account: cash, debit: amount }, { account: cat.id, credit: amount }]
      : [{ account: cat.id, debit: amount }, { account: cash, credit: amount }],
  }));
  audit(req.user.id, `cash_${direction}`, 'journal', id, { amount, category: cat.name });
  res.json({ entry_id: id });
});

/** Delete a manual cash entry (sales, purchases, payroll must be cancelled from their own screen). */
r.delete('/cash/:entryId', requireRole('manager'), (req, res) => {
  const e = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(Number(req.params.entryId));
  if (!e) throw notFound('Entry');
  assertOpenDate(e.date, 'This entry');
  if (e.ref_type === 'expense') { tx(() => deleteExpense(e.ref_id, req.user.id)); return res.json({ ok: true }); }
  if (!['cash', 'payment', 'transfer'].includes(e.ref_type)) throw bad('This entry belongs to an invoice/purchase/payroll. Cancel it from that screen.');
  // a payment whose cheque bounced must stay (the bounce reversal points at it)
  if (db.prepare('SELECT 1 FROM fund_transactions WHERE entry_id = ? AND cheque_status = ?').get(e.id, 'bounced')) throw bad('This cheque was marked bounced and cannot be deleted');
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(e.id);
  audit(req.user.id, 'delete', 'journal', e.id, { memo: e.memo });
  res.json({ ok: true });
});

// ---------- profit & loss --------------------------------------------
/**
 * Profit & Loss for any date range, straight from the journal:
 *
 *   Gross revenue            (Sales of finished & trading goods)
 * − Cost of goods sold       (cost of the units SOLD: weighted-average raw material
 *                             cost of their batch + labour/power charged to the batch)
 * = Gross profit
 * − Operational expenses     (custom expense categories, stock loss, …)
 * − Payroll                  (monthly salaries + daily wages + overtime)
 * + Other income
 * = Net profit / loss
 *
 * Every expense account lands in exactly one section, so the result always
 * equals total income − total expenses in the books.
 */
export function pnl(from, to) {
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.is_expense_category, a.description, COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
    FROM accounts a JOIN journal_lines jl ON jl.account_id = a.id JOIN journal_entries je ON je.id = jl.entry_id
    WHERE a.type IN ('income','expense') AND je.date BETWEEN ? AND ? AND ${NOT_CLOSING}
    GROUP BY a.id ORDER BY a.code`).all(from, to);
  const amt = (x) => r2(x.type === 'income' ? x.cr - x.dr : x.dr - x.cr);
  const sumOf = (list) => r2(list.reduce((s, x) => s + x.amount, 0));
  const PAYROLL = [ACC.SALARIES, ACC.OVERTIME];

  const sales = r2(rows.filter((x) => x.code === ACC.SALES).reduce((s, x) => s + amt(x), 0));
  const cogs = r2(rows.filter((x) => x.code === ACC.COGS).reduce((s, x) => s + amt(x), 0));
  const otherIncome = rows.filter((x) => x.type === 'income' && x.code !== ACC.SALES).map((x) => ({ name: x.name, amount: amt(x) })).filter((x) => x.amount);
  const NOTE = { [ACC.OVERHEAD_ABSORBED]: 'Labour/power moved into batch cost (counted in COGS when sold)', [ACC.STOCK_LOSS]: 'Damaged or lost stock' };
  const operating = rows.filter((x) => x.type === 'expense' && x.code !== ACC.COGS && !PAYROLL.includes(x.code))
    .map((x) => ({ id: x.id, code: x.code, name: x.name, is_category: !!x.is_expense_category, note: NOTE[x.code] || null, amount: amt(x) }))
    .filter((x) => x.amount).sort((a, b) => b.amount - a.amount);

  // Payroll split by employee type (via the payslip each journal entry belongs to)
  const pay = db.prepare(`
    SELECT a.code, COALESCE(p.salary_type, e.salary_type) AS salary_type, SUM(jl.debit - jl.credit) AS amount
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN payroll p ON je.ref_type = 'payroll' AND p.id = je.ref_id LEFT JOIN employees e ON e.id = p.employee_id
    WHERE a.code IN (?, ?) AND je.date BETWEEN ? AND ? AND ${NOT_CLOSING}
    GROUP BY a.code, COALESCE(p.salary_type, e.salary_type)`).all(ACC.SALARIES, ACC.OVERTIME, from, to);
  const pick = (code, type) => r2(pay.filter((x) => x.code === code && (type === undefined || x.salary_type === type)).reduce((s, x) => s + x.amount, 0));
  const payroll = {
    monthly: pick(ACC.SALARIES, 'monthly'),
    daily: pick(ACC.SALARIES, 'daily'),
    overtime: pick(ACC.OVERTIME),
    other: r2(pick(ACC.SALARIES) - pick(ACC.SALARIES, 'monthly') - pick(ACC.SALARIES, 'daily')),
  };
  payroll.total = r2(payroll.monthly + payroll.daily + payroll.overtime + payroll.other);

  const gross = r2(sales - cogs);
  const opTotal = sumOf(operating);
  const otherTotal = sumOf(otherIncome);
  const net = r2(gross - opTotal - payroll.total + otherTotal);
  const materialsUsed = r2(db.prepare(`SELECT COALESCE(SUM(pc.amount),0) s FROM production_consumption pc
    JOIN production_batches b ON b.id = pc.batch_id WHERE b.status = 'active' AND b.date BETWEEN ? AND ?`).get(from, to).s);
  const pct = (v) => (sales ? r2((v / sales) * 100) : null);

  return {
    from, to,
    sales, cogs, gross_profit: gross,
    operating: { lines: operating, total: opTotal },
    payroll,
    other_income: { lines: otherIncome, total: otherTotal },
    total_expenses: r2(opTotal + payroll.total),           // operating + payroll (excl. COGS)
    total_costs: r2(cogs + opTotal + payroll.total),        // everything taken away from sales
    net_profit: net,
    margins: { cogs: pct(cogs), gross: pct(gross), operating: pct(opTotal), payroll: pct(payroll.total), net: pct(net) },
    materials_used_in_production: materialsUsed,
  };
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5) + 1;
const monthEndOf = (d) => { const [y, m] = d.split('-').map(Number); return `${d.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/** The period just before [from, to] — previous month if a whole month is selected. */
function previousPeriod(from, to) {
  const prevTo = addDays(from, -1);
  const wholeMonth = from === monthStart(from) && to === monthEndOf(from);
  return wholeMonth ? [monthStart(prevTo), prevTo] : [addDays(from, -daysBetween(from, to)), prevTo];
}

r.get('/reports/pnl', requireRole('manager'), (req, res) => {
  const to = date(req.query.to || req.asOf || today());
  const from = date(req.query.from || monthStart(to));
  if (to < from) throw bad('End date is before start date');
  const [pf, pt] = previousPeriod(from, to);
  res.json({ ...pnl(from, to), previous: pnl(pf, pt) });
});

/**
 * Finance overview for one month: the P&L, the same month before,
 * the six-month trend and where the expense money went.
 */
r.get('/finance/overview', requireRole('manager'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const from = `${month}-01`;
  const to = monthEndOf(from);
  const [pf, pt] = previousPeriod(from, to);
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${from}T12:00:00`); d.setMonth(d.getMonth() - i);
    const f = d.toLocaleDateString('en-CA').slice(0, 7) + '-01';
    const p = pnl(f, monthEndOf(f));
    trend.push({ month: f.slice(0, 7), sales: p.sales, cogs: p.cogs, operating: p.operating.total, payroll: p.payroll.total, net_profit: p.net_profit });
  }
  const byCat = db.prepare(`SELECT a.id, a.name, SUM(e.amount) AS amount, COUNT(*) AS count FROM expenses e JOIN accounts a ON a.id = e.category_id
    WHERE e.status = 'active' AND e.date BETWEEN ? AND ? GROUP BY a.id ORDER BY amount DESC`).all(from, to);
  res.json({
    month, current: pnl(from, to), previous: pnl(pf, pt), trend,
    expenses_by_category: byCat.map((x) => ({ ...x, amount: r2(x.amount) })),
    cash_in_hand: fundTotal('cash', to), bank_balance: fundTotal('bank', to),
  });
});

r.get('/reports/trial-balance', requireRole('manager'), (req, res) => {
  const to = date(req.query.to || req.asOf || today());
  const rows = db.prepare(`SELECT a.code, a.name, a.type, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
    FROM accounts a JOIN journal_lines jl ON jl.account_id = a.id JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.date <= ? AND NOT (je.ref_type = 'year_close' AND je.date = ?) GROUP BY a.id ORDER BY a.code`).all(to, to)
    .map((x) => { const b = r2(x.dr - x.cr); return { code: x.code, name: x.name, type: x.type, debit: b > 0 ? b : 0, credit: b < 0 ? -b : 0 }; })
    .filter((x) => x.debit || x.credit);
  res.json({ to, rows, total_debit: r2(rows.reduce((s, x) => s + x.debit, 0)), total_credit: r2(rows.reduce((s, x) => s + x.credit, 0)) });
});

/** Day book: every journal entry; ?method= shows only entries paid by that method, ?method=none only non-cash entries. */
r.get('/reports/journal', requireRole('manager'), (req, res) => {
  const to = date(req.query.to || req.asOf || today());
  const from = date(req.query.from || monthStart(to));
  const m = req.query.method;
  const methodSql = [...METHODS, 'transfer'].includes(m) ? 'AND EXISTS (SELECT 1 FROM fund_transactions f WHERE f.entry_id = je.id AND f.method = ?)'
    : m === 'none' ? 'AND NOT EXISTS (SELECT 1 FROM fund_transactions f WHERE f.entry_id = je.id)' : '';
  const entries = db.prepare(`SELECT je.*, u.full_name AS user_name,
      (SELECT GROUP_CONCAT(DISTINCT f.method) FROM fund_transactions f WHERE f.entry_id = je.id) AS methods
    FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by
    WHERE je.date BETWEEN ? AND ? ${methodSql} ORDER BY je.date DESC, je.id DESC LIMIT 500`).all(from, to, ...(methodSql && m !== 'none' ? [m] : []));
  const lines = db.prepare(`SELECT jl.*, a.name AS account_name, a.code, p.name AS party_name, e.name AS employee_name
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id LEFT JOIN parties p ON p.id = jl.party_id
    LEFT JOIN employees e ON e.id = jl.employee_id WHERE jl.entry_id = ?`);
  res.json({ from, to, entries: entries.map((e) => ({ ...e, lines: lines.all(e.id) })) });
});

/**
 * Balance sheet on a date: assets = liabilities + equity.
 * Equity includes the profit of years not yet closed (closed years' profit already sits in Retained Earnings).
 */
r.get('/reports/balance-sheet', requireRole('manager'), (req, res) => {
  const to = date(req.query.to || req.asOf || today());
  const rows = db.prepare(`SELECT a.id, a.code, a.name, a.type, a.is_cash, ROUND(SUM(jl.debit - jl.credit), 2) AS bal
    FROM accounts a JOIN journal_lines jl ON jl.account_id = a.id JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.date <= ? GROUP BY a.id ORDER BY a.code`).all(to).filter((x) => Math.abs(x.bal) > 0.004);
  const pick = (type, sign) => rows.filter((x) => x.type === type).map((x) => ({ code: x.code, name: x.name, amount: r2(x.bal * sign) }));
  const assets = pick('asset', 1), liabilities = pick('liability', -1), equity = pick('equity', -1);
  const unclosed = r2(-rows.filter((x) => x.type === 'income' || x.type === 'expense').reduce((s, x) => s + x.bal, 0));
  if (Math.abs(unclosed) > 0.004) equity.push({ code: '', name: 'Profit of the year (not closed yet)', amount: unclosed });
  const sum = (l) => r2(l.reduce((s, x) => s + x.amount, 0));
  const ta = sum(assets), tl = sum(liabilities), te = sum(equity);
  res.json({ to, assets, liabilities, equity, total_assets: ta, total_liabilities: tl, total_equity: te, balanced: Math.abs(ta - tl - te) < 0.01 });
});

/** Integrity check: stock registers vs. the accounting books. */
r.get('/reports/stock-valuation', requireRole('manager'), (req, res) => {
  const items = listItemsWithStock();
  const raw = r2(items.filter((i) => i.kind === 'raw').reduce((s, i) => s + i.value, 0));
  const goods = r2(items.filter((i) => i.kind !== 'raw').reduce((s, i) => s + i.value, 0));
  res.json({
    items,
    raw: { register: raw, books: balance(ACC.RAW_STOCK) },
    goods: { register: goods, books: balance(ACC.FG_STOCK) },
  });
});

// ---------- dashboard -------------------------------------------------
r.get('/dashboard', (req, res) => {
  const t = req.asOf || today(); // the selected financial year's "today" (its last day for past years)
  const ms = monthStart(t);
  const lowStock = listItemsWithStock(null, t).filter((i) => i.low);
  const emps = db.prepare('SELECT COUNT(*) c FROM employees WHERE active = 1').get().c;
  const att = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) c FROM attendance a JOIN employees e ON e.id = a.employee_id
    WHERE a.date = ? AND e.active = 1 GROUP BY status`).all(t).map((x) => [x.status, x.c]));
  const recentBatches = db.prepare(`SELECT b.id, b.batch_no, b.date, b.qty_produced, b.lot_id, b.status, i.name AS product_name, i.unit
    FROM production_batches b JOIN items i ON i.id = b.product_id WHERE b.date <= ? ORDER BY b.date DESC, b.id DESC LIMIT 5`).all(t);
  const base = { today: t, low_stock: lowStock, attendance: { total: emps, ...att }, recent_batches: recentBatches };

  if (req.user.role === 'staff') return res.json(base); // staff do not see money figures

  // money in/out today across all cash & bank accounts (internal transfers excluded)
  const cashToday = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount END),0) i, COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END),0) o
    FROM fund_transactions WHERE date = ? AND method NOT IN ('transfer', 'opening')`).get(t);
  const salesToday = db.prepare("SELECT COALESCE(SUM(total),0) total, COUNT(*) n, COALESCE(SUM(paid),0) cash FROM sales WHERE date = ? AND status = 'active'").get(t);
  const todayPnl = pnl(t, t);
  const monthPnl = pnl(ms, t);

  const from14 = addDays(t, -13);
  const salesByDay = Object.fromEntries(db.prepare("SELECT date, SUM(total) s FROM sales WHERE status='active' AND date BETWEEN ? AND ? GROUP BY date").all(from14, t).map((x) => [x.date, x.s]));
  const expByDay = Object.fromEntries(db.prepare(`SELECT je.date, SUM(jl.debit - jl.credit) s FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE a.type = 'expense' AND a.code NOT IN ('${ACC.COGS}', '${ACC.OVERHEAD_ABSORBED}') AND je.date BETWEEN ? AND ? AND ${NOT_CLOSING} GROUP BY je.date`).all(from14, t).map((x) => [x.date, x.s]));
  const series = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(from14, i);
    return { date: d, sales: r2(salesByDay[d] || 0), expenses: r2(expByDay[d] || 0) };
  });

  res.json({
    ...base,
    sales_today: { total: r2(salesToday.total), count: salesToday.n, received: r2(salesToday.cash) },
    cash_in_today: r2(cashToday.i),
    cash_out_today: r2(cashToday.o),
    expenses_today: todayPnl.total_expenses,
    cash_in_hand: fundTotal('cash', t),
    bank_balance: fundTotal('bank', t),
    receivable: balance(ACC.RECEIVABLE, { to: t }),
    payable: r2(-balance(ACC.PAYABLE, { to: t })),
    stock_value: { raw: balance(ACC.RAW_STOCK, { to: t }), goods: balance(ACC.FG_STOCK, { to: t }) },
    month: monthPnl,
    series,
    recent_sales: db.prepare(`SELECT s.id, s.invoice_no, s.date, s.total, s.paid, s.status, p.name AS customer_name
      FROM sales s JOIN parties p ON p.id = s.customer_id WHERE s.date <= ? ORDER BY s.date DESC, s.id DESC LIMIT 5`).all(t),
    fiscal_year: req.fy ? { id: req.fy.id, name: req.fy.name, state: req.fy.state, start_date: req.fy.start_date, end_date: req.fy.end_date } : null,
  });
});

// =====================================================================
//  Dashboard analytics: KPIs for a period (vs the period before), trends, breakdowns
// =====================================================================
const shiftMonths = (d, n) => {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
const PERIODS = {
  month: { label: 'This month', back: 1, range: (t) => [monthStart(t), t] },
  last_month: { label: 'Last month', back: 1, range: (t) => { const s = monthStart(shiftMonths(monthStart(t), -1)); return [s, monthEndOf(s)]; } },
  quarter: { label: 'Last 3 months', back: 3, range: (t) => [monthStart(shiftMonths(monthStart(t), -2)), t] },
  year: { label: 'This year', back: 12, range: (t, fy) => [fy?.start_date && fy.start_date <= t ? fy.start_date : `${t.slice(0, 4)}-01-01`, t] },
};

r.get('/dashboard/analytics', (req, res) => {
  const t = req.asOf || today();
  const key = PERIODS[req.query.period] ? req.query.period : 'month';
  const P = PERIODS[key];
  const [from, to] = P.range(t, req.fy);
  const prevFrom = shiftMonths(from, -P.back);
  const prevTo = key === 'last_month' ? monthEndOf(prevFrom) : shiftMonths(to, -P.back);

  // last 12 months, ending with the month of "today"
  const months = Array.from({ length: 12 }, (_, i) => {
    const ms = monthStart(shiftMonths(monthStart(t), i - 11));
    const me = monthEndOf(ms) < t ? monthEndOf(ms) : t;
    return { month: ms.slice(0, 7), from: ms, to: me };
  });
  const prodByMonth = Object.fromEntries(db.prepare(`SELECT substr(date, 1, 7) m, COUNT(*) batches, SUM(qty_produced) units, SUM(total_cost) cost
    FROM production_batches WHERE status = 'active' AND date BETWEEN ? AND ? GROUP BY m`).all(months[0].from, t).map((x) => [x.m, x]));
  const production = months.map((m) => ({ month: m.month, batches: prodByMonth[m.month]?.batches || 0, units: r2(prodByMonth[m.month]?.units || 0), cost: r2(prodByMonth[m.month]?.cost || 0) }));

  if (req.user.role === 'staff') return res.json({ period: { key, label: P.label, from, to }, production }); // no money for staff

  const kpi = (p) => ({ sales: p.sales, cogs: p.cogs, gross_profit: p.gross_profit, operating: p.operating.total, payroll: p.payroll.total, total_expenses: p.total_expenses, net_profit: p.net_profit });
  const cur = pnl(from, to);

  const fundByMonth = Object.fromEntries(db.prepare(`SELECT substr(date, 1, 7) m,
      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount END), 0) i, COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0) o
    FROM fund_transactions WHERE method NOT IN ('transfer', 'opening') AND date BETWEEN ? AND ? GROUP BY m`).all(months[0].from, t).map((x) => [x.m, x]));
  const trend = months.map((m) => {
    const p = pnl(m.from, m.to);
    return { month: m.month, sales: p.sales, cogs: p.cogs, gross_profit: p.gross_profit, expenses: r2(p.total_expenses), net_profit: p.net_profit,
      money_in: r2(fundByMonth[m.month]?.i || 0), money_out: r2(fundByMonth[m.month]?.o || 0) };
  });

  const from30 = addDays(t, -29);
  const byDay = Object.fromEntries(db.prepare(`SELECT date, SUM(total) s, COUNT(*) n FROM sales WHERE status = 'active' AND date BETWEEN ? AND ? GROUP BY date`)
    .all(from30, t).map((x) => [x.date, x]));
  // sales returns come off the day they were booked (net sales)
  const retByDay = Object.fromEntries(db.prepare(`SELECT date, SUM(total) s FROM sale_returns WHERE status = 'active' AND date BETWEEN ? AND ? GROUP BY date`)
    .all(from30, t).map((x) => [x.date, x.s]));
  const daily = Array.from({ length: 30 }, (_, i) => { const d = addDays(from30, i); return { date: d, sales: r2((byDay[d]?.s || 0) - (retByDay[d] || 0)), invoices: byDay[d]?.n || 0 }; });

  const retByItem = Object.fromEntries(db.prepare(`SELECT sri.item_id, SUM(sri.qty) qty, SUM(sri.amount) amount, SUM(CASE WHEN sri.restock = 1 THEN sri.cost ELSE 0 END) cost
    FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id WHERE sr.status = 'active' AND sr.date BETWEEN ? AND ? GROUP BY sri.item_id`)
    .all(from, to).map((x) => [x.item_id, x]));
  const topProducts = db.prepare(`SELECT i.id, i.name, i.unit, i.kind, SUM(si.qty) qty, SUM(si.amount) revenue, SUM(si.cost) cost
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN items i ON i.id = si.item_id
    WHERE s.status = 'active' AND s.date BETWEEN ? AND ? GROUP BY i.id`).all(from, to)
    .map((x) => {
      const b = retByItem[x.id] || { qty: 0, amount: 0, cost: 0 };
      const revenue = r2(x.revenue - b.amount), cost = r2(x.cost - b.cost);
      return { ...x, qty: r2(x.qty - b.qty), revenue, cost, returned_qty: r2(b.qty), margin_pct: revenue ? r2(((revenue - cost) / revenue) * 100) : null };
    })
    .filter((x) => x.qty > 0.0005).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  const ar = accId(ACC.RECEIVABLE);
  const owed = Object.fromEntries(db.prepare(`SELECT jl.party_id, SUM(jl.debit - jl.credit) b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = ? AND je.date <= ? AND jl.party_id IS NOT NULL GROUP BY jl.party_id`).all(ar, t).map((x) => [x.party_id, r2(x.b)]));
  const topCustomers = db.prepare(`SELECT p.id, p.name, COUNT(*) invoices, SUM(s.total) sales, SUM(s.paid) received
    FROM sales s JOIN parties p ON p.id = s.customer_id WHERE s.status = 'active' AND s.date BETWEEN ? AND ?
    GROUP BY p.id`).all(from, to);
  const retByCustomer = Object.fromEntries(db.prepare(`SELECT customer_id, SUM(total) s FROM sale_returns WHERE status = 'active' AND date BETWEEN ? AND ? GROUP BY customer_id`)
    .all(from, to).map((x) => [x.customer_id, x.s]));
  const topCustomersNet = topCustomers.map((x) => ({ ...x, sales: r2(x.sales - (retByCustomer[x.id] || 0)), returned: r2(retByCustomer[x.id] || 0), received: r2(x.received), owes: owed[x.id] || 0 }))
    .sort((a, b) => b.sales - a.sales).slice(0, 8);
  const names = Object.fromEntries(db.prepare("SELECT id, name FROM parties WHERE type = 'customer'").all().map((x) => [x.id, x.name]));
  const receivables = Object.entries(owed).filter(([, b]) => b > 0.005)
    .map(([id, b]) => ({ id: Number(id), name: names[id] || '—', owes: b })).sort((a, b) => b.owes - a.owes).slice(0, 8);

  const expenses = [
    ...cur.operating.lines.filter((x) => x.amount > 0).map((x) => ({ key: x.code, label: x.name, amount: x.amount })),
    ...(cur.payroll.total > 0 ? [{ key: 'payroll', label: 'Salaries & wages', amount: cur.payroll.total }] : []),
  ].sort((a, b) => b.amount - a.amount);

  const items = listItemsWithStock(null, t);
  const stockBy = (k) => r2(items.filter((i) => i.kind === k).reduce((sum, i) => sum + i.value, 0));
  const inv = db.prepare(`SELECT COALESCE(SUM(total), 0) total, COALESCE(SUM(paid), 0) paid, COUNT(*) n FROM sales WHERE status = 'active' AND date BETWEEN ? AND ?`).get(from, to);

  res.json({
    period: { key, label: P.label, from, to, prev_from: prevFrom, prev_to: prevTo },
    kpi: { ...kpi(cur), invoices: inv.n, avg_invoice: inv.n ? r2(inv.total / inv.n) : 0 },
    prev: kpi(pnl(prevFrom, prevTo)),
    position: {
      cash: fundTotal('cash', t), bank: fundTotal('bank', t),
      receivable: balance(ACC.RECEIVABLE, { to: t }), payable: r2(-balance(ACC.PAYABLE, { to: t })),
      stock: { raw: stockBy('raw'), finished: stockBy('finished'), trading: stockBy('trading') },
    },
    collection: { invoiced: r2(inv.total), received: r2(inv.paid), on_credit: r2(inv.total - inv.paid) },
    trend, daily, production, top_products: topProducts, top_customers: topCustomersNet, receivables, expenses,
  });
});

export default r;
