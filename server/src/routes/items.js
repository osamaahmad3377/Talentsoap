import { Router } from 'express';
import { db, tx, r2, r3, today, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, required, notFound } from '../errors.js';
import { listItemsWithStock, getItem, assertUsable, stockOf, stockIn, stockOut, tankComposition, isAvg, EPS } from '../inventory.js';
import { post, ACC, stockAccountFor } from '../accounting.js';
import { assertOpenDate, fyForDate } from '../fiscal.js';

const r = Router();
const KINDS = ['raw', 'finished', 'trading'];

// ---------- items ---------------------------------------------------
r.get('/items', (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  let rows = listItemsWithStock(kind, req.asOf);
  if (req.query.category_id) rows = rows.filter((i) => i.category_id === Number(req.query.category_id));
  res.json(rows);
});

// ---------- item categories (one list per item type) ---------------------
const LEGACY = { oil: 'Oil', chemical: 'Chemical', fragrance: 'Fragrance', packaging: 'Packaging', soap: 'Soap', other: 'Other' };

r.get('/item-categories', (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.active = 1) AS items
    FROM item_categories c WHERE (? IS NULL OR c.kind = ?) AND (c.active = 1 OR ? = 1)
    ORDER BY c.kind, c.active DESC, (c.name = 'Other'), c.name`).all(kind, kind, req.query.all ? 1 : 0));
});

r.post('/item-categories', requireRole('manager'), (req, res) => {
  const kind = req.body.kind;
  if (!KINDS.includes(kind)) throw bad('Choose the type of item');
  const name = required(req.body.name, 'Category name').slice(0, 60);
  const old = db.prepare('SELECT * FROM item_categories WHERE kind = ? AND name = ?').get(kind, name);
  if (old?.active) throw bad(`"${old.name}" already exists`);
  if (old) { db.prepare('UPDATE item_categories SET active = 1 WHERE id = ?').run(old.id); return res.json({ id: old.id, name: old.name, restored: true }); }
  const { id } = db.prepare('INSERT INTO item_categories(kind, name) VALUES (?, ?) RETURNING id').get(kind, name);
  audit(req.user.id, 'create', 'item_category', id, { kind, name });
  res.json({ id, name });
});

r.put('/item-categories/:id', requireRole('manager'), (req, res) => {
  const c = db.prepare('SELECT * FROM item_categories WHERE id = ?').get(Number(req.params.id));
  if (!c) throw notFound('Category');
  const name = req.body.name === undefined ? c.name : required(req.body.name, 'Category name').slice(0, 60);
  const clash = db.prepare('SELECT 1 FROM item_categories WHERE kind = ? AND name = ? AND id <> ?').get(c.kind, name, c.id);
  if (clash) throw bad(`"${name}" already exists`);
  const active = req.body.active === undefined ? c.active : req.body.active ? 1 : 0;
  tx(() => {
    db.prepare('UPDATE item_categories SET name = ?, active = ? WHERE id = ?').run(name, active, c.id);
    db.prepare('UPDATE items SET category = ? WHERE category_id = ?').run(name, c.id); // keep the text copy in step
  });
  audit(req.user.id, 'update', 'item_category', c.id, { name, active });
  res.json({ ok: true });
});

/**
 * The category for an item being saved: by id (must belong to the same item type),
 * or by name for older callers (created if missing). Hidden categories stay valid
 * only for items already in them.
 */
function resolveCategory(kind, body, currentId = null) {
  if (body.category_id) {
    const c = db.prepare('SELECT * FROM item_categories WHERE id = ?').get(Number(body.category_id));
    if (!c || c.kind !== kind) throw bad('Choose a category for this type of item');
    if (!c.active && c.id !== currentId) throw bad(`"${c.name}" is hidden. Show it again under Categories first.`);
    return c;
  }
  if (currentId && !body.category) return db.prepare('SELECT * FROM item_categories WHERE id = ?').get(currentId);
  const raw = String(body.category || 'Other').trim();
  const name = LEGACY[raw.toLowerCase()] || raw;
  db.prepare('INSERT INTO item_categories(kind, name) VALUES (?, ?) ON CONFLICT(kind, name) DO NOTHING').run(kind, name);
  return db.prepare('SELECT * FROM item_categories WHERE kind = ? AND name = ?').get(kind, name);
}

r.get('/stock/alerts', (req, res) => res.json(listItemsWithStock(null, req.asOf).filter((i) => i.low)));

r.get('/items/:id', (req, res) => {
  const item = db.prepare(`SELECT i.*, c.name AS category_name, u.full_name AS deleted_by_name FROM items i
    LEFT JOIN item_categories c ON c.id = i.category_id LEFT JOIN users u ON u.id = i.deleted_by WHERE i.id = ?`).get(Number(req.params.id));
  if (!item) throw notFound('Item');
  const stock = stockOf(item);
  // History limited to the selected financial year, with the stock brought forward into it
  const fyStart = req.fy?.start_date || '0000-01-01';
  const asOf = req.asOf || new Date().toLocaleDateString('en-CA');
  const movements = db.prepare(`
    SELECT m.*, l.lot_code, p.name AS party_name FROM stock_movements m
    LEFT JOIN stock_lots l ON l.id = m.lot_id LEFT JOIN parties p ON p.id = m.party_id
    WHERE m.item_id = ? AND m.date BETWEEN ? AND ? ORDER BY m.id DESC LIMIT 300`).all(item.id, fyStart, asOf);
  const ob = db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(value),0) v FROM stock_movements WHERE item_id = ? AND date < ?').get(item.id, fyStart);
  const opening = { date: fyStart, qty: r3(ob.q), value: r2(ob.v), unit_cost: Math.abs(ob.q) > 1e-6 ? r2(ob.v / ob.q) : 0 };
  const historic = asOf < new Date().toLocaleDateString('en-CA');
  const out = { ...item, stock, low: item.reorder_level > 0 && stock <= item.reorder_level, movements, opening, as_of: asOf };
  if (req.user.role !== 'staff') out.opening_entries = openingEntries(item);
  if (historic) {
    // viewing a past year: stock & value on its last day
    const c = db.prepare('SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(value),0) v FROM stock_movements WHERE item_id = ? AND date <= ?').get(item.id, asOf);
    out.historic = { qty: r3(c.q), value: r2(c.v), unit_cost: Math.abs(c.q) > 1e-6 ? r2(c.v / c.q) : 0 };
  }

  if (isAvg(item)) {
    // Tank view: weighted average + what is in the tank by supplier delivery
    out.unit_cost = r2(item.avg_cost);
    out.value = r2(item.stock_qty * item.avg_cost);
    const comp = tankComposition(item.id);
    out.tank = comp.parts.filter((p) => p.qty > 1e-6).map((p) => ({
      ...p, qty: r3(p.qty), share_pct: comp.total > 0 ? r2((p.qty / comp.total) * 100) : 0,
      supplier_name: p.supplier_id ? db.prepare('SELECT name FROM parties WHERE id = ?').get(p.supplier_id)?.name : null,
      purchase_no: p.ref_type === 'purchase' ? db.prepare('SELECT purchase_no FROM purchases WHERE id = ?').get(p.ref_id)?.purchase_no : null,
    })).sort((a, b) => b.receipt_movement_id - a.receipt_movement_id);
    out.purchases = db.prepare(`SELECT pi.id, pi.qty, pi.unit_cost, pi.amount, pu.id AS purchase_id, pu.purchase_no, pu.date, pu.status, p.name AS supplier_name
      FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN parties p ON p.id = pu.supplier_id
      WHERE pi.item_id = ? ORDER BY pu.date DESC, pu.id DESC LIMIT 50`).all(item.id);
    out.used_in = db.prepare(`SELECT b.id, b.batch_no, b.date, b.status, pc.qty, pc.avg_cost, pc.amount, i.name AS product_name, b.lot_id
      FROM production_consumption pc JOIN production_batches b ON b.id = pc.batch_id JOIN items i ON i.id = b.product_id
      WHERE pc.item_id = ? ORDER BY b.id DESC LIMIT 50`).all(item.id);
    out.sold_to = db.prepare(`SELECT s.id AS sale_id, s.invoice_no, s.date, s.status, si.qty, si.unit_price, si.amount, si.cost, p.name AS customer_name
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN parties p ON p.id = s.customer_id
      WHERE si.item_id = ? ORDER BY s.date DESC, s.id DESC LIMIT 50`).all(item.id);
    if (req.user.role === 'staff') for (const x of out.sold_to) { delete x.unit_price; delete x.amount; delete x.cost; }
  } else {
    out.lots = db.prepare(`
      SELECT l.*, p.name AS supplier_name, b.id AS batch_id, b.status AS batch_status
      FROM stock_lots l LEFT JOIN parties p ON p.id = l.supplier_id
      LEFT JOIN production_batches b ON l.source_type = 'production' AND b.id = l.source_id
      WHERE l.item_id = ? AND (l.qty_remaining > 0 OR ? = 1)
      ORDER BY l.date DESC, l.id DESC LIMIT 200`).all(item.id, req.query.all ? 1 : 0);
    out.value = r2(out.lots.reduce((s, l) => s + l.qty_remaining * l.unit_cost, 0));
    out.unit_cost = stock > 0 ? r2(out.value / stock) : 0;
    out.recipes = db.prepare('SELECT id, name, output_qty FROM recipes WHERE product_id = ? AND active = 1').all(item.id);
  }
  res.json(out);
});

function readItem(body, currentCategoryId = null) {
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw bad('Choose a type');
  const cat = resolveCategory(kind, body, currentCategoryId);
  return {
    kind,
    name: required(body.name, 'Name'),
    category: cat.name,
    category_id: cat.id,
    unit: body.unit || (kind === 'raw' ? 'kg' : 'pcs'),
    container: body.container || null,
    reorder_level: Number(body.reorder_level) || 0,
    sale_price: Number(body.sale_price) || 0,
    sku: body.sku || null,
  };
}

r.post('/items', requireRole('manager'), (req, res) => {
  const it = readItem(req.body);
  const result = tx(() => {
    const { id } = db.prepare(`INSERT INTO items(kind, name, category, category_id, unit, container, reorder_level, sale_price, sku)
      VALUES (@kind, @name, @category, @category_id, @unit, @container, @reorder_level, @sale_price, @sku) RETURNING id`).get(it);
    // Optional opening stock when creating the item
    const oq = Number(req.body.opening_qty) || 0;
    if (oq > 0) openingStock(id, oq, Number(req.body.opening_cost) || 0, today(), req.user.id);
    return id;
  });
  audit(req.user.id, 'create', 'item', result, it);
  res.json({ id: result });
});

r.put('/items/:id', requireRole('manager'), (req, res) => {
  const old = assertUsable(getItem(req.params.id));
  const it = readItem({ ...old, category: undefined, ...req.body, kind: old.kind }, old.category_id);
  tx(() => {
    db.prepare(`UPDATE items SET name=@name, category=@category, category_id=@category_id, unit=@unit, container=@container, reorder_level=@reorder_level,
                sale_price=@sale_price, sku=@sku WHERE id=@id`).run({ ...it, id: old.id });
    // "Stock you have now" / "Cost per unit" on the edit form = the item's first opening-stock entry
    if (req.body.opening_qty !== undefined && req.body.opening_qty !== null) {
      const first = db.prepare("SELECT * FROM stock_movements WHERE item_id = ? AND type = 'opening' ORDER BY id LIMIT 1").get(old.id);
      const oq = Number(req.body.opening_qty) || 0;
      if (first) correctOpening(getItem(old.id), first, req.body.opening_qty, req.body.opening_cost, req.user.id);
      else if (oq > 0) {
        assertOpenDate(today(), 'Opening stock');
        openingStock(old.id, r3(oq), Number(req.body.opening_cost) || 0, today(), req.user.id);
      }
    }
  });
  audit(req.user.id, 'update', 'item', old.id, it);
  res.json({ ok: true });
});

// ---------- deleting an item ----------------------------------------
// "Delete" never erases: the item leaves every list and form, but invoices,
// purchases, batches, ledgers and reports keep showing it by name.

/** Where an item appears, and anything that must be fixed before it can be deleted. */
function deleteCheck(item) {
  const one = (sql) => db.prepare(sql).get(item.id).n;
  const stock = stockOf(item);
  const used = {
    invoices: one(`SELECT COUNT(DISTINCT sale_id) n FROM sale_items WHERE item_id = ?`),
    purchases: one(`SELECT COUNT(DISTINCT purchase_id) n FROM purchase_items WHERE item_id = ?`),
    batches_made: one(`SELECT COUNT(*) n FROM production_batches WHERE product_id = ?`),
    batches_used_in: one(`SELECT COUNT(DISTINCT batch_id) n FROM production_consumption WHERE item_id = ?`),
    movements: one(`SELECT COUNT(*) n FROM stock_movements WHERE item_id = ?`),
  };
  const ownRecipes = db.prepare('SELECT id, name FROM recipes WHERE product_id = ? AND active = 1').all(item.id);
  const blockers = [];
  if (Math.abs(stock) > 1e-6) {
    blockers.push({ code: 'stock', message: `${r3(stock)} ${item.unit} is still in stock. Use "Adjust stock" to remove it (or sell it) first, so the books stay correct.` });
  }
  return { item: { id: item.id, name: item.name, kind: item.kind, unit: item.unit, active: item.active }, stock: r3(stock), used, own_recipes: ownRecipes, blockers, can_delete: !blockers.length && !!item.active };
}

r.get('/items/:id/delete-check', requireRole('manager'), (req, res) => res.json(deleteCheck(getItem(req.params.id))));

r.post('/items/:id/delete', requireRole('manager'), (req, res) => {
  const item = getItem(req.params.id);
  if (!item.active) throw bad('This item is already deleted');
  if (String(req.body?.confirm || '').trim().toUpperCase() !== 'DELETE') throw bad('Type DELETE to confirm');
  const check = deleteCheck(item);
  if (check.blockers.length) throw bad(check.blockers.map((b) => b.message).join(' '));
  tx(() => {
    db.prepare("UPDATE items SET active = 0, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(req.user.id, item.id);
    // its own saved recipes go with it, and it drops out of other products' saved ingredients
    db.prepare('UPDATE recipes SET active = 0 WHERE product_id = ? AND active = 1').run(item.id);
    db.prepare('DELETE FROM recipe_items WHERE item_id = ? AND recipe_id IN (SELECT id FROM recipes WHERE active = 1)').run(item.id);
  });
  audit(req.user.id, 'delete', 'item', item.id, { name: item.name, kind: item.kind, used: check.used, recipes_hidden: check.own_recipes.map((x) => x.name) });
  res.json({ ok: true, recipes_hidden: check.own_recipes.length });
});

r.get('/items-deleted', requireRole('manager'), (req, res) => {
  res.json(db.prepare(`SELECT i.id, i.kind, i.name, i.unit, i.deleted_at, u.full_name AS deleted_by_name, c.name AS category_name,
      (SELECT COUNT(DISTINCT sale_id) FROM sale_items WHERE item_id = i.id) AS invoices
    FROM items i LEFT JOIN users u ON u.id = i.deleted_by LEFT JOIN item_categories c ON c.id = i.category_id
    WHERE i.active = 0 AND (? IS NULL OR i.kind = ?) ORDER BY i.deleted_at DESC, i.id DESC`)
    .all(KINDS.includes(req.query.kind) ? req.query.kind : null, KINDS.includes(req.query.kind) ? req.query.kind : null));
});

r.post('/items/:id/restore', requireRole('manager'), (req, res) => {
  const item = getItem(req.params.id);
  if (item.active) throw bad('This item is not deleted');
  db.prepare('UPDATE items SET active = 1, deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(item.id);
  audit(req.user.id, 'restore', 'item', item.id, { name: item.name });
  res.json({ ok: true });
});

function openingStock(itemId, qty, unitCost, d, userId) {
  const item = getItem(itemId);
  const res = stockIn({
    item, qty, unit_cost: unitCost, date: d, type: 'opening', ref_type: 'opening',
    source_type: 'opening', note: 'Opening stock / stock found',
  });
  postOpening(item, res.movement_id, d, r2(qty * unitCost), userId);
  return res;
}

/** Journal for one opening-stock entry, linked to its stock movement so it can be corrected later. */
function postOpening(item, movementId, d, value, userId) {
  return post({
    date: d, memo: `Opening stock: ${item.name}`, ref_type: 'opening_stock', ref_id: movementId, user_id: userId,
    lines: [
      { account: stockAccountFor(item.kind), debit: value },
      { account: ACC.OPENING, credit: value },
    ],
  });
}

const MOVE_WORD = { production_out: 'used in production', sale: 'sold', adjustment: 'removed', purchase_cancel: 'purchase cancelled', sale_return_cancel: 'return cancelled' };

/**
 * Opening-stock entries of an item, and what may still be corrected on each:
 *  - nothing used from it yet  -> quantity and price can both be changed
 *  - goods batch partly sold    -> quantity can change (not below what left the batch), price is locked
 *  - raw material tank used after it -> locked (the average cost already flowed into production / sales)
 *  - in a closed financial year -> locked
 */
function openingEntries(item) {
  const rows = db.prepare(`SELECT m.id, m.date, m.qty, m.unit_cost, m.value, m.lot_id, m.note, l.lot_code, l.qty_in, l.qty_remaining
    FROM stock_movements m LEFT JOIN stock_lots l ON l.id = m.lot_id
    WHERE m.item_id = ? AND m.type = 'opening' ORDER BY m.date DESC, m.id DESC`).all(item.id);
  return rows.map((m) => {
    const out = { id: m.id, date: m.date, qty: r3(m.qty), unit_cost: m.unit_cost, value: r2(m.value), lot_id: m.lot_id, lot_code: m.lot_code, note: m.note,
      used_qty: 0, can_edit: true, can_edit_cost: true, min_qty: 0, locked_reason: null };
    const fy = fyForDate(m.date);
    if (!item.active) Object.assign(out, { can_edit: false, can_edit_cost: false, locked_reason: 'This item is deleted. Restore it first.' });
    else if (fy?.status === 'closed') Object.assign(out, { can_edit: false, can_edit_cost: false, locked_reason: `${fy.name} is closed.` });
    else if (m.lot_id) {
      const used = r3(m.qty_in - m.qty_remaining);
      const moved = db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE lot_id = ? AND id <> ?').get(m.lot_id, m.id).c;
      out.used_qty = Math.max(0, used);
      out.min_qty = Math.max(0, used);
      if (used > EPS || moved > 0) {
        out.can_edit_cost = false;
        out.locked_reason = `${out.used_qty > 0 ? `${r3(used)} ${item.unit} of it was already sold or used` : 'It was already sold or used'} at this price, so the price is locked. The quantity can still be corrected.`;
      }
    } else {
      const later = db.prepare(`SELECT type, date FROM stock_movements WHERE item_id = ? AND lot_id IS NULL AND id > ? AND qty < 0 ORDER BY id LIMIT 1`).get(item.id, m.id);
      if (later) Object.assign(out, { can_edit: false, can_edit_cost: false,
        locked_reason: `The tank was already ${MOVE_WORD[later.type] || 'used'} on ${later.date} at the average cost this stock gave, so it is locked. Use "Adjust stock" to correct the quantity from today.` });
    }
    return out;
  });
}

/**
 * Correct an opening-stock entry in place (quantity and/or price), as of its own date.
 * The stock movement, the batch or tank (and the tank's running average) and the journal are all corrected together.
 */
r.put('/items/:id/opening/:movementId', requireRole('manager'), (req, res) => {
  const item = getItem(req.params.id);
  const m = db.prepare("SELECT * FROM stock_movements WHERE id = ? AND item_id = ? AND type = 'opening'").get(Number(req.params.movementId), item.id);
  if (!m) throw notFound('Opening stock entry');
  const changed = tx(() => correctOpening(item, m, req.body.qty, req.body.unit_cost, req.user.id));
  res.json({ ok: true, unchanged: !changed });
});

/** Validate and apply a correction to one opening entry. Returns false when nothing changed. Run inside tx(). */
function correctOpening(item, m, qtyIn, costIn, userId) {
  const entry = openingEntries(item).find((x) => x.id === m.id);
  const qty = r3(num(qtyIn, 'quantity'));
  const cost = costIn === undefined || costIn === '' || costIn === null ? m.unit_cost : num(costIn, 'cost per unit', { allowZero: true });
  const costChanged = Math.abs(cost - m.unit_cost) > 1e-9;
  if (!costChanged && Math.abs(qty - m.qty) < EPS) return false;
  if (!entry.can_edit) throw bad(entry.locked_reason);
  assertOpenDate(m.date, 'This opening stock');
  if (costChanged && !entry.can_edit_cost) throw bad(entry.locked_reason);
  if (qty < entry.min_qty - EPS) throw bad(`${entry.min_qty} ${item.unit} of this stock has already left the batch — the quantity cannot be less than that`);
  const value = r2(qty * cost);

  db.prepare('UPDATE stock_movements SET qty = ?, unit_cost = ?, value = ? WHERE id = ?').run(qty, cost, value, m.id);
  if (m.lot_id) {
    const lot = db.prepare('SELECT * FROM stock_lots WHERE id = ?').get(m.lot_id);
    db.prepare('UPDATE stock_lots SET qty_in = ?, qty_remaining = round(qty_remaining + ?, 6), unit_cost = ? WHERE id = ?')
      .run(qty, r3(qty - lot.qty_in), cost, lot.id);
  } else {
    // replay the tank from just before this receipt (only receipts follow it, so nothing else changes)
    const prev = db.prepare('SELECT qty_after, avg_cost_after FROM stock_movements WHERE item_id = ? AND lot_id IS NULL AND id < ? ORDER BY id DESC LIMIT 1').get(item.id, m.id);
    let q0 = Math.max(0, prev?.qty_after || 0), avg = prev?.avg_cost_after || 0;
    const upd = db.prepare('UPDATE stock_movements SET qty_after = ?, avg_cost_after = ? WHERE id = ?');
    for (const x of db.prepare('SELECT id, qty, unit_cost FROM stock_movements WHERE item_id = ? AND lot_id IS NULL AND id >= ? ORDER BY id').all(item.id, m.id)) {
      const q1 = Math.round((q0 + x.qty) * 1e6) / 1e6;
      avg = q1 > EPS ? Math.round(((q0 * avg + x.qty * x.unit_cost) / q1) * 1e6) / 1e6 : x.unit_cost;
      q0 = q1;
      upd.run(q1, avg, x.id);
    }
    db.prepare('UPDATE items SET stock_qty = ?, avg_cost = ? WHERE id = ?').run(q0, avg, item.id);
  }
  // re-post the journal for this entry (same date) with the corrected value
  for (const je of db.prepare("SELECT id FROM journal_entries WHERE ref_type = 'opening_stock' AND ref_id = ?").all(m.id)) {
    db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(je.id);
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(je.id);
  }
  postOpening(item, m.id, m.date, value, userId);
  audit(userId, 'edit_opening_stock', 'item', item.id, { movement_id: m.id, from: { qty: m.qty, unit_cost: m.unit_cost }, to: { qty, unit_cost: cost } });
  return true;
}

/**
 * Stock adjustment.
 *  qty > 0 : opening stock / stock found  -> added at the given cost
 *             (raw: re-averages the tank; goods: new opening lot)
 *  qty < 0 : damage / wastage / count loss -> removed at book cost, booked as Stock Loss
 */
r.post('/items/:id/adjust', requireRole('manager'), (req, res) => {
  const item = assertUsable(getItem(req.params.id));
  const qty = Number(req.body.qty);
  if (!Number.isFinite(qty) || qty === 0) throw bad('Enter a quantity (use minus for removing stock)');
  const d = date(req.body.date);
  assertOpenDate(d, 'A stock adjustment');
  const reason = String(req.body.reason || (qty > 0 ? 'Opening stock' : 'Damaged / wastage'));

  const out = tx(() => {
    if (qty > 0) {
      const cost = req.body.unit_cost === undefined || req.body.unit_cost === ''
        ? (item.kind === 'raw' ? item.avg_cost : 0)
        : num(req.body.unit_cost, 'unit cost', { allowZero: true });
      return openingStock(item.id, qty, cost, d, req.user.id);
    }
    const { cost } = stockOut({ item, qty: -qty, date: d, type: 'adjustment', ref_type: 'adjustment', note: reason });
    post({
      date: d, memo: `Stock removed: ${item.name} — ${reason}`, ref_type: 'adjustment', ref_id: item.id, user_id: req.user.id,
      lines: [
        { account: ACC.STOCK_LOSS, debit: cost },
        { account: stockAccountFor(item.kind), credit: cost },
      ],
    });
    return { cost };
  });
  audit(req.user.id, 'adjust', 'item', item.id, { qty, reason });
  res.json(out);
});

// ---------- recipes (Bill of Materials) -----------------------------
function recipeWithLines(id) {
  const recipe = db.prepare(`SELECT r.*, i.name AS product_name, i.unit AS product_unit
    FROM recipes r JOIN items i ON i.id = r.product_id WHERE r.id = ?`).get(id);
  if (!recipe) throw notFound('Recipe');
  recipe.items = db.prepare(`SELECT ri.*, i.name, i.unit, i.kind FROM recipe_items ri JOIN items i ON i.id = ri.item_id
    WHERE ri.recipe_id = ? ORDER BY ri.id`).all(id);
  return recipe;
}

r.get('/recipes', (req, res) => {
  const rows = db.prepare(`SELECT r.*, i.name AS product_name, i.unit AS product_unit,
      (SELECT COUNT(*) FROM recipe_items WHERE recipe_id = r.id) AS item_count
    FROM recipes r JOIN items i ON i.id = r.product_id
    WHERE r.active = 1 AND i.active = 1 ${req.query.product_id ? 'AND r.product_id = ?' : ''} ORDER BY i.name, r.name`)
    .all(...(req.query.product_id ? [Number(req.query.product_id)] : []));
  res.json(rows);
});

r.get('/recipes/:id', (req, res) => res.json(recipeWithLines(Number(req.params.id))));

function saveRecipe(body, id = null) {
  const product = assertUsable(getItem(body.product_id));
  if (product.kind !== 'finished') throw bad('Recipes can only be made for finished products');
  const name = required(body.name, 'Recipe name');
  const output_qty = num(body.output_qty, 'output quantity');
  const lines = (body.items || []).filter((l) => l.item_id && Number(l.qty) > 0);
  if (!lines.length) throw bad('Add at least one raw material to the recipe');
  for (const l of lines) if (Number(l.item_id) === product.id) throw bad('A product cannot be an ingredient of itself');

  return tx(() => {
    if (id) {
      db.prepare('UPDATE recipes SET product_id=?, name=?, output_qty=?, notes=? WHERE id=?')
        .run(product.id, name, output_qty, body.notes || null, id);
      db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(id);
    } else {
      id = db.prepare('INSERT INTO recipes(product_id, name, output_qty, notes) VALUES (?,?,?,?) RETURNING id')
        .get(product.id, name, output_qty, body.notes || null).id;
    }
    const ins = db.prepare('INSERT INTO recipe_items(recipe_id, item_id, qty) VALUES (?,?,?)');
    const seen = new Set();
    for (const l of lines) {
      const it = assertUsable(getItem(l.item_id));
      if (it.kind !== 'raw') throw bad(`"${it.name}" is not a raw material`);
      if (seen.has(it.id)) throw bad(`"${it.name}" is listed twice in the recipe`);
      seen.add(it.id);
      ins.run(id, it.id, r3(l.qty));
    }
    return id;
  });
}

r.post('/recipes', requireRole('manager'), (req, res) => {
  const id = saveRecipe(req.body);
  audit(req.user.id, 'create', 'recipe', id);
  res.json({ id });
});
r.put('/recipes/:id', requireRole('manager'), (req, res) => {
  recipeWithLines(Number(req.params.id));
  saveRecipe(req.body, Number(req.params.id));
  audit(req.user.id, 'update', 'recipe', Number(req.params.id));
  res.json({ ok: true });
});
r.delete('/recipes/:id', requireRole('manager'), (req, res) => {
  db.prepare('UPDATE recipes SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

export { recipeWithLines };
export default r;
