// Operational expenses: custom categories + expense register
//
// Every expense is a voucher in `expenses` AND one journal entry
//   Dr <expense category>  /  Cr Cash in Hand | Bank
// so it reduces the cash book instantly and appears in Profit & Loss.
// Editing re-posts the entry; deleting removes it (the voucher row and the
// audit log keep the history).
import { Router } from 'express';
import { db, tx, r2, nextNo, audit, today } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { post, resolveFund, METHODS } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';

const r = Router();
r.use(['/expenses', '/expense-categories'], requireRole('manager'));

const addDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const monthEnd = (d) => { const [y, m] = d.split('-').map(Number); return `${d.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

// ---------- categories ------------------------------------------------
function getCategory(id) {
  const c = db.prepare("SELECT * FROM accounts WHERE id = ? AND type = 'expense' AND is_expense_category = 1").get(Number(id));
  if (!c) throw bad('Choose an expense category');
  return c;
}

export function createCategory(name, description = null) {
  name = required(name, 'Category name');
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE').get(name)) throw bad('A category with this name already exists');
  const max = db.prepare("SELECT MAX(CAST(code AS INTEGER)) m FROM accounts WHERE code BETWEEN '5300' AND '5999'").get().m;
  const code = String(Math.max(5300, (max || 5290) + 10));
  return db.prepare("INSERT INTO accounts(code, name, type, is_expense_category, description) VALUES (?, ?, 'expense', 1, ?) RETURNING id, code")
    .get(code, name, description || null);
}

/** Categories with this-month and all-time totals (used for the picker and the manager). */
r.get('/expense-categories', (req, res) => {
  const t = today();
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.description, a.active, a.system,
      COALESCE(SUM(CASE WHEN e.date BETWEEN ? AND ? THEN e.amount END), 0) AS this_month,
      COUNT(e.id) AS uses,
      MAX(e.date) AS last_used
    FROM accounts a LEFT JOIN expenses e ON e.category_id = a.id AND e.status = 'active'
    WHERE a.type = 'expense' AND a.is_expense_category = 1 AND (a.active = 1 OR ? = 1)
    GROUP BY a.id ORDER BY a.active DESC, uses DESC, a.name`).all(monthStart(t), monthEnd(t), req.query.all ? 1 : 0);
  res.json(rows.map((c) => ({ ...c, this_month: r2(c.this_month) })));
});

r.post('/expense-categories', (req, res) => {
  const c = createCategory(req.body.name, req.body.description);
  audit(req.user.id, 'create', 'expense_category', c.id, { name: req.body.name });
  res.json(c);
});

r.put('/expense-categories/:id', (req, res) => {
  const c = getCategory(req.params.id);
  const name = req.body.name === undefined ? c.name : required(req.body.name, 'Category name');
  if (name.toLowerCase() !== c.name.toLowerCase() && db.prepare('SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE').get(name)) {
    throw bad('A category with this name already exists');
  }
  const active = req.body.active === undefined ? c.active : req.body.active ? 1 : 0;
  db.prepare('UPDATE accounts SET name = ?, description = ?, active = ? WHERE id = ?')
    .run(name, req.body.description === undefined ? c.description : req.body.description || null, active, c.id);
  audit(req.user.id, 'update', 'expense_category', c.id, { name, active });
  res.json({ ok: true });
});

// ---------- expense vouchers -----------------------------------------
function readExpense(b) {
  const cat = getCategory(b.category_id);
  if (!cat.active) throw bad(`"${cat.name}" is hidden. Show it again in Manage categories first.`);
  const pay = resolveFund(b); // Cash / Bank transfer / Cheque + reference fields
  const d = date(b.date);
  assertOpenDate(d, 'An expense');
  return {
    cat,
    date: d,
    amount: r2(num(b.amount, 'amount')),
    pay_account_id: pay.account,
    payment: pay.meta,
    paid_to: String(b.paid_to || '').trim() || null,
    bill_no: String(b.bill_no || '').trim() || null,
    note: String(b.note || '').trim() || null,
  };
}

