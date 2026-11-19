// Sales returns (credit notes): goods a customer brings back against an invoice
import { Router } from 'express';
import { db, tx, r2, r3, nextNo, audit, getSettings } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, notFound } from '../errors.js';
import { getItem, assertUsable, restoreLots, unrestoreLots, receiveAvg, reverseReceiptAvg, EPS } from '../inventory.js';
import { post, reverseRef, ACC, resolveFund, partyBalance } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';

const r = Router();
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };

/** Quantity already returned per invoice line (active returns only). */
export function returnedQtyBySaleItem(saleId) {
  return Object.fromEntries(db.prepare(`SELECT sri.sale_item_id, SUM(sri.qty) q FROM sale_return_items sri
    JOIN sale_returns sr ON sr.id = sri.return_id WHERE sr.sale_id = ? AND sr.status = 'active' GROUP BY sri.sale_item_id`)
    .all(saleId).map((x) => [x.sale_item_id, r3(x.q)]));
}

/** Returns booked against an invoice, newest first. */
export function returnsOfSale(saleId) {
  return db.prepare(`SELECT id, return_no, date, subtotal, discount, total, refund, cost_restocked, cost_damaged, status, reason
    FROM sale_returns WHERE sale_id = ? ORDER BY date DESC, id DESC`).all(saleId);
}

/** Per invoice line, what is returned so far: qty, amount (before discount) and the cost that went back into stock. */
export function returnedLines(saleId) {
  return Object.fromEntries(db.prepare(`SELECT sri.sale_item_id, SUM(sri.qty) qty, SUM(sri.amount) amount,
      SUM(CASE WHEN sri.restock = 1 THEN sri.cost ELSE 0 END) restocked
    FROM sale_return_items sri JOIN sale_returns sr ON sr.id = sri.return_id
    WHERE sr.sale_id = ? AND sr.status = 'active' GROUP BY sri.sale_item_id`).all(saleId)
    .map((x) => [x.sale_item_id, { qty: r3(x.qty), amount: r2(x.amount), restocked: r2(x.restocked) }]));
}

// ---------------------------------------------------------------------
r.get('/returns', (req, res) => {
  const where = [], args = [];
  if (/^\d{4}-\d{2}$/.test(req.query.month || '')) { where.push('sr.date BETWEEN ? AND ?'); args.push(`${req.query.month}-01`, monthEnd(req.query.month)); }
  if (req.query.customer_id) { where.push('sr.customer_id = ?'); args.push(Number(req.query.customer_id)); }
  const rows = db.prepare(`SELECT sr.*, p.name AS customer_name, s.invoice_no,
      (SELECT COUNT(*) FROM sale_return_items WHERE return_id = sr.id) AS lines
    FROM sale_returns sr JOIN parties p ON p.id = sr.customer_id JOIN sales s ON s.id = sr.sale_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sr.date DESC, sr.id DESC LIMIT 500`).all(...args);
  if (req.user.role === 'staff') for (const x of rows) { delete x.cost_restocked; delete x.cost_damaged; }
  const active = rows.filter((x) => x.status === 'active');
  res.json({
    rows,
    summary: { count: active.length, total: r2(active.reduce((s, x) => s + x.total, 0)), refunded: r2(active.reduce((s, x) => s + x.refund, 0)) },
  });
});

