import { db, r2 } from './db.js';
import { HttpError } from './errors.js';
import { assertOpenDate } from './fiscal.js';

// Account codes used by the application logic
export const ACC = {
  CASH: '1000',
  BANK: '1010',
  RECEIVABLE: '1100',
  RAW_STOCK: '1200',
  FG_STOCK: '1210',
  ADVANCES: '1300',
  PAYABLE: '2000',
  SALARIES_PAYABLE: '2100',
  CAPITAL: '3000',
  RETAINED: '3200',
  DRAWINGS: '3100',
  OPENING: '3900',
  SALES: '4000',
  OTHER_INCOME: '4900',
  COGS: '5000',
  SALARIES: '5100',
  OVERTIME: '5110',
  OVERHEAD_ABSORBED: '5150',
  STOCK_LOSS: '5250',
};

const idByCode = new Map();
export function accId(codeOrId) {
  if (typeof codeOrId === 'number') return codeOrId;
  if (!idByCode.has(codeOrId)) {
    const row = db.prepare('SELECT id FROM accounts WHERE code = ?').get(codeOrId);
    if (!row) throw new Error(`Unknown account ${codeOrId}`);
    idByCode.set(codeOrId, row.id);
  }
  return idByCode.get(codeOrId);
}

// ---------- Cash & bank (fund) accounts, payment methods --------------
export const METHODS = ['cash', 'bank_transfer', 'cheque'];
export const METHOD_LABEL = { cash: 'Cash', bank_transfer: 'Bank transfer', cheque: 'Cheque', transfer: 'Internal transfer', opening: 'Opening balance' };

export function fundAccount(id) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND is_cash = 1').get(Number(id));
  if (!a) throw new HttpError(400, 'Choose a cash or bank account');
  return a;
}
export const defaultFund = (type) =>
  db.prepare('SELECT * FROM accounts WHERE is_cash = 1 AND fund_type = ? AND active = 1 ORDER BY code LIMIT 1').get(type);

const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, 120));

/**
 * Read the payment fields of any form and return the fund account + method details.
 *   body: { payment_method: 'cash'|'bank_transfer'|'cheque', account_id?, cheque_no?, cheque_date?, bank_name?, reference? }
 *   (older clients sending only pay_account_id / account_id get the method inferred from the account)
 * Cash must use a cash account; bank transfer and cheque must use a bank account.
 */
export function resolveFund(b = {}) {
  const accountId = b.account_id ?? b.pay_account_id ?? null;
  let method = b.payment_method || null;
  if (!method && accountId) method = fundAccount(accountId).fund_type === 'bank' ? 'bank_transfer' : 'cash';
  method ||= 'cash';
  if (!METHODS.includes(method)) throw new HttpError(400, 'Choose Cash, Bank transfer or Cheque');
  const type = method === 'cash' ? 'cash' : 'bank';
  const acc = accountId ? fundAccount(accountId) : defaultFund(type);
  if (!acc) throw new HttpError(400, type === 'bank' ? 'Add a bank account first (Cash & Bank → Add account)' : 'Add a cash account first');
  if (acc.fund_type !== type) {
    throw new HttpError(400, method === 'cash' ? `"${acc.name}" is a bank account — choose Bank transfer or Cheque, or pick a cash account` : `"${acc.name}" is a cash account — bank transfers and cheques must use a bank account`);
  }
  if (!acc.active) throw new HttpError(400, `"${acc.name}" is closed`);
  if (b.cheque_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.cheque_date)) throw new HttpError(400, 'Invalid cheque date');
  return {
    account: acc.id, fund: acc,
    meta: {
      method,
      reference: method === 'cash' ? null : clean(b.reference),
      cheque_no: method === 'cheque' ? clean(b.cheque_no) : null,
      cheque_date: method === 'cheque' ? b.cheque_date || null : null,
      bank_name: method === 'cheque' ? clean(b.bank_name) : null,
    },
  };
}

/** Legacy helper kept for callers that only need the account id. */
export const cashAccount = (id) => fundAccount(id).id;

/** Stock account for an item kind. */
export const stockAccountFor = (kind) => (kind === 'raw' ? ACC.RAW_STOCK : ACC.FG_STOCK);

/**
 * Post one balanced double-entry journal entry.
 * lines: [{ account: code|id, debit?, credit?, party_id?, employee_id?, payment?, reverses? }]
 * payment: { method, reference, cheque_no, cheque_date, bank_name } — applies to every
 *          cash/bank line (a line's own `payment` wins).
 * Every line on a fund account also writes a fund_transactions row, so the cash & bank
 * ledger can never miss a transaction. Must be called inside a transaction.
 */
