// Cash & Bank: fund accounts, live balances, fund ledger, internal transfers, cheques
//
// Balances always come from the journal; the fund_transactions ledger (written by
// accounting.post) adds the payment method, references and cheque status.
import { Router } from 'express';
import { db, tx, r2, today, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { post, balance, fundAccount, fundTotal, reverseEntry, ACC, METHODS, METHOD_LABEL } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';

const r = Router();
r.use(['/funds', '/reports/payment-methods'], requireRole('manager'));

const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };
const ALL_METHODS = [...METHODS, 'transfer', 'opening'];

/** What a fund movement was for, in plain words (used for grouping and labels). */
export function purposeOf(f) {
  const t = f.ref_type || '';
  if (t.endsWith('_bounce')) return 'Bounced cheques';
  if (t.endsWith('_cancel')) return 'Refunds & cancellations';
  return {
    sale: 'Sales receipts', purchase: 'Purchase payments', expense: 'Expenses', payroll: 'Salaries & wages',
    advance: 'Advances & loans', transfer: 'Internal transfers', opening: 'Opening balances',
    payment: f.direction === 'in' ? 'Customer payments' : 'Supplier payments',
    cash: f.direction === 'in' ? 'Other money in' : 'Other money out',
  }[t] || 'Other';
}

// ---------- accounts ---------------------------------------------------
/** All cash & bank accounts with live balances and activity. */
r.get('/funds', (req, res) => {
  const t = req.asOf || today(); // balances as on the selected year's "today"
  const m = t.slice(0, 7);
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.fund_type, a.bank_name, a.account_number, a.active,
      COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = a.id AND je.date <= ?), 0) AS balance,
      COALESCE((SELECT SUM(CASE WHEN direction = 'in' THEN amount END) FROM fund_transactions WHERE account_id = a.id AND date = ?), 0) AS today_in,
      COALESCE((SELECT SUM(CASE WHEN direction = 'out' THEN amount END) FROM fund_transactions WHERE account_id = a.id AND date = ?), 0) AS today_out,
      COALESCE((SELECT SUM(CASE WHEN direction = 'in' THEN amount END) FROM fund_transactions WHERE account_id = a.id AND date BETWEEN ? AND ?), 0) AS month_in,
      COALESCE((SELECT SUM(CASE WHEN direction = 'out' THEN amount END) FROM fund_transactions WHERE account_id = a.id AND date BETWEEN ? AND ?), 0) AS month_out,
      COALESCE((SELECT SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) FROM fund_transactions WHERE account_id = a.id AND cheque_status = 'pending' AND date <= ?), 0) AS pending_cheques,
      (SELECT COUNT(*) FROM fund_transactions WHERE account_id = a.id AND cheque_status = 'pending' AND date <= ?) AS pending_count,
      (SELECT MAX(date) FROM fund_transactions WHERE account_id = a.id) AS last_activity
    FROM accounts a WHERE a.is_cash = 1 AND (a.active = 1 OR ? = 1)
    ORDER BY a.fund_type DESC, a.code`).all(t, t, t, `${m}-01`, monthEnd(m), `${m}-01`, monthEnd(m), t, t, req.query.all ? 1 : 0);
  const accounts = rows.map((a) => ({ ...a, ...Object.fromEntries(['balance', 'today_in', 'today_out', 'month_in', 'month_out', 'pending_cheques'].map((k) => [k, r2(a[k])])) }));
  const cash = fundTotal('cash', t), bank = fundTotal('bank', t);
  res.json({ accounts, totals: { cash, bank, all: r2(cash + bank) } });
});

/** Open a new cash box or bank account, optionally with an opening balance. */
r.post('/funds', (req, res) => {
  const type = req.body.fund_type === 'cash' ? 'cash' : 'bank';
  const name = required(req.body.name, 'Account name');
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE').get(name)) throw bad('An account with this name already exists');
  const opening = r2(Number(req.body.opening_balance) || 0);
  if (opening < 0) throw bad('Opening balance cannot be negative');
  const [lo, hi] = type === 'cash' ? [1001, 1009] : [1011, 1099];
  const used = new Set(db.prepare("SELECT code FROM accounts WHERE code BETWEEN ? AND ?").all(String(lo), String(hi)).map((x) => Number(x.code)));
  let code = lo; while (used.has(code) && code <= hi) code++;
  if (code > hi) throw bad('Too many accounts of this type');
  const out = tx(() => {
    const { id } = db.prepare(`INSERT INTO accounts(code, name, type, is_cash, fund_type, bank_name, account_number)
      VALUES (?, ?, 'asset', 1, ?, ?, ?) RETURNING id`)
      .get(String(code), name, type, type === 'bank' ? req.body.bank_name || null : null, type === 'bank' ? req.body.account_number || null : null);
    if (opening > 0) {
      post({ date: date(req.body.opening_date), memo: `Opening balance: ${name}`, ref_type: 'opening', ref_id: id, user_id: req.user.id,
        payment: { method: 'opening' }, lines: [{ account: id, debit: opening }, { account: ACC.OPENING, credit: opening }] });
    }
    return { id, code: String(code) };
  });
  audit(req.user.id, 'create', 'fund_account', out.id, { name, type, opening });
  res.json(out);
});

r.put('/funds/:id', (req, res) => {
  const a = fundAccount(req.params.id);
  const name = req.body.name === undefined ? a.name : required(req.body.name, 'Account name');
  if (name.toLowerCase() !== a.name.toLowerCase() && db.prepare('SELECT 1 FROM accounts WHERE name = ? COLLATE NOCASE').get(name)) throw bad('An account with this name already exists');
  const active = req.body.active === undefined ? a.active : req.body.active ? 1 : 0;
  if (!active && a.active) {
    if (Math.abs(balance(a.id)) > 0.005) throw bad(`Move the remaining ${balance(a.id)} out of "${a.name}" before closing it`);
    const others = db.prepare('SELECT COUNT(*) c FROM accounts WHERE is_cash = 1 AND fund_type = ? AND active = 1 AND id <> ?').get(a.fund_type, a.id).c;
    if (!others) throw bad(`Keep at least one ${a.fund_type} account open`);
  }
  db.prepare('UPDATE accounts SET name = ?, bank_name = ?, account_number = ?, active = ? WHERE id = ?')
    .run(name, req.body.bank_name ?? a.bank_name, req.body.account_number ?? a.account_number, active, a.id);
  audit(req.user.id, 'update', 'fund_account', a.id, { name, active });
  res.json({ ok: true });
});

// ---------- ledger -----------------------------------------------------
/**
 * Cash & bank ledger with filters.
 *  ?account_id  ?month | ?from&to  ?method  ?direction=in|out  ?purpose  ?cheque=pending  ?q
 * With one account and no other filters, rows carry a running balance.
 */
r.get('/funds/transactions', (req, res) => {
  const q = req.query;
  let from, to;
  if (q.from || q.to) { from = date(q.from || q.to); to = date(q.to || q.from); }
  else { const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : (req.asOf || today()).slice(0, 7); from = `${m}-01`; to = monthEnd(m); }
  const pendingOnly = q.cheque === 'pending';
  const where = pendingOnly ? ["f.cheque_status = 'pending'", 'f.date <= ?'] : ['f.date BETWEEN ? AND ?'];
  const args = pendingOnly ? [req.asOf || today()] : [from, to];
  if (q.account_id) { where.push('f.account_id = ?'); args.push(Number(q.account_id)); }
  else if (q.fund_type) { where.push('a.fund_type = ?'); args.push(q.fund_type === 'bank' ? 'bank' : 'cash'); }
  if (ALL_METHODS.includes(q.method)) { where.push('f.method = ?'); args.push(q.method); }
  if (q.direction === 'in' || q.direction === 'out') { where.push('f.direction = ?'); args.push(q.direction); }
  if (q.q) { where.push('(f.memo LIKE ? OR f.cheque_no LIKE ? OR f.reference LIKE ? OR p.name LIKE ? OR e.name LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s, s, s); }
  let rows = db.prepare(`
    SELECT f.*, a.name AS account_name, a.fund_type, p.name AS party_name, e.name AS employee_name
    FROM fund_transactions f JOIN accounts a ON a.id = f.account_id
    LEFT JOIN parties p ON p.id = f.party_id LEFT JOIN employees e ON e.id = f.employee_id
    WHERE ${where.join(' AND ')} ORDER BY f.date, f.id`).all(...args).map((f) => ({ ...f, purpose: purposeOf(f) }));
  if (q.purpose) rows = rows.filter((f) => f.purpose === q.purpose);

  // Opening / running balance when looking at whole accounts (no narrowing filters)
  const narrowed = pendingOnly || q.method || q.direction || q.q || q.purpose;
  let opening = null, closing = null;
  if (!narrowed) {
    const accWhere = q.account_id ? 'jl.account_id = ?' : q.fund_type ? 'a.fund_type = ?' : '1 = 1';
    const accArg = q.account_id ? [Number(q.account_id)] : q.fund_type ? [q.fund_type === 'bank' ? 'bank' : 'cash'] : [];
    opening = r2(db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id WHERE a.is_cash = 1 AND ${accWhere} AND je.date < ?`).get(...accArg, from).b);
    let run = opening;
    rows = rows.map((f) => { run = r2(run + (f.direction === 'in' ? f.amount : -f.amount)); return { ...f, balance: run }; });
    closing = run;
  }
  const sum = (list) => r2(list.reduce((s, f) => s + f.amount, 0));
  const ins = rows.filter((f) => f.direction === 'in'), outs = rows.filter((f) => f.direction === 'out');
  const byMethod = ALL_METHODS.map((m) => ({ method: m, label: METHOD_LABEL[m], in: sum(ins.filter((f) => f.method === m)), out: sum(outs.filter((f) => f.method === m)) }))
    .filter((x) => x.in || x.out);
  res.json({ from, to, opening, closing, total_in: sum(ins), total_out: sum(outs), by_method: byMethod, rows: rows.reverse() });
});

