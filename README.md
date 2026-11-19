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

## Hosting free on Cloudflare

The same code also runs on **Cloudflare Workers** (free plan): the screens are static assets, and the server and its SQLite database run in one **Durable Object**. Nothing has to stay switched on at the factory.

1. In Cloudflare: **Workers & Pages → Create → Import a repository**, choose this GitHub repository. Build command `npm run build`, deploy command `npx wrangler deploy`. Every push to `main` deploys again.
2. Open the `….workers.dev` address. A brand-new system shows a **Welcome** page: choose **Bring my data** and pick the file from **Settings → Download all data** on the computer version (or **Start empty**), and set the admin password.
3. Settings live in `wrangler.jsonc` (time zone `APP_TZ`, default `Asia/Karachi`).

Online, the starting password `admin123` is always refused. Download your data regularly from **Settings → Your data**.

Test the Cloudflare version locally (needs Node 22+): `npm run cf:dev`.

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
| **Production** | Pick soap → enter what went in this time (starts from the last batch) → live stock check → save. Materials are deducted at the average cost; a new batch is added to stock |
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
