// End-to-end business flow test: run with `npm test`
process.env.DB_FILE = ':memory:';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/index.js');
const { startClient } = await import('../src/apiClient.js');
const { db } = await import('../src/db.js');

let api;
const ids = {};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: expected ${b}, got ${a}`);

before(async () => { api = await startClient(createApp()); });
after(async () => { await api.close(); });

test('setup masters', async () => {
  ids.sup1 = (await api.post('/parties', { type: 'supplier', name: 'Oil Co' })).id;
  ids.sup2 = (await api.post('/parties', { type: 'supplier', name: 'Oil Two' })).id;
  ids.cus = (await api.post('/parties', { type: 'customer', name: 'Shop A' })).id;
  ids.oil = (await api.post('/items', { kind: 'raw', name: 'Palm Oil', unit: 'kg', reorder_level: 50 })).id;
  ids.lye = (await api.post('/items', { kind: 'raw', name: 'Caustic', unit: 'kg' })).id;
  ids.soap = (await api.post('/items', { kind: 'finished', name: 'Soap', unit: 'pcs', sale_price: 100 })).id;
  ids.recipe = (await api.post('/recipes', { product_id: ids.soap, name: 'Std', output_qty: 100, items: [{ item_id: ids.oil, qty: 10 }, { item_id: ids.lye, qty: 2 }] })).id;
});

test('weighted average cost is recalculated on every purchase', async () => {
  await api.post('/purchases', { supplier_id: ids.sup1, items: [{ item_id: ids.oil, qty: 100, unit_cost: 400 }, { item_id: ids.lye, qty: 20, unit_cost: 200 }] });
  let oil = await api.get(`/items/${ids.oil}`);
  near(oil.unit_cost, 400, 'avg after first purchase');
  ids.pur2 = (await api.post('/purchases', { supplier_id: ids.sup2, items: [{ item_id: ids.oil, qty: 50, unit_cost: 460 }], paid: 10000 })).id;
  oil = await api.get(`/items/${ids.oil}`);
  near(oil.unit_cost, (100 * 400 + 50 * 460) / 150, 'moving average'); // 420
  near(oil.stock, 150, 'tank qty');
  assert.equal(oil.tank.length, 2, 'two deliveries in tank');
});

test('production is refused when raw material is short', async () => {
  await assert.rejects(api.post('/production', { recipe_id: ids.recipe, runs: 11 }), /Not enough raw material/);
  const oil = await api.get(`/items/${ids.oil}`);
  near(oil.stock, 150, 'nothing deducted after refusal');
});

test('production issues at weighted average and builds a traceable batch', async () => {
  const b = await api.post('/production', { recipe_id: ids.recipe, runs: 3, other_cost: 600 });
  // 30kg oil @420 + 6kg lye @200 = 12600 + 1200 = 13800 ; +600 = 14400 / 300 pcs = 48
  near(b.material_cost, 13800, 'material cost');
  near(b.unit_cost, 48, 'unit cost');
  ids.lot = b.lot_id;
  const oil = await api.get(`/items/${ids.oil}`);
  near(oil.stock, 120, 'oil left');
  near(oil.unit_cost, 420, 'issue does not change avg');
});

test('sale from stock, then full traceability of the batch', async () => {
  const s = await api.post('/sales', { customer_id: ids.cus, items: [{ item_id: ids.soap, qty: 120, unit_price: 90 }], paid: 5000 });
  ids.sale = s.id;
  const t = await api.get(`/trace/lot/${ids.lot}`);
  assert.equal(t.batch.qty_produced, 300);
  const oil = t.materials.find((m) => m.name === 'Palm Oil');
  near(oil.avg_cost, 420, 'avg cost at production time');
  assert.equal(oil.sources.length, 2, 'both suppliers traced');
  const share = Object.fromEntries(oil.sources.map((x) => [x.supplier_name, x.share_pct]));
  near(share['Oil Co'], 66.67, 'mixed-tank share supplier 1');
  near(share['Oil Two'], 33.33, 'mixed-tank share supplier 2');
  assert.equal(t.sales.length, 1);
  assert.equal(t.sales[0].customer_name, 'Shop A');
  assert.equal(t.sales[0].payment, 'Partial');
  near(t.summary.remaining, 180, 'remaining in batch');
  near(t.summary.profit, 120 * 90 - 120 * 48, 'batch profit');
});

test('forward trace (recall) from a supplier delivery to customers', async () => {
  const f = await api.get(`/trace/purchase/${ids.pur2}`);
  assert.deepEqual(f.customers.map((c) => c.name), ['Shop A']);
});

test('ledgers are updated automatically', async () => {
  const cus = await api.get(`/parties/${ids.cus}`);
  near(cus.balance, 10800 - 5000, 'customer owes');
  const sup2 = await api.get(`/parties/${ids.sup2}`);
  near(sup2.balance, 23000 - 10000, 'we owe supplier 2');
});

test('books balance and stock registers agree with the ledger', async () => {
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, 'trial balance');
  const sv = await api.get('/reports/stock-valuation');
  near(sv.raw.register, sv.raw.books, 'raw stock register = books');
  near(sv.goods.register, sv.goods.books, 'goods stock register = books');
  const p = await api.get('/reports/pnl');
  near(p.sales, 10800, 'sales');
  near(p.cogs, 5760, 'cogs');
});

test('cancelling a sale restores stock; cancelling a purchase restores the average', async () => {
  await api.post(`/sales/${ids.sale}/cancel`);
  const t = await api.get(`/trace/lot/${ids.lot}`);
  near(t.summary.remaining, 300, 'stock back in batch');
  const pur = (await api.post('/purchases', { supplier_id: ids.sup1, items: [{ item_id: ids.lye, qty: 5, unit_cost: 260 }] })).id;
  await api.post(`/purchases/${pur}/cancel`);
  const lye = await api.get(`/items/${ids.lye}`);
  near(lye.unit_cost, 200, 'avg restored after cancelling purchase');
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, 'trial balance after cancellations');
});

test('attendance-linked payroll with advance deduction', async () => {
  const e = (await api.post('/employees', { name: 'Worker', salary_type: 'monthly', salary_amount: 30000, join_date: '2026-01-01' })).id;
  await api.post('/advances', { employee_id: e, type: 'advance', amount: 4000, date: '2026-09-10' });
  // September has 30 days: 2 absent, 2 half days, 2 leaves (1 paid allowance) -> unpaid = 2 + 1 + 1 = 4
  const marks = { '2026-09-01': 'A', '2026-09-02': 'A', '2026-09-03': 'H', '2026-09-04': 'H', '2026-09-05': 'L', '2026-09-06': 'L', '2026-09-07': 'P' };
  for (const [date, status] of Object.entries(marks)) await api.put('/attendance', { date, records: [{ employee_id: e, status }] });
  const { rows } = await api.post('/payroll/generate', { month: '2026-09' });
  const slip = rows.find((r) => r.employee_id === e);
  near(slip.paid_days, 26, 'paid days');
  near(slip.gross, 26000, 'gross');
  near(slip.advance_deduction, 4000, 'advance recovered');
  near(slip.net, 22000, 'net');
  await api.post(`/payroll/${slip.id}/pay`, {});
  const emp = await api.get(`/employees/${e}`);
  near(emp.advance_balance, 0, 'advance cleared');
  await assert.rejects(api.put('/attendance', { date: '2026-09-08', records: [{ employee_id: e, status: 'P' }] }), /locked/);
});

test('staff role cannot see finance', async () => {
  await api.post('/users', { username: 'worker1', full_name: 'Floor Staff', role: 'staff', password: 'secret12' });
  const staff = await startClient(createApp(), { username: 'worker1', password: 'secret12' });
  await assert.rejects(staff.get('/reports/pnl'), /403/);
  const dash = await staff.get('/dashboard');
  assert.equal(dash.cash_in_hand, undefined);
  const t = await staff.get(`/trace/lot/${ids.lot}`);
  assert.equal(t.materials[0].avg_cost, undefined, 'costs hidden from staff');
  await staff.close();
  assert.ok(db.prepare('SELECT COUNT(*) c FROM audit_log').get().c > 0);
});

test('daily wager: (days worked x rate) + overtime - loan installment = net', async () => {
  await api.put('/hr/settings', { shift_start: '08:00', shift_end: '17:00', weekly_off_day: 0, overtime_rate_per_hour: 150, paid_leaves_per_month: 1, monthly_deduct_absent: true });
  const a = (await api.post('/employees', { name: 'Wager A', salary_type: 'daily', salary_amount: 1000, overtime_rate: 200, join_date: '2026-01-01' })).id;
  const b = (await api.post('/employees', { name: 'Wager B', salary_type: 'daily', salary_amount: 800, join_date: '2026-01-01' })).id;
  await api.post('/advances', { employee_id: a, type: 'loan', amount: 6000, monthly_installment: 2000, date: '2026-10-01' });

  const mark = (date, records) => api.put('/attendance', { date, records });
  const ot = { '2026-10-05': 2, '2026-10-06': 1.5, '2026-10-07': 0, '2026-10-08': 0, '2026-10-09': 3 };
  for (const [d, h] of Object.entries(ot)) await mark(d, [{ employee_id: a, status: 'P', overtime_hours: h }]);
  await mark('2026-10-10', [{ employee_id: a, status: 'H' }]);
  await mark('2026-10-12', [{ employee_id: a, status: 'H' }]);
  await mark('2026-10-13', [{ employee_id: a, status: 'A' }]);
  await mark('2026-10-14', [{ employee_id: a, status: 'A' }]);
  await mark('2026-10-05', [{ employee_id: a, status: 'P', overtime_hours: 2 }, { employee_id: b, status: 'P', overtime_hours: 2 }]);
  await mark('2026-10-06', [{ employee_id: b, status: 'P', overtime_hours: 2 }]);

  const { rows } = await api.post('/payroll/generate', { month: '2026-10' });
  const sa = rows.find((r) => r.employee_id === a);
  near(sa.paid_days, 6, 'days worked = 5 present + 2 half');
  near(sa.basic_pay, 6000, 'basic');
  near(sa.overtime_hours, 6.5, 'overtime hours');
  near(sa.overtime_pay, 1300, 'own overtime rate 200/h');
  near(sa.advance_deduction, 2000, 'one loan installment');
  near(sa.net, 5300, 'net payable');
  assert.equal(sa.working_days, 27, 'October minus 4 Sundays');
  assert.equal(sa.unmarked, 18, 'unmarked working days flagged');
  const sb = rows.find((r) => r.employee_id === b);
  near(sb.overtime_pay, 600, 'factory standard rate 150/h');
  near(sb.net, 2200, 'wager B net');

  await api.post(`/payroll/${sa.id}/pay`, {});
  const accts = await api.get('/accounts');
  near(accts.find((x) => x.code === '5110').balance, 1300, 'overtime posted to Overtime Wages');
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, 'books balance after payroll');
});

test('attendance rules: no overtime when absent, no leave for daily wagers, monthly staff opt-in', async () => {
  const w = (await api.post('/employees', { name: 'Wager C', salary_type: 'daily', salary_amount: 900 })).id;
  const m = (await api.post('/employees', { name: 'Clerk', salary_type: 'monthly', salary_amount: 31000, join_date: '2026-01-01' })).id;
  await assert.rejects(api.put('/attendance', { date: '2026-10-05', records: [{ employee_id: w, status: 'A', overtime_hours: 2 }] }), /only be added when/);
  await assert.rejects(api.put('/attendance', { date: '2026-10-05', records: [{ employee_id: w, status: 'L' }] }), /not used for daily wagers/);
  await assert.rejects(api.put('/attendance', { date: '2026-10-05', records: [{ employee_id: m, status: 'P', overtime_hours: 1 }] }), /not set up for overtime/);
  await assert.rejects(api.put('/attendance', { date: '2026-10-05', records: [{ employee_id: w, status: 'P', overtime_hours: 20 }] }), /cannot be more than/);

  // monthly salaried: absences cut only while the factory rule is on
  await api.put('/attendance', { date: '2026-10-07', records: [{ employee_id: m, status: 'A' }] });
  await api.put('/attendance', { date: '2026-10-08', records: [{ employee_id: m, status: 'A' }] });
  let slip = (await api.post('/payroll/generate', { month: '2026-10' })).rows.find((r) => r.employee_id === m);
  near(slip.basic_pay, 29000, 'two absent days cut (31000/31 x 29)');
  await api.put('/hr/settings', { shift_start: '08:00', shift_end: '17:00', weekly_off_day: 0, overtime_rate_per_hour: 150, paid_leaves_per_month: 1, monthly_deduct_absent: false });
  slip = (await api.post('/payroll/generate', { month: '2026-10' })).rows.find((r) => r.employee_id === m);
  near(slip.basic_pay, 31000, 'standard monthly payout when rule is off');
  await assert.rejects(api.put('/hr/settings', { shift_start: '17:00', shift_end: '08:00' }), /end after/);
});

test('expense categories: add, rename, hide', async () => {
  const c = await api.post('/expense-categories', { name: 'Diesel', description: 'Generator fuel' });
  await assert.rejects(api.post('/expense-categories', { name: 'diesel' }), /already exists/);
  await api.put(`/expense-categories/${c.id}`, { name: 'Diesel & Generator' });
  let cats = await api.get('/expense-categories');
  assert.ok(cats.some((x) => x.name === 'Diesel & Generator'));
  await api.put(`/expense-categories/${c.id}`, { active: false });
  cats = await api.get('/expense-categories');
  assert.ok(!cats.some((x) => x.id === c.id), 'hidden from the picker');
  await assert.rejects(api.post('/expenses', { category_id: c.id, amount: 100, date: '2026-08-01' }), /hidden/);
  await api.put(`/expense-categories/${c.id}`, { active: true });
  ids.diesel = c.id;
});

test('expenses hit the cash book instantly; edit, switch to bank and delete stay in sync', async () => {
  const [cash, bank] = await api.get('/accounts/cash');
  const book = (acc) => api.get(`/cash?account_id=${acc}&from=2026-08-01&to=2026-08-31`);
  const before = (await book(cash.id)).closing;

  const x = await api.post('/expenses', { category_id: ids.diesel, amount: 2000, date: '2026-08-10', paid_to: 'PSO Pump', note: '40 litres' });
  near((await book(cash.id)).closing, before - 2000, 'cash reduced');

  await api.put(`/expenses/${x.id}`, { amount: 2500 });
  near((await book(cash.id)).closing, before - 2500, 'edit re-posts');

  await api.put(`/expenses/${x.id}`, { pay_account_id: bank.id });
  near((await book(cash.id)).closing, before, 'cash restored when paid by bank');
  near((await book(bank.id)).total_out, 2500, 'bank reduced');

  // Cash Book "Cash Out" with an expense category creates a voucher too
  const cats = await api.get('/cash/categories');
  const rent = cats.out.find((c) => c.code === '5210');
  await api.post('/cash', { direction: 'out', category_id: rent.id, amount: 15000, date: '2026-08-01', note: 'August rent' });

  const aug = await api.get('/expenses?month=2026-08');
  assert.equal(aug.count, 2);
  near(aug.total, 17500, 'month total');
  assert.equal(aug.by_category[0].label, 'Rent', 'biggest category first');
  near(aug.by_category[0].pct, 85.71, 'share of month');
  assert.equal((await api.get('/expenses?from=2026-08-05&to=2026-08-31')).count, 1, 'date-wise filter');
  assert.equal((await api.get(`/expenses?month=2026-08&category_id=${ids.diesel}`)).count, 1, 'category filter');
  assert.equal((await api.get('/expenses?month=2026-08&q=PSO')).count, 1, 'search');

  await api.del(`/expenses/${x.id}`);
  near((await book(bank.id)).total_out, 0, 'delete removes it from the book');
  near((await api.get('/expenses?month=2026-08')).total, 15000, 'register updated');
});

test('P&L = revenue − COGS − operating − payroll, and ties to the books', async () => {
  const p = await api.get('/reports/pnl?from=2026-01-01&to=2026-12-31');
  near(p.net_profit, p.sales - p.cogs - p.operating.total - p.payroll.total + p.other_income.total, 'formula');
  const tb = await api.get('/reports/trial-balance?to=2026-12-31');
  const books = tb.rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.credit - r.debit, 0)
    - tb.rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.debit - r.credit, 0);
  near(p.net_profit, books, 'P&L equals income − expenses in the ledger');
  assert.ok(p.operating.lines.some((l) => l.name === 'Rent' && l.amount === 15000), 'custom category in operating expenses');

  // Salaries are booked in the salary month even though they were paid in November
  const oct = await api.get('/reports/pnl?from=2026-10-01&to=2026-10-31');
  near(oct.payroll.daily, 6000, 'daily wages in October');
  near(oct.payroll.overtime, 1300, 'overtime in October');
  const sep = await api.get('/reports/pnl?from=2026-09-01&to=2026-09-30');
  near(sep.payroll.monthly, 26000, 'monthly salary in September');
  assert.equal(oct.previous.from, '2026-09-01', 'previous month for comparison');

  const ov = await api.get('/finance/overview?month=2026-10');
  assert.equal(ov.trend.length, 6);
  near(ov.current.net_profit, oct.net_profit, 'overview uses the same P&L');
});

// ---------- payment methods & multi-account cash/bank ----------------------
async function fundsMatchBooks() {
  const { accounts } = await api.get('/funds?all=1');
  for (const a of accounts) {
    const t = await api.get(`/funds/transactions?account_id=${a.id}&from=2000-01-01&to=2099-12-31`);
    near(t.closing, a.balance, `fund ledger = books for ${a.name}`);
    near(t.total_in - t.total_out, a.balance, `fund rows sum for ${a.name}`);
  }
}

test('multiple bank accounts with opening balance; existing history is in the fund ledger', async () => {
  const meezan = await api.post('/funds', { fund_type: 'bank', name: 'Meezan Current', bank_name: 'Meezan Bank', account_number: 'PK00MEZN0001', opening_balance: 50000, opening_date: '2026-07-01' });
  ids.meezan = meezan.id;
  const f = await api.get('/funds');
  near(f.accounts.find((a) => a.id === meezan.id).balance, 50000, 'opening balance');
  near(f.totals.all, f.totals.cash + f.totals.bank, 'totals');
  await fundsMatchBooks();
});

test('payment method must match the account; cheque details are kept', async () => {
  const [cash] = (await api.get('/accounts/cash')).filter((a) => a.fund_type === 'cash');
  const sale = { customer_id: ids.cus, date: '2026-07-05', items: [{ item_id: ids.soap, qty: 10, unit_price: 100 }], paid: 1000 };
  await assert.rejects(api.post('/sales', { ...sale, payment_method: 'cash', account_id: ids.meezan }), /bank account/);
  await assert.rejects(api.post('/sales', { ...sale, payment_method: 'cheque', account_id: cash.id }), /cash account/);
  await assert.rejects(api.post('/sales', { ...sale, payment_method: 'bitcoin' }), /Choose Cash/);

  const s = await api.post('/sales', { ...sale, payment_method: 'cheque', account_id: ids.meezan, cheque_no: '004512', bank_name: 'HBL', cheque_date: '2026-07-05' });
  ids.chqSale = s.id;
  const inv = await api.get(`/sales/${s.id}`);
  assert.equal(inv.payments[0].method, 'cheque');
  assert.equal(inv.payments[0].cheque_no, '004512');
  assert.equal(inv.payments[0].cheque_status, 'pending');
  const f = await api.get('/funds');
  near(f.accounts.find((a) => a.id === ids.meezan).balance, 51000, 'cheque instantly in the selected bank');

  const july = (m) => api.get(`/sales?month=2026-07&method=${m}`);
  assert.equal((await july('cheque')).rows.length, 1, 'sales filtered by cheque');
  assert.equal((await july('cash')).rows.length, 0, 'no cash sales in July');
  near((await july('cheque')).summary.by_method.cheque, 1000, 'summary by method');
});

test('bounced cheque reverses the payment; cleared cheque is marked', async () => {
  const pending = await api.get(`/funds/transactions?cheque=pending&account_id=${ids.meezan}`);
  const chq = pending.rows.find((r) => r.ref_type === 'sale' && r.ref_id === ids.chqSale);
  const custBefore = (await api.get(`/parties/${ids.cus}`)).balance;
  await api.post(`/funds/transactions/${chq.id}/bounce`, { date: '2026-07-09' });
  near((await api.get(`/parties/${ids.cus}`)).balance, custBefore + 1000, 'customer owes again');
  near((await api.get(`/sales/${ids.chqSale}`)).paid, 0, 'invoice back to unpaid');
  near((await api.get('/funds')).accounts.find((a) => a.id === ids.meezan).balance, 50000, 'bank back down');
  await assert.rejects(api.post(`/funds/transactions/${chq.id}/clear`, {}), /already bounced/);

  // supplier paid by our cheque, then cleared
  await api.post(`/parties/${ids.sup1}/payment`, { amount: 5000, date: '2026-07-10', payment_method: 'cheque', account_id: ids.meezan, cheque_no: '100201' });
  const ours = (await api.get(`/funds/transactions?cheque=pending&account_id=${ids.meezan}`)).rows.find((r) => r.cheque_no === '100201');
  await api.post(`/funds/transactions/${ours.id}/clear`, { date: '2026-07-12' });
  const after = (await api.get(`/funds/transactions?account_id=${ids.meezan}&month=2026-07`)).rows.find((r) => r.id === ours.id);
  assert.equal(after.cheque_status, 'cleared');
  await fundsMatchBooks();
});

test('expenses, salaries and advances record their method; filters by method work everywhere', async () => {
  const cats = await api.get('/expense-categories');
  const x = await api.post('/expenses', { category_id: cats[0].id, amount: 3000, date: '2026-07-15', payment_method: 'bank_transfer', account_id: ids.meezan, reference: 'IBFT-778812' });
  let jul = await api.get('/expenses?month=2026-07');
  assert.equal(jul.rows[0].payment_method, 'bank_transfer');
  assert.equal(jul.rows[0].reference, 'IBFT-778812');
  assert.equal((await api.get('/expenses?month=2026-07&method=cash')).count, 0, 'expense filter by method');
  await api.put(`/expenses/${x.id}`, { amount: 3200 }); // payment details untouched by this edit
  jul = await api.get('/expenses?month=2026-07');
  assert.equal(jul.rows[0].reference, 'IBFT-778812', 'reference kept when only the amount changed');
  await api.put(`/expenses/${x.id}`, { payment_method: 'cash' });
  assert.equal((await api.get('/expenses?month=2026-07&method=cash')).count, 1, 'switched to cash');

  const e = (await api.post('/employees', { name: 'Bank Paid', salary_type: 'monthly', salary_amount: 31000, join_date: '2026-01-01' })).id;
  await api.post('/advances', { employee_id: e, type: 'advance', amount: 1000, date: '2026-07-03', payment_method: 'cash' });
  const slip = (await api.post('/payroll/generate', { month: '2026-07' })).rows.find((r) => r.employee_id === e);
  await api.post(`/payroll/${slip.id}/pay`, { payment_method: 'bank_transfer', account_id: ids.meezan, reference: 'SAL-JUL', date: '2026-07-31' });
  const row = (await api.get(`/funds/transactions?account_id=${ids.meezan}&month=2026-07&method=bank_transfer`)).rows.find((r) => r.ref_type === 'payroll');
  assert.equal(row.employee_name, 'Bank Paid');
  assert.equal(row.purpose, 'Salaries & wages');
  near(row.amount, 30000, 'net salary after advance');

  const book = await api.get('/reports/journal?from=2026-07-01&to=2026-07-31&method=bank_transfer');
  assert.ok(book.entries.length === 1 && book.entries.every((en) => en.methods.includes('bank_transfer')), 'day book filtered by method');
  const rep = await api.get('/reports/payment-methods?from=2026-07-01&to=2026-07-31');
  const bankOut = rep.methods.find((m) => m.method === 'bank_transfer').out;
  near(bankOut, 30000, 'bank transfer out = salary (expense moved to cash)');
  assert.ok(rep.purposes.some((p) => p.purpose === 'Bounced cheques'));
  await fundsMatchBooks();
});

test('internal transfer moves money between accounts and cannot overdraw', async () => {
  const f0 = await api.get('/funds');
  const cash = f0.accounts.find((a) => a.fund_type === 'cash');
  const before = { cash: cash.balance, bank: f0.accounts.find((a) => a.id === ids.meezan).balance };
  await assert.rejects(api.post('/funds/transfer', { from_account_id: ids.meezan, to_account_id: cash.id, amount: before.bank + 1 }), /You cannot move more/);
  await assert.rejects(api.post('/funds/transfer', { from_account_id: cash.id, to_account_id: cash.id, amount: 10 }), /two different/);
  await api.post('/funds/transfer', { from_account_id: ids.meezan, to_account_id: cash.id, amount: 2000, note: 'Petty cash' });
  const f1 = await api.get('/funds');
  near(f1.accounts.find((a) => a.id === cash.id).balance, before.cash + 2000, 'cash up');
  near(f1.accounts.find((a) => a.id === ids.meezan).balance, before.bank - 2000, 'bank down');
  near(f1.totals.all, f0.totals.all, 'transfers do not change total funds');
  const t = await api.get(`/funds/transactions?account_id=${cash.id}&method=transfer&from=2000-01-01&to=2099-12-31`);
  assert.ok(t.rows.some((r) => r.memo.startsWith('Cash withdrawn from Meezan Current')));
  await assert.rejects(api.put(`/funds/${ids.meezan}`, { active: false }), /before closing/);
  const tb = await api.get('/reports/trial-balance?to=2099-12-31');
  near(tb.total_debit, tb.total_credit, 'books balance');
  await fundsMatchBooks();
});

// ---------- financial years, year-end closing, carry-forward ---------------
test('financial years: default year, adding an earlier year, trading in it', async () => {
  const list = await api.get('/financial-years');
  const cur = list.years.find((y) => y.state === 'active');
  assert.equal(cur.name, 'FY 2026-27');
  ids.fyCur = cur.id;
  await assert.rejects(api.post('/financial-years', { start_date: '2026-06-01', end_date: '2027-05-31' }), /overlap/);
  ids.fyPrev = (await api.post('/financial-years', { start_date: '2025-07-01', end_date: '2026-06-30' })).id;
  ids.catJune = (await api.get('/expense-categories'))[0].id;
  await assert.rejects(api.post('/expenses', { category_id: ids.catJune, amount: 10, date: '2025-06-30' }), /No financial year covers/);

  ids.olive = (await api.post('/items', { kind: 'raw', name: 'Olive Oil', unit: 'kg' })).id;
  ids.oliveSoap = (await api.post('/items', { kind: 'finished', name: 'Olive Soap', unit: 'pcs' })).id;
  const rec = (await api.post('/recipes', { product_id: ids.oliveSoap, name: 'Olive', output_qty: 100, items: [{ item_id: ids.olive, qty: 10 }] })).id;
  await api.post('/purchases', { supplier_id: ids.sup1, date: '2026-06-05', items: [{ item_id: ids.olive, qty: 100, unit_cost: 500 }], paid: 20000 });
  await api.post('/production', { recipe_id: rec, runs: 2, date: '2026-06-10' });
  ids.juneSale = (await api.post('/sales', { customer_id: ids.cus, date: '2026-06-20', items: [{ item_id: ids.oliveSoap, qty: 150, unit_price: 90 }],
    paid: 5000, payment_method: 'cheque', account_id: ids.meezan, cheque_no: 'JUN-1' })).id;
  await api.post('/expenses', { category_id: ids.catJune, amount: 1500, date: '2026-06-25' });
});

test('pre-closing summary shows exactly what will be carried forward', async () => {
  const pv = await api.get(`/financial-years/${ids.fyPrev}/closing-preview`);
  assert.deepEqual(pv.blockers, []);
  assert.equal(pv.next.id, ids.fyCur, 'next year already exists');
  const olive = pv.position.items.find((i) => i.id === ids.olive);
  near(olive.qty, 80, 'tank qty on 30 June'); near(olive.unit_cost, 500, 'weighted average carried');
  const soap = pv.position.items.find((i) => i.id === ids.oliveSoap);
  near(soap.qty, 50, 'finished stock'); near(soap.unit_cost, 50, 'batch cost');
  assert.equal(pv.position.lots.length, 1, 'one batch carried');
  near(pv.position.net_profit, 13500 - 7500 - 1500, 'net profit');
  near(pv.position.pnl.net_profit, pv.position.net_profit, 'matches P&L');
  near(pv.position.parties.find((p) => p.id === ids.cus).amount, 8500, 'customer owes');
  near(pv.position.parties.find((p) => p.id === ids.sup1).amount, 30000, 'we owe supplier');
  near(pv.position.totals.stock_raw, pv.position.totals.books_raw, 'stock = books (raw)');
  assert.ok(pv.warnings.some((w) => /cheque/.test(w)), 'pending cheque warning');
});

test('closing locks the year, moves profit to Retained Earnings and carries balances forward', async () => {
  await assert.rejects(api.post(`/financial-years/${ids.fyPrev}/close`, { confirm: 'wrong' }), /Type FY 2025-26/);
  const res = await api.post(`/financial-years/${ids.fyPrev}/close`, { confirm: 'FY 2025-26' });
  near(res.net_profit, 4500, 'profit closed');
  near((await api.get('/reports/pnl?from=2025-07-01&to=2026-06-30')).net_profit, 4500, 'closed year P&L still readable');
  const bs = await api.get('/reports/balance-sheet?to=2026-06-30');
  assert.ok(bs.balanced, 'balance sheet balances at year end');
  near(bs.equity.find((e) => e.name === 'Retained Earnings').amount, 4500, 'profit in retained earnings');
  assert.ok((await api.get('/reports/balance-sheet?to=2099-12-31')).balanced, 'balance sheet balances today');
  const tb = await api.get('/reports/trial-balance?to=2026-06-30');
  near(tb.total_debit, tb.total_credit, 'pre-closing trial balance'); assert.ok(tb.rows.some((r) => r.name === 'Sales'));
  const ob = await api.get(`/financial-years/${ids.fyCur}/opening-balances`);
  assert.ok(ob.all_match, 'every opening balance matches the books');
  const it = ob.rows.find((r) => r.kind === 'item' && r.ref_id === ids.olive);
  near(it.qty, 80); near(it.unit_cost, 500);
  near(ob.rows.find((r) => r.kind === 'party' && r.ref_id === ids.cus).amount, 8500);
  assert.ok(ob.rows.some((r) => r.kind === 'fund' && r.ref_id === ids.meezan));
  assert.equal((await api.get('/financial-years')).years.find((y) => y.id === ids.fyPrev).state, 'closed');
});

test('a closed year is locked in the app and in the database; viewing it is read-only', async () => {
  await assert.rejects(api.post('/expenses', { category_id: ids.catJune, amount: 100, date: '2026-06-15' }), /closed and locked/);
  const exp = (await api.get('/expenses?month=2026-06')).rows[0];
  await assert.rejects(api.put(`/expenses/${exp.id}`, { amount: 1 }), /closed/);
  await assert.rejects(api.del(`/expenses/${exp.id}`), /closed/);
  await assert.rejects(api.post(`/sales/${ids.juneSale}/cancel`, {}), /closed/);
  const emp = db.prepare('SELECT id FROM employees LIMIT 1').get().id;
  await assert.rejects(api.put('/attendance', { date: '2026-06-10', records: [{ employee_id: emp, status: 'P' }] }), /closed/);
  assert.throws(() => db.prepare("INSERT INTO journal_entries(date, memo) VALUES ('2026-06-01', 'backdoor')").run(), /FY_CLOSED/);
  assert.throws(() => db.prepare('UPDATE expenses SET amount = 1 WHERE id = ?').run(exp.id), /FY_CLOSED/);
  assert.throws(() => db.prepare("DELETE FROM stock_movements WHERE date = '2026-06-10'").run(), /FY_CLOSED/);

  api.fy = ids.fyPrev; // year switcher -> FY 2025-26
  const view = await api.get(`/parties/${ids.cus}`);
  near(view.balance, 8500, 'customer balance at that year end'); assert.equal(view.period.to, '2026-06-30');
  assert.equal((await api.get('/dashboard')).today, '2026-06-30', 'dashboard as of year end');
  const stock = (await api.get('/items?kind=raw')).find((i) => i.id === ids.olive);
  near(stock.stock, 80, 'stock as of year end');
  await assert.rejects(api.post('/expenses', { category_id: ids.catJune, amount: 100 }), /read-only/);
  api.fy = null;

  const chq = (await api.get('/funds/transactions?cheque=pending')).rows.find((r) => r.cheque_no === 'JUN-1');
  await api.post(`/funds/transactions/${chq.id}/clear`, {});
  near((await api.get(`/parties/${ids.cus}`)).opening_balance, 8500, 'new year starts with the carried-forward balance');
});

test('reopening (admin) unlocks; re-closing recalculates; the current year cannot close early', async () => {
  await api.post(`/financial-years/${ids.fyPrev}/reopen`, {});
  await api.post('/expenses', { category_id: ids.catJune, amount: 500, date: '2026-06-28' });
  const res = await api.post(`/financial-years/${ids.fyPrev}/close`, { confirm: 'FY 2025-26' });
  near(res.net_profit, 4000, 're-closed with the new expense');
  assert.ok((await api.get(`/financial-years/${ids.fyCur}/opening-balances`)).all_match);
  const pv = await api.get(`/financial-years/${ids.fyCur}/closing-preview`);
  assert.ok(pv.blockers.some((b) => /ends on/.test(b)), 'cannot close before the year ends');
  const tb = await api.get('/reports/trial-balance?to=2099-12-31');
  near(tb.total_debit, tb.total_credit, 'books still balance');
});

// ---------- item categories ---------------------------------------------------
test('item categories: separate list per item type, add / rename / hide, filter', async () => {
  const raw = await api.get('/item-categories?kind=raw');
  assert.ok(['Oil', 'Chemical', 'Fragrance', 'Packaging', 'Other'].every((n) => raw.some((c) => c.name === n)), 'starter raw categories');
  assert.ok(!(await api.get('/item-categories?kind=finished')).some((c) => c.name === 'Chemical'), 'lists are separate');

  const ess = await api.post('/item-categories', { kind: 'raw', name: 'Essential Oils' });
  await assert.rejects(api.post('/item-categories', { kind: 'raw', name: 'essential oils' }), /already exists/);
  const bath = await api.post('/item-categories', { kind: 'finished', name: 'Bath Soap' });

  const rose = (await api.post('/items', { kind: 'raw', name: 'Rose Oil', unit: 'kg', category_id: ess.id })).id;
  await assert.rejects(api.post('/items', { kind: 'raw', name: 'Wrong', category_id: bath.id }), /category for this type/);
  assert.equal((await api.get(`/items/${rose}`)).category_name, 'Essential Oils');
  assert.deepEqual((await api.get(`/items?kind=raw&category_id=${ess.id}`)).map((i) => i.name), ['Rose Oil'], 'filter by category');

  await api.put(`/item-categories/${ess.id}`, { name: 'Essential & Floral Oils' });
  assert.equal((await api.get(`/items/${rose}`)).category_name, 'Essential & Floral Oils', 'rename reaches items');

  await api.put(`/item-categories/${ess.id}`, { active: false });
  assert.ok(!(await api.get('/item-categories?kind=raw')).some((c) => c.id === ess.id), 'hidden from the form');
  await assert.rejects(api.post('/items', { kind: 'raw', name: 'Jasmine Oil', category_id: ess.id }), /hidden/);
  await api.put(`/items/${rose}`, { reorder_level: 5 }); // editing an item in a hidden category still works
  assert.equal((await api.get(`/items/${rose}`)).category_name, 'Essential & Floral Oils');

  const other = raw.find((c) => c.name === 'Other');
  await api.put(`/items/${rose}`, { category_id: other.id });
  assert.equal((await api.get(`/items/${rose}`)).category_name, 'Other', 'moved to another category');

  // older callers sending a category name still work
  const legacy = (await api.post('/items', { kind: 'trading', name: 'Toothpaste', category: 'Oral Care' })).id;
  assert.equal((await api.get(`/items/${legacy}`)).category_name, 'Oral Care');
});

test('raw material can be sold on an invoice: tank cost, books, traceability, cancel', async () => {
  const supA = (await api.post('/parties', { type: 'supplier', name: 'Glycerin Supplier A' })).id;
  const supB = (await api.post('/parties', { type: 'supplier', name: 'Glycerin Supplier B' })).id;
  const buyer = (await api.post('/parties', { type: 'customer', name: 'Raw Buyer' })).id;
  const gly = (await api.post('/items', { kind: 'raw', name: 'Glycerin', unit: 'kg', sale_price: 300 })).id;
  const purA = (await api.post('/purchases', { supplier_id: supA, items: [{ item_id: gly, qty: 60, unit_cost: 200 }] })).id;
  await api.post('/purchases', { supplier_id: supB, items: [{ item_id: gly, qty: 40, unit_cost: 250 }] });
  near((await api.get(`/items/${gly}`)).unit_cost, 220, 'avg (60*200+40*250)/100');

  await assert.rejects(api.post('/sales', { customer_id: buyer, items: [{ item_id: gly, qty: 101, unit_price: 300 }] }), /Not enough "Glycerin"/);

  const s = await api.post('/sales', { customer_id: buyer, items: [{ item_id: gly, qty: 25, unit_price: 300 }], paid: 7500, payment_method: 'cash' });
  let item = await api.get(`/items/${gly}`);
  near(item.stock, 75, 'left the tank');
  near(item.unit_cost, 220, 'selling does not change the average');
  assert.equal(item.sold_to[0].customer_name, 'Raw Buyer');
  assert.equal(item.movements[0].type, 'sale');

  const inv = await api.get(`/sales/${s.id}`);
  near(inv.cost_total, 25 * 220, 'cost at weighted average');
  assert.equal(inv.items[0].kind, 'raw');
  assert.deepEqual(inv.items[0].sources.map((x) => [x.supplier_name, x.share_pct]), [['Glycerin Supplier A', 60], ['Glycerin Supplier B', 40]]);

  const lines = db.prepare(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id WHERE e.ref_type = 'sale' AND e.ref_id = ?`).all(s.id);
  near(lines.filter((l) => l.code === '1200').reduce((t, l) => t + l.credit, 0), 5500, 'raw material stock credited');
  assert.ok(!lines.some((l) => l.code === '1210'), 'finished goods stock untouched');
  near(lines.filter((l) => l.code === '5000').reduce((t, l) => t + l.debit, 0), 5500, 'cost of goods sold');

  const tr = await api.get(`/trace/purchase/${purA}`);
  near(tr.lines[0].direct_sales[0].qty, 15, '60% of 25 kg came from supplier A');
  assert.ok(tr.customers.some((c) => c.name === 'Raw Buyer'), 'recall list includes the raw-material buyer');

  // mixed invoice: soap + raw on one bill
  const mixed = await api.post('/sales', { customer_id: buyer, items: [{ item_id: ids.soap, qty: 1, unit_price: 100 }, { item_id: gly, qty: 5, unit_price: 300 }] });
  const m = await api.get(`/sales/${mixed.id}`);
  assert.equal(m.items.length, 2);
  near(m.items.find((x) => x.kind === 'raw').cost, 1100, 'raw line cost');

  await api.post(`/sales/${s.id}/cancel`);
  await api.post(`/sales/${mixed.id}/cancel`);
  item = await api.get(`/items/${gly}`);
  near(item.stock, 100, 'cancel returns material to the tank');
  near(item.unit_cost, 220, 'average unchanged after the return');
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, "books still balance");
});