// ---------- internal transfers ---------------------------------------------
/** Move money between own accounts (cash deposited in bank, cash withdrawn, bank to bank). Call inside tx(). */
export function transferFunds({ from_account_id, to_account_id, amount, date: d, note, reference }, userId) {
  const from = fundAccount(from_account_id), to = fundAccount(to_account_id);
  if (from.id === to.id) throw bad('Choose two different accounts');
  if (!from.active || !to.active) throw bad('One of these accounts is closed');
  amount = r2(num(amount, 'amount'));
  d = date(d);
  const available = balance(from.id, { to: d });
  if (amount > available + 0.005) throw bad(`Only ${available.toLocaleString('en-PK')} is in "${from.name}" on ${d}. You cannot move more than that.`);
  const what = from.fund_type === 'cash' && to.fund_type === 'bank' ? `Cash deposited into ${to.name}`
    : from.fund_type === 'bank' && to.fund_type === 'cash' ? `Cash withdrawn from ${from.name}` : `Transfer ${from.name} → ${to.name}`;
  const memo = [what, note && String(note).trim()].filter(Boolean).join(' — ');
  return post({ date: d, memo, ref_type: 'transfer', user_id: userId, payment: { method: 'transfer', reference: reference || null },
    lines: [{ account: to.id, debit: amount }, { account: from.id, credit: amount }] });
}

