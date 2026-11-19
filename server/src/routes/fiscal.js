// Financial years: setup, pre-closing checks, year-end closing with carry-forward, reopening.
//
// Year-end closing (one transaction):
//   1. snapshot the closing position on the last day: every GL account, customer,
//      supplier, cash/bank account, item (qty + weighted average cost) and batch
//   2. post the closing entry: income & expense accounts -> Retained Earnings
//   3. store the snapshot as the NEW year's opening balances (fiscal_year_balances)
//   4. lock the year (status 'closed'; database triggers then reject any change)
// The ledger is continuous, so the new year's balances start exactly where the old
// year ended; the snapshot records it and is verified against the books.
import { Router } from 'express';
import { db, tx, r2, r3, today, audit, getSettings, fyBoundsFor, restampFiscalYears, FY_TABLES } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, date, notFound } from '../errors.js';
import { post, accId, ACC } from '../accounting.js';
import { fyState, getFy, currentFy, asOfFor } from '../fiscal.js';
import { pnl } from './finance.js';

const r = Router();
const dayAfter = (d) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + 1); return x.toLocaleDateString('en-CA'); };
const dayBefore = (d) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() - 1); return x.toLocaleDateString('en-CA'); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5) + 1;
const NOT_CLOSING = "(je.ref_type IS NULL OR je.ref_type <> 'year_close')";

