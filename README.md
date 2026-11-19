# Soap Factory ERP

A simple, touch-friendly management system for a **make-to-stock soap factory**: stock tanks with weighted-average costing, production batches (ingredients entered per batch), sales invoices, customer and supplier ledgers, cash book, attendance-based payroll, and full **batch traceability** from supplier to customer.

## Quick start

Requires **Node.js 20+**.

```bash
npm run setup     # install server + client, build the app
npm run seed      # optional: load demo data (only on an empty database)
npm start         # http://localhost:4000
```

Log in as **admin / admin123**, then change the password in **Settings**. To set a different first password: `ADMIN_PASSWORD=yourpass npm start` on first run.

The terminal prints a `http://192.168.x.x:4000` address. Open it on any tablet or phone on the factory Wi-Fi.

### Development

```bash
npm run dev:server   # API on :4000 with auto-reload
npm run dev:client   # UI on :5173 with hot reload (proxies /api)
npm test             # end-to-end business tests (costing, ledgers, payroll, roles)
```

## What each screen does

| Screen | Purpose |
|---|---|
| **Home** | Quick-action tiles, low-stock alerts, today's sales and cash, month profit/loss, 14-day chart |
| **Stock** | Raw materials (tanks, weighted average, current supplier mix), finished goods and trading items by batch, low-stock flags |
| **Production** | Pick soap → number of mixes → live material check → save. Materials are deducted at the average cost; a new batch is added to stock |
| **Sales** | Invoice from stock (Cash / Credit / Part payment), optional batch choice, printable/PDF invoice, WhatsApp share |
| **Purchases** | Supplier bill entry with a live "new average cost" preview; recall view shows where each delivery went |
| **Customers / Suppliers** | Balances and full ledger in plain words; receive or make payments; print statements |
| **Cash Book** | Daily cash/bank book with opening and closing balance; Cash In / Cash Out with categories |
| **Reports** | Profit & Loss, Trial Balance, Day Book, Stock Value (with a books-vs-stock check) |
| **Staff** | One-tap attendance (P / A / Half / Leave), monthly sheet, salary calculation, advances and loans, payslips |
| **Product History** | Search a batch, invoice or supplier → full history. Each batch has its own link: `/trace/lot/:id` |

## Project layout

```
server/   Express API + SQLite (schema in server/src/schema.sql)
client/   React app (Vite)
docs/     ARCHITECTURE.md — blueprint, ER diagram, accounting rules, responsive guidelines
```

Data lives in `server/data/factory.db`. Back it up from **Settings → Download backup**, or copy the folder.
