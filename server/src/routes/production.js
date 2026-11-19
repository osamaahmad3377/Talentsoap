// Independent (make-to-stock) production
import { Router } from 'express';
import { db, tx, r2, r3, nextNo, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { bad, num, date, notFound } from '../errors.js';
import { getItem, assertUsable, issueAvg, receiveAvg, createLot, voidLot, tankComposition, EPS } from '../inventory.js';
import { post, reverseRef, ACC } from '../accounting.js';
import { assertOpenDate } from '../fiscal.js';
import { recipeWithLines } from './items.js';

const r = Router();

/** One ingredient line: the material, how much this batch needs, and whether the tank has it. */
function lineFor(it, need) {
  return {
    item_id: it.id, name: it.name, unit: it.unit, container: it.container, need: r3(need),
    available: r3(it.stock_qty), enough: it.stock_qty + EPS >= need,
    avg_cost: r2(it.avg_cost), est_cost: r2(need * it.avg_cost),
  };
}

function summary(product, lines, expectedQty, extra = {}) {
  return {
    product: { id: product.id, name: product.name, unit: product.unit },
    expected_qty: expectedQty == null ? null : r3(expectedQty), lines,
    can_produce: lines.length > 0 && lines.every((l) => l.enough),
    est_material_cost: r2(lines.reduce((s, l) => s + l.est_cost, 0)),
    ...extra,
  };
}

/** Older callers: a saved recipe x number of mixes. */
function planFromRecipe(recipeId, runs) {
  const recipe = recipeWithLines(Number(recipeId));
  if (!recipe.active) throw bad('This recipe is no longer active');
  const product = assertUsable(getItem(recipe.product_id));
  const lines = recipe.items.map((ri) => ({ ...lineFor(assertUsable(getItem(ri.item_id)), r3(ri.qty * runs)), per_run: ri.qty }));
  return summary(product, lines, recipe.output_qty * runs, {
    recipe: { id: recipe.id, name: recipe.name, product_id: recipe.product_id, product_name: recipe.product_name, product_unit: recipe.product_unit, output_qty: recipe.output_qty },
    runs, recipe_id: recipe.id,
  });
}

/** This batch's own ingredients, typed in on the Make a batch screen (the recipe changes batch to batch). */
function planFromItems(productId, items) {
  const product = assertUsable(getItem(productId));
  if (product.kind !== 'finished') throw bad('Choose a finished product to make');
  if (!Array.isArray(items)) throw bad('Add the ingredients used in this batch');
  const seen = new Set();
  const lines = [];
  for (const l of items) {
    if (!l || !l.item_id) continue;
    const it = assertUsable(getItem(l.item_id));
    if (it.kind !== 'raw') throw bad(`"${it.name}" is not a raw material`);
    if (it.id === product.id) throw bad('A product cannot be an ingredient of itself');
    if (seen.has(it.id)) throw bad(`"${it.name}" is listed twice. Put the full amount on one line.`);
    seen.add(it.id);
    lines.push(lineFor(it, num(l.qty, `quantity of ${it.name}`)));
  }
  if (!lines.length) throw bad('Add at least one ingredient with its quantity');
  return summary(product, lines, null, { recipe_id: null, runs: 1 });
}

function plan(body, runs) {
  if (body.recipe_id && !body.items) return planFromRecipe(body.recipe_id, runs);
  return planFromItems(body.product_id, body.items);
}

const hideCost = (p) => {
  delete p.est_material_cost;
  for (const l of p.lines || p.items || []) { delete l.avg_cost; delete l.est_cost; }
  return p;
};

/**
 * Starting point for a new batch of a product: the ingredients of its last batch
 * (or, if it was never made, its old saved recipe). Everything can be changed.
 */
r.get('/production/start', (req, res) => {
  const product = assertUsable(getItem(req.query.product_id));
  if (product.kind !== 'finished') throw bad('Choose a finished product to make');
  let items = [], qtyProduced = null, source = null;
  const last = db.prepare(`SELECT id, batch_no, date, qty_produced FROM production_batches
    WHERE product_id = ? AND status = 'active' ORDER BY date DESC, id DESC LIMIT 1`).get(product.id);
  if (last) {
    items = db.prepare(`SELECT item_id, SUM(qty) AS qty FROM production_consumption WHERE batch_id = ?
      GROUP BY item_id ORDER BY MIN(id)`).all(last.id);
    qtyProduced = last.qty_produced;
    source = { type: 'last_batch', batch_no: last.batch_no, date: last.date };
  } else {
    const rec = db.prepare('SELECT id, name, output_qty FROM recipes WHERE product_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(product.id);
    if (rec) {
      items = db.prepare('SELECT item_id, qty FROM recipe_items WHERE recipe_id = ? ORDER BY id').all(rec.id);
      qtyProduced = rec.output_qty;
      source = { type: 'recipe', name: rec.name };
    }
  }
  const lines = [];
  for (const x of items) {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(x.item_id);
    if (!it || !it.active || it.kind !== 'raw') continue; // deleted since: leave it out
    lines.push(lineFor(it, r3(x.qty)));
  }
  const out = summary(product, lines, qtyProduced, { source });
  res.json(req.user.role === 'staff' ? hideCost(out) : out);
});

r.get('/production', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, i.name AS product_name, i.unit AS product_unit, l.lot_code, l.qty_remaining
    FROM production_batches b JOIN items i ON i.id = b.product_id
    LEFT JOIN stock_lots l ON l.id = b.lot_id
    WHERE b.date BETWEEN ? AND ? ${req.query.product_id ? 'AND b.product_id = ?' : ''}
    ORDER BY b.date DESC, b.id DESC LIMIT 500`).all(req.fy?.start_date || '0000-01-01', req.fy?.end_date || '9999-12-31', ...(req.query.product_id ? [Number(req.query.product_id)] : []));
  res.json(rows);
});

r.post('/production/preview', (req, res) => {
  const p = plan(req.body, num(req.body.runs ?? 1, 'number of batches'));
  res.json(req.user.role === 'staff' ? hideCost(p) : p);
});

/**
 * Record a production batch (stock building, no customer order involved):
 *  1. validate every material is in stock (whole batch is refused otherwise)
 *  2. snapshot which supplier deliveries are in each tank (mixed-tank model)
 *  3. issue each material at its current weighted average cost
 *  4. create the finished-goods batch costed at materials + other cost
 *  5. post: Dr Finished Goods Stock / Cr Raw Material Stock (+ Cr Overhead Charged)
 */
r.post('/production', requireRole('staff'), (req, res) => {
  const runs = req.body.items ? 1 : num(req.body.runs ?? 1, 'number of batches');
  const d = date(req.body.date);
  assertOpenDate(d, 'A production batch');
  const otherCost = r2(Number(req.body.other_cost) || 0);
  if (otherCost < 0) throw bad('Other cost cannot be negative');

  const batch = tx(() => {
    const p = plan(req.body, runs); // inside tx so stock can't change underneath us
    if (!p.can_produce) {
      const short = p.lines.filter((l) => !l.enough).map((l) => `${l.name} (need ${l.need}, have ${l.available} ${l.unit})`);
      throw bad(`Not enough raw material: ${short.join(', ')}`);
    }
    const qtyProduced = num(req.body.qty_produced || p.expected_qty, `quantity made (${p.product.unit})`);

    const batchNo = nextNo(`B${d.slice(2, 4)}${d.slice(5, 7)}`, 3); // e.g. B2611-001
    const { id } = db.prepare(`INSERT INTO production_batches(batch_no, product_id, recipe_id, date, runs, qty_produced,
        material_cost, other_cost, total_cost, unit_cost, notes, created_by)
      VALUES (?,?,?,?,?,?,0,?,0,0,?,?) RETURNING id`)
      .get(batchNo, p.product.id, p.recipe_id, d, runs, qtyProduced, otherCost, req.body.notes || null, req.user.id);

    const insC = db.prepare(`INSERT INTO production_consumption(batch_id, item_id, qty, avg_cost, amount, movement_id)
      VALUES (?,?,?,?,?,?) RETURNING id`);
    const insS = db.prepare(`INSERT INTO production_material_sources(consumption_id, receipt_movement_id, purchase_id, supplier_id, qty, share_pct)
      VALUES (?,?,?,?,?,?)`);
    let materialCost = 0;
    for (const l of p.lines) {
      const comp = tankComposition(l.item_id);
      const issued = issueAvg({ item_id: l.item_id, qty: l.need, date: d, type: 'production_out', ref_type: 'production', ref_id: id });
      const c = insC.get(id, l.item_id, l.need, issued.unit_cost, issued.cost, issued.movement_id);
      materialCost += issued.cost;

      // Each delivery contributes to this batch in proportion to its share of the tank
      if (comp.total > EPS) {
        for (const part of comp.parts) {
          const share = part.qty / comp.total;
          if (share < 0.005) continue; // under 0.5%: negligible trace
          insS.run(c.id, part.receipt_movement_id, part.ref_type === 'purchase' ? part.ref_id : null,
            part.supplier_id, r3(l.need * share), r2(share * 100));
        }
      }
    }
    materialCost = r2(materialCost);
    const total = r2(materialCost + otherCost);
    const unitCost = Math.round((total / qtyProduced) * 1e6) / 1e6;

    const lot = createLot({
      item_id: p.product.id, qty: qtyProduced, unit_cost: unitCost, date: d,
      source_type: 'production', source_id: id, lot_code: batchNo,
      movement_type: 'production_in', ref_type: 'production', ref_id: id,
    });
    db.prepare('UPDATE production_batches SET material_cost=?, total_cost=?, unit_cost=?, lot_id=? WHERE id=?')
      .run(materialCost, total, unitCost, lot.id, id);

    const stockValue = r2(unitCost * qtyProduced);
    const overhead = r2(stockValue - materialCost);
    post({
      date: d, memo: `Production ${batchNo}: ${qtyProduced} ${p.product.unit} ${p.product.name}`,
      ref_type: 'production', ref_id: id, user_id: req.user.id,
      lines: [
        { account: ACC.FG_STOCK, debit: stockValue },
        { account: ACC.RAW_STOCK, credit: materialCost },
        { account: ACC.OVERHEAD_ABSORBED, credit: Math.max(0, overhead), debit: Math.max(0, -overhead) },
      ],
    });
    return { id, batch_no: batchNo, lot_id: lot.id, qty_produced: qtyProduced, material_cost: materialCost, total_cost: total, unit_cost: r2(unitCost) };
  });
  audit(req.user.id, 'create', 'production', batch.id, { batch_no: batch.batch_no });
  res.json(batch);
});

/** Cancel a batch that has not been sold from: finished goods removed, materials returned to tanks. */
r.post('/production/:id/cancel', requireRole('manager'), (req, res) => {
  const b = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(Number(req.params.id));
  if (!b) throw notFound('Batch');
  if (b.status === 'cancelled') throw bad('Already cancelled');
  assertOpenDate(b.date, 'This batch');
  const d = date(req.body?.date);
  tx(() => {
    voidLot(b.lot_id, { date: d, movement_type: 'production_cancel', ref_type: 'production', ref_id: b.id });
    for (const c of db.prepare('SELECT item_id, qty, avg_cost FROM production_consumption WHERE batch_id = ?').all(b.id)) {
      receiveAvg({ item_id: c.item_id, qty: c.qty, unit_cost: c.avg_cost, date: d, type: 'production_cancel', ref_type: 'production', ref_id: b.id, note: `Returned from cancelled ${b.batch_no}` });
    }
    reverseRef('production', b.id, { date: d, memo: `Cancelled batch ${b.batch_no}`, user_id: req.user.id });
    db.prepare("UPDATE production_batches SET status = 'cancelled' WHERE id = ?").run(b.id);
  });
  audit(req.user.id, 'cancel', 'production', b.id);
  res.json({ ok: true });
});

export default r;
