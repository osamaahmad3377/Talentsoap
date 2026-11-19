-- =====================================================================
--  Soap Factory ERP — database schema (SQLite; portable to PostgreSQL)
--
--  Business model: MAKE-TO-STOCK. Production is planned internally and
--  builds finished-goods stock; customers are invoiced from that stock.
--
--  Costing:
--   * RAW MATERIALS live in shared tanks/containers  -> WEIGHTED AVERAGE.
--     items.stock_qty / items.avg_cost are the live tank balance. Every
--     receipt recalculates the moving average; every issue leaves at it.
--   * FINISHED GOODS & TRADING GOODS are discrete, labelled units
--     -> tracked per BATCH (stock_lots). Each production run = one batch,
--     so a batch can be traced to its materials, suppliers and customers.
--
--  Accounting: every money event posts ONE balanced double-entry journal
--  entry. Customer/supplier ledgers, cash book, trial balance and P&L are
--  all views over journal_lines, so the books can never disagree.
--  Money is rounded to 2 decimals on write (NUMERIC(14,2) in PostgreSQL).
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------- System ---------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','staff')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sequences (           -- INV-00001, PUR-00001, B2611-001 ...
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ---------- Financial years -------------------------------------------
-- One continuous ledger; a financial year is a date range with a lifecycle.
--   status 'open'   -> shown as Active (contains today), Upcoming (starts later)
--                      or "Ended — not closed yet"
--   status 'closed' -> Closed / Locked: database triggers reject any insert,
--                      change or delete dated inside it.
-- Every transactional table carries fiscal_year_id, stamped by trigger from its date.
CREATE TABLE IF NOT EXISTS financial_years (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,              -- e.g. "FY 2025-26"
  start_date       TEXT NOT NULL,
  end_date         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at        TEXT,
  closed_by        INTEGER REFERENCES users(id),
  closing_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  net_profit       REAL,                              -- moved to Retained Earnings at closing
  closing_summary  TEXT,                              -- JSON totals shown on the year page
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date < end_date)
);

-- Opening-balance ledger: the closing position of a year, carried forward as the
-- opening position of the next one (written by the year-end closing).
--   kind: account | party | fund | item | lot
CREATE TABLE IF NOT EXISTS fiscal_year_balances (
  id              INTEGER PRIMARY KEY,
  fiscal_year_id  INTEGER NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE, -- year that OPENS with this
  from_year_id    INTEGER NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE, -- year that was closed
  kind            TEXT NOT NULL CHECK (kind IN ('account','party','fund','item','lot')),
  ref_id          INTEGER NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT,                               -- account type / customer|supplier / cash|bank / item kind
  qty             REAL,                               -- items & lots
  unit_cost       REAL,                               -- items: weighted average; lots: batch cost
  amount          REAL NOT NULL,                      -- accounts: debit − credit; parties: owed (+); funds/items: value
  UNIQUE (fiscal_year_id, kind, ref_id)
);

-- ---------- Masters --------------------------------------------------
CREATE TABLE IF NOT EXISTS parties (             -- customers & suppliers
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('customer','supplier')),
  name       TEXT NOT NULL,
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_parties_type ON parties(type, name);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  cnic          TEXT,
  designation   TEXT,
  -- Employment type: 'monthly' = Monthly Salaried, 'daily' = Daily Wager
  salary_type   TEXT NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly','daily')),
  salary_amount REAL NOT NULL CHECK (salary_amount >= 0),  -- monthly salary, or per-day wage rate
  overtime_eligible INTEGER NOT NULL DEFAULT 0,             -- gets paid for extra hours
  overtime_rate REAL CHECK (overtime_rate IS NULL OR overtime_rate >= 0), -- per hour; NULL = factory standard rate
  join_date     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Accounting core -----------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  is_cash             INTEGER NOT NULL DEFAULT 0,   -- 1 = a fund account (cash box or bank account)
  fund_type           TEXT CHECK (fund_type IN ('cash','bank')),  -- which kind of fund account
  bank_name           TEXT,                         -- bank accounts: e.g. "Meezan Bank"
  account_number      TEXT,                         -- bank accounts: IBAN / account no.
  is_expense_category INTEGER NOT NULL DEFAULT 0,   -- an Expense Category (Rent, Electricity, ...)
  description         TEXT,                         -- shown under the category name
  active              INTEGER NOT NULL DEFAULT 1,   -- 0 = hidden from forms, history kept
  system              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,                        -- YYYY-MM-DD
  fiscal_year_id INTEGER REFERENCES financial_years(id),
  memo       TEXT NOT NULL,
  ref_type   TEXT,     -- sale | purchase | production | payment | cash | payroll | advance | adjustment | opening | *_cancel
  ref_id     INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_je_date ON journal_entries(date);