function mustGet(id) {
  const fy = getFy(id);
  if (!fy) throw notFound('Financial year');
  return fy;
}
const rowsInYear = (fyId) => FY_TABLES.reduce((n, [t]) => n + db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE fiscal_year_id = ?`).get(fyId).c, 0);

function decorate(fy) {
  const state = fyState(fy);
  const entries = db.prepare('SELECT COUNT(*) c FROM journal_entries WHERE fiscal_year_id = ?').get(fy.id).c;
  const out = { ...fy, state, entries, closing_summary: fy.closing_summary ? JSON.parse(fy.closing_summary) : null };
  if (fy.status === 'open') out.profit_so_far = pnl(fy.start_date, asOfFor(fy)).net_profit;
  out.opening_balances = db.prepare('SELECT COUNT(*) c FROM fiscal_year_balances WHERE fiscal_year_id = ?').get(fy.id).c;
  return out;
}

r.get('/financial-years', (req, res) => {
  const years = db.prepare('SELECT * FROM financial_years ORDER BY start_date DESC').all().map(decorate);
  res.json({ years, current_id: currentFy()?.id ?? null, viewing_id: req.fy?.id ?? null, fy_start_month: getSettings().fy_start_month || '07' });
});

// ---------- setup (admin) ------------------------------------------------
function validateRange(start, end, exceptId = null) {
  if (start >= end) throw bad('The year must end after it starts');
  const len = daysBetween(start, end);
  if (len < 28 || len > 550) throw bad('A financial year must be between 1 and 18 months long');
  const clash = db.prepare('SELECT name FROM financial_years WHERE id IS NOT ? AND start_date <= ? AND end_date >= ?').get(exceptId, end, start);
  if (clash) throw bad(`These dates overlap ${clash.name}`);
}
function suggestName(start, end) {
  const y1 = start.slice(0, 4), y2 = end.slice(0, 4);
  return y1 === y2 ? `FY ${y1}` : `FY ${y1}-${y2.slice(2)}`;
}

r.post('/financial-years', requireRole('admin'), (req, res) => {
  const start = date(req.body.start_date), end = date(req.body.end_date);
  validateRange(start, end);
  const name = String(req.body.name || '').trim() || suggestName(start, end);
  if (db.prepare('SELECT 1 FROM financial_years WHERE name = ?').get(name)) throw bad('A year with this name already exists');
  const id = tx(() => {
    const { id } = db.prepare('INSERT INTO financial_years(name, start_date, end_date) VALUES (?,?,?) RETURNING id').get(name, start, end);
    restampFiscalYears();
    return id;
  });
  audit(req.user.id, 'create', 'financial_year', id, { name, start, end });
  res.json({ id });
});

r.put('/financial-years/:id', requireRole('admin'), (req, res) => {
  const fy = mustGet(req.params.id);
  if (fy.status === 'closed') throw bad('A closed year cannot be changed. Reopen it first.');
  const start = date(req.body.start_date || fy.start_date), end = date(req.body.end_date || fy.end_date);
  validateRange(start, end, fy.id);
  const name = String(req.body.name || fy.name).trim();
  tx(() => {
    db.prepare('UPDATE financial_years SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(name, start, end, fy.id);
    restampFiscalYears();
    const orphan = FY_TABLES.find(([t]) => db.prepare(`SELECT 1 FROM ${t} WHERE fiscal_year_id IS NULL LIMIT 1`).get());
    if (orphan) throw bad('Some existing entries would no longer belong to any financial year. Keep the dates covering them.');
  });
  audit(req.user.id, 'update', 'financial_year', fy.id, { name, start, end });
  res.json({ ok: true });
});

r.delete('/financial-years/:id', requireRole('admin'), (req, res) => {
  const fy = mustGet(req.params.id);
  if (fy.status === 'closed') throw bad('A closed year cannot be deleted');
  if (rowsInYear(fy.id)) throw bad('This year already has entries and cannot be deleted');
  db.prepare('DELETE FROM financial_years WHERE id = ?').run(fy.id);
  audit(req.user.id, 'delete', 'financial_year', fy.id, { name: fy.name });
  res.json({ ok: true });
});

// ---------- closing position --------------------------------------------
/** Closing position on the year's last day (before the closing entry). */
function closingPosition(fy) {
  const end = fy.end_date;
  const accounts = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.is_cash, a.fund_type, ROUND(SUM(jl.debit - jl.credit), 2) AS balance
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE je.date <= ? GROUP BY a.id ORDER BY a.code`).all(end).filter((a) => Math.abs(a.balance) > 0.004);
  const parties = db.prepare(`
    SELECT p.id, p.name, p.type, ROUND(SUM(jl.debit - jl.credit), 2) AS bal
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN parties p ON p.id = jl.party_id
    WHERE je.date <= ? AND jl.account_id IN (?, ?) GROUP BY p.id ORDER BY p.type, p.name`).all(end, accId(ACC.RECEIVABLE), accId(ACC.PAYABLE))
    .map((p) => ({ id: p.id, name: p.name, type: p.type, amount: r2(p.type === 'customer' ? p.bal : -p.bal) }))
    .filter((p) => Math.abs(p.amount) > 0.004);
  const funds = db.prepare(`
    SELECT a.id, a.name, a.fund_type, a.bank_name,
      ROUND(COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_id = a.id AND je.date <= ?), 0), 2) AS amount,
      (SELECT COUNT(*) FROM fund_transactions f WHERE f.account_id = a.id AND f.cheque_status = 'pending' AND f.date <= ?) AS pending_cheques
    FROM accounts a WHERE a.is_cash = 1 ORDER BY a.fund_type DESC, a.code`).all(end, end)
    .filter((f) => Math.abs(f.amount) > 0.004 || f.pending_cheques);
  // Stock from the movement ledger up to the last day (exact even if later entries exist)
  const items = db.prepare(`
    SELECT i.id, i.name, i.kind, i.unit, i.container, ROUND(SUM(m.qty), 6) AS qty, ROUND(SUM(m.value), 2) AS value
    FROM stock_movements m JOIN items i ON i.id = m.item_id WHERE m.date <= ? GROUP BY i.id ORDER BY i.kind, i.name`).all(end)
    .filter((i) => Math.abs(i.qty) > 1e-6 || Math.abs(i.value) > 0.004)
    .map((i) => ({ ...i, qty: r3(i.qty), unit_cost: Math.abs(i.qty) > 1e-6 ? Math.round((i.value / i.qty) * 1e4) / 1e4 : 0 }));
  const lots = db.prepare(`
    SELECT l.id, l.lot_code, l.unit_cost, i.name, i.unit, i.kind, ROUND(SUM(m.qty), 6) AS qty
    FROM stock_movements m JOIN stock_lots l ON l.id = m.lot_id JOIN items i ON i.id = l.item_id
    WHERE m.date <= ? GROUP BY l.id HAVING SUM(m.qty) > 1e-6 ORDER BY i.name, l.date`).all(end)
    .map((l) => ({ ...l, qty: r3(l.qty), value: r2(l.qty * l.unit_cost) }));

  const bal = (code) => accounts.find((a) => a.code === code)?.balance || 0;
  const stockValue = (kind) => r2(items.filter((i) => (kind === 'raw' ? i.kind === 'raw' : i.kind !== 'raw')).reduce((s, i) => s + i.value, 0));
  const pl = pnl(fy.start_date, end);
  const income = accounts.filter((a) => a.type === 'income' || a.type === 'expense');
  const dr = r2(accounts.reduce((s, a) => s + Math.max(0, a.balance), 0));
  const cr = r2(accounts.reduce((s, a) => s + Math.max(0, -a.balance), 0));
  return {
    accounts, parties, funds, items, lots, pnl: pl, pl_accounts: income,
    net_profit: r2(-income.reduce((s, a) => s + a.balance, 0)),
    totals: {
      cash: r2(funds.filter((f) => f.fund_type === 'cash').reduce((s, f) => s + f.amount, 0)),
      bank: r2(funds.filter((f) => f.fund_type === 'bank').reduce((s, f) => s + f.amount, 0)),
      receivable: r2(parties.filter((p) => p.type === 'customer').reduce((s, p) => s + p.amount, 0)),
      payable: r2(parties.filter((p) => p.type === 'supplier').reduce((s, p) => s + p.amount, 0)),
      stock_raw: stockValue('raw'), stock_goods: stockValue('goods'),
      books_raw: r2(bal(ACC.RAW_STOCK)), books_goods: r2(bal(ACC.FG_STOCK)),
      retained_before: r2(-bal(ACC.RETAINED)),
      trial_debit: dr, trial_credit: cr,
    },
  };
}

