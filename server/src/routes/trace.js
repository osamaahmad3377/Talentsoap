// End-to-end product traceability
import { Router } from 'express';
import { db, r2, r3 } from '../db.js';
import { notFound } from '../errors.js';

const r = Router();

const payType = (s) => (s.paid >= s.total - 0.005 ? 'Cash' : s.paid > 0 ? 'Partial' : 'Credit');

/** Search anything traceable: batch / lot code, invoice, purchase. */
r.get('/trace/search', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q.length < 3) return res.json([]);
  const lots = db.prepare(`SELECT l.id, l.lot_code, l.date, i.name FROM stock_lots l JOIN items i ON i.id = l.item_id
    WHERE l.lot_code LIKE ? OR i.name LIKE ? ORDER BY l.id DESC LIMIT 15`).all(q, q)
    .map((x) => ({ kind: 'batch', id: x.id, title: x.lot_code, sub: `${x.name} · ${x.date}`, link: `/trace/lot/${x.id}` }));
  const inv = req.user.role === 'staff' ? [] : db.prepare(`SELECT s.id, s.invoice_no, s.date, p.name FROM sales s JOIN parties p ON p.id = s.customer_id
    WHERE s.invoice_no LIKE ? OR p.name LIKE ? ORDER BY s.id DESC LIMIT 10`).all(q, q)
    .map((x) => ({ kind: 'invoice', id: x.id, title: x.invoice_no, sub: `${x.name} · ${x.date}`, link: `/sales/${x.id}` }));
  const pur = req.user.role === 'staff' ? [] : db.prepare(`SELECT pu.id, pu.purchase_no, pu.date, p.name FROM purchases pu JOIN parties p ON p.id = pu.supplier_id
    WHERE pu.purchase_no LIKE ? OR pu.supplier_bill_no LIKE ? OR p.name LIKE ? ORDER BY pu.id DESC LIMIT 10`).all(q, q, q)
    .map((x) => ({ kind: 'purchase', id: x.id, title: x.purchase_no, sub: `${x.name} · ${x.date}`, link: `/trace/purchase/${x.id}` }));
  res.json([...lots, ...inv, ...pur]);
});

/** Customers who received goods from a lot. */
function salesOfLot(lotId) {
  return db.prepare(`
    SELECT s.id AS sale_id, s.invoice_no, s.date, s.status, s.total, s.paid, p.id AS customer_id, p.name AS customer_name,
      sa.qty, si.unit_price, ROUND(sa.qty * si.unit_price, 2) AS amount, sa.unit_cost,
      COALESCE((SELECT SUM(sra.qty) FROM sale_return_allocations sra JOIN sale_return_items sri ON sri.id = sra.return_item_id
        JOIN sale_returns sr ON sr.id = sri.return_id WHERE sra.lot_id = sa.lot_id AND sri.sale_item_id = si.id AND sr.status = 'active'), 0) AS returned_qty
    FROM sale_allocations sa JOIN sale_items si ON si.id = sa.sale_item_id JOIN sales s ON s.id = si.sale_id
    JOIN parties p ON p.id = s.customer_id
    WHERE sa.lot_id = ? ORDER BY s.date, s.id`).all(lotId)
    .map((x) => ({ ...x, payment: payType(x) }));
}

/**
 * Full history of one finished-goods batch (or trading lot):
 * batch facts -> raw materials at weighted avg cost -> supplier deliveries in
 * the tanks -> every invoice that shipped units from this batch.
 */
