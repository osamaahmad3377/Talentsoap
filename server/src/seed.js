// Loads realistic demo data through the real API so all books stay consistent.
// Usage: npm run seed      (only runs on an empty database)
import { db } from './db.js';
import { createApp } from './index.js';
import { startClient } from './apiClient.js';

const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };

export async function seed() {
  if (db.prepare('SELECT 1 FROM items LIMIT 1').get()) {
    console.log('Database already has data — seed skipped.');
    return;
  }
  const api = await startClient(createApp());
  try {
    await api.put('/settings', { company_name: 'Al-Noor Soap Industries', company_address: 'Plot 14, SITE Industrial Area', company_phone: '0300-1234567', currency: 'Rs' });

    // --- suppliers & customers
    const sup = {};
    for (const [k, name, phone] of [['oil', 'Karachi Oil Traders', '0321-5550101'], ['chem', 'Pak Chemicals Co.', '0333-5550202'], ['pack', 'Star Packaging', '0345-5550303'], ['frag', 'Royal Fragrances', '0300-5550404']]) {
      sup[k] = (await api.post('/parties', { type: 'supplier', name, phone })).id;
    }
    const cus = {};
    for (const [k, name, phone, ob] of [['a', 'Madina General Store', '0301-7770001', 0], ['b', 'Hassan Wholesale', '0302-7770002', 15000], ['c', 'City Mart', '0303-7770003', 0]]) {
      cus[k] = (await api.post('/parties', { type: 'customer', name, phone, opening_balance: ob, opening_date: day(-20) })).id;
    }
    const walkIn = db.prepare("SELECT id FROM parties WHERE name = 'Walk-in Customer'").get().id;

    // --- raw materials (tanks), finished soap, trading goods
    const it = {};
    const mk = async (k, body) => { it[k] = (await api.post('/items', body)).id; };
    await mk('palm', { kind: 'raw', name: 'Palm Oil', category: 'oil', unit: 'kg', container: 'Tank 1', reorder_level: 200 });
    await mk('coco', { kind: 'raw', name: 'Coconut Oil', category: 'oil', unit: 'kg', container: 'Tank 2', reorder_level: 100 });
    await mk('naoh', { kind: 'raw', name: 'Caustic Soda', category: 'chemical', unit: 'kg', container: 'Chemical Store', reorder_level: 50 });
    await mk('lav', { kind: 'raw', name: 'Lavender Fragrance', category: 'fragrance', unit: 'kg', container: 'Fragrance Shelf', reorder_level: 5 });
    await mk('neem', { kind: 'raw', name: 'Neem Extract', category: 'fragrance', unit: 'kg', container: 'Fragrance Shelf', reorder_level: 5 });
    await mk('wrap', { kind: 'raw', name: 'Printed Wrapper', category: 'packaging', unit: 'pcs', container: 'Packing Room', reorder_level: 1000 });
    await mk('ctn', { kind: 'raw', name: 'Carton (48 pcs)', category: 'packaging', unit: 'pcs', container: 'Packing Room', reorder_level: 20 });
    await mk('lavsoap', { kind: 'finished', name: 'Lavender Soap 100g', category: 'soap', unit: 'pcs', sale_price: 85, reorder_level: 500 });
    await mk('neemsoap', { kind: 'finished', name: 'Neem Soap 120g', category: 'soap', unit: 'pcs', sale_price: 95, reorder_level: 300 });
    await mk('sham', { kind: 'trading', name: 'Herbal Shampoo 200ml', category: 'other', unit: 'pcs', sale_price: 320, reorder_level: 24 });

    // --- recipes (one run = one kettle)
    const lavR = (await api.post('/recipes', { product_id: it.lavsoap, name: 'Lavender — standard kettle', output_qty: 1000, items: [
      { item_id: it.palm, qty: 60 }, { item_id: it.coco, qty: 25 }, { item_id: it.naoh, qty: 13 }, { item_id: it.lav, qty: 1.5 },
      { item_id: it.wrap, qty: 1000 }, { item_id: it.ctn, qty: 21 }] })).id;
    const neemR = (await api.post('/recipes', { product_id: it.neemsoap, name: 'Neem — standard kettle', output_qty: 800, items: [
      { item_id: it.palm, qty: 65 }, { item_id: it.coco, qty: 25 }, { item_id: it.naoh, qty: 14 }, { item_id: it.neem, qty: 2 },
      { item_id: it.wrap, qty: 800 }, { item_id: it.ctn, qty: 17 }] })).id;

    // --- purchases at different rates (shows the weighted average moving)
    const buy = (supplier_id, d, items, paid = 0, bill) => api.post('/purchases', { supplier_id, date: d, items, paid, supplier_bill_no: bill });
    await buy(sup.oil, day(-18), [{ item_id: it.palm, qty: 400, unit_cost: 420 }, { item_id: it.coco, qty: 150, unit_cost: 610 }], 100000, 'KOT-881');
    await buy(sup.chem, day(-18), [{ item_id: it.naoh, qty: 100, unit_cost: 190 }], 19000, 'PC-2231');
    await buy(sup.frag, day(-17), [{ item_id: it.lav, qty: 10, unit_cost: 5200 }, { item_id: it.neem, qty: 8, unit_cost: 3100 }], 0, 'RF-77');
    await buy(sup.pack, day(-17), [{ item_id: it.wrap, qty: 6000, unit_cost: 2.5 }, { item_id: it.ctn, qty: 140, unit_cost: 48 }], 10000, 'SP-1902');
    await buy(sup.pack, day(-16), [{ item_id: it.sham, qty: 96, unit_cost: 230 }], 22080, 'SP-1910');

    // --- production (stock building) and sales from stock
    const make = (recipe_id, runs, d, other_cost, qty_produced) => api.post('/production', { recipe_id, runs, date: d, other_cost, qty_produced });
    const b1 = await make(lavR, 2, day(-15), 6000, 1985);
    const b2 = await make(neemR, 1, day(-14), 3000);
    // a second delivery of palm oil at a higher price lands in Tank 1 (re-averaged)
    await buy(sup.oil, day(-12), [{ item_id: it.palm, qty: 300, unit_cost: 455 }], 50000, 'KOT-902');
    const b3 = await make(lavR, 1, day(-10), 3000, 990);

    const sell = (customer_id, d, items, paid, discount = 0, pay = {}) => api.post('/sales', { customer_id, date: d, items, paid, discount, ...pay });
    await sell(cus.a, day(-13), [{ item_id: it.lavsoap, qty: 480, unit_price: 82 }, { item_id: it.sham, qty: 12, unit_price: 320 }], 0);
    await sell(cus.b, day(-11), [{ item_id: it.lavsoap, qty: 960, unit_price: 80 }, { item_id: it.neemsoap, qty: 288, unit_price: 92 }], 50000, 1000,
      { payment_method: 'cheque', cheque_no: '004512', bank_name: 'HBL', cheque_date: day(-11) });
    await sell(cus.c, day(-6), [{ item_id: it.lavsoap, qty: 720, unit_price: 83 }], 59760);
    await sell(walkIn, day(-2), [{ item_id: it.neemsoap, qty: 48, unit_price: 95 }, { item_id: it.sham, qty: 6, unit_price: 320 }], 6480);
    await sell(cus.a, day(0), [{ item_id: it.lavsoap, qty: 240, unit_price: 82 }, { item_id: it.neemsoap, qty: 96, unit_price: 92 }], 10000);

    // --- payments
    await api.post(`/parties/${cus.a}/payment`, { amount: 30000, date: day(-5), note: 'Cash collected by salesman' });
    await api.post(`/parties/${sup.frag}/payment`, { amount: 40000, date: day(-4), payment_method: 'bank_transfer', reference: 'IBFT-20931' });
    const meezan = await api.post('/funds', { fund_type: 'bank', name: 'Meezan Current', bank_name: 'Meezan Bank', account_number: 'PK36MEZN0001234567', opening_balance: 75000, opening_date: day(-20) });
    await api.post(`/parties/${cus.c}/payment`, { amount: 10000, date: day(-1), payment_method: 'bank_transfer', account_id: meezan.id, reference: 'RAAST-88120' });

    // --- cash book
    const acc = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
    await api.post('/cash', { direction: 'in', category_id: acc('3000'), amount: 300000, date: day(-20), note: 'Owner investment' });
    await api.post('/cash', { direction: 'out', category_id: acc('1010'), amount: 100000, date: day(-19), note: 'Deposit to bank' });
    // operational expenses (expense register -> cash book -> P&L)
    const exp = (code, amount, d, note, paid_to, bank) => api.post('/expenses', { category_id: acc(code), amount, date: d, note, paid_to, pay_account_id: bank ? acc('1010') : undefined });
    await exp('5210', 25000, day(-19), 'Factory rent', 'Haji Rasheed (landlord)', true);
    await exp('5200', 16200, day(-17), 'K-Electric bill', 'K-Electric', true);
    await exp('5200', 18500, day(-8), 'K-Electric bill', 'K-Electric');
    await exp('5220', 3500, day(-6), 'Delivery to City Mart', 'Ali Goods Transport');
    await exp('5260', 1200, day(0), 'Tea for staff', 'Chai wala');
    await exp('5230', 4500, day(-1), 'Mixer motor repair', 'Usman Electric Works');
    await exp('5240', 2300, day(-3), 'Register, pens, printer paper', 'Saddar stationers');
    await exp('5270', 800, day(-2), 'Gate lock replaced', null);

    // --- employees, attendance, advance
    // Shift 8 AM - 5 PM, Sunday off, factory standard overtime Rs 150/hour
    await api.put('/hr/settings', { shift_start: '08:00', shift_end: '17:00', weekly_off_day: 0, overtime_rate_per_hour: 150, paid_leaves_per_month: 1, monthly_deduct_absent: true });
    const emp = [];
    for (const e of [
      { name: 'Muhammad Aslam', designation: 'Supervisor', salary_type: 'monthly', salary_amount: 45000 },
      { name: 'Imran Khan', designation: 'Kettle Operator', salary_type: 'monthly', salary_amount: 32000, overtime_eligible: true },
      { name: 'Bilal Ahmed', designation: 'Packing', salary_type: 'daily', salary_amount: 1200, overtime_rate: 175 },
      { name: 'Shahid Ali', designation: 'Helper', salary_type: 'daily', salary_amount: 1000 },
    ]) emp.push((await api.post('/employees', { ...e, join_date: day(-90) })).id);
    const pattern = ['P', 'P', 'P', 'H', 'P', 'A', 'P', 'P', 'L', 'P'];
    const otPattern = [0, 2, 0, 0, 1.5, 0, 3, 0, 0, 1];
    for (let i = -20; i <= 0; i++) {
      const d = day(i);
      if (d.slice(0, 7) !== day(0).slice(0, 7)) continue;
      if (new Date(`${d}T12:00:00`).getDay() === 0) continue; // Sunday off
      await api.put('/attendance', { date: d, records: emp.map((id, k) => {
        let status = pattern[(i + 20 + k * 3) % pattern.length];
        if (status === 'L' && k >= 2) status = 'A';              // daily wagers have no leave
        const ot = status === 'P' && k >= 1 ? otPattern[(i + 20 + k) % otPattern.length] : 0;
        return { employee_id: id, status, overtime_hours: ot };
      }) });
    }
    await api.post('/advances', { employee_id: emp[1], type: 'advance', amount: 5000, date: day(-7), note: 'Family emergency' });
    await api.post('/advances', { employee_id: emp[0], type: 'loan', amount: 30000, monthly_installment: 5000, date: day(-25), note: 'Motorbike loan' });

    console.log(`Demo data loaded: batches ${b1.batch_no}, ${b2.batch_no}, ${b3.batch_no}`);
  } finally {
    await api.close();
  }
}

if (process.argv[1]?.endsWith('seed.js')) seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
