/**
 * Inventory engine
 *
 *  RAW materials  -> weighted average (one running balance per tank)
 *     receive: new_avg = (old_qty*old_avg + qty*cost) / (old_qty + qty)
 *     issue  : leaves at the current avg; avg does not change
 *
 *  FINISHED / TRADING goods -> batches (stock_lots), shipped oldest batch
 *     first unless a specific batch is chosen.
 *
 * All functions here must run inside a db transaction (see tx()).
 */
import { db, r2, r3, nextNo } from './db.js';
import { bad } from './errors.js';

export const EPS = 0.000001;
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

export function getItem(id) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!item) throw bad('Item not found');
  return item;
}

export const isAvg = (item) => item.kind === 'raw';

/** Deleted items stay on old documents but cannot be used on new ones. */
export function assertUsable(item) {
  if (!item.active) throw bad(`"${item.name}" was deleted. Restore it from Stock → Deleted items to use it again.`);
  return item;
}

export function stockOf(itemOrId) {
  const item = typeof itemOrId === 'object' ? itemOrId : getItem(itemOrId);
  if (isAvg(item)) return r3(db.prepare('SELECT stock_qty FROM items WHERE id = ?').get(item.id).stock_qty);
  return r3(db.prepare('SELECT COALESCE(SUM(qty_remaining),0) s FROM stock_lots WHERE item_id = ?').get(item.id).s);
}

const insMove = () => db.prepare(`INSERT INTO stock_movements
  (item_id, lot_id, date, qty, unit_cost, value, qty_after, avg_cost_after, type, ref_type, ref_id, party_id, note)
  VALUES (@item_id, @lot_id, @date, @qty, @unit_cost, @value, @qty_after, @avg_cost_after, @type, @ref_type, @ref_id, @party_id, @note)
  RETURNING id`);

// =====================================================================
//  Weighted average (raw materials / tanks)
// =====================================================================

/** Add material to the tank and recalculate the moving average cost. */
export function receiveAvg({ item_id, qty, unit_cost, date, type, ref_type = null, ref_id = null, party_id = null, note = null }) {
  const item = getItem(item_id);
  const oldQty = Math.max(0, item.stock_qty);
  const newQty = r6(oldQty + qty);
  const newAvg = newQty > EPS ? r6((oldQty * item.avg_cost + qty * unit_cost) / newQty) : unit_cost;
  db.prepare('UPDATE items SET stock_qty = ?, avg_cost = ? WHERE id = ?').run(newQty, newAvg, item.id);
  const { id } = insMove().get({
    item_id: item.id, lot_id: null, date, qty: r6(qty), unit_cost, value: r2(qty * unit_cost),
    qty_after: newQty, avg_cost_after: newAvg, type, ref_type, ref_id, party_id, note,
  });
  return { movement_id: id, avg_cost: newAvg };
}

/** Take material out of the tank at the current weighted average cost. */
export function issueAvg({ item_id, qty, date, type, ref_type = null, ref_id = null, party_id = null, note = null }) {
  const item = getItem(item_id);
  const need = r6(qty);
  if (item.stock_qty + EPS < need) {
    throw bad(`Not enough "${item.name}". Needed ${r3(need)} ${item.unit}, in stock ${r3(item.stock_qty)} ${item.unit}.`);
  }
  let newQty = r6(item.stock_qty - need);
  if (newQty < EPS) newQty = 0;
  db.prepare('UPDATE items SET stock_qty = ? WHERE id = ?').run(newQty, item.id);
  const cost = r2(need * item.avg_cost);
  const { id } = insMove().get({
    item_id: item.id, lot_id: null, date, qty: -need, unit_cost: item.avg_cost, value: -cost,
    qty_after: newQty, avg_cost_after: item.avg_cost, type, ref_type, ref_id, party_id, note,
  });
  return { movement_id: id, unit_cost: item.avg_cost, cost };
}

/**
 * Reverse a specific receipt (cancelling a purchase): take the same qty and
 * value back out, so the average returns to what it would have been.
 */