const memoOf = (e) => [e.cat.name, e.note, e.paid_to && `paid to ${e.paid_to}`].filter(Boolean).join(' — ');

function postExpense(id, e, userId) {
  return post({
    date: e.date, memo: memoOf(e), ref_type: 'expense', ref_id: id, user_id: userId, payment: e.payment,
    lines: [{ account: e.cat.id, debit: e.amount }, { account: e.pay_account_id, credit: e.amount }],
  });
}

/** Create an expense (also used by the Cash Book "Cash Out" form). Call inside tx(). */
export function createExpense(body, userId) {
  const e = readExpense(body);
  const no = nextNo('EXP');
  const { id } = db.prepare(`INSERT INTO expenses(expense_no, date, category_id, amount, pay_account_id, paid_to, bill_no, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).get(no, e.date, e.cat.id, e.amount, e.pay_account_id, e.paid_to, e.bill_no, e.note, userId);
  const entry = postExpense(id, e, userId);
  db.prepare('UPDATE expenses SET journal_entry_id = ? WHERE id = ?').run(entry, id);
  return { id, expense_no: no, journal_entry_id: entry };
}

export function deleteExpense(id, userId) {
  const x = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(id));
  if (!x || x.status !== 'active') throw notFound('Expense');
  assertOpenDate(x.date, 'This expense');
  db.prepare("DELETE FROM journal_entries WHERE ref_type = 'expense' AND ref_id = ?").run(x.id);
  db.prepare("UPDATE expenses SET status = 'deleted', journal_entry_id = NULL, updated_at = datetime('now') WHERE id = ?").run(x.id);
  audit(userId, 'delete', 'expense', x.id, { expense_no: x.expense_no, amount: x.amount, date: x.date });
}

/**
 * Expense register with filters and summaries.
 *   ?month=YYYY-MM            (default this month)  or  ?from=&to=
 *   &category_id= &account_id= &q=
 */
r.get('/expenses', (req, res) => {
  let from, to;
  if (req.query.from || req.query.to) { from = date(req.query.from || req.query.to); to = date(req.query.to || req.query.from); }
  else { const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : (req.asOf || today()).slice(0, 7); from = `${m}-01`; to = monthEnd(from); }
  if (to < from) throw bad('End date is before start date');

  const where = ["e.status = 'active'", 'e.date BETWEEN ? AND ?'];
  const args = [from, to];
  if (req.query.category_id) { where.push('e.category_id = ?'); args.push(Number(req.query.category_id)); }
  if (req.query.account_id) { where.push('e.pay_account_id = ?'); args.push(Number(req.query.account_id)); }
  if (METHODS.includes(req.query.method)) { where.push('f.method = ?'); args.push(req.query.method); }
  if (req.query.q) { where.push('(e.note LIKE ? OR e.paid_to LIKE ? OR e.bill_no LIKE ? OR e.expense_no LIKE ?)'); const q = `%${req.query.q}%`; args.push(q, q, q, q); }
  const rows = db.prepare(`
    SELECT e.*, a.name AS category_name, p.name AS pay_account_name, u.full_name AS created_by_name,
      f.method AS payment_method, f.reference, f.cheque_no, f.cheque_date, f.bank_name, f.cheque_status
    FROM expenses e JOIN accounts a ON a.id = e.category_id JOIN accounts p ON p.id = e.pay_account_id
    LEFT JOIN fund_transactions f ON f.entry_id = e.journal_entry_id
    LEFT JOIN users u ON u.id = e.created_by
    WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC`).all(...args);

  const total = r2(rows.reduce((s, x) => s + x.amount, 0));
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const x of rows) {
      const k = keyFn(x);
      const g = m.get(k) || { key: k, label: labelFn(x), amount: 0, count: 0 };
      g.amount += x.amount; g.count += 1; m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, amount: r2(g.amount), pct: total ? r2((g.amount / total) * 100) : 0 }));
  };

  // Same-length period just before, for "vs last month"
  const days = Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 864e5) + 1;
  const isMonth = from === monthStart(from) && to === monthEnd(from);
  const prevTo = addDays(from, -1);
  const prevFrom = isMonth ? monthStart(prevTo) : addDays(from, -days);
  const prevTotal = r2(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE status='active' AND date BETWEEN ? AND ?").get(prevFrom, prevTo).s);

  res.json({
    from, to, rows, total, count: rows.length,
    by_category: group((x) => x.category_id, (x) => x.category_name).sort((a, b) => b.amount - a.amount),
    by_day: group((x) => x.date, (x) => x.date).sort((a, b) => (a.key < b.key ? 1 : -1)),
    by_mode: group((x) => x.pay_account_id, (x) => x.pay_account_name),
    by_method: group((x) => x.payment_method, (x) => x.payment_method),
    previous: { from: prevFrom, to: prevTo, total: prevTotal },
  });
});

r.get('/expenses/:id', (req, res) => {
  const x = db.prepare(`SELECT e.*, a.name AS category_name, p.name AS pay_account_name,
      f.method AS payment_method, f.reference, f.cheque_no, f.cheque_date, f.bank_name, f.cheque_status
    FROM expenses e JOIN accounts a ON a.id = e.category_id JOIN accounts p ON p.id = e.pay_account_id
    LEFT JOIN fund_transactions f ON f.entry_id = e.journal_entry_id WHERE e.id = ?`).get(Number(req.params.id));
  if (!x) throw notFound('Expense');
  res.json(x);
});

r.post('/expenses', (req, res) => {
  const out = tx(() => createExpense(req.body, req.user.id));
  audit(req.user.id, 'create', 'expense', out.id, { amount: req.body.amount });
  res.json(out);
});

/** Edit: update the voucher and re-post its journal entry (cash book follows automatically). */
r.put('/expenses/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(req.params.id));
  if (!old || old.status !== 'active') throw notFound('Expense');
  assertOpenDate(old.date, 'This expense');
  // Payment details not sent in this edit stay as they were (method, cheque no., reference)
  const oldPay = db.prepare('SELECT * FROM fund_transactions WHERE entry_id = ?').get(old.journal_entry_id) || {};
  const touched = ['payment_method', 'account_id', 'pay_account_id'].some((k) => k in req.body);
  const keep = touched ? {} : { payment_method: oldPay.method, reference: oldPay.reference, cheque_no: oldPay.cheque_no, cheque_date: oldPay.cheque_date, bank_name: oldPay.bank_name };
  const e = readExpense({ ...old, ...keep, ...req.body, pay_account_id: req.body.account_id ?? req.body.pay_account_id ?? (req.body.payment_method ? undefined : old.pay_account_id) });
  tx(() => {
    db.prepare("DELETE FROM journal_entries WHERE ref_type = 'expense' AND ref_id = ?").run(old.id);
    const entry = postExpense(old.id, e, req.user.id);
    if (oldPay.cheque_status === 'cleared' && e.payment.method === 'cheque' && e.payment.cheque_no === oldPay.cheque_no) {
      db.prepare("UPDATE fund_transactions SET cheque_status = 'cleared', cleared_date = ? WHERE entry_id = ?").run(oldPay.cleared_date, entry);
    }
    db.prepare(`UPDATE expenses SET date=?, category_id=?, amount=?, pay_account_id=?, paid_to=?, bill_no=?, note=?,
      journal_entry_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(e.date, e.cat.id, e.amount, e.pay_account_id, e.paid_to, e.bill_no, e.note, entry, old.id);
  });
  audit(req.user.id, 'update', 'expense', old.id, { before: { amount: old.amount, date: old.date, category_id: old.category_id }, after: { amount: e.amount, date: e.date, category_id: e.cat.id } });
  res.json({ ok: true });
});

r.delete('/expenses/:id', (req, res) => {
  tx(() => deleteExpense(req.params.id, req.user.id));
  res.json({ ok: true });
});

export default r;