r.get('/returns/:id', (req, res) => {
  const ret = db.prepare(`SELECT sr.*, p.name AS customer_name, p.phone AS customer_phone, p.address AS customer_address,
      s.invoice_no, s.date AS invoice_date, a.name AS refund_account_name, u.full_name AS created_by_name
    FROM sale_returns sr JOIN parties p ON p.id = sr.customer_id JOIN sales s ON s.id = sr.sale_id
    LEFT JOIN accounts a ON a.id = sr.refund_account_id LEFT JOIN users u ON u.id = sr.created_by WHERE sr.id = ?`).get(Number(req.params.id));
  if (!ret) throw notFound('Return');
  ret.items = db.prepare(`SELECT sri.*, i.name, i.unit, i.kind, i.container FROM sale_return_items sri JOIN items i ON i.id = sri.item_id
    WHERE sri.return_id = ? ORDER BY sri.id`).all(ret.id);
  for (const it of ret.items) {
    it.batches = db.prepare(`SELECT sra.qty, sra.lot_id, l.lot_code FROM sale_return_allocations sra JOIN stock_lots l ON l.id = sra.lot_id
      WHERE sra.return_item_id = ?`).all(it.id);
  }
  ret.payments = db.prepare(`SELECT f.*, a.name AS account_name FROM fund_transactions f JOIN accounts a ON a.id = f.account_id
    WHERE f.ref_type IN ('sale_return', 'sale_return_cancel') AND f.ref_id = ? ORDER BY f.id`).all(ret.id);
  ret.customer_balance = partyBalance(db.prepare('SELECT * FROM parties WHERE id = ?').get(ret.customer_id));
  if (req.user.role === 'staff') {
    delete ret.cost_restocked; delete ret.cost_damaged;
    for (const it of ret.items) delete it.cost;
  }
  ret.company = getSettings();
  res.json(ret);
});

/**
 * Book a return against an invoice.
 *  body: { date, reason, items: [{ sale_item_id, qty, restock: true|false }], refund, payment_method, account_id, … }
 *
 *  - "Back to stock" lines go back into the same batches they were shipped from
 *    (raw material back into its tank at the cost it left with).
 *  - "Damaged" lines do not come back into stock; their cost is moved to Stock Loss.
 *  - The customer is credited at the invoice rate, less their share of any invoice discount.
 *
 *  Journal:  Dr Sales / Cr Customer (credit)
 *            Dr Finished Goods or Raw Material Stock (restocked cost), Dr Stock Loss (damaged cost) / Cr Cost of Goods Sold
 *            refund now: Dr Customer / Cr Cash|Bank
 */