export function reverseReceiptAvg({ item_id, qty, unit_cost, date, ref_type, ref_id, what = 'this purchase' }) {
  const item = getItem(item_id);
  if (item.stock_qty + EPS < qty) {
    throw bad(`Cannot cancel: part of "${item.name}" from ${what} has already been used or sold.`);
  }
  const value = qty * unit_cost;
  let newQty = r6(item.stock_qty - qty);
  let newAvg = item.avg_cost;
  if (newQty < EPS) { newQty = 0; } else {
    newAvg = Math.max(0, r6((item.stock_qty * item.avg_cost - value) / newQty));
  }
  db.prepare('UPDATE items SET stock_qty = ?, avg_cost = ? WHERE id = ?').run(newQty, newAvg, item.id);
  insMove().get({
    item_id: item.id, lot_id: null, date, qty: -r6(qty), unit_cost, value: -r2(value),
    qty_after: newQty, avg_cost_after: newAvg, type: `${ref_type}_cancel`, ref_type, ref_id, party_id: null, note: 'Cancelled',
  });
}

/**
 * What is physically in the tank right now, broken down by delivery.
 *
 * Model: the tank is perfectly mixed. Every receipt adds a contributor;
 * every issue removes the same FRACTION from every contributor. We replay
 * the tank ledger since it was last empty to get each delivery's remaining
 * quantity. Contributors under 0.5% of the tank are merged into "older stock".
 */
export function tankComposition(itemId) {
  const lastEmpty = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM stock_movements
    WHERE item_id = ? AND lot_id IS NULL AND qty_after <= ?`).get(itemId, EPS).id;
  const moves = db.prepare(`SELECT m.id, m.qty, m.type, m.date, m.party_id, m.ref_type, m.ref_id
    FROM stock_movements m WHERE m.item_id = ? AND m.lot_id IS NULL AND m.id > ? ORDER BY m.id`).all(itemId, lastEmpty);

  const parts = new Map(); // receipt movement id -> { qty, ... }
  let total = 0;
  for (const m of moves) {
    if (m.qty > 0) {
      parts.set(m.id, { receipt_movement_id: m.id, qty: m.qty, date: m.date, supplier_id: m.party_id, type: m.type, ref_type: m.ref_type, ref_id: m.ref_id });
      total += m.qty;
    } else if (m.type === 'purchase_cancel') {
      // a cancelled delivery leaves the tank as itself, not as a mixed fraction
      const p = [...parts.values()].find((x) => x.ref_type === 'purchase' && x.ref_id === m.ref_id);
      if (p) { const t = Math.min(p.qty, -m.qty); p.qty -= t; total -= t; }
    } else if (total > EPS) {
      const keep = Math.max(0, 1 + m.qty / total); // m.qty is negative
      for (const p of parts.values()) p.qty *= keep;
      total *= keep;
    }
  }
  return { total, parts: [...parts.values()] };
}

// =====================================================================
//  Batches (finished & trading goods)
// =====================================================================

export function createLot({ item_id, qty, unit_cost, date, source_type, source_id = null, supplier_id = null,
  lot_code = null, movement_type, ref_type = null, ref_id = null, note = null }) {
  const code = lot_code || nextNo(source_type === 'opening' ? 'OP' : 'LOT', 6);
  const lot = db.prepare(`INSERT INTO stock_lots(item_id, lot_code, source_type, source_id, supplier_id, date, qty_in, qty_remaining, unit_cost)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
    .get(item_id, code, source_type, source_id, supplier_id, date, r3(qty), r3(qty), unit_cost);
  const mv = insMove().get({
    item_id, lot_id: lot.id, date, qty: r3(qty), unit_cost, value: r2(qty * unit_cost), qty_after: null, avg_cost_after: null,
    type: movement_type, ref_type, ref_id, party_id: supplier_id, note,
  });
  return { id: lot.id, lot_code: code, movement_id: mv.id };
}