/** Next year: the one starting the day after, or a proposal of the same length. */
function nextYearOf(fy) {
  const existing = db.prepare('SELECT * FROM financial_years WHERE start_date = ?').get(dayAfter(fy.end_date));
  if (existing) return { ...existing, exists: true };
  const start = dayAfter(fy.end_date);
  const b = fyBoundsFor(start, start.slice(5, 7));
  const end = b.start === start ? b.end : (() => { const x = new Date(`${start}T12:00:00`); x.setFullYear(x.getFullYear() + 1); x.setDate(x.getDate() - 1); return x.toLocaleDateString('en-CA'); })();
  return { exists: false, name: suggestName(start, end), start_date: start, end_date: end };
}

/** Everything that must (blockers) or should (warnings) be sorted out before closing. */
function checks(fy, pos) {
  const blockers = [], warnings = [];
  if (fy.status === 'closed') blockers.push(`${fy.name} is already closed.`);
  if (today() < fy.end_date) blockers.push(`${fy.name} ends on ${fy.end_date}. It can be closed from that day onwards.`);
  const earlier = db.prepare("SELECT name FROM financial_years WHERE status = 'open' AND end_date < ? ORDER BY start_date").all(fy.start_date);
  if (earlier.length) blockers.push(`Close the earlier year first: ${earlier.map((e) => e.name).join(', ')}.`);
  const drafts = db.prepare(`SELECT p.month, COUNT(*) c FROM payroll p WHERE p.status = 'draft' AND (p.month || '-01') BETWEEN ? AND ? GROUP BY p.month`).all(fy.start_date, fy.end_date);
  if (drafts.length) blockers.push(`Unpaid salary slips for ${drafts.map((d) => d.month).join(', ')}. Pay them or delete them (Staff → Monthly Payroll) — they cannot be paid after the year is locked.`);
  if (pos && Math.abs(pos.totals.trial_debit - pos.totals.trial_credit) > 0.01) blockers.push('The trial balance does not balance. Contact support before closing.');
  if (pos) {
    const pend = pos.funds.reduce((s, f) => s + f.pending_cheques, 0);
    if (pend) warnings.push(`${pend} cheque(s) dated in this year are not cleared yet. They stay in the bank balance and can still be marked cleared or bounced after closing.`);
    for (const f of pos.funds) if (f.amount < -0.004) warnings.push(`${f.name} would carry forward a negative balance (${f.amount}). Check for missing entries.`);
    for (const i of pos.items) if (i.qty < -1e-6) warnings.push(`${i.name} would carry forward negative stock (${i.qty} ${i.unit}).`);
    const d1 = r2(pos.totals.stock_raw - pos.totals.books_raw), d2 = r2(pos.totals.stock_goods - pos.totals.books_goods);
    if (Math.abs(d1) > 1 || Math.abs(d2) > 1) warnings.push(`Stock registers differ from the books by ${d1} (raw) / ${d2} (goods).`);
  }
  return { blockers, warnings };
}