test('deleting a stock item: needs DELETE typed, hides it from lists, keeps it on old documents, can be restored', async () => {
  const sup = (await api.post('/parties', { type: 'supplier', name: 'Shampoo Supplier' })).id;
  const cus = (await api.post('/parties', { type: 'customer', name: 'Shampoo Buyer' })).id;
  const sh = (await api.post('/items', { kind: 'trading', name: 'Old Shampoo', unit: 'pcs', sale_price: 150 })).id;
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: sh, qty: 10, unit_cost: 100 }] });
  const sale = await api.post('/sales', { customer_id: cus, items: [{ item_id: sh, qty: 4, unit_price: 150 }] });

  // stock left -> blocked
  let check = await api.get(`/items/${sh}/delete-check`);
  assert.equal(check.can_delete, false);
  assert.equal(check.blockers[0].code, 'stock');
  assert.equal(check.used.invoices, 1);
  await assert.rejects(api.post(`/items/${sh}/delete`, { confirm: 'DELETE' }), /still in stock/);
  await api.post(`/items/${sh}/adjust`, { qty: -6, reason: 'Expired' });
  check = await api.get(`/items/${sh}/delete-check`);
  assert.equal(check.can_delete, true);

  // the word must be typed
  await assert.rejects(api.post(`/items/${sh}/delete`, {}), /Type DELETE/);
  await assert.rejects(api.post(`/items/${sh}/delete`, { confirm: 'yes' }), /Type DELETE/);
  await api.post(`/items/${sh}/delete`, { confirm: ' delete ' });

  // gone from lists and forms
  assert.ok(!(await api.get('/items')).some((i) => i.id === sh), 'not in stock list');
  assert.ok((await api.get('/items-deleted?kind=trading')).some((i) => i.id === sh), 'in deleted list');
  await assert.rejects(api.post('/sales', { customer_id: cus, items: [{ item_id: sh, qty: 1, unit_price: 150 }] }), /was deleted/);
  await assert.rejects(api.post('/purchases', { supplier_id: sup, items: [{ item_id: sh, qty: 1, unit_cost: 100 }] }), /was deleted/);
  await assert.rejects(api.put(`/items/${sh}`, { name: 'X' }), /was deleted/);
  await assert.rejects(api.post(`/items/${sh}/adjust`, { qty: 5, unit_cost: 1 }), /was deleted/);

  // ...but old documents and history keep it
  const inv = await api.get(`/sales/${sale.id}`);
  assert.equal(inv.items[0].name, 'Old Shampoo', 'invoice still shows the item');
  const detail = await api.get(`/items/${sh}`);
  assert.equal(detail.active, 0);
  assert.ok(detail.deleted_at && detail.deleted_by_name, 'who and when');
  assert.ok(detail.movements.length >= 3, 'history kept');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'delete' AND entity = 'item' AND entity_id = ?").get(sh), 'audited');

  // restore
  await api.post(`/items/${sh}/restore`);
  assert.ok((await api.get('/items')).some((i) => i.id === sh), 'back in the list');
  await api.post(`/items/${sh}/delete`, { confirm: 'DELETE' });

  // being an ingredient no longer blocks deleting (only stock does)
  const tank = await api.get(`/items/${ids.lye}/delete-check`);
  assert.ok(!tank.blockers.some((b) => b.code === 'recipe'), 'recipes do not block');

  // a finished product's own recipes are hidden with it
  const temp = (await api.post('/items', { kind: 'finished', name: 'Temp Soap', unit: 'pcs' })).id;
  const rec = (await api.post('/recipes', { product_id: temp, name: 'Temp', output_qty: 10, items: [{ item_id: ids.lye, qty: 1 }] })).id;
  const res = await api.post(`/items/${temp}/delete`, { confirm: 'DELETE' });
  assert.equal(res.recipes_hidden, 1);
  assert.ok(!(await api.get('/recipes')).some((r) => r.id === rec), 'recipe hidden');
  await assert.rejects(api.post('/production', { recipe_id: rec, runs: 1 }), /no longer active/);
});

