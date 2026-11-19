// Purchases, sales, customers & suppliers
import { Router } from 'express';
import { db, tx, r2, r3, nextNo, audit, getSettings, today } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { getItem, assertUsable, stockIn, consumeLots, restoreLots, voidLot, reverseReceiptAvg, issueAvg, receiveAvg, tankComposition, EPS } from '../inventory.js';
import { post, reverseRef, ACC, stockAccountFor, resolveFund, partyBalance, accId, METHODS } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';
import { returnsOfSale, returnedLines } from './returns.js';

const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };

/**
 * Shared list filter for invoices / purchase bills.
 *  ?month=YYYY-MM | ?from&to,  ?method=cash|bank_transfer|cheque|credit
 * "credit" = nothing paid at the time of the document.
 */
function docListFilter(q, alias, refType, direction, where, args) {
  if (/^\d{4}-\d{2}$/.test(q.month || '')) { where.push(`${alias}.date BETWEEN ? AND ?`); args.push(`${q.month}-01`, monthEnd(q.month)); }
  if (q.from) { where.push(`${alias}.date >= ?`); args.push(q.from); }
  if (q.to) { where.push(`${alias}.date <= ?`); args.push(q.to); }
  if (q.method === 'credit') where.push(`${alias}.paid = 0`);
  else if (METHODS.includes(q.method)) {
    where.push(`EXISTS (SELECT 1 FROM fund_transactions f WHERE f.ref_type = '${refType}' AND f.ref_id = ${alias}.id AND f.direction = '${direction}' AND f.method = ?)`);
    args.push(q.method);
  }
}
const methodOf = (alias, refType, direction) => `(SELECT f.method FROM fund_transactions f WHERE f.ref_type = '${refType}' AND f.ref_id = ${alias}.id AND f.direction = '${direction}' ORDER BY f.id LIMIT 1)`;
function docSummary(rows) {
  const active = rows.filter((x) => x.status === 'active');
  const by = Object.fromEntries(METHODS.map((m) => [m, 0]));
  for (const x of active) if (x.payment_method && by[x.payment_method] !== undefined) by[x.payment_method] = r2(by[x.payment_method] + x.paid);
  const total = r2(active.reduce((s, x) => s + x.total, 0));
  const paid = r2(active.reduce((s, x) => s + x.paid, 0));
  return { count: active.length, total, paid, unpaid: r2(total - paid), by_method: by };
}
const fundRowsFor = (refType, id) => db.prepare(`SELECT f.*, a.name AS account_name FROM fund_transactions f JOIN accounts a ON a.id = f.account_id
  WHERE f.ref_type IN (?, ?, ?) AND f.ref_id = ? ORDER BY f.id`).all(refType, `${refType}_cancel`, `${refType}_bounce`, id);

const r = Router();

function getParty(id, type) {
  const p = db.prepare('SELECT * FROM parties WHERE id = ?').get(Number(id));
  if (!p || (type && p.type !== type)) throw bad(type === 'supplier' ? 'Choose a supplier' : 'Choose a customer');
  return p;
}

// =====================================================================
//  PURCHASES  (raw materials and trading goods)
// =====================================================================
r.get('/purchases', requireRole('manager'), (req, res) => {
  const where = [], args = [];
  if (req.query.supplier_id) { where.push('pu.supplier_id = ?'); args.push(Number(req.query.supplier_id)); }
  docListFilter(req.query, 'pu', 'purchase', 'out', where, args);
  const rows = db.prepare(`SELECT pu.*, p.name AS supplier_name, ${methodOf('pu', 'purchase', 'out')} AS payment_method,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = pu.id) AS lines
    FROM purchases pu JOIN parties p ON p.id = pu.supplier_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pu.date DESC, pu.id DESC LIMIT 500`).all(...args);
  res.json({ rows, summary: docSummary(rows) });
});

r.get('/purchases/:id', requireRole('manager'), (req, res) => {
  const pu = db.prepare(`SELECT pu.*, p.name AS supplier_name, p.phone AS supplier_phone, p.address AS supplier_address
    FROM purchases pu JOIN parties p ON p.id = pu.supplier_id WHERE pu.id = ?`).get(Number(req.params.id));
  if (!pu) throw notFound('Purchase');
  pu.payments = fundRowsFor('purchase', pu.id);
  pu.items = db.prepare(`SELECT pi.*, i.name, i.unit, i.kind, i.container, l.lot_code FROM purchase_items pi
    JOIN items i ON i.id = pi.item_id LEFT JOIN stock_lots l ON l.id = pi.lot_id WHERE pi.purchase_id = ?`).all(pu.id);
  res.json(pu);
});