r.post('/funds/transfer', (req, res) => {
  const entry = tx(() => transferFunds(req.body, req.user.id));
  audit(req.user.id, 'transfer', 'fund', entry, req.body);
  res.json({ entry_id: entry });
});

// ---------- cheques -------------------------------------------------------
function getFundTxn(id) {
  const f = db.prepare('SELECT * FROM fund_transactions WHERE id = ?').get(Number(id));
  if (!f) throw notFound('Transaction');
  if (f.method !== 'cheque' || f.reverses_id) throw bad('This is not a cheque');
  if (f.cheque_status !== 'pending') throw bad(`This cheque is already ${f.cheque_status}`);
  return f;
}

/** Cheque cleared by the bank (money was already shown in the bank account). */
r.post('/funds/transactions/:id/clear', (req, res) => {
  const f = getFundTxn(req.params.id);
  db.prepare("UPDATE fund_transactions SET cheque_status = 'cleared', cleared_date = ? WHERE id = ?").run(date(req.body?.date), f.id);
  audit(req.user.id, 'cheque_cleared', 'fund_txn', f.id);
  res.json({ ok: true });
});

/**
 * Cheque bounced: the payment is reversed, so the customer owes again (or we owe the
 * supplier again) and the bank balance goes back down/up. Only for customer/supplier cheques.
 */