/** Ship goods out of batches: chosen batch first, then oldest first. */
export function consumeLots({ item_id, qty, date, movement_type, ref_type, ref_id, preferLotId = null, note = null }) {
  const item = getItem(item_id);
  const need = r3(qty);
  const available = stockOf(item);
  if (available + EPS < need) {
    throw bad(`Not enough stock of "${item.name}". Needed ${need} ${item.unit}, available ${available} ${item.unit}.`);
  }
  const lots = db.prepare(`SELECT id, qty_remaining, unit_cost FROM stock_lots
    WHERE item_id = ? AND qty_remaining > ? ORDER BY (id = ?) DESC, date, id`).all(item_id, EPS, preferLotId ?? -1);
  const upd = db.prepare('UPDATE stock_lots SET qty_remaining = round(qty_remaining - ?, 6) WHERE id = ?');
  const ins = insMove();
  const takes = [];
  let left = need;
  for (const lot of lots) {
    if (left <= EPS) break;
    const take = r3(Math.min(left, lot.qty_remaining));
    upd.run(take, lot.id);
    ins.get({ item_id, lot_id: lot.id, date, qty: -take, unit_cost: lot.unit_cost, value: -r2(take * lot.unit_cost),
      qty_after: null, avg_cost_after: null, type: movement_type, ref_type, ref_id, party_id: null, note });
    takes.push({ lot_id: lot.id, qty: take, unit_cost: lot.unit_cost });
    left = r3(left - take);
  }
  return { takes, cost: r2(takes.reduce((s, t) => s + t.qty * t.unit_cost, 0)) };
}

/** Put goods back into the batches they came from (cancelling an invoice). */
export function restoreLots(takes, { date, movement_type, ref_type, ref_id, party_id = null, note = 'Cancelled' }) {
  const upd = db.prepare('UPDATE stock_lots SET qty_remaining = round(qty_remaining + ?, 6) WHERE id = ?');
  const ins = insMove();
  for (const t of takes) {
    upd.run(t.qty, t.lot_id);
    ins.get({ item_id: t.item_id, lot_id: t.lot_id, date, qty: t.qty, unit_cost: t.unit_cost, value: r2(t.qty * t.unit_cost),
      qty_after: null, avg_cost_after: null, type: movement_type, ref_type, ref_id, party_id, note });
  }
}

/** Take returned goods back out of specific batches (cancelling a sales return). */
export function unrestoreLots(takes, { date, movement_type, ref_type, ref_id, note = 'Cancelled' }) {
  const upd = db.prepare('UPDATE stock_lots SET qty_remaining = round(qty_remaining - ?, 6) WHERE id = ?');
  const ins = insMove();
  for (const t of takes) {
    const lot = db.prepare('SELECT l.qty_remaining, l.lot_code, i.name FROM stock_lots l JOIN items i ON i.id = l.item_id WHERE l.id = ?').get(t.lot_id);
    if (lot.qty_remaining + EPS < t.qty) {
      throw bad(`Cannot cancel: the returned "${lot.name}" in batch ${lot.lot_code} has already been sold again.`);
    }
    upd.run(t.qty, t.lot_id);
    ins.get({ item_id: t.item_id, lot_id: t.lot_id, date, qty: -t.qty, unit_cost: t.unit_cost, value: -r2(t.qty * t.unit_cost),
      qty_after: null, avg_cost_after: null, type: movement_type, ref_type, ref_id, party_id: null, note });
  }
}

/** Remove an untouched batch entirely (cancel production / trading purchase). */
export function voidLot(lotId, { date, movement_type, ref_type, ref_id }) {
  const lot = db.prepare('SELECT l.*, i.name FROM stock_lots l JOIN items i ON i.id = l.item_id WHERE l.id = ?').get(lotId);
  if (Math.abs(lot.qty_remaining - lot.qty_in) > EPS) {
    throw bad(`Cannot cancel: some of batch ${lot.lot_code} (${lot.name}) has already been sold.`);
  }
  db.prepare('UPDATE stock_lots SET qty_remaining = 0 WHERE id = ?').run(lotId);
  insMove().get({ item_id: lot.item_id, lot_id: lotId, date, qty: -lot.qty_in, unit_cost: lot.unit_cost, value: -r2(lot.qty_in * lot.unit_cost),
    qty_after: null, avg_cost_after: null, type: movement_type, ref_type, ref_id, party_id: null, note: 'Cancelled' });
}