r.post('/sales/:id/returns', requireRole('manager'), (req, res) => {
  const sale = db.prepare('SELECT s.*, p.name AS customer_name FROM sales s JOIN parties p ON p.id = s.customer_id WHERE s.id = ?').get(Number(req.params.id));
  if (!sale) throw notFound('Invoice');
  if (sale.status === 'cancelled') throw bad('This invoice is cancelled — there is nothing to return');
  const d = date(req.body.date);
  if (d < sale.date) throw bad(`The return date cannot be before the invoice date (${sale.date})`);
  assertOpenDate(d, 'A return');

  const saleItems = Object.fromEntries(db.prepare(`SELECT si.*, i.name, i.kind, i.unit FROM sale_items si JOIN items i ON i.id = si.item_id
    WHERE si.sale_id = ?`).all(sale.id).map((x) => [x.id, x]));
  const already = returnedQtyBySaleItem(sale.id);
  const seen = new Set();
  const lines = (req.body.items || []).filter((l) => l.sale_item_id && Number(l.qty) > 0).map((l) => {
    const si = saleItems[Number(l.sale_item_id)];
    if (!si) throw bad('This item is not on the invoice');
    if (seen.has(si.id)) throw bad(`"${si.name}" is listed twice`);
    seen.add(si.id);
    const qty = r3(num(l.qty, `quantity for ${si.name}`));
    const left = r3(si.qty - (already[si.id] || 0));
    if (qty > left + EPS) throw bad(`Only ${left} ${si.unit} of "${si.name}" can still be returned on this invoice`);
    const restock = l.restock !== false && l.restock !== 0 && l.restock !== '0';
    if (restock) assertUsable(getItem(si.item_id));
    return { si, qty, restock, amount: r2(qty * si.unit_price) };
  });
  if (!lines.length) throw bad('Enter the quantity being returned for at least one item');

  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  // the customer gets back what they actually paid per unit: invoice rate less their share of the invoice discount
  const prev = db.prepare("SELECT COALESCE(SUM(subtotal),0) sub, COALESCE(SUM(discount),0) disc FROM sale_returns WHERE sale_id = ? AND status = 'active'").get(sale.id);
  const allBack = Object.values(saleItems).every((si) => {
    const l = lines.find((x) => x.si.id === si.id);
    return (already[si.id] || 0) + (l ? l.qty : 0) >= si.qty - EPS;
  });
  const discount = sale.discount > 0
    ? (allBack ? r2(sale.discount - prev.disc) : r2(subtotal * (sale.discount / sale.subtotal)))
    : 0;
  const total = r2(subtotal - discount);
  const refund = r2(Number(req.body.refund) || 0);
  if (refund < 0 || refund > total + 0.001) throw bad('Money paid back cannot be more than the return total');
  const pay = refund > 0 ? resolveFund(req.body) : null;
  const reason = String(req.body.reason || '').trim().slice(0, 300) || null;

  const result = tx(() => {
    const no = nextNo('RET');
    const { id } = db.prepare(`INSERT INTO sale_returns(return_no, sale_id, customer_id, date, subtotal, discount, total, refund, refund_account_id, reason, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
      .get(no, sale.id, sale.customer_id, d, subtotal, discount, total, refund, pay?.account ?? null, reason, req.user.id);
    const insLine = db.prepare(`INSERT INTO sale_return_items(return_id, sale_item_id, item_id, qty, unit_price, amount, cost, restock)
      VALUES (?,?,?,?,?,?,0,?) RETURNING id`);
    const insAlloc = db.prepare('INSERT INTO sale_return_allocations(return_item_id, lot_id, qty, unit_cost) VALUES (?,?,?,?)');
    const note = `Returned by ${sale.customer_name} (invoice ${sale.invoice_no})`;
    const back = { [ACC.FG_STOCK]: 0, [ACC.RAW_STOCK]: 0 };
    let damaged = 0;

    for (const l of lines) {
      const line = insLine.get(id, l.si.id, l.si.item_id, l.qty, l.si.unit_price, l.amount, l.restock ? 1 : 0);
      let cost = 0;
      if (l.si.kind === 'raw') {
        // back into the tank at the cost it left with
        const unit = l.si.qty > 0 ? l.si.cost / l.si.qty : 0;
        cost = r2(l.qty * unit);
        if (l.restock) receiveAvg({ item_id: l.si.item_id, qty: l.qty, unit_cost: unit, date: d, type: 'sale_return', ref_type: 'sale_return', ref_id: id, note });
      } else {
        // back into the batches it was shipped from (whatever of each batch is not yet returned)
        const allocs = db.prepare('SELECT lot_id, qty, unit_cost FROM sale_allocations WHERE sale_item_id = ? ORDER BY id').all(l.si.id);
        const backBy = Object.fromEntries(db.prepare(`SELECT sra.lot_id, SUM(sra.qty) q FROM sale_return_allocations sra
          JOIN sale_return_items sri ON sri.id = sra.return_item_id JOIN sale_returns sr ON sr.id = sri.return_id
          WHERE sri.sale_item_id = ? AND sr.status = 'active' AND sri.return_id <> ? GROUP BY sra.lot_id`).all(l.si.id, id).map((x) => [x.lot_id, x.q]));
        const takes = [];
        let left = l.qty;
        for (const a of allocs) {
          if (left <= EPS) break;
          const free = r3(a.qty - (backBy[a.lot_id] || 0));
          if (free <= EPS) continue;
          const take = r3(Math.min(left, free));
          backBy[a.lot_id] = (backBy[a.lot_id] || 0) + take;
          takes.push({ item_id: l.si.item_id, lot_id: a.lot_id, qty: take, unit_cost: a.unit_cost });
          left = r3(left - take);
        }
        if (left > EPS) throw bad(`Could not match the returned "${l.si.name}" to its batches`);
        for (const t of takes) insAlloc.run(line.id, t.lot_id, t.qty, t.unit_cost);
        cost = r2(takes.reduce((s, t) => s + t.qty * t.unit_cost, 0));
        if (l.restock) restoreLots(takes, { date: d, movement_type: 'sale_return', ref_type: 'sale_return', ref_id: id, party_id: sale.customer_id, note });
      }
      db.prepare('UPDATE sale_return_items SET cost = ? WHERE id = ?').run(cost, line.id);
      if (l.restock) back[l.si.kind === 'raw' ? ACC.RAW_STOCK : ACC.FG_STOCK] += cost;
      else damaged += cost;
    }
    const fg = r2(back[ACC.FG_STOCK]), raw = r2(back[ACC.RAW_STOCK]);
    damaged = r2(damaged);
    db.prepare('UPDATE sale_returns SET cost_restocked = ?, cost_damaged = ? WHERE id = ?').run(r2(fg + raw), damaged, id);

    post({
      date: d, memo: `Return ${no} from ${sale.customer_name} (invoice ${sale.invoice_no})`, ref_type: 'sale_return', ref_id: id, user_id: req.user.id,
      lines: [
        { account: ACC.SALES, debit: total },
        { account: ACC.RECEIVABLE, party_id: sale.customer_id, credit: total },
        ...(fg ? [{ account: ACC.FG_STOCK, debit: fg }] : []),
        ...(raw ? [{ account: ACC.RAW_STOCK, debit: raw }] : []),
        ...(damaged ? [{ account: ACC.STOCK_LOSS, debit: damaged }] : []),
        { account: ACC.COGS, credit: r2(fg + raw + damaged) },
      ],
    });
    if (refund > 0) {
      post({
        date: d, memo: `Money paid back on return ${no} to ${sale.customer_name}`, ref_type: 'sale_return', ref_id: id, user_id: req.user.id, payment: pay.meta,
        lines: [
          { account: ACC.RECEIVABLE, party_id: sale.customer_id, debit: refund },
          { account: pay.account, credit: refund },
        ],
      });
    }
    return { id, return_no: no, total };
  });
  audit(req.user.id, 'create', 'sale_return', result.id, { sale_id: sale.id, total });
  res.json(result);
});

/** Cancel a return: the goods leave stock again and the customer's account is reversed. */
r.post('/returns/:id/cancel', requireRole('manager'), (req, res) => {
  const ret = db.prepare('SELECT * FROM sale_returns WHERE id = ?').get(Number(req.params.id));
  if (!ret) throw notFound('Return');
  if (ret.status === 'cancelled') throw bad('Already cancelled');
  assertOpenDate(ret.date, 'This return');
  const d = date(req.body?.date);
  tx(() => {
    const lines = db.prepare(`SELECT sri.*, i.kind FROM sale_return_items sri JOIN items i ON i.id = sri.item_id
      WHERE sri.return_id = ? AND sri.restock = 1`).all(ret.id);
    for (const l of lines) {
      if (l.kind === 'raw') {
        reverseReceiptAvg({ item_id: l.item_id, qty: l.qty, unit_cost: l.qty > 0 ? l.cost / l.qty : 0, date: d,
          ref_type: 'sale_return', ref_id: ret.id, what: 'this return' });
      } else {
        const takes = db.prepare('SELECT lot_id, qty, unit_cost FROM sale_return_allocations WHERE return_item_id = ?').all(l.id)
          .map((t) => ({ ...t, item_id: l.item_id }));
        unrestoreLots(takes, { date: d, movement_type: 'sale_return_cancel', ref_type: 'sale_return', ref_id: ret.id });
      }
    }
    reverseRef('sale_return', ret.id, { date: d, memo: `Cancelled return ${ret.return_no}`, user_id: req.user.id });
    db.prepare("UPDATE sale_returns SET status = 'cancelled' WHERE id = ?").run(ret.id);
  });
  audit(req.user.id, 'cancel', 'sale_return', ret.id);
  res.json({ ok: true });
});

export default r;