r.post('/funds/transactions/:id/bounce', (req, res) => {
  const f = getFundTxn(req.params.id);
  if (!['sale', 'purchase', 'payment'].includes(f.ref_type)) {
    throw bad('Only customer and supplier cheques can be marked bounced. For an expense or salary, edit it or pay it again.');
  }
  const d = date(req.body?.date);
  tx(() => {
    reverseEntry(f.entry_id, {
      date: d, memo: `Cheque ${f.cheque_no ? '#' + f.cheque_no + ' ' : ''}bounced — ${f.memo}`,
      ref_type: `${f.ref_type}_bounce`, ref_id: f.ref_id, user_id: req.user.id,
    });
    db.prepare("UPDATE fund_transactions SET cheque_status = 'bounced', cleared_date = ? WHERE id = ?").run(d, f.id);
    if (f.ref_type === 'sale') db.prepare('UPDATE sales SET paid = round(paid - ?, 2) WHERE id = ?').run(f.amount, f.ref_id);
    if (f.ref_type === 'purchase') db.prepare('UPDATE purchases SET paid = round(paid - ?, 2) WHERE id = ?').run(f.amount, f.ref_id);
  });
  audit(req.user.id, 'cheque_bounced', 'fund_txn', f.id, { amount: f.amount });
  res.json({ ok: true });
});

// ---------- payment method report ----------------------------------------
/** Money in / out by payment method and purpose for a period (internal transfers shown separately). */
r.get('/reports/payment-methods', (req, res) => {
  const to = date(req.query.to || today());
  const from = date(req.query.from || `${to.slice(0, 7)}-01`);
  const rows = db.prepare(`SELECT f.*, a.name AS account_name, a.fund_type FROM fund_transactions f JOIN accounts a ON a.id = f.account_id
    WHERE f.date BETWEEN ? AND ?`).all(from, to);
  const purposes = new Map();
  const methods = Object.fromEntries(ALL_METHODS.map((m) => [m, { method: m, label: METHOD_LABEL[m], in: 0, out: 0, count: 0 }]));
  const accounts = new Map();
  for (const f of rows) {
    const p = purposeOf(f);
    const g = purposes.get(p) || { purpose: p, ...Object.fromEntries(ALL_METHODS.map((m) => [m, 0])), in: 0, out: 0 };
    const signed = f.direction === 'in' ? f.amount : -f.amount;
    g[f.method] = r2(g[f.method] + signed);
    g[f.direction] = r2(g[f.direction] + f.amount);
    purposes.set(p, g);
    const m = methods[f.method];
    m[f.direction] = r2(m[f.direction] + f.amount); m.count++;
    const a = accounts.get(f.account_id) || { id: f.account_id, name: f.account_name, fund_type: f.fund_type, in: 0, out: 0 };
    a[f.direction] = r2(a[f.direction] + f.amount);
    accounts.set(f.account_id, a);
  }
  res.json({
    from, to,
    methods: Object.values(methods).filter((m) => m.count),
    purposes: [...purposes.values()].sort((a, b) => b.in + b.out - (a.in + a.out)),
    accounts: [...accounts.values()],
  });
});

export default r;
