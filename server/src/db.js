import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(here, '..', 'data', 'factory.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');   // safe concurrent reads while writing
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

// ---------- helpers --------------------------------------------------
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local

/** Run fn inside one SQLite transaction (all-or-nothing). */
export const tx = (fn) => db.transaction(fn)();

/** Next document number, e.g. nextNo('INV') -> "INV-00012" */
export function nextNo(prefix, width = 5) {
  db.prepare('INSERT INTO sequences(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(prefix);
  const { value } = db.prepare('UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value').get(prefix);
  return `${prefix}-${String(value).padStart(width, '0')}`;
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function audit(userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log(user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)')
    .run(userId ?? null, action, entity ?? null, entityId ?? null, details ? JSON.stringify(details) : null);
}

// ---------- financial years: stamping & locking -------------------------
// Transactional tables and the expression giving each row's accounting date.
export const FY_TABLES = [
  ['journal_entries', 'date'], ['fund_transactions', 'date'], ['stock_movements', 'date'],
  ['production_batches', 'date'], ['purchases', 'date'], ['sales', 'date'], ['sale_returns', 'date'], ['expenses', 'date'],
  ['attendance', 'date'], ['employee_advances', 'date'], ['payroll', "month || '-01'"],
];
// Columns whose change is a real accounting change (other columns — e.g. a cheque's
// cleared status or an invoice's running "paid" figure — may still be updated later).
const FY_LOCKED_COLUMNS = {
  journal_entries: 'date, memo, ref_type, ref_id',
  fund_transactions: 'entry_id, line_id, account_id, date, direction, amount, method',
  stock_movements: 'item_id, lot_id, date, qty, unit_cost, value',
  production_batches: 'date, product_id, qty_produced, material_cost, other_cost, total_cost, unit_cost, status',
  purchases: 'date, supplier_id, total, status, pay_account_id',
  sales: 'date, customer_id, subtotal, discount, total, cost_total, status, pay_account_id',
  sale_returns: 'date, sale_id, customer_id, subtotal, discount, total, refund, refund_account_id, cost_restocked, cost_damaged, status',
  expenses: 'date, category_id, amount, pay_account_id, status, note, paid_to, bill_no',
  attendance: 'employee_id, date, status, overtime_hours',
  employee_advances: 'employee_id, date, type, amount, monthly_installment',
  payroll: 'month, status, gross, basic_pay, overtime_pay, bonus, advance_deduction, net, paid_date',
};
const inClosedYear = (expr) => `EXISTS (SELECT 1 FROM financial_years WHERE status = 'closed' AND (${expr}) BETWEEN start_date AND end_date)`;

/** (Re)create every financial-year trigger. Safe to run on each start. */
export function installFyTriggers() {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fy\\_%' ESCAPE '\\'").all()) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  for (const [t, expr] of FY_TABLES) {
    const NEW = expr.replace(/\b(date|month)\b/g, 'NEW.$1');
    const OLD = expr.replace(/\b(date|month)\b/g, 'OLD.$1');
    const yearOf = (e) => `(SELECT id FROM financial_years WHERE (${e}) BETWEEN start_date AND end_date)`;
    const dateCol = expr.includes('month') ? 'month' : 'date';
    db.exec(`
      CREATE INDEX IF NOT EXISTS ix_${t}_fy ON ${t}(fiscal_year_id);
      CREATE TRIGGER fy_lock_ins_${t} BEFORE INSERT ON ${t} WHEN ${inClosedYear(NEW)}
        BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
      CREATE TRIGGER fy_lock_upd_${t} BEFORE UPDATE OF ${FY_LOCKED_COLUMNS[t]} ON ${t} WHEN ${inClosedYear(OLD)} OR ${inClosedYear(NEW)}
        BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
      CREATE TRIGGER fy_lock_del_${t} BEFORE DELETE ON ${t} WHEN ${inClosedYear(OLD)}
        BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
      CREATE TRIGGER fy_stamp_ins_${t} AFTER INSERT ON ${t}
        BEGIN UPDATE ${t} SET fiscal_year_id = ${yearOf(NEW)} WHERE id = NEW.id; END;
      CREATE TRIGGER fy_stamp_upd_${t} AFTER UPDATE OF ${dateCol} ON ${t}
        BEGIN UPDATE ${t} SET fiscal_year_id = ${yearOf(NEW)} WHERE id = NEW.id; END;
    `);
  }
  // Every journal entry must fall inside a defined financial year
  db.exec(`
    CREATE TRIGGER fy_cover_ins_journal BEFORE INSERT ON journal_entries
      WHEN NOT EXISTS (SELECT 1 FROM financial_years WHERE NEW.date BETWEEN start_date AND end_date)
      BEGIN SELECT RAISE(ABORT, 'FY_MISSING'); END;
    CREATE TRIGGER fy_lock_ins_lines BEFORE INSERT ON journal_lines
      WHEN ${inClosedYear('SELECT date FROM journal_entries WHERE id = NEW.entry_id')}
      BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
    CREATE TRIGGER fy_lock_upd_lines BEFORE UPDATE ON journal_lines
      WHEN ${inClosedYear('SELECT date FROM journal_entries WHERE id = OLD.entry_id')}
      BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
    CREATE TRIGGER fy_lock_del_lines BEFORE DELETE ON journal_lines
      WHEN ${inClosedYear('SELECT date FROM journal_entries WHERE id = OLD.entry_id')}
      BEGIN SELECT RAISE(ABORT, 'FY_CLOSED'); END;
  `);
}

/** Re-stamp fiscal_year_id after years are added or their dates change (only rows that differ). */
export function restampFiscalYears() {
  for (const [t, expr] of FY_TABLES) {
    const yearOf = `(SELECT fy.id FROM financial_years fy WHERE (${expr}) BETWEEN fy.start_date AND fy.end_date)`;
    db.prepare(`UPDATE ${t} SET fiscal_year_id = ${yearOf} WHERE fiscal_year_id IS NOT ${yearOf}`).run();
  }
}

/** Financial year containing a date, for a start month like '07' (July–June) or '01' (calendar). */
export function fyBoundsFor(d, startMonth = '07') {
  const sm = Number(startMonth) || 7;
  const [y, m] = d.split('-').map(Number);
  const y0 = m >= sm ? y : y - 1;
  const start = `${y0}-${String(sm).padStart(2, '0')}-01`;
  const next = new Date(y0 + 1, sm - 1, 1); next.setDate(0);
  const end = next.toLocaleDateString('en-CA');
  const name = sm === 1 ? `FY ${y0}` : `FY ${y0}-${String((y0 + 1) % 100).padStart(2, '0')}`;
  return { start, end, name };
}

// ---------- migrations ------------------------------------------------
// schema.sql describes a fresh install. Existing databases are upgraded here,
// once per version (PRAGMA user_version). Each step is idempotent.
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(table, col, def) {
  if (hasColumn(table, col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  return true;
}
const MIGRATIONS = [
  // v1: daily wagers, overtime, payroll breakdown
  () => {
    if (addColumn('employees', 'overtime_eligible', 'INTEGER NOT NULL DEFAULT 0')) {
      db.exec("UPDATE employees SET overtime_eligible = 1 WHERE salary_type = 'daily'");
    }
    addColumn('employees', 'overtime_rate', 'REAL CHECK (overtime_rate IS NULL OR overtime_rate >= 0)');
    addColumn('attendance', 'overtime_hours', 'REAL NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 16)');
    addColumn('payroll', 'salary_type', 'TEXT');
    addColumn('payroll', 'working_days', 'REAL NOT NULL DEFAULT 0');
    if (addColumn('payroll', 'basic_pay', 'REAL NOT NULL DEFAULT 0')) db.exec('UPDATE payroll SET basic_pay = gross');
    addColumn('payroll', 'overtime_hours', 'REAL NOT NULL DEFAULT 0');
    addColumn('payroll', 'overtime_rate', 'REAL NOT NULL DEFAULT 0');
    addColumn('payroll', 'overtime_pay', 'REAL NOT NULL DEFAULT 0');
    addColumn('payroll', 'advance_outstanding', 'REAL NOT NULL DEFAULT 0');
  },
  // v2: expense register, manageable categories
  () => {
    addColumn('accounts', 'description', 'TEXT');
    addColumn('accounts', 'active', 'INTEGER NOT NULL DEFAULT 1');
    // Turn earlier "Cash Out" expense entries into expense vouchers so they show in the register
    const old = db.prepare(`
      SELECT je.id, je.date, je.memo, je.created_by, je.created_at, d.account_id AS category_id, d.debit AS amount, c.account_id AS pay_account_id
      FROM journal_entries je
      JOIN journal_lines d ON d.entry_id = je.id AND d.debit > 0
      JOIN accounts da ON da.id = d.account_id AND da.is_expense_category = 1
      JOIN journal_lines c ON c.entry_id = je.id AND c.credit > 0
      JOIN accounts ca ON ca.id = c.account_id AND ca.is_cash = 1
      WHERE je.ref_type = 'cash' AND (SELECT COUNT(*) FROM journal_lines x WHERE x.entry_id = je.id) = 2
      ORDER BY je.date, je.id`).all();
    const ins = db.prepare(`INSERT INTO expenses(expense_no, date, category_id, amount, pay_account_id, note, journal_entry_id, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`);
    for (const e of old) {
      const note = e.memo.includes(' — ') ? e.memo.split(' — ').slice(1).join(' — ') : null;
      const { id } = ins.get(nextNo('EXP'), e.date, e.category_id, e.amount, e.pay_account_id, note, e.id, e.created_by, e.created_at);
      db.prepare("UPDATE journal_entries SET ref_type = 'expense', ref_id = ? WHERE id = ?").run(id, e.id);
    }
  },
  // v3: multi-account cash & bank, payment methods, fund ledger
  () => {
    addColumn('accounts', 'fund_type', "TEXT CHECK (fund_type IN ('cash','bank'))");
    addColumn('accounts', 'bank_name', 'TEXT');
    addColumn('accounts', 'account_number', 'TEXT');
    db.exec("UPDATE accounts SET fund_type = 'cash' WHERE code = '1000'");
    db.exec("UPDATE accounts SET fund_type = 'bank' WHERE code = '1010'");
    // Backfill the fund ledger from existing journal lines on cash/bank accounts
    const lines = db.prepare(`
      SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.debit, jl.credit, je.date, je.memo, je.ref_type, je.ref_id, a.fund_type,
        (SELECT COUNT(*) FROM journal_lines x JOIN accounts xa ON xa.id = x.account_id WHERE x.entry_id = je.id AND xa.is_cash = 1) AS fund_lines,
        (SELECT x.party_id FROM journal_lines x WHERE x.entry_id = je.id AND x.party_id IS NOT NULL LIMIT 1) AS party_id,
        (SELECT x.employee_id FROM journal_lines x WHERE x.entry_id = je.id AND x.employee_id IS NOT NULL LIMIT 1) AS employee_id
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
      WHERE a.is_cash = 1 AND NOT EXISTS (SELECT 1 FROM fund_transactions f WHERE f.line_id = jl.id)`).all();
    const ins = db.prepare(`INSERT INTO fund_transactions(entry_id, line_id, account_id, date, direction, amount, method, party_id, employee_id, ref_type, ref_id, memo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) {
      const method = l.fund_lines > 1 ? 'transfer' : l.fund_type === 'bank' ? 'bank_transfer' : 'cash';
      ins.run(l.entry_id, l.line_id, l.account_id, l.date, l.debit > 0 ? 'in' : 'out', l.debit > 0 ? l.debit : l.credit, method,
        l.party_id, l.employee_id, l.fund_lines > 1 ? 'transfer' : l.ref_type, l.ref_id, l.memo);
    }
  },
  // v4: financial years — fiscal_year_id on every transactional table (stamped + locked by triggers)
  () => {
    for (const [t] of FY_TABLES) addColumn(t, 'fiscal_year_id', 'INTEGER REFERENCES financial_years(id)');
  },
  // v5: user-managed item categories (one list per item type); existing items keep their category
  () => {
    addColumn('items', 'category_id', 'INTEGER REFERENCES item_categories(id)');
    const OLD = { oil: 'Oil', chemical: 'Chemical', fragrance: 'Fragrance', packaging: 'Packaging', soap: 'Soap', other: 'Other' };
    const ins = db.prepare('INSERT INTO item_categories(kind, name) VALUES (?, ?) ON CONFLICT(kind, name) DO NOTHING');
    const find = db.prepare('SELECT id, name FROM item_categories WHERE kind = ? AND name = ?');
    for (const it of db.prepare('SELECT id, kind, category FROM items WHERE category_id IS NULL').all()) {
      const raw = String(it.category || 'other');
      const name = OLD[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
      ins.run(it.kind, name);
      const c = find.get(it.kind, name);
      db.prepare('UPDATE items SET category_id = ?, category = ? WHERE id = ?').run(c.id, c.name, it.id);
    }
  },
  // v6: deleting a stock item = hide it from lists (who / when), never erase its history
  () => {
    addColumn('items', 'deleted_at', 'TEXT');
    addColumn('items', 'deleted_by', 'INTEGER REFERENCES users(id)');
    db.prepare("UPDATE items SET deleted_at = COALESCE(deleted_at, datetime('now')) WHERE active = 0").run();
  },
  // v7: each opening-stock journal entry points at its own stock movement, so opening stock can be corrected later
  () => {
    const moves = db.prepare("SELECT id, item_id, date, value FROM stock_movements WHERE type = 'opening' ORDER BY id").all();
    const find = db.prepare(`SELECT je.id FROM journal_entries je WHERE je.ref_type = 'adjustment' AND je.ref_id = ? AND je.date = ?
        AND je.memo LIKE 'Opening stock:%' AND ABS((SELECT SUM(debit) FROM journal_lines WHERE entry_id = je.id) - ?) < 0.011
        AND NOT EXISTS (SELECT 1 FROM financial_years f WHERE f.status = 'closed' AND je.date BETWEEN f.start_date AND f.end_date)
      ORDER BY je.id LIMIT 1`);
    const link = db.prepare("UPDATE journal_entries SET ref_type = 'opening_stock', ref_id = ? WHERE id = ?");
    for (const m of moves) {
      if (Math.abs(m.value) < 0.005) continue; // a zero-cost entry has no journal
      const je = find.get(m.item_id, m.date, m.value);
      if (je) link.run(m.id, je.id);
    }
  },
];
{
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => { MIGRATIONS[v](); db.pragma(`user_version = ${v + 1}`); })();
    console.log(`Database upgraded to version ${v + 1}`);
  }
}

// ---------- first-run bootstrap -------------------------------------
const SYSTEM_ACCOUNTS = [
  // code, name, type, is_cash, is_expense_category
  ['1000', 'Cash in Hand', 'asset', 1, 0],
  ['1010', 'Bank Account', 'asset', 1, 0],
  ['1100', 'Customers (Receivable)', 'asset', 0, 0],
  ['1200', 'Raw Material Stock', 'asset', 0, 0],
  ['1210', 'Finished Goods Stock', 'asset', 0, 0],
  ['1300', 'Employee Advances & Loans', 'asset', 0, 0],
  ['2000', 'Suppliers (Payable)', 'liability', 0, 0],
  ['2100', 'Salaries Payable', 'liability', 0, 0],
  ['3000', "Owner's Capital", 'equity', 0, 0],
  ['3100', 'Owner Withdrawals', 'equity', 0, 0],
  ['3200', 'Retained Earnings', 'equity', 0, 0],
  ['3900', 'Opening Balances', 'equity', 0, 0],
  ['4000', 'Sales', 'income', 0, 0],
  ['4900', 'Other Income', 'income', 0, 0],
  ['5000', 'Cost of Goods Sold', 'expense', 0, 0],
  ['5100', 'Salaries & Wages', 'expense', 0, 0],
  ['5110', 'Overtime Wages', 'expense', 0, 0],
  ['5150', 'Overhead Charged to Production', 'expense', 0, 0],
  ['5200', 'Electricity & Gas', 'expense', 0, 1],
  ['5210', 'Rent', 'expense', 0, 1],
  ['5220', 'Transport & Freight', 'expense', 0, 1],
  ['5230', 'Repairs & Maintenance', 'expense', 0, 1],
  ['5240', 'Office & Miscellaneous', 'expense', 0, 1],
  ['5250', 'Stock Loss / Wastage', 'expense', 0, 0],
  ['5260', 'Food & Tea', 'expense', 0, 1],
  ['5270', 'Miscellaneous', 'expense', 0, 1],
];

const DEFAULT_SETTINGS = {
  company_name: 'My Soap Factory',
  company_address: 'Industrial Area',
  company_phone: '',
  currency: 'Rs',
  invoice_footer: 'Thank you for your business!',
  paid_leaves_per_month: '1',
  // HR & payroll rules
  shift_start: '08:00',            // standard shift; work after shift_end is overtime
  shift_end: '17:00',
  weekly_off_day: '0',             // 0 = Sunday ... 6 = Saturday, '' = none
  overtime_rate_per_hour: '0',     // factory standard rate (used when an employee has no own rate)
  monthly_deduct_absent: '1',      // 1 = cut monthly salary for absent days, 0 = always full salary
  fy_start_month: '07',            // financial year starts in July (Pakistan: 1 Jul – 30 Jun)
};

const insAcc = db.prepare(
  'INSERT INTO accounts(code, name, type, is_cash, is_expense_category, system) VALUES (?,?,?,?,?,1) ON CONFLICT(code) DO NOTHING'
);
for (const a of SYSTEM_ACCOUNTS) insAcc.run(...a);
db.exec("UPDATE accounts SET fund_type = 'cash' WHERE code = '1000' AND fund_type IS NULL");
db.exec("UPDATE accounts SET fund_type = 'bank' WHERE code = '1010' AND fund_type IS NULL");

const insSet = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, v);

// First run (or upgrade): make sure financial years cover all existing data and today
if (!db.prepare('SELECT 1 FROM financial_years LIMIT 1').get()) {
  const sm = db.prepare("SELECT value FROM settings WHERE key = 'fy_start_month'").get()?.value || '07';
  const dates = FY_TABLES.map(([t, expr]) => db.prepare(`SELECT MIN(${expr}) d FROM ${t}`).get().d).filter(Boolean);
  let d = [...dates, today()].sort()[0];
  const ins = db.prepare('INSERT INTO financial_years(name, start_date, end_date) VALUES (?,?,?)');
  for (let guard = 0; guard < 50; guard++) {
    const b = fyBoundsFor(d, sm);
    ins.run(b.name, b.start, b.end);
    if (b.end >= today()) break;
    const n = new Date(`${b.end}T12:00:00`); n.setDate(n.getDate() + 1); d = n.toLocaleDateString('en-CA');
  }
}
installFyTriggers();
restampFiscalYears();

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("INSERT INTO users(username, full_name, role, password_hash) VALUES ('admin', 'Administrator', 'admin', ?)")
    .run(hashPassword(pw));
  console.log(`Created default user "admin" with password "${pw}" — change it in Settings.`);
}

// Starter item categories (once — after that the lists belong to the users)
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'item_categories_seeded'").get()) {
  const START = {
    raw: ['Oil', 'Chemical', 'Fragrance', 'Colour', 'Packaging', 'Other'],
    finished: ['Soap', 'Other'],
    trading: ['Ready-made Goods', 'Other'],
  };
  const ins = db.prepare('INSERT INTO item_categories(kind, name) VALUES (?, ?) ON CONFLICT(kind, name) DO NOTHING');
  for (const [kind, names] of Object.entries(START)) for (const n of names) ins.run(kind, n);
  db.prepare("INSERT INTO settings(key, value) VALUES ('item_categories_seeded', '1')").run();
}

if (!db.prepare("SELECT 1 FROM parties WHERE type='customer' LIMIT 1").get()) {
  db.prepare("INSERT INTO parties(type, name, notes) VALUES ('customer', 'Walk-in Customer', 'Cash sales counter')").run();
}