CREATE INDEX IF NOT EXISTS ix_je_ref  ON journal_entries(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id          INTEGER PRIMARY KEY,
  entry_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  party_id    INTEGER REFERENCES parties(id),      -- on Receivable / Payable lines
  employee_id INTEGER REFERENCES employees(id),    -- on Employee Advance lines
  debit       REAL NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit      REAL NOT NULL DEFAULT 0 CHECK (credit >= 0)
);
CREATE INDEX IF NOT EXISTS ix_jl_entry   ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jl_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS ix_jl_party   ON journal_lines(party_id);
CREATE INDEX IF NOT EXISTS ix_jl_emp     ON journal_lines(employee_id);

-- ---------- Cash & bank fund ledger ---------------------------------
-- One row for every journal line that touches a fund account (is_cash = 1).
-- Written automatically by accounting.post(), deleted with its journal entry,
-- so SUM(in − out) per account always equals that account's balance in the books.
CREATE TABLE IF NOT EXISTS fund_transactions (
  id            INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  entry_id      INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_id       INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  date          TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount        REAL NOT NULL CHECK (amount > 0),
  -- cash | bank_transfer | cheque  (chosen by the user)
  -- transfer (between own accounts) | opening (opening balance)  (system)
  method        TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','cheque','transfer','opening')),
  reference     TEXT,                              -- bank transaction / reference ID
  cheque_no     TEXT,
  cheque_date   TEXT,
  bank_name     TEXT,                              -- e.g. the customer's bank on a received cheque
  cheque_status TEXT CHECK (cheque_status IN ('pending','cleared','bounced')),
  cleared_date  TEXT,
  party_id      INTEGER REFERENCES parties(id),
  employee_id   INTEGER REFERENCES employees(id),
  ref_type      TEXT,                              -- sale | purchase | payment | expense | payroll | advance | cash | transfer | opening | *_cancel | *_bounce
  ref_id        INTEGER,
  memo          TEXT,
  reverses_id   INTEGER REFERENCES fund_transactions(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_ft_account ON fund_transactions(account_id, date, id);
CREATE INDEX IF NOT EXISTS ix_ft_method  ON fund_transactions(method, date);
CREATE INDEX IF NOT EXISTS ix_ft_ref     ON fund_transactions(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS ix_ft_entry   ON fund_transactions(entry_id);

-- ---------- Items & stock -------------------------------------------
-- kind: raw      (oils, chemicals, packaging, fragrance) -> weighted average
--       finished (soap made here)                       -> per batch
--       trading  (ready-made goods bought for resale)   -> per purchase lot
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('raw','finished','trading')),
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',      -- category name (kept in step with category_id)
  category_id   INTEGER REFERENCES item_categories(id),
  unit          TEXT NOT NULL DEFAULT 'kg',
  container     TEXT,                               -- e.g. "Tank 2", "Drum Store"
  reorder_level REAL NOT NULL DEFAULT 0,            -- low-stock alert threshold
  sale_price    REAL NOT NULL DEFAULT 0,
  sku           TEXT,
  -- live weighted-average balance (raw materials only)
  stock_qty     REAL NOT NULL DEFAULT 0 CHECK (stock_qty >= -0.000001),
  avg_cost      REAL NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,      -- 0 = deleted: hidden from lists, kept on old documents
  deleted_at    TEXT,
  deleted_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Item categories, managed by users: a separate list per item type
CREATE TABLE IF NOT EXISTS item_categories (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('raw','finished','trading')),
  name       TEXT NOT NULL COLLATE NOCASE,
  active     INTEGER NOT NULL DEFAULT 1,              -- 0 = hidden from the Add item form (items keep it)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);

-- Batches / lots of finished & trading goods
CREATE TABLE IF NOT EXISTS stock_lots (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  lot_code      TEXT NOT NULL UNIQUE,               -- batch no. printed on cartons
  source_type   TEXT NOT NULL CHECK (source_type IN ('production','purchase','opening')),
  source_id     INTEGER,                            -- production_batches.id | purchase_items.id
  supplier_id   INTEGER REFERENCES parties(id),
  date          TEXT NOT NULL,
  qty_in        REAL NOT NULL CHECK (qty_in > 0),
  qty_remaining REAL NOT NULL CHECK (qty_remaining >= -0.000001),
  unit_cost     REAL NOT NULL CHECK (unit_cost >= 0)
);
CREATE INDEX IF NOT EXISTS ix_lots_item ON stock_lots(item_id, date, id);

-- Every stock in/out. For raw materials qty_after / avg_cost_after form the
-- tank ledger (how much was in the tank and at what average after each event).
CREATE TABLE IF NOT EXISTS stock_movements (
  id             INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  item_id        INTEGER NOT NULL REFERENCES items(id),
  lot_id         INTEGER REFERENCES stock_lots(id), -- NULL for raw materials
  date           TEXT NOT NULL,
  qty            REAL NOT NULL,                     -- + in, - out
  unit_cost      REAL NOT NULL,
  value          REAL NOT NULL,                     -- signed money value
  qty_after      REAL,
  avg_cost_after REAL,
  type           TEXT NOT NULL,  -- purchase | opening | adjustment | production_in | production_out | sale | *_cancel
  ref_type       TEXT,
  ref_id         INTEGER,
  party_id       INTEGER REFERENCES parties(id),    -- supplier on receipts
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_mov_item ON stock_movements(item_id, id);
CREATE INDEX IF NOT EXISTS ix_mov_lot  ON stock_movements(lot_id);
CREATE INDEX IF NOT EXISTS ix_mov_ref  ON stock_movements(ref_type, ref_id);

-- ---------- Recipes (Bill of Materials) -----------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES items(id),
  name       TEXT NOT NULL,
  output_qty REAL NOT NULL CHECK (output_qty > 0),  -- one run yields this many units
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id        INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id),
  qty       REAL NOT NULL CHECK (qty > 0),          -- per one run
  UNIQUE (recipe_id, item_id)
);