test('dashboard analytics: KPIs match the P&L, 12-month trend, breakdowns add up', async () => {
  for (const period of ['month', 'last_month', 'quarter', 'year']) {
    const a = await api.get(`/dashboard/analytics?period=${period}`);
    assert.equal(a.period.key, period);
    const p = await api.get(`/reports/pnl?from=${a.period.from}&to=${a.period.to}`);
    near(a.kpi.sales, p.sales, `${period} sales = P&L`);
    near(a.kpi.net_profit, p.net_profit, `${period} net profit = P&L`);
    assert.equal(a.trend.length, 12);
    assert.equal(a.daily.length, 30);
    assert.equal(a.production.length, 12);
  }
  const a = await api.get('/dashboard/analytics?period=year');
  const t = a.trend.at(-1);
  near(t.gross_profit, t.sales - t.cogs, 'gross = sales - cogs');
  const owed = a.receivables.reduce((s, r) => s + r.owes, 0);
  assert.ok(owed <= a.position.receivable + 0.01, 'top debtors within total receivable');
  near(a.collection.received + a.collection.on_credit, a.collection.invoiced, 'collected + credit = invoiced');
  assert.ok(a.trend.every((m) => m.money_in >= 0 && m.money_out >= 0));
});

test('invoice profit is shown to managers (cost, profit, margin) and hidden from staff', async () => {
  const cus = (await api.post('/parties', { type: 'customer', name: 'Profit Check Shop' })).id;
  const sup = (await api.post('/parties', { type: 'supplier', name: 'Profit Check Supplier' })).id;
  const tea = (await api.post('/items', { kind: 'trading', name: 'Profit Tea', unit: 'pcs', sale_price: 150 })).id;
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: tea, qty: 10, unit_cost: 100 }] });
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: tea, qty: 10, unit_cost: 120 }] });
  // 12 pcs: 10 from the oldest batch @100 + 2 @120 = 1240 cost; 12 x 150 = 1800, discount 60 -> 1740
  const s = await api.post('/sales', { customer_id: cus, items: [{ item_id: tea, qty: 12, unit_price: 150 }], discount: 60 });
  const inv = await api.get(`/sales/${s.id}`);
  near(inv.profit.cost, 1240, 'cost oldest batch first');
  near(inv.profit.profit, 500, 'profit after discount');
  near(inv.profit.margin_pct, 28.74, 'margin %');
  near(inv.profit.lines[0].profit, 560, 'line profit before invoice discount');

  const staff = await startClient(createApp(), { username: 'worker1', password: 'secret12' });
  const seen = await staff.get(`/sales/${s.id}`);
  assert.equal(seen.profit, undefined, 'no profit for staff');
  assert.equal(seen.cost_total, undefined, 'no cost for staff');
  assert.equal(seen.items[0].cost, undefined, 'no line cost for staff');
  await staff.close();
});