// =====================================================================
//  Generic (dispatch by item kind)
// =====================================================================

/** Stock-in that works for any item: tank receipt for raw, new lot otherwise. */
export function stockIn({ item, qty, unit_cost, date, type, ref_type, ref_id, supplier_id = null, source_type, source_id = null, lot_code = null, note = null }) {
  if (isAvg(item)) {
    const m = receiveAvg({ item_id: item.id, qty, unit_cost, date, type, ref_type, ref_id, party_id: supplier_id, note });
    return { movement_id: m.movement_id, lot_id: null };
  }
  const lot = createLot({ item_id: item.id, qty, unit_cost, date, source_type, source_id, supplier_id, lot_code, movement_type: type, ref_type, ref_id, note });
  return { movement_id: lot.movement_id, lot_id: lot.id, lot_code: lot.lot_code };
}

/** Stock-out that works for any item. Returns total cost at book value. */
export function stockOut({ item, qty, date, type, ref_type, ref_id = null, note = null }) {
  if (isAvg(item)) return issueAvg({ item_id: item.id, qty, date, type, ref_type, ref_id, note });
  return consumeLots({ item_id: item.id, qty, date, movement_type: type, ref_type, ref_id, note });
}

/**
 * Items with stock, value and low-stock flag.
 * asOf (YYYY-MM-DD, earlier than today) gives stock on that date from the movement ledger,
 * e.g. the closing stock of a past financial year.
 */
export function listItemsWithStock(kind, asOf = null) {
  if (asOf && asOf < new Date().toLocaleDateString('en-CA')) {
    const rows = db.prepare(`
      SELECT i.*, c.name AS category_name, COALESCE(SUM(m.qty), 0) AS stock, COALESCE(SUM(m.value), 0) AS value
      FROM items i LEFT JOIN stock_movements m ON m.item_id = i.id AND m.date <= ?
      LEFT JOIN item_categories c ON c.id = i.category_id
      WHERE (? IS NULL OR i.kind = ?) GROUP BY i.id
      -- a deleted item still counts in a past year if it held stock on that date
      HAVING i.active = 1 OR ABS(COALESCE(SUM(m.qty), 0)) > ${EPS}
      ORDER BY i.name`).all(asOf, kind, kind);
    return rows.map((r) => ({
      ...r, stock: r3(r.stock), value: r2(r.value),
      unit_cost: r.stock > EPS ? r2(r.value / r.stock) : 0,
      low: r.reorder_level > 0 && r.stock <= r.reorder_level + EPS, as_of: asOf,
    }));
  }
  const rows = db.prepare(`
    SELECT i.*,
      CASE WHEN i.kind = 'raw' THEN i.stock_qty
           ELSE COALESCE((SELECT SUM(qty_remaining) FROM stock_lots WHERE item_id = i.id), 0) END AS stock,
      CASE WHEN i.kind = 'raw' THEN i.stock_qty * i.avg_cost
           ELSE COALESCE((SELECT SUM(qty_remaining * unit_cost) FROM stock_lots WHERE item_id = i.id), 0) END AS value
      , c.name AS category_name
    FROM items i LEFT JOIN item_categories c ON c.id = i.category_id
    WHERE i.active = 1 ${kind ? 'AND i.kind = ?' : ''}
    ORDER BY i.name`).all(...(kind ? [kind] : []));
  return rows.map((r) => ({
    ...r,
    stock: r3(r.stock),
    value: r2(r.value),
    unit_cost: r.kind === 'raw' ? r2(r.avg_cost) : (r.stock > EPS ? r2(r.value / r.stock) : 0),
    low: r.reorder_level > 0 && r.stock <= r.reorder_level + EPS,
  }));
}