-- ---------- Production (make-to-stock) ------------------------------
CREATE TABLE IF NOT EXISTS production_batches (
  id            INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  batch_no      TEXT NOT NULL UNIQUE,
  product_id    INTEGER NOT NULL REFERENCES items(id),
  recipe_id     INTEGER REFERENCES recipes(id),
  date          TEXT NOT NULL,
  runs          REAL NOT NULL DEFAULT 1,
  qty_produced  REAL NOT NULL CHECK (qty_produced > 0),
  material_cost REAL NOT NULL,
  other_cost    REAL NOT NULL DEFAULT 0,            -- labour / power charged to batch
  total_cost    REAL NOT NULL,
  unit_cost     REAL NOT NULL,
  lot_id        INTEGER REFERENCES stock_lots(id),
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw material drawn from each tank for a batch, at the average cost of that moment
CREATE TABLE IF NOT EXISTS production_consumption (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  qty         REAL NOT NULL,
  avg_cost    REAL NOT NULL,                        -- weighted average unit cost at production time
  amount      REAL NOT NULL,
  movement_id INTEGER REFERENCES stock_movements(id)
);
CREATE INDEX IF NOT EXISTS ix_pc_batch ON production_consumption(batch_id);

-- Snapshot (taken at production time) of which supplier deliveries were
-- in the tank, and how much of each went into the batch, assuming the tank
-- contents are fully mixed.
CREATE TABLE IF NOT EXISTS production_material_sources (
  id                  INTEGER PRIMARY KEY,
  consumption_id      INTEGER NOT NULL REFERENCES production_consumption(id) ON DELETE CASCADE,
  receipt_movement_id INTEGER NOT NULL REFERENCES stock_movements(id),
  purchase_id         INTEGER REFERENCES purchases(id),
  supplier_id         INTEGER REFERENCES parties(id),
  qty                 REAL NOT NULL,                -- estimated qty of this delivery in the batch
  share_pct           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pms_cons ON production_material_sources(consumption_id);
CREATE INDEX IF NOT EXISTS ix_pms_pur  ON production_material_sources(purchase_id);

-- ---------- Purchases -----------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id               INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  purchase_no      TEXT NOT NULL UNIQUE,
  supplier_id      INTEGER NOT NULL REFERENCES parties(id),
  supplier_bill_no TEXT,
  date             TEXT NOT NULL,
  total            REAL NOT NULL,
  paid             REAL NOT NULL DEFAULT 0,
  pay_account_id   INTEGER REFERENCES accounts(id),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  qty         REAL NOT NULL CHECK (qty > 0),
  unit_cost   REAL NOT NULL CHECK (unit_cost >= 0),
  amount      REAL NOT NULL,
  movement_id INTEGER REFERENCES stock_movements(id),  -- tank receipt (raw)
  lot_id      INTEGER REFERENCES stock_lots(id)        -- lot (trading)
);

-- ---------- Sales (invoiced from stock) -----------------------------
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  invoice_no     TEXT NOT NULL UNIQUE,
  customer_id    INTEGER NOT NULL REFERENCES parties(id),
  date           TEXT NOT NULL,
  subtotal       REAL NOT NULL,
  discount       REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL,
  paid           REAL NOT NULL DEFAULT 0,          -- received at time of sale
  pay_account_id INTEGER REFERENCES accounts(id),
  cost_total     REAL NOT NULL DEFAULT 0,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sales_date ON sales(date);

CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  qty        REAL NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  amount     REAL NOT NULL,
  cost       REAL NOT NULL DEFAULT 0
);