test('sales return: goods back into their batches / tank, damaged written off, customer credited, refund, cancel', async () => {
  const cus = (await api.post('/parties', { type: 'customer', name: 'Return Shop' })).id;
  const sup = (await api.post('/parties', { type: 'supplier', name: 'Return Supplier' })).id;
  const box = (await api.post('/items', { kind: 'trading', name: 'Gift Box', unit: 'pcs', sale_price: 100 })).id;
  const coco = (await api.post('/items', { kind: 'raw', name: 'Coconut Oil', unit: 'kg' })).id;
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: box, qty: 10, unit_cost: 50 }] });
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: box, qty: 10, unit_cost: 60 }] });
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: coco, qty: 100, unit_cost: 300 }] });
  // 15 boxes: 10 @50 + 5 @60 = 800 cost; 10 kg oil @300 = 3000 cost. 1500 + 4000 = 5500, 10% discount -> 4950
  const s = await api.post('/sales', { customer_id: cus, discount: 550, items: [{ item_id: box, qty: 15, unit_price: 100 }, { item_id: coco, qty: 10, unit_price: 400 }] });
  const inv0 = await api.get(`/sales/${s.id}`);
  const lineOf = (inv, item) => inv.items.find((x) => x.item_id === item);
  const bal0 = (await api.get(`/parties/${cus}`)).balance;
  near(bal0, 4950, 'customer owes the invoice');

  // return 1: 6 boxes back to stock, 4 kg oil damaged; 500 paid back in cash
  const r1 = await api.post(`/sales/${s.id}/returns`, { reason: 'Wrong item', refund: 500, payment_method: 'cash', items: [
    { sale_item_id: lineOf(inv0, box).id, qty: 6, restock: true },
    { sale_item_id: lineOf(inv0, coco).id, qty: 4, restock: false },
  ] });
  near(r1.total, 1980, '2200 less 10% discount share');
  const ret1 = await api.get(`/returns/${r1.id}`);
  assert.equal(ret1.invoice_no, inv0.invoice_no);
  near(ret1.cost_restocked, 300, '6 boxes back into the oldest batch @50');
  near(ret1.cost_damaged, 1200, 'damaged oil cost written off');
  assert.equal(ret1.items[0].batches.length, 1);

  let boxItem = await api.get(`/items/${box}`);
  near(boxItem.stock, 11, '20 - 15 + 6');
  let cocoItem = await api.get(`/items/${coco}`);
  near(cocoItem.stock, 90, 'damaged oil does not come back');
  near((await api.get(`/parties/${cus}`)).balance, 4950 - 1980 + 500, 'credited, then refund paid out');

  let inv = await api.get(`/sales/${s.id}`);
  near(lineOf(inv, box).returnable_qty, 9, 'boxes still returnable');
  near(lineOf(inv, coco).returnable_qty, 6, 'oil still returnable');
  near(inv.returned_total, 1980, 'returns on invoice');
  near(inv.profit.revenue, 2970, 'net sale after return');
  near(inv.profit.cost, 3500, 'only restocked cost comes off');

  await assert.rejects(api.post(`/sales/${s.id}/returns`, { items: [{ sale_item_id: lineOf(inv, box).id, qty: 10 }] }), /can still be returned/);
  await assert.rejects(api.post(`/sales/${s.id}/cancel`), /Cancel the return first/);

  // return 2: everything left, back to stock -> the rest of the discount, exactly
  const r2r = await api.post(`/sales/${s.id}/returns`, { items: [
    { sale_item_id: lineOf(inv, box).id, qty: 9 }, { sale_item_id: lineOf(inv, coco).id, qty: 6 },
  ] });
  near(r2r.total, 3300 - 330, 'the rest of the invoice');
  const ret2 = await api.get(`/returns/${r2r.id}`);
  near(ret2.cost_restocked, 4 * 50 + 5 * 60 + 6 * 300, 'remaining batches and tank cost');
  boxItem = await api.get(`/items/${box}`);
  near(boxItem.stock, 20, 'all boxes back');
  cocoItem = await api.get(`/items/${coco}`);
  near(cocoItem.stock, 96, '90 + 6');
  near(cocoItem.unit_cost, 300, 'tank average unchanged');
  assert.equal(cocoItem.movements[0].type, 'sale_return');
  inv = await api.get(`/sales/${s.id}`);
  near(inv.profit.revenue, 0, 'all returned');
  near(inv.profit.cost, 1200, 'damaged oil remains a loss');
  await assert.rejects(api.post(`/sales/${s.id}/returns`, { items: [{ sale_item_id: lineOf(inv, box).id, qty: 1 }] }), /can still be returned/);

  const list = await api.get('/returns');
  assert.ok(list.rows.some((x) => x.id === r1.id) && list.rows.some((x) => x.id === r2r.id));

  // books
  const pnlLines = db.prepare(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id WHERE e.ref_type = 'sale_return' AND e.ref_id = ?`).all(r1.id);
  near(pnlLines.filter((l) => l.code === '4000').reduce((t, l) => t + l.debit, 0), 1980, 'sales reduced');
  near(pnlLines.filter((l) => l.code === '5250').reduce((t, l) => t + l.debit, 0), 1200, 'damaged goods to stock loss');
  near(pnlLines.filter((l) => l.code === '1210').reduce((t, l) => t + l.debit, 0), 300, 'goods stock back');
  let sv = await api.get('/reports/stock-valuation');
  near(sv.raw.register, sv.raw.books, 'raw register = books after returns');
  near(sv.goods.register, sv.goods.books, 'goods register = books after returns');

  // a box sold again cannot be "un-returned"
  const s2 = await api.post('/sales', { customer_id: cus, items: [{ item_id: box, qty: 20, unit_price: 100 }] });
  await assert.rejects(api.post(`/returns/${r2r.id}/cancel`), /already been sold again/);
  await api.post(`/sales/${s2.id}/cancel`);

  // cancel both returns, then the invoice
  await api.post(`/returns/${r2r.id}/cancel`);
  await api.post(`/returns/${r1.id}/cancel`);
  near((await api.get(`/items/${box}`)).stock, 5, 'returned boxes left stock again');
  near((await api.get(`/items/${coco}`)).stock, 90, 'oil back out of the tank');
  near((await api.get(`/parties/${cus}`)).balance, 4950, 'customer account restored');
  await api.post(`/sales/${s.id}/cancel`);
  near((await api.get(`/items/${box}`)).stock, 20, 'invoice cancelled');
  sv = await api.get('/reports/stock-valuation');
  near(sv.raw.register, sv.raw.books, 'raw register = books');
  near(sv.goods.register, sv.goods.books, 'goods register = books');
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, 'books balance');

  const staff = await startClient(createApp(), { username: 'worker1', password: 'secret12' });
  await assert.rejects(staff.post(`/sales/${s2.id}/returns`, { items: [] }), /permission|403|allowed/i);
  const seen = await staff.get(`/returns/${r1.id}`);
  assert.equal(seen.cost_damaged, undefined, 'no cost for staff');
  await staff.close();
});

test('opening stock can be corrected later (qty and price) until it is used; books and tank average follow', async () => {
  const sup = (await api.post('/parties', { type: 'supplier', name: 'Opening Fix Supplier' })).id;
  const cus = (await api.post('/parties', { type: 'customer', name: 'Opening Fix Shop' })).id;
  // raw: opening entered with a wrong price, then a purchase on top
  const tallow = (await api.post('/items', { kind: 'raw', name: 'Tallow Fix', unit: 'kg', opening_qty: 100, opening_cost: 50 })).id;
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: tallow, qty: 100, unit_cost: 300 }] });
  let it = await api.get(`/items/${tallow}`);
  near(it.unit_cost, 175, 'avg with the wrong opening price');
  assert.equal(it.opening_entries.length, 1);
  assert.equal(it.opening_entries[0].can_edit_cost, true);
  await api.put(`/items/${tallow}/opening/${it.opening_entries[0].id}`, { qty: 120, unit_cost: 280 });
  it = await api.get(`/items/${tallow}`);
  near(it.stock, 220, 'tank qty corrected');
  near(it.unit_cost, (120 * 280 + 100 * 300) / 220, 'average replayed with the corrected opening');
  near(it.opening_entries[0].value, 33600, 'opening value');
  let sv = await api.get('/reports/stock-valuation');
  near(sv.raw.register, sv.raw.books, 'raw register = books after correction');
  // once the tank is used after it, the opening entry is locked
  await api.post('/sales', { customer_id: cus, items: [{ item_id: tallow, qty: 10, unit_price: 400 }] });
  it = await api.get(`/items/${tallow}`);
  assert.equal(it.opening_entries[0].can_edit, false);
  await assert.rejects(api.put(`/items/${tallow}/opening/${it.opening_entries[0].id}`, { qty: 130, unit_cost: 280 }), /locked/);

  // goods: opening batch, free to edit until something is sold from it
  const wrap = (await api.post('/items', { kind: 'trading', name: 'Wrapper Fix', unit: 'pcs', opening_qty: 50, opening_cost: 10 })).id;
  let w = await api.get(`/items/${wrap}`);
  const op = w.opening_entries[0];
  await api.put(`/items/${wrap}/opening/${op.id}`, { qty: 60, unit_cost: 12 });
  w = await api.get(`/items/${wrap}`);
  near(w.stock, 60, 'batch qty corrected'); near(w.value, 720, 'batch value corrected');
  await api.post('/sales', { customer_id: cus, items: [{ item_id: wrap, qty: 25, unit_price: 20 }] });
  w = await api.get(`/items/${wrap}`);
  assert.equal(w.opening_entries[0].can_edit_cost, false, 'price locked after a sale');
  near(w.opening_entries[0].min_qty, 25, 'cannot go below what was sold');
  await assert.rejects(api.put(`/items/${wrap}/opening/${op.id}`, { qty: 60, unit_cost: 15 }), /price is locked/);
  await assert.rejects(api.put(`/items/${wrap}/opening/${op.id}`, { qty: 20, unit_cost: 12 }), /cannot be less/);
  await api.put(`/items/${wrap}/opening/${op.id}`, { qty: 40, unit_cost: 12 });
  w = await api.get(`/items/${wrap}`);
  near(w.stock, 15, '40 - 25 sold');
  sv = await api.get('/reports/stock-valuation');
  near(sv.goods.register, sv.goods.books, 'goods register = books after correction');
  const tb = await api.get('/reports/trial-balance');
  near(tb.total_debit, tb.total_credit, 'books balance');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE ref_type = 'opening_stock' AND ref_id = ?").get(op.id).c, 1, 'one journal per opening entry');
});

test('edit item form corrects the opening stock together with the item details', async () => {
  const id = (await api.post('/items', { kind: 'finished', name: 'Rose Soap Fix', unit: 'pcs', sale_price: 120, opening_qty: 500, opening_cost: 40 })).id;
  let it = await api.get(`/items/${id}`);
  // same form, wrong numbers fixed + new name, saved in one go
  await api.put(`/items/${id}`, { name: 'Rose Soap 100g', sale_price: 130, opening_qty: 450, opening_cost: 45 });
  it = await api.get(`/items/${id}`);
  assert.equal(it.name, 'Rose Soap 100g'); near(it.sale_price, 130, 'price saved');
  near(it.stock, 450, 'opening qty corrected'); near(it.opening_entries[0].unit_cost, 45, 'opening cost corrected');
  // saving details without the stock fields leaves stock alone
  await api.put(`/items/${id}`, { reorder_level: 50 });
  near((await api.get(`/items/${id}`)).stock, 450, 'stock untouched');
  // a refused correction rolls back the whole save
  const cus = (await api.post('/parties', { type: 'customer', name: 'Rose Buyer' })).id;
  await api.post('/sales', { customer_id: cus, items: [{ item_id: id, qty: 100, unit_price: 130 }] });
  await assert.rejects(api.put(`/items/${id}`, { name: 'Renamed', opening_qty: 450, opening_cost: 50 }), /price is locked/);
  it = await api.get(`/items/${id}`);
  assert.equal(it.name, 'Rose Soap 100g', 'nothing saved when the stock correction is refused');
  await api.put(`/items/${id}`, { opening_qty: 480, opening_cost: 45 });
  near((await api.get(`/items/${id}`)).stock, 380, 'qty still correctable after a sale');
  // an item created without opening stock can get it from the edit form
  const id2 = (await api.post('/items', { kind: 'trading', name: 'Late Opening', unit: 'pcs' })).id;
  await api.put(`/items/${id2}`, { opening_qty: 30, opening_cost: 20 });
  it = await api.get(`/items/${id2}`);
  near(it.stock, 30, 'opening added'); near(it.value, 600, 'value');
  const sv = await api.get('/reports/stock-valuation');
  near(sv.goods.register, sv.goods.books, 'goods register = books');
});

test('make a batch with its own ingredients, and the next batch starts from the last one', async () => {
  const sup = (await api.post('/parties', { type: 'supplier', name: 'Mix Supplier' })).id;
  const coco = (await api.post('/items', { kind: 'raw', name: 'Coconut Oil', unit: 'kg' })).id;
  const soda = (await api.post('/items', { kind: 'raw', name: 'Soda Ash', unit: 'kg' })).id;
  const bar = (await api.post('/items', { kind: 'finished', name: 'Coco Bar', unit: 'pcs' })).id;
  await api.post('/purchases', { supplier_id: sup, items: [{ item_id: coco, qty: 100, unit_cost: 300 }, { item_id: soda, qty: 50, unit_cost: 80 }] });

  // never made, no saved recipe: an empty start
  let start = await api.get(`/production/start?product_id=${bar}`);
  assert.equal(start.lines.length, 0);
  assert.equal(start.source, null);

  // a product that only has an old saved recipe starts from it
  start = await api.get(`/production/start?product_id=${ids.soap}`);
  assert.equal(start.source.type, 'last_batch', 'Soap was made before');

  const mix = [{ item_id: coco, qty: 40 }, { item_id: soda, qty: 6.5 }];
  await assert.rejects(api.post('/production', { product_id: bar, items: mix }), /quantity made/);
  await assert.rejects(api.post('/production', { product_id: bar, items: [...mix, { item_id: coco, qty: 1 }], qty_produced: 10 }), /listed twice/);
  await assert.rejects(api.post('/production', { product_id: bar, items: [{ item_id: coco, qty: 101 }], qty_produced: 10 }), /Not enough raw material/);
  await assert.rejects(api.post('/production', { product_id: bar, items: [], qty_produced: 10 }), /at least one ingredient/);
  await assert.rejects(api.post('/production', { product_id: coco, items: mix, qty_produced: 10 }), /finished product/);

  const pv = await api.post('/production/preview', { product_id: bar, items: mix });
  assert.ok(pv.can_produce);
  near(pv.est_material_cost, 40 * 300 + 6.5 * 80, 'preview cost');

  const b = await api.post('/production', { product_id: bar, items: mix, qty_produced: 250, other_cost: 480 });
  near(b.material_cost, 12520, 'material cost'); // 12000 + 520
  near(b.unit_cost, (12520 + 480) / 250, 'unit cost');
  const row = db.prepare('SELECT recipe_id, runs FROM production_batches WHERE id = ?').get(b.id);
  assert.equal(row.recipe_id, null);
  assert.equal(row.runs, 1);
  near((await api.get(`/items/${coco}`)).stock, 60, 'coconut left');
  near((await api.get(`/items/${soda}`)).stock, 43.5, 'soda left');
  near((await api.get(`/items/${bar}`)).stock, 250, 'bars in stock');
  const t = await api.get(`/trace/lot/${b.lot_id}`);
  assert.equal(t.materials.length, 2, 'both ingredients traced');

  // next time: the same ingredients and quantities come back, ready to change
  start = await api.get(`/production/start?product_id=${bar}`);
  assert.equal(start.source.type, 'last_batch');
  assert.equal(start.source.batch_no, b.batch_no);
  assert.deepEqual(start.lines.map((l) => [l.item_id, l.need]), [[coco, 40], [soda, 6.5]]);
  assert.equal(start.expected_qty, 250);
  near(start.lines[0].available, 60, 'live stock shown');

  // a different recipe this time: less coconut, no soda
  const b2 = await api.post('/production', { product_id: bar, items: [{ item_id: coco, qty: 30 }], qty_produced: 180 });
  near(b2.material_cost, 9000, 'second mix cost');
  start = await api.get(`/production/start?product_id=${bar}`);
  assert.deepEqual(start.lines.map((l) => [l.item_id, l.need]), [[coco, 30]]);

  // cancelling the latest batch falls back to the one before
  await api.post(`/production/${b2.id}/cancel`);
  start = await api.get(`/production/start?product_id=${bar}`);
  assert.equal(start.source.batch_no, b.batch_no);
});

test('online safety: starting password refused over the internet, login limit per real visitor', async () => {
  const base = api.base;
  const login = (headers, password = 'admin123') => fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password }),
  });
  // on the factory network the starting password still works (to change it)
  assert.equal((await login({})).status, 200);
  // through Cloudflare it is refused
  const r = await login({ 'cf-connecting-ip': '203.0.113.7', 'cf-visitor': '{"scheme":"https"}' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /starting password/);
  // the cookie is marked secure when the visitor is on https
  await api.post('/users', { username: 'online1', full_name: 'Online', role: 'staff', password: 'strongpass1' });
  const ok = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.8', 'cf-visitor': '{"scheme":"https"}' }, body: JSON.stringify({ username: 'online1', password: 'strongpass1' }) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /Secure/i);
  // one visitor guessing passwords is blocked without locking out another visitor
  for (let i = 0; i < 10; i++) await login({ 'cf-connecting-ip': '198.51.100.9' }, 'wrong-' + i);
  assert.equal((await login({ 'cf-connecting-ip': '198.51.100.9' }, 'x')).status, 429);
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.10' }, body: JSON.stringify({ username: 'online1', password: 'strongpass1' }) })).status, 200);
});

test('data file: download everything, restore it, and get exactly the same books back', async () => {
  const snapshot = () => ({
    items: db.prepare('SELECT id, name, stock_qty, avg_cost, active FROM items ORDER BY id').all(),
    lots: db.prepare('SELECT id, qty_remaining, unit_cost FROM stock_lots ORDER BY id').all(),
    tb: db.prepare('SELECT account_id, ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM journal_lines GROUP BY account_id ORDER BY account_id').all(),
    years: db.prepare('SELECT id, status FROM financial_years ORDER BY id').all(),
    seq: db.prepare('SELECT * FROM sequences ORDER BY name').all(),
    stamped: db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE fiscal_year_id IS NULL').get().n,
  });
  const before = snapshot();
  assert.equal((await fetch(`${api.base}/backup`)).status, 401, 'not without logging in');
  const dump = await api.get('/backup');
  assert.equal(dump.format, 'soap-factory-erp-data');
  assert.ok(!('sessions' in dump.tables), 'logins are never in the file');
  assert.ok(dump.tables.items.rows.length > 0);

  // change something after the download
  await api.post('/items', { kind: 'raw', name: 'After Backup Item', unit: 'kg' });
  assert.ok(db.prepare("SELECT 1 FROM items WHERE name = 'After Backup Item'").get());

  // a wrong file is refused and nothing changes
  await assert.rejects(api.post('/backup/restore', { format: 'x' }), /not a data file/);
  await assert.rejects(api.post('/backup/restore', { ...dump, schema_version: 999 }), /newer version/);
  assert.ok(db.prepare("SELECT 1 FROM items WHERE name = 'After Backup Item'").get(), 'untouched after a refused file');

  const r = await api.post('/backup/restore', dump);
  assert.ok(r.relogin);
  assert.deepEqual(snapshot(), before, 'identical books after restore');
  assert.ok(!db.prepare("SELECT 1 FROM items WHERE name = 'After Backup Item'").get(), 'later change undone');
  // year locks are back in force
  const closed = db.prepare("SELECT * FROM financial_years WHERE status = 'closed' LIMIT 1").get();
  if (closed) assert.throws(() => db.prepare('INSERT INTO expenses(date, category_id, amount) VALUES (?, 1, 1)').run(closed.start_date), /FY_CLOSED/);
  // everyone has to log in again; the same password still works
  await assert.rejects(api.get('/items'), /401/);
  await api.close();
  api = await startClient(createApp());
  assert.ok((await api.get('/items')).length > 0);
  // non-admins cannot download or restore
  await api.post('/users', { username: 'clerk9', full_name: 'Clerk', role: 'manager', password: 'clerkpass9' });
  const clerk = await startClient(createApp(), { username: 'clerk9', password: 'clerkpass9' });
  await assert.rejects(clerk.get('/backup'), /403/);
  await assert.rejects(clerk.post('/backup/restore', dump), /403/);
  await clerk.close();
  // setup is closed on a system that is in use
  assert.equal((await api.get('/setup/status')).fresh, false);
  await assert.rejects(api.post('/setup/restore', { password: 'whatever123' }), /already set up/);
});

test('one phone number belongs to only one customer and only one supplier', async () => {
  const a = (await api.post('/parties', { type: 'customer', name: 'Phone Shop A', phone: '0300-1112233' })).id;
  // the same number written differently is still refused
  for (const phone of ['03001112233', '+92 300 1112233', '923001112233', '0092-300-111-2233']) {
    await assert.rejects(api.post('/parties', { type: 'customer', name: 'Phone Shop B', phone }), /already saved for the customer "Phone Shop A"/);
  }
  // a supplier may share a customer's number (the same person can buy and sell)
  const s1 = (await api.post('/parties', { type: 'supplier', name: 'Phone Supplier 1', phone: '0300 1112233' })).id;
  await assert.rejects(api.post('/parties', { type: 'supplier', name: 'Phone Supplier 2', phone: '+923001112233' }), /already saved for the supplier "Phone Supplier 1"/);
  // editing: moving onto a taken number is refused; keeping your own number is fine
  const b = (await api.post('/parties', { type: 'customer', name: 'Phone Shop C', phone: '0311-0000001' })).id;
  await assert.rejects(api.put(`/parties/${b}`, { phone: '0300-1112233' }), /already saved/);
  await api.put(`/parties/${a}`, { name: 'Phone Shop A (Main)', phone: '0300-1112233' });
  // no number, or the same blank number, never clashes
  await api.post('/parties', { type: 'customer', name: 'No Phone 1' });
  await api.post('/parties', { type: 'customer', name: 'No Phone 2', phone: '' });
  // an old pair that already shares a number can still be edited (name, address)
  const d1 = db.prepare("INSERT INTO parties(type, name, phone) VALUES ('customer', 'Old Dup 1', '0399-7654321') RETURNING id").get().id;
  const d2 = db.prepare("INSERT INTO parties(type, name, phone) VALUES ('customer', 'Old Dup 2', '0399-7654321') RETURNING id").get().id;
  await api.put(`/parties/${d2}`, { name: 'Old Dup 2 renamed', address: 'Kamra' });
  assert.equal(db.prepare('SELECT name FROM parties WHERE id = ?').get(d2).name, 'Old Dup 2 renamed');
  assert.ok(d1 && s1);
});