/** Pre-closing summary: what will be carried forward, and whether closing is allowed. */
r.get('/financial-years/:id/closing-preview', requireRole('manager'), (req, res) => {
  const fy = mustGet(req.params.id);
  const pos = closingPosition(fy);
  res.json({ year: decorate(fy), next: nextYearOf(fy), ...checks(fy, pos), position: pos });
});

// ---------- close & carry forward ------------------------------------------
r.post('/financial-years/:id/close', requireRole('manager'), (req, res) => {
  const fy = mustGet(req.params.id);
  if (String(req.body.confirm || '').trim().toUpperCase() !== fy.name.toUpperCase()) throw bad(`Type ${fy.name} to confirm`);
  const result = tx(() => {
    const pos = closingPosition(fy);
    const { blockers } = checks(fy, pos);
    if (blockers.length) throw bad(blockers[0]);

    // the new year: existing, or created now ("Start New Year")
    let next = nextYearOf(fy);
    if (!next.exists) {
      const start = dayAfter(fy.end_date);
      const end = date(req.body.next_end_date || next.end_date);
      validateRange(start, end);
      const name = String(req.body.next_name || '').trim() || suggestName(start, end);
      const { id } = db.prepare('INSERT INTO financial_years(name, start_date, end_date) VALUES (?,?,?) RETURNING id').get(name, start, end);
      restampFiscalYears();
      next = getFy(id);
    }

    // closing entry: every income/expense balance -> Retained Earnings
    const net = pos.net_profit;
    const lines = pos.pl_accounts.map((a) => ({ account: a.id, debit: a.balance < 0 ? -a.balance : 0, credit: a.balance > 0 ? a.balance : 0 }));
    lines.push({ account: ACC.RETAINED, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 });
    const entryId = post({
      date: fy.end_date, ref_type: 'year_close', ref_id: fy.id, user_id: req.user.id, lines,
      memo: `Year-end closing ${fy.name}: ${net >= 0 ? 'profit' : 'loss'} moved to Retained Earnings`,
    });

    // opening balances of the new year (= closing position, after the closing entry)
    db.prepare('DELETE FROM fiscal_year_balances WHERE fiscal_year_id = ?').run(next.id);
    const ins = db.prepare(`INSERT INTO fiscal_year_balances(fiscal_year_id, from_year_id, kind, ref_id, name, category, qty, unit_cost, amount)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const after = db.prepare(`SELECT a.id, a.name, a.type, ROUND(SUM(jl.debit - jl.credit), 2) AS balance FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id WHERE je.date <= ? GROUP BY a.id`).all(fy.end_date);
    for (const a of after) if (Math.abs(a.balance) > 0.004) ins.run(next.id, fy.id, 'account', a.id, a.name, a.type, null, null, a.balance);
    for (const p of pos.parties) ins.run(next.id, fy.id, 'party', p.id, p.name, p.type, null, null, p.amount);
    for (const f of pos.funds) ins.run(next.id, fy.id, 'fund', f.id, f.name, f.fund_type, null, null, f.amount);
    for (const i of pos.items) ins.run(next.id, fy.id, 'item', i.id, i.name, i.kind, i.qty, i.unit_cost, i.value);
    for (const l of pos.lots) ins.run(next.id, fy.id, 'lot', l.id, `${l.lot_code} · ${l.name}`, l.kind, l.qty, l.unit_cost, l.value);

    const summary = {
      sales: pos.pnl.sales, cogs: pos.pnl.cogs, operating: pos.pnl.operating.total, payroll: pos.pnl.payroll.total, net_profit: net,
      ...pos.totals, customers: pos.parties.filter((p) => p.type === 'customer').length, suppliers: pos.parties.filter((p) => p.type === 'supplier').length,
      items: pos.items.length, lots: pos.lots.length, next_year: next.name,
    };
    db.prepare(`UPDATE financial_years SET status = 'closed', closed_at = datetime('now'), closed_by = ?, closing_entry_id = ?, net_profit = ?, closing_summary = ?
      WHERE id = ?`).run(req.user.id, entryId, net, JSON.stringify(summary), fy.id);
    return { closed: fy.name, next_year_id: next.id, next_year: next.name, net_profit: net, summary };
  });
  audit(req.user.id, 'close', 'financial_year', fy.id, result.summary);
  res.json(result);
});

/** Reopen the most recently closed year (admin): removes the closing entry and its carried-forward snapshot. */
r.post('/financial-years/:id/reopen', requireRole('admin'), (req, res) => {
  const fy = mustGet(req.params.id);
  if (fy.status !== 'closed') throw bad('This year is not closed');
  const later = db.prepare("SELECT name FROM financial_years WHERE status = 'closed' AND start_date > ?").get(fy.start_date);
  if (later) throw bad(`Reopen ${later.name} first — years are reopened newest first.`);
  tx(() => {
    db.prepare("UPDATE financial_years SET status = 'open', closed_at = NULL, closed_by = NULL, net_profit = NULL, closing_summary = NULL WHERE id = ?").run(fy.id);
    db.prepare("DELETE FROM journal_entries WHERE ref_type = 'year_close' AND ref_id = ?").run(fy.id);
    db.prepare('UPDATE financial_years SET closing_entry_id = NULL WHERE id = ?').run(fy.id);
    db.prepare('DELETE FROM fiscal_year_balances WHERE from_year_id = ?').run(fy.id);
  });
  audit(req.user.id, 'reopen', 'financial_year', fy.id, { name: fy.name });
  res.json({ ok: true });
});

/** Opening balances carried into a year, each checked against the books on its first day. */
r.get('/financial-years/:id/opening-balances', requireRole('manager'), (req, res) => {
  const fy = mustGet(req.params.id);
  const rows = db.prepare('SELECT * FROM fiscal_year_balances WHERE fiscal_year_id = ? ORDER BY kind, category, name').all(fy.id);
  const before = dayBefore(fy.start_date);
  const acct = db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ? AND je.date <= ?`);
  const party = db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.party_id = ? AND jl.account_id IN (?, ?) AND je.date <= ?`);
  const stock = db.prepare('SELECT COALESCE(SUM(qty), 0) q, COALESCE(SUM(value), 0) v FROM stock_movements WHERE item_id = ? AND date <= ?');
  const checked = rows.map((x) => {
    let books;
    if (x.kind === 'account' || x.kind === 'fund') books = r2(acct.get(x.ref_id, before).b);
    else if (x.kind === 'party') { const b = party.get(x.ref_id, accId(ACC.RECEIVABLE), accId(ACC.PAYABLE), before).b; books = r2(x.category === 'customer' ? b : -b); }
    else if (x.kind === 'item') books = r2(stock.get(x.ref_id, before).v);
    else books = x.amount;
    return { ...x, books, matches: Math.abs(books - x.amount) < 0.01 };
  });
  res.json({ year: decorate(fy), from_year: rows[0] ? getFy(rows[0].from_year_id) : null, rows: checked, all_match: checked.every((x) => x.matches) });
});

export default r;