-- Which batches each invoice line was shipped from
CREATE TABLE IF NOT EXISTS sale_allocations (
  id           INTEGER PRIMARY KEY,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  lot_id       INTEGER NOT NULL REFERENCES stock_lots(id),
  qty          REAL NOT NULL CHECK (qty > 0),
  unit_cost    REAL NOT NULL
);
-- Raw material sold straight from a tank: which supplier deliveries were in
-- the tank at the time (same mixed-tank estimate as production).
CREATE TABLE IF NOT EXISTS sale_material_sources (
  id                  INTEGER PRIMARY KEY,
  sale_item_id        INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  receipt_movement_id INTEGER NOT NULL REFERENCES stock_movements(id),
  purchase_id         INTEGER REFERENCES purchases(id),
  supplier_id         INTEGER REFERENCES parties(id),
  qty                 REAL NOT NULL,
  share_pct           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sms_item ON sale_material_sources(sale_item_id);
CREATE INDEX IF NOT EXISTS ix_sms_rcpt ON sale_material_sources(receipt_movement_id);
CREATE INDEX IF NOT EXISTS ix_sa_lot ON sale_allocations(lot_id);

-- ---------- Sales returns (credit notes) ------------------------------
-- Goods a customer brings back, always against the invoice they were sold on.
-- Each line either goes back into stock (the same batch / tank it left) or is
-- written off as damaged. The customer is credited at the invoice price (less
-- the invoice discount share); money can also be paid back on the spot.
CREATE TABLE IF NOT EXISTS sale_returns (
  id                INTEGER PRIMARY KEY,
  fiscal_year_id    INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  return_no         TEXT NOT NULL UNIQUE,
  sale_id           INTEGER NOT NULL REFERENCES sales(id),
  customer_id       INTEGER NOT NULL REFERENCES parties(id),
  date              TEXT NOT NULL,
  subtotal          REAL NOT NULL,              -- returned qty × invoice rate
  discount          REAL NOT NULL DEFAULT 0,    -- share of the invoice discount
  total             REAL NOT NULL,              -- credited to the customer
  refund            REAL NOT NULL DEFAULT 0,    -- money paid back now
  refund_account_id INTEGER REFERENCES accounts(id),
  cost_restocked    REAL NOT NULL DEFAULT 0,    -- cost value put back into stock
  cost_damaged      REAL NOT NULL DEFAULT 0,    -- cost value written off
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sr_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS ix_sr_date ON sale_returns(date);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id           INTEGER PRIMARY KEY,
  return_id    INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  item_id      INTEGER NOT NULL REFERENCES items(id),
  qty          REAL NOT NULL CHECK (qty > 0),
  unit_price   REAL NOT NULL,
  amount       REAL NOT NULL,
  cost         REAL NOT NULL DEFAULT 0,         -- cost value of the returned qty (as it left)
  restock      INTEGER NOT NULL DEFAULT 1        -- 1 = back into stock, 0 = damaged / written off
);
CREATE INDEX IF NOT EXISTS ix_sri_sale_item ON sale_return_items(sale_item_id);

-- Which batches returned goods went back into
CREATE TABLE IF NOT EXISTS sale_return_allocations (
  id             INTEGER PRIMARY KEY,
  return_item_id INTEGER NOT NULL REFERENCES sale_return_items(id) ON DELETE CASCADE,
  lot_id         INTEGER NOT NULL REFERENCES stock_lots(id),
  qty            REAL NOT NULL CHECK (qty > 0),
  unit_cost      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sra_lot ON sale_return_allocations(lot_id);

-- ---------- Operational expenses ------------------------------------
-- One row per expense voucher. Each posts Dr <category> / Cr Cash|Bank
-- (journal_entries.ref_type = 'expense'), so it lands in the cash book and P&L.
CREATE TABLE IF NOT EXISTS expenses (
  id               INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  expense_no       TEXT NOT NULL UNIQUE,            -- EXP-00001
  date             TEXT NOT NULL,
  category_id      INTEGER NOT NULL REFERENCES accounts(id),
  amount           REAL NOT NULL CHECK (amount > 0),
  pay_account_id   INTEGER NOT NULL REFERENCES accounts(id),  -- Cash in Hand / Bank
  paid_to          TEXT,                            -- e.g. K-Electric, Ali Transport
  bill_no          TEXT,                            -- receipt / bill reference
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_exp_date ON expenses(status, date);
CREATE INDEX IF NOT EXISTS ix_exp_cat  ON expenses(category_id, date);

-- ---------- HR & payroll --------------------------------------------
-- P = present, A = absent, H = half day, L = leave (monthly staff only)
CREATE TABLE IF NOT EXISTS attendance (
  id             INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('P','A','H','L')),
  overtime_hours REAL NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 16), -- hours beyond the standard shift
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS ix_att_date ON attendance(date);

CREATE TABLE IF NOT EXISTS employee_advances (
  id                  INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  employee_id         INTEGER NOT NULL REFERENCES employees(id),
  date                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('advance','loan')),
  amount              REAL NOT NULL CHECK (amount > 0),
  monthly_installment REAL,                         -- loan: recover this much per month
  pay_account_id      INTEGER REFERENCES accounts(id),
  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll (
  id                INTEGER PRIMARY KEY,
  fiscal_year_id INTEGER REFERENCES financial_years(id),   -- stamped by trigger
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  month             TEXT NOT NULL,                  -- YYYY-MM
  salary_type       TEXT,                           -- snapshot at generation
  days_in_month     INTEGER NOT NULL,
  working_days      REAL NOT NULL DEFAULT 0,        -- days in month minus weekly offs (after joining)
  present           REAL NOT NULL DEFAULT 0,
  absent            REAL NOT NULL DEFAULT 0,
  half_days         REAL NOT NULL DEFAULT 0,
  leave             REAL NOT NULL DEFAULT 0,
  unmarked          REAL NOT NULL DEFAULT 0,
  paid_days         REAL NOT NULL,
  base_salary       REAL NOT NULL,                  -- monthly salary or per-day rate
  basic_pay         REAL NOT NULL DEFAULT 0,        -- pay for days worked
  overtime_hours    REAL NOT NULL DEFAULT 0,
  overtime_rate     REAL NOT NULL DEFAULT 0,
  overtime_pay      REAL NOT NULL DEFAULT 0,        -- overtime_hours x overtime_rate
  gross             REAL NOT NULL,                  -- basic_pay + overtime_pay
  bonus             REAL NOT NULL DEFAULT 0,
  advance_outstanding REAL NOT NULL DEFAULT 0,      -- advance/loan balance before this salary
  advance_deduction REAL NOT NULL DEFAULT 0,
  net               REAL NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','paid')),
  paid_date         TEXT,
  pay_account_id    INTEGER REFERENCES accounts(id),
  UNIQUE (employee_id, month)
);