export function post({ date, memo, ref_type = null, ref_id = null, user_id = null, lines, payment = null }) {
  assertOpenDate(date); // no postings into closed (locked) or undefined financial years
  const clean = lines
    .map((l) => ({ ...l, debit: r2(l.debit || 0), credit: r2(l.credit || 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (!clean.length) return null;

  const dr = r2(clean.reduce((s, l) => s + l.debit, 0));
  const cr = r2(clean.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.005) throw new Error(`Unbalanced journal "${memo}": Dr ${dr} vs Cr ${cr}`);

  const { id } = db
    .prepare('INSERT INTO journal_entries(date, memo, ref_type, ref_id, created_by) VALUES (?,?,?,?,?) RETURNING id')
    .get(date, memo, ref_type, ref_id, user_id);
  const ins = db.prepare(
    'INSERT INTO journal_lines(entry_id, account_id, party_id, employee_id, debit, credit) VALUES (?,?,?,?,?,?) RETURNING id'
  );
  const funds = new Map(db.prepare('SELECT id, fund_type FROM accounts WHERE is_cash = 1').all().map((a) => [a.id, a.fund_type]));
  const partyId = clean.find((l) => l.party_id)?.party_id ?? null;
  const employeeId = clean.find((l) => l.employee_id)?.employee_id ?? null;
  const fundLines = clean.filter((l) => funds.has(accId(l.account))).length;
  const insFund = db.prepare(`INSERT INTO fund_transactions(entry_id, line_id, account_id, date, direction, amount, method, reference,
      cheque_no, cheque_date, bank_name, cheque_status, party_id, employee_id, ref_type, ref_id, memo, reverses_id)
    VALUES (@entry_id, @line_id, @account_id, @date, @direction, @amount, @method, @reference, @cheque_no, @cheque_date, @bank_name,
      @cheque_status, @party_id, @employee_id, @ref_type, @ref_id, @memo, @reverses_id)`);

  for (const l of clean) {
    const account = accId(l.account);
    const line = ins.get(id, account, l.party_id ?? null, l.employee_id ?? null, l.debit, l.credit);
    if (!funds.has(account)) continue;
    const meta = l.payment || payment || {};
    const method = meta.method || (fundLines > 1 ? 'transfer' : funds.get(account) === 'bank' ? 'bank_transfer' : 'cash');
    insFund.run({
      entry_id: id, line_id: line.id, account_id: account, date,
      direction: l.debit > 0 ? 'in' : 'out', amount: l.debit > 0 ? l.debit : l.credit, method,
      reference: meta.reference ?? null, cheque_no: meta.cheque_no ?? null, cheque_date: meta.cheque_date ?? null, bank_name: meta.bank_name ?? null,
      cheque_status: method === 'cheque' && !l.reverses ? 'pending' : null,
      party_id: partyId, employee_id: employeeId, ref_type, ref_id, memo, reverses_id: l.reverses ?? null,
    });
  }
  return id;
}

/** Mirror lines of one journal entry, carrying each fund line's payment details. */
function mirrorLines(entryId) {
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(entryId);
  const fundRow = db.prepare('SELECT * FROM fund_transactions WHERE line_id = ?');
  return lines.map((l) => {
    const f = fundRow.get(l.id);
    return {
      account: l.account_id, party_id: l.party_id, employee_id: l.employee_id, debit: l.credit, credit: l.debit,
      ...(f ? { payment: { method: f.method, reference: f.reference, cheque_no: f.cheque_no, cheque_date: f.cheque_date, bank_name: f.bank_name }, reverses: f.id } : {}),
    };
  });
}

/** Post mirror-image entries for everything recorded against a document (used when cancelling). */
export function reverseRef(ref_type, ref_id, { date, memo, user_id }) {
  const entries = db.prepare('SELECT id FROM journal_entries WHERE ref_type = ? AND ref_id = ?').all(ref_type, ref_id);
  for (const e of entries) post({ date, memo, ref_type: `${ref_type}_cancel`, ref_id, user_id, lines: mirrorLines(e.id) });
}

/** Reverse one journal entry (e.g. a bounced cheque). Returns the new entry id. */
export function reverseEntry(entryId, { date, memo, ref_type, ref_id, user_id }) {
  return post({ date, memo, ref_type, ref_id, user_id, lines: mirrorLines(entryId) });
}

/** Total balance of all active fund accounts of a type ('cash' | 'bank'). */
export function fundTotal(type, to = null) {
  return r2(db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) b FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    JOIN journal_entries je ON je.id = jl.entry_id WHERE a.is_cash = 1 AND a.fund_type = ? AND (? IS NULL OR je.date <= ?)`).get(type, to, to).b);
}

/** Balance of an account (debit - credit), optionally filtered. */
export function balance(code, { party_id, employee_id, to } = {}) {
  let sql = `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS b FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ?`;
  const args = [accId(code)];
  if (party_id) { sql += ' AND jl.party_id = ?'; args.push(party_id); }
  if (employee_id) { sql += ' AND jl.employee_id = ?'; args.push(employee_id); }
  if (to) { sql += ' AND je.date <= ?'; args.push(to); }
  return r2(db.prepare(sql).get(...args).b);
}

/**
 * Party balance, always returned as a positive "they owe us" for customers
 * and positive "we owe them" for suppliers.
 */
export function partyBalance(party) {
  return party.type === 'customer'
    ? balance(ACC.RECEIVABLE, { party_id: party.id })
    : -balance(ACC.PAYABLE, { party_id: party.id });
}
