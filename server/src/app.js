// The ERP web app: API routes, security and error handling.
// Shared by the computer version (index.js) and the Cloudflare version (worker.js).
import express from 'express';
import cookieParser from 'cookie-parser';
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
import { setupRoutes, backupRoutes } from './routes/data.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** The visitor's IP: Cloudflare's header when the request came through Cloudflare. */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  return cf && LOOPBACK.has(req.socket?.remoteAddress) ? String(cf) : req.socket?.remoteAddress;
}

/** extra(app) adds computer-only routes (e.g. serving the screens from disk). */
export function createApp({ extra } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // a full data file can be large; everything else stays small
  app.use(['/api/backup/restore', '/api/setup/restore'], express.json({ limit: '60mb' }));
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

  // Brute-force guard on login: 10 tries / 5 min per visitor.
  const tries = new Map();
  app.use(['/api/auth/login', '/api/setup'], (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = clientIp(req), now = Date.now();
    const t = (tries.get(key) || []).filter((x) => now - x < 5 * 60e3);
    if (t.length >= 10) return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes.' });
    t.push(now); tries.set(key, t);
    if (tries.size > 5000) for (const [k, v] of tries) if (now - v[v.length - 1] > 5 * 60e3) tries.delete(k);
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', setupRoutes);  // first-time setup of an empty system (public, only while it is empty)
  app.use('/api', authRoutes);   // login/logout are public; everything after requires a session
  app.use('/api/backup', requireAuth(), requireRole('admin'), backupRoutes);
  app.use('/api', requireAuth(), fyContext, fiscalRoutes, privateAuthRoutes, itemRoutes, productionRoutes, tradeRoutes, returnRoutes, financeRoutes, traceRoutes, hrRoutes, expenseRoutes, fundRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  if (extra) extra(app);

  // Errors: friendly message for expected errors, generic for bugs
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large' || err.status === 413) return res.status(413).json({ error: 'That file is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That is not a valid data file.' });
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