/**
 * Record a purchase bill.
 *  - raw material lines are added to their tank and the weighted average is recalculated
 *  - trading-goods lines become a traceable lot tagged with the supplier
 *  - Dr Stock / Cr Supplier (Payable); if paid now: Dr Supplier / Cr Cash
 */
r.post('/purchases', requireRole('manager'), (req, res) => {
  const supplier = getParty(req.body.supplier_id, 'supplier');
  const d = date(req.body.date);
  assertOpenDate(d, 'A purchase');
  const lines = (req.body.items || []).filter((l) => l.item_id);
  if (!lines.length) throw bad('Add at least one item');
  const parsed = lines.map((l) => {
    const item = assertUsable(getItem(l.item_id));
    if (item.kind === 'finished') throw bad(`"${item.name}" is made in the factory — record it through Production`);
    const qty = num(l.qty, `quantity for ${item.name}`);
    const unit_cost = num(l.unit_cost, `rate for ${item.name}`, { allowZero: true });
    return { item, qty: r3(qty), unit_cost, amount: r2(qty * unit_cost) };
  });
  const total = r2(parsed.reduce((s, l) => s + l.amount, 0));
  const paid = r2(Number(req.body.paid) || 0);
  if (paid < 0 || paid > total + 0.001) throw bad('Paid amount cannot be more than the bill total');
  const pay = paid > 0 ? resolveFund(req.body) : null;
  const payAcc = pay?.account ?? null;

  const result = tx(() => {
    const no = nextNo('PUR');
    const { id } = db.prepare(`INSERT INTO purchases(purchase_no, supplier_id, supplier_bill_no, date, total, paid, pay_account_id, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(no, supplier.id, req.body.supplier_bill_no || null, d, total, paid, payAcc, req.body.notes || null, req.user.id);
    const insLine = db.prepare('INSERT INTO purchase_items(purchase_id, item_id, qty, unit_cost, amount) VALUES (?,?,?,?,?) RETURNING id');
    const byAccount = {};
    for (const l of parsed) {
      const line = insLine.get(id, l.item.id, l.qty, l.unit_cost, l.amount);
      // raw -> poured into the tank (re-averages cost); trading -> new traceable lot
      const st = stockIn({
        item: l.item, qty: l.qty, unit_cost: l.unit_cost, date: d, type: 'purchase',
        ref_type: 'purchase', ref_id: id, supplier_id: supplier.id, source_type: 'purchase', source_id: line.id,
      });
      db.prepare('UPDATE purchase_items SET movement_id = ?, lot_id = ? WHERE id = ?').run(st.movement_id, st.lot_id, line.id);
      const acc = stockAccountFor(l.item.kind);
      byAccount[acc] = (byAccount[acc] || 0) + l.amount;
    }
    post({
      date: d, memo: `Purchase ${no} from ${supplier.name}`, ref_type: 'purchase', ref_id: id, user_id: req.user.id,
      lines: [
        ...Object.entries(byAccount).map(([account, amt]) => ({ account, debit: amt })),
        { account: ACC.PAYABLE, party_id: supplier.id, credit: total },
      ],
    });
    if (paid > 0) {
      post({
        date: d, memo: `Paid on purchase ${no}`, ref_type: 'purchase', ref_id: id, user_id: req.user.id, payment: pay.meta,
        lines: [
          { account: ACC.PAYABLE, party_id: supplier.id, debit: paid },
          { account: payAcc, credit: paid },
        ],
      });
    }
    return { id, purchase_no: no };
  });
  audit(req.user.id, 'create', 'purchase', result.id, { total });
  res.json(result);
});

r.post('/purchases/:id/cancel', requireRole('manager'), (req, res) => {
  const pu = db.prepare('SELECT * FROM purchases WHERE id = ?').get(Number(req.params.id));
  if (!pu) throw notFound('Purchase');
  if (pu.status === 'cancelled') throw bad('Already cancelled');
  assertOpenDate(pu.date, 'This purchase');
  const d = date(req.body?.date);
  tx(() => {
    for (const l of db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(pu.id)) {
      if (l.lot_id) voidLot(l.lot_id, { date: d, movement_type: 'purchase_cancel', ref_type: 'purchase', ref_id: pu.id });
      else reverseReceiptAvg({ item_id: l.item_id, qty: l.qty, unit_cost: l.unit_cost, date: d, ref_type: 'purchase', ref_id: pu.id });
    }
    reverseRef('purchase', pu.id, { date: d, memo: `Cancelled purchase ${pu.purchase_no}`, user_id: req.user.id });
    db.prepare("UPDATE purchases SET status = 'cancelled' WHERE id = ?").run(pu.id);
  });
  audit(req.user.id, 'cancel', 'purchase', pu.id);
  res.json({ ok: true });
});

// =====================================================================
//  SALES & INVOICES
// =====================================================================
r.get('/sales', (req, res) => {
  const where = [], args = [];
  if (req.query.customer_id) { where.push('s.customer_id = ?'); args.push(Number(req.query.customer_id)); }
  docListFilter(req.query, 's', 'sale', 'in', where, args);
  const rows = db.prepare(`SELECT s.*, p.name AS customer_name, ${methodOf('s', 'sale', 'in')} AS payment_method
    FROM sales s JOIN parties p ON p.id = s.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.date DESC, s.id DESC LIMIT 500`).all(...args);
  res.json({ rows, summary: docSummary(rows) });
});

r.get('/sales/:id', (req, res) => {
  const s = db.prepare(`SELECT s.*, p.name AS customer_name, p.phone AS customer_phone, p.address AS customer_address,
      a.name AS pay_account_name, u.full_name AS created_by_name
    FROM sales s JOIN parties p ON p.id = s.customer_id
    LEFT JOIN accounts a ON a.id = s.pay_account_id LEFT JOIN users u ON u.id = s.created_by
    WHERE s.id = ?`).get(Number(req.params.id));
  if (!s) throw notFound('Invoice');
  s.items = db.prepare(`SELECT si.*, i.name, i.unit, i.kind, i.container FROM sale_items si JOIN items i ON i.id = si.item_id WHERE si.sale_id = ?`).all(s.id);
  for (const it of s.items) {
    it.batches = db.prepare(`SELECT sa.qty, sa.lot_id, l.lot_code FROM sale_allocations sa JOIN stock_lots l ON l.id = sa.lot_id
      WHERE sa.sale_item_id = ?`).all(it.id);
    if (it.kind === 'raw') {
      it.sources = db.prepare(`SELECT sms.qty, sms.share_pct, sms.purchase_id, pu.purchase_no, sp.name AS supplier_name
        FROM sale_material_sources sms LEFT JOIN purchases pu ON pu.id = sms.purchase_id LEFT JOIN parties sp ON sp.id = sms.supplier_id
        WHERE sms.sale_item_id = ? ORDER BY sms.share_pct DESC`).all(it.id);
    }
  }
  s.customer_balance = partyBalance(getParty(s.customer_id));
  s.payments = fundRowsFor('sale', s.id);
  // goods brought back against this invoice
  const back = returnedLines(s.id);
  for (const it of s.items) {
    it.returned_qty = back[it.id]?.qty || 0;
    it.returnable_qty = r3(Math.max(0, it.qty - it.returned_qty));
  }
  s.returns = returnsOfSale(s.id);
  const activeReturns = s.returns.filter((x) => x.status === 'active');
  s.returned_total = r2(activeReturns.reduce((t, x) => t + x.total, 0));
  if (req.user.role === 'staff') {
    // staff do not see costs or profit
    delete s.cost_total;
    for (const it of s.items) delete it.cost;
    for (const x of s.returns) { delete x.cost_restocked; delete x.cost_damaged; }
  } else {
    // internal only (never printed): profit = invoice total after discount − cost of the goods that left stock,
    // after returns: returned sales come off, and only goods put back into stock come off the cost (damaged returns are a loss)
    const revenue = r2(s.total - s.returned_total);
    const cost = r2(s.cost_total - activeReturns.reduce((t, x) => t + x.cost_restocked, 0));
    const profit = r2(revenue - cost);
    s.profit = {
      revenue, cost, discount: s.discount, profit, returned: s.returned_total,
      margin_pct: revenue > 0 ? r2((profit / revenue) * 100) : null,
      lines: s.items.map((it) => {
        const rev = r2(it.amount - (back[it.id]?.amount || 0));
        const c = r2(it.cost - (back[it.id]?.restocked || 0));
        return { id: it.id, name: it.name, revenue: rev, cost: c, profit: r2(rev - c), margin_pct: rev > 0 ? r2(((rev - c) / rev) * 100) : null };
      }),
    };
  }
  s.company = getSettings();
  res.json(s);
});

/**
 * Create a sales invoice.
 *  - goods are invoiced from stock: oldest batch first (or a chosen batch), recorded in sale_allocations
 *  - raw materials can be sold too: they leave the tank at the weighted average cost, and the
 *    supplier deliveries in the tank at that moment are recorded in sale_material_sources
 *  - Dr Customer / Cr Sales;  Dr Cost of Goods Sold / Cr Finished Goods Stock (or Raw Material Stock)
 *  - if received now: Dr Cash / Cr Customer
 */
r.post('/sales', requireRole('staff'), (req, res) => {
  const customer = getParty(req.body.customer_id, 'customer');
  const d = date(req.body.date);
  assertOpenDate(d, 'An invoice');
  const lines = (req.body.items || []).filter((l) => l.item_id);
  if (!lines.length) throw bad('Add at least one product');
  const parsed = lines.map((l) => {
    const item = assertUsable(getItem(l.item_id));
    const qty = num(l.qty, `quantity for ${item.name}`);
    const unit_price = num(l.unit_price, `price for ${item.name}`, { allowZero: true });
    return { item, qty: r3(qty), unit_price, amount: r2(qty * unit_price), lot_id: l.lot_id ? Number(l.lot_id) : null };
  });
  const subtotal = r2(parsed.reduce((s, l) => s + l.amount, 0));
  const discount = r2(Number(req.body.discount) || 0);
  if (discount < 0 || discount > subtotal) throw bad('Discount is not valid');
  const total = r2(subtotal - discount);
  const paid = r2(Number(req.body.paid) || 0);
  if (paid < 0 || paid > total + 0.001) throw bad('Received amount cannot be more than the invoice total');
  const pay = paid > 0 ? resolveFund(req.body) : null;
  const payAcc = pay?.account ?? null;

  const result = tx(() => {
    const no = nextNo('INV');
    const { id } = db.prepare(`INSERT INTO sales(invoice_no, customer_id, date, subtotal, discount, total, paid, pay_account_id, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(no, customer.id, d, subtotal, discount, total, paid, payAcc, req.body.notes || null, req.user.id);
    const insLine = db.prepare('INSERT INTO sale_items(sale_id, item_id, qty, unit_price, amount, cost) VALUES (?,?,?,?,?,0) RETURNING id');
    const insAlloc = db.prepare('INSERT INTO sale_allocations(sale_item_id, lot_id, qty, unit_cost) VALUES (?,?,?,?)');
    const insSrc = db.prepare(`INSERT INTO sale_material_sources(sale_item_id, receipt_movement_id, purchase_id, supplier_id, qty, share_pct)
      VALUES (?,?,?,?,?,?)`);
    const costBy = { [ACC.FG_STOCK]: 0, [ACC.RAW_STOCK]: 0 };
    for (const l of parsed) {
      const line = insLine.get(id, l.item.id, l.qty, l.unit_price, l.amount);
      let cost;
      if (l.item.kind === 'raw') {
        // straight out of the tank at the weighted average cost
        const comp = tankComposition(l.item.id);
        ({ cost } = issueAvg({ item_id: l.item.id, qty: l.qty, date: d, type: 'sale', ref_type: 'sale', ref_id: id, party_id: customer.id }));
        if (comp.total > EPS) {
          for (const part of comp.parts) {
            const share = part.qty / comp.total;
            if (share < 0.005) continue;
            insSrc.run(line.id, part.receipt_movement_id, part.ref_type === 'purchase' ? part.ref_id : null,
              part.supplier_id, r3(l.qty * share), r2(share * 100));
          }
        }
        costBy[ACC.RAW_STOCK] += cost;
      } else {
        const out = consumeLots({ item_id: l.item.id, qty: l.qty, date: d, movement_type: 'sale', ref_type: 'sale', ref_id: id, preferLotId: l.lot_id });
        for (const t of out.takes) insAlloc.run(line.id, t.lot_id, t.qty, t.unit_cost);
        cost = out.cost;
        costBy[ACC.FG_STOCK] += cost;
      }
      db.prepare('UPDATE sale_items SET cost = ? WHERE id = ?').run(cost, line.id);
    }
    const fgCost = r2(costBy[ACC.FG_STOCK]), rawCost = r2(costBy[ACC.RAW_STOCK]);
    const costTotal = r2(fgCost + rawCost);
    db.prepare('UPDATE sales SET cost_total = ? WHERE id = ?').run(costTotal, id);

    post({
      date: d, memo: `Invoice ${no} to ${customer.name}`, ref_type: 'sale', ref_id: id, user_id: req.user.id,
      lines: [
        { account: ACC.RECEIVABLE, party_id: customer.id, debit: total },
        { account: ACC.SALES, credit: total },
        { account: ACC.COGS, debit: costTotal },
        ...(fgCost ? [{ account: ACC.FG_STOCK, credit: fgCost }] : []),
        ...(rawCost ? [{ account: ACC.RAW_STOCK, credit: rawCost }] : []),
      ],
    });
    if (paid > 0) {
      post({
        date: d, memo: `Received on invoice ${no}`, ref_type: 'sale', ref_id: id, user_id: req.user.id, payment: pay.meta,
        lines: [
          { account: payAcc, debit: paid },
          { account: ACC.RECEIVABLE, party_id: customer.id, credit: paid },
        ],
      });
    }
    return { id, invoice_no: no };
  });
  audit(req.user.id, 'create', 'sale', result.id, { total });
  res.json(result);
});

r.post('/sales/:id/cancel', requireRole('manager'), (req, res) => {
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(req.params.id));
  if (!s) throw notFound('Invoice');
  if (s.status === 'cancelled') throw bad('Already cancelled');
  assertOpenDate(s.date, 'This invoice');
  const open = db.prepare("SELECT return_no FROM sale_returns WHERE sale_id = ? AND status = 'active'").all(s.id).map((x) => x.return_no);
  if (open.length) throw bad(`This invoice has returns (${open.join(', ')}). Cancel the return first, then the invoice.`);
  const d = date(req.body?.date);
  tx(() => {
    const allocs = db.prepare(`SELECT si.item_id, sa.lot_id, sa.qty, sa.unit_cost FROM sale_allocations sa
      JOIN sale_items si ON si.id = sa.sale_item_id WHERE si.sale_id = ?`).all(s.id);
    restoreLots(allocs, { date: d, movement_type: 'sale_cancel', ref_type: 'sale', ref_id: s.id });
    // raw material goes back into its tank at the cost it left with
    const rawLines = db.prepare(`SELECT si.item_id, si.qty, si.cost FROM sale_items si JOIN items i ON i.id = si.item_id
      WHERE si.sale_id = ? AND i.kind = 'raw'`).all(s.id);
    for (const l of rawLines) {
      receiveAvg({ item_id: l.item_id, qty: l.qty, unit_cost: l.qty > 0 ? l.cost / l.qty : 0, date: d,
        type: 'sale_cancel', ref_type: 'sale', ref_id: s.id, note: `Returned: invoice ${s.invoice_no} cancelled` });
    }
    reverseRef('sale', s.id, { date: d, memo: `Cancelled invoice ${s.invoice_no}`, user_id: req.user.id });
    db.prepare("UPDATE sales SET status = 'cancelled' WHERE id = ?").run(s.id);
  });
  audit(req.user.id, 'cancel', 'sale', s.id);
  res.json({ ok: true });
});

// =====================================================================
//  CUSTOMERS & SUPPLIERS (ledgers)
// =====================================================================
r.get('/parties', (req, res) => {
  const type = req.query.type === 'supplier' ? 'supplier' : 'customer';
  if (type === 'supplier' && req.user.role === 'staff') return res.status(403).json({ error: 'No permission' });
  const acc = accId(type === 'customer' ? ACC.RECEIVABLE : ACC.PAYABLE);
  const sign = type === 'customer' ? 1 : -1;
  const rows = db.prepare(`SELECT p.*,
      COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.party_id = p.id AND jl.account_id = ? AND je.date <= ?), 0) * ? AS balance
    FROM parties p WHERE p.type = ? AND p.active = 1 ORDER BY p.name`).all(acc, req.asOf || today(), sign, type);
  res.json(rows.map((p) => ({ ...p, balance: r2(p.balance) })));
});

r.post('/parties', requireRole('staff'), (req, res) => {
  const type = req.body.type === 'supplier' ? 'supplier' : 'customer';
  if (type === 'supplier' && req.user.role === 'staff') throw bad('No permission');
  const name = required(req.body.name, 'Name');
  const opening = r2(Number(req.body.opening_balance) || 0);
  const id = tx(() => {
    const { id } = db.prepare('INSERT INTO parties(type, name, phone, address, notes) VALUES (?,?,?,?,?) RETURNING id')
      .get(type, name, req.body.phone || null, req.body.address || null, req.body.notes || null);
    if (opening !== 0) {
      // Positive opening = customer owes us / we owe the supplier
      const amt = Math.abs(opening);
      const ctrl = type === 'customer' ? ACC.RECEIVABLE : ACC.PAYABLE;
      const partyDebit = (type === 'customer') === (opening > 0);
      post({
        date: date(req.body.opening_date), memo: `Opening balance: ${name}`, ref_type: 'opening', ref_id: id, user_id: req.user.id,
        lines: [
          { account: ctrl, party_id: id, debit: partyDebit ? amt : 0, credit: partyDebit ? 0 : amt },
          { account: ACC.OPENING, debit: partyDebit ? 0 : amt, credit: partyDebit ? amt : 0 },
        ],
      });
    }
    return id;
  });
  audit(req.user.id, 'create', 'party', id, { type, name });
  res.json({ id });
});

r.put('/parties/:id', requireRole('manager'), (req, res) => {
  const p = getParty(req.params.id);
  db.prepare('UPDATE parties SET name=?, phone=?, address=?, notes=? WHERE id=?')
    .run(required(req.body.name ?? p.name, 'Name'), req.body.phone ?? p.phone, req.body.address ?? p.address, req.body.notes ?? p.notes, p.id);
  res.json({ ok: true });
});

/** Party ledger: every debit/credit with a running balance. */
r.get('/parties/:id', requireRole('staff'), (req, res) => {
  const p = getParty(req.params.id);
  if (p.type === 'supplier' && req.user.role === 'staff') throw bad('No permission');
  const acc = accId(p.type === 'customer' ? ACC.RECEIVABLE : ACC.PAYABLE);
  const fyStart = req.fy?.start_date || '0000-01-01';
  const asOf = req.asOf || today();
  const rows = db.prepare(`SELECT je.id AS entry_id, je.date, je.memo, je.ref_type, je.ref_id, jl.debit, jl.credit,
      f.id AS fund_id, f.method, f.cheque_no, f.reference, f.bank_name, f.cheque_status, fa.name AS fund_account
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    LEFT JOIN fund_transactions f ON f.entry_id = je.id LEFT JOIN accounts fa ON fa.id = f.account_id
    WHERE jl.party_id = ? AND jl.account_id = ? AND je.date BETWEEN ? AND ? ORDER BY je.date, je.id`).all(p.id, acc, fyStart, asOf);
  const sign = p.type === 'customer' ? 1 : -1;
  // balance brought forward from earlier years
  const opening = r2(sign * db.prepare(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.party_id = ? AND jl.account_id = ? AND je.date < ?`).get(p.id, acc, fyStart).b);
  let run = opening;
  const ledger = rows.map((row) => {
    run = r2(run + (row.debit - row.credit) * sign);
    return { ...row, balance: run };
  });
  const docs = p.type === 'customer'
    ? db.prepare("SELECT id, invoice_no AS no, date, total, paid, status FROM sales WHERE customer_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 100").all(p.id, fyStart, asOf)
    : db.prepare("SELECT id, purchase_no AS no, date, total, paid, status FROM purchases WHERE supplier_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 100").all(p.id, fyStart, asOf);
  res.json({ ...p, opening_balance: opening, period: { from: fyStart, to: asOf }, balance: run, ledger, docs });
});

/**
 * Money received from a customer, or paid to a supplier, by Cash / Bank transfer / Cheque.
 * Customer: Dr Cash|Bank / Cr Receivable.  Supplier: Dr Payable / Cr Cash|Bank.
 */
r.post('/parties/:id/payment', requireRole('manager'), (req, res) => {
  const p = getParty(req.params.id);
  const amount = r2(num(req.body.amount, 'amount'));
  const pay = resolveFund(req.body);
  const cash = pay.account;
  const d = date(req.body.date);
  const note = req.body.note ? ` — ${req.body.note}` : '';
  const id = tx(() => post({
    date: d, ref_type: 'payment', ref_id: p.id, user_id: req.user.id, payment: pay.meta,
    memo: p.type === 'customer' ? `Received from ${p.name}${note}` : `Paid to ${p.name}${note}`,
    lines: p.type === 'customer'
      ? [{ account: cash, debit: amount }, { account: ACC.RECEIVABLE, party_id: p.id, credit: amount }]
      : [{ account: ACC.PAYABLE, party_id: p.id, debit: amount }, { account: cash, credit: amount }],
  }));
  audit(req.user.id, 'payment', 'party', p.id, { amount });
  res.json({ entry_id: id, balance: partyBalance(p) });
});

export default r;