r.get('/trace/lot/:id', (req, res) => {
  const lot = db.prepare(`SELECT l.*, i.name AS item_name, i.unit, i.kind, i.sale_price, p.name AS supplier_name
    FROM stock_lots l JOIN items i ON i.id = l.item_id LEFT JOIN parties p ON p.id = l.supplier_id WHERE l.id = ?`).get(Number(req.params.id));
  if (!lot) throw notFound('Batch');
  const showMoney = req.user.role !== 'staff';
  const out = { lot, origin: lot.source_type };

  if (lot.source_type === 'production') {
    out.batch = db.prepare(`SELECT b.*, rc.name AS recipe_name, u.full_name AS made_by FROM production_batches b
      LEFT JOIN recipes rc ON rc.id = b.recipe_id LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?`).get(lot.source_id);
    const srcStmt = db.prepare(`
      SELECT s.qty, s.share_pct, s.purchase_id, pu.purchase_no, pu.supplier_bill_no, m.date AS received_date, m.unit_cost AS purchase_rate,
        m.type AS receipt_type, sp.id AS supplier_id, sp.name AS supplier_name
      FROM production_material_sources s JOIN stock_movements m ON m.id = s.receipt_movement_id
      LEFT JOIN purchases pu ON pu.id = s.purchase_id LEFT JOIN parties sp ON sp.id = s.supplier_id
      WHERE s.consumption_id = ? ORDER BY s.share_pct DESC`);
    out.materials = db.prepare(`SELECT pc.*, i.name, i.unit, i.category, i.container FROM production_consumption pc
      JOIN items i ON i.id = pc.item_id WHERE pc.batch_id = ? ORDER BY pc.amount DESC`).all(lot.source_id)
      .map((m) => ({ ...m, sources: srcStmt.all(m.id) }));
    out.suppliers = [...new Map(out.materials.flatMap((m) => m.sources).filter((s) => s.supplier_id)
      .map((s) => [s.supplier_id, { id: s.supplier_id, name: s.supplier_name }])).values()];
  } else if (lot.source_type === 'purchase') {
    out.purchase = db.prepare(`SELECT pu.id, pu.purchase_no, pu.supplier_bill_no, pu.date, pi.qty, pi.unit_cost, pi.amount, p.name AS supplier_name, p.id AS supplier_id
      FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN parties p ON p.id = pu.supplier_id WHERE pi.id = ?`).get(lot.source_id);
  }

  const sales = salesOfLot(lot.id);
  const active = sales.filter((s) => s.status === 'active');
  // net of goods customers brought back
  const soldQty = r3(active.reduce((s, x) => s + x.qty - x.returned_qty, 0));
  const revenue = r2(active.reduce((s, x) => s + (x.qty - x.returned_qty) * x.unit_price, 0));
  const cost = r2(active.reduce((s, x) => s + (x.qty - x.returned_qty) * x.unit_cost, 0));
  out.sales = sales;
  out.summary = {
    qty_in: lot.qty_in, sold: soldQty, remaining: r3(lot.qty_remaining),
    customers: new Set(active.map((s) => s.customer_id)).size,
    revenue, cost_of_sold: cost, profit: r2(revenue - cost),
  };

  if (!showMoney) {
    // staff can follow the trail but not see prices
    for (const m of out.materials || []) { delete m.avg_cost; delete m.amount; for (const s of m.sources) delete s.purchase_rate; }
    for (const s of out.sales) { delete s.unit_price; delete s.amount; delete s.unit_cost; delete s.total; delete s.paid; }
    if (out.batch) for (const k of ['material_cost', 'other_cost', 'total_cost', 'unit_cost']) delete out.batch[k];
    if (out.purchase) { delete out.purchase.unit_cost; delete out.purchase.amount; }
    out.lot.unit_cost = undefined;
    out.summary = { qty_in: lot.qty_in, sold: soldQty, remaining: r3(lot.qty_remaining), customers: out.summary.customers };
  }
  res.json(out);
});

/**
 * Forward trace / product recall: a supplier delivery -> batches it went
 * into -> customers who received those batches.
 */
r.get('/trace/purchase/:id', (req, res) => {
  const pu = db.prepare(`SELECT pu.*, p.name AS supplier_name FROM purchases pu JOIN parties p ON p.id = pu.supplier_id WHERE pu.id = ?`)
    .get(Number(req.params.id));
  if (!pu) throw notFound('Purchase');
  const lines = db.prepare(`SELECT pi.*, i.name, i.unit, i.kind, i.container, l.lot_code FROM purchase_items pi
    JOIN items i ON i.id = pi.item_id LEFT JOIN stock_lots l ON l.id = pi.lot_id WHERE pi.purchase_id = ?`).all(pu.id);
  for (const line of lines) {
    if (line.lot_id) {
      line.sales = salesOfLot(line.lot_id); // trading goods: sold straight from this lot
    } else {
      line.batches = db.prepare(`
        SELECT b.id, b.batch_no, b.date, b.status, b.lot_id, i.name AS product_name, i.unit AS product_unit,
          s.qty AS qty_used, s.share_pct
        FROM production_material_sources s JOIN production_consumption pc ON pc.id = s.consumption_id
        JOIN production_batches b ON b.id = pc.batch_id JOIN items i ON i.id = b.product_id
        WHERE s.receipt_movement_id = ? ORDER BY b.date, b.id`).all(line.movement_id)
        .map((b) => ({ ...b, sales: salesOfLot(b.lot_id) }));
      // raw material sold to customers straight from the tank
      line.direct_sales = db.prepare(`
        SELECT s.id AS sale_id, s.invoice_no, s.date, s.status, s.total, s.paid, p.id AS customer_id, p.name AS customer_name,
          sms.qty, sms.share_pct, si.unit_price
        FROM sale_material_sources sms JOIN sale_items si ON si.id = sms.sale_item_id JOIN sales s ON s.id = si.sale_id
        JOIN parties p ON p.id = s.customer_id
        WHERE sms.receipt_movement_id = ? ORDER BY s.date, s.id`).all(line.movement_id)
        .map((x) => ({ ...x, payment: payType(x) }));
    }
  }
  const customers = new Map();
  for (const l of lines) for (const s of [...(l.sales || []), ...(l.direct_sales || []), ...(l.batches || []).flatMap((b) => b.sales)]) {
    if (s.status === 'active') customers.set(s.customer_id, s.customer_name);
  }
  const payments = req.user.role === 'staff' ? [] : db.prepare(`SELECT f.*, a.name AS account_name FROM fund_transactions f JOIN accounts a ON a.id = f.account_id
    WHERE f.ref_type IN ('purchase', 'purchase_cancel', 'purchase_bounce') AND f.ref_id = ? ORDER BY f.id`).all(pu.id);
  res.json({ purchase: pu, lines, payments, customers: [...customers].map(([id, name]) => ({ id, name })) });
});

export default r;
