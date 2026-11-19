import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { requireAuth, requireRole } from './auth.js';
import { fyContext } from './fiscal.js';
import fiscalRoutes from './routes/fiscal.js';
import authRoutes, { privateAuthRoutes } from './routes/auth.js';
import itemRoutes from './routes/items.js';
import productionRoutes from './routes/production.js';
import tradeRoutes from './routes/trade.js';
import financeRoutes from './routes/finance.js';
import traceRoutes from './routes/trace.js';
import hrRoutes from './routes/hr.js';
import expenseRoutes from './routes/expenses.js';
import fundRoutes from './routes/funds.js';
import returnRoutes from './routes/returns.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  // Very small brute-force guard on login: 10 tries / 5 min / IP
  const tries = new Map();
  app.use('/api/auth/login', (req, res, next) => {
    const key = req.ip, now = Date.now();
    const t = (tries.get(key) || []).filter((x) => now - x < 5 * 60e3);
    if (t.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes.' });
    t.push(now); tries.set(key, t); next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', authRoutes); // login/logout are public; everything after requires a session
  app.use('/api', requireAuth(), fyContext, fiscalRoutes, privateAuthRoutes, itemRoutes, productionRoutes, tradeRoutes, returnRoutes, financeRoutes, traceRoutes, hrRoutes, expenseRoutes, fundRoutes);

  // One-click database backup (admin)
  app.get('/api/backup', requireAuth(), requireRole('admin'), async (req, res, next) => {
    try {
      const file = path.join(os.tmpdir(), `soap-erp-backup-${Date.now()}.db`);
      await db.backup(file);
      res.download(file, `factory-backup-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(file, () => {}));
    } catch (e) { next(e); }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built React app (single process, single port in production)
  const dist = path.join(here, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // Errors: friendly message for expected errors, generic for bugs
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code?.startsWith?.('SQLITE_CONSTRAINT') ? 400 : 500);
    if (status >= 500) console.error(err);
    // messages raised by the financial-year triggers in the database
    const FY_MSG = {
      FY_CLOSED: 'This falls in a closed financial year. Closed years are locked: nothing in them can be added, changed or deleted.',
      FY_MISSING: 'No financial year covers this date. Add it under Financial Years first.',
    };
    const msg = FY_MSG[err.message] || (status >= 500 ? 'Something went wrong. Please try again.' : err.message);
    res.status(status).json({ error: msg });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4000;
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`Soap Factory ERP running on http://localhost:${port}`);
    for (const ifs of Object.values(os.networkInterfaces()).flat()) {
      if (ifs?.family === 'IPv4' && !ifs.internal) console.log(`  On factory Wi-Fi:  http://${ifs.address}:${port}`);
    }
  });
}
