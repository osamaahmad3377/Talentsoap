import { Router } from 'express';
import { db, getSettings, audit } from '../db.js';
import { createSession, destroySession, verifyPassword, hashPassword, requireRole } from '../auth.js';
import { bad, required } from '../errors.js';

const r = Router();      // public: login / logout
const pr = Router();     // private: everything else (mounted behind requireAuth)
const isProd = process.env.NODE_ENV === 'production';

r.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const { token, maxAge } = await createSession(user.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: isProd && process.env.HTTPS === '1', maxAge });
  audit(user.id, 'login', 'user', user.id);
  res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role });
});

r.post('/auth/logout', async (req, res) => {
  if (req.cookies?.sid) await destroySession(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

pr.get('/auth/me', (req, res) => res.json({ ...req.user, settings: getSettings() }));

pr.post('/auth/password', (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current || '', user.password_hash)) throw bad('Current password is wrong');
  if (!next || String(next).length < 6) throw bad('New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ---------- settings (admin) ----------------------------------------
pr.get('/settings', (req, res) => res.json(getSettings()));
pr.put('/settings', requireRole('admin'), (req, res) => {
  const allowed = ['company_name', 'company_address', 'company_phone', 'currency', 'invoice_footer', 'paid_leaves_per_month'];
  const up = db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of allowed) if (k in req.body) up.run(k, String(req.body[k] ?? ''));
  audit(req.user.id, 'update', 'settings', null, req.body);
  res.json(getSettings());
});

// ---------- users (admin) -------------------------------------------
pr.get('/users', requireRole('admin'), (req, res) =>
  res.json(db.prepare('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id').all()));

pr.post('/users', requireRole('admin'), (req, res) => {
  const username = required(req.body.username, 'Username');
  const full_name = required(req.body.full_name, 'Full name');
  const role = ['admin', 'manager', 'staff'].includes(req.body.role) ? req.body.role : 'staff';
  if (!req.body.password || req.body.password.length < 6) throw bad('Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('Username already taken');
  const { id } = db.prepare('INSERT INTO users(username, full_name, role, password_hash) VALUES (?,?,?,?) RETURNING id')
    .get(username, full_name, role, hashPassword(req.body.password));
  audit(req.user.id, 'create', 'user', id, { username, role });
  res.json({ id });
});

pr.put('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw bad('User not found');
  const role = ['admin', 'manager', 'staff'].includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active === undefined ? u.active : req.body.active ? 1 : 0;
  if (id === req.user.id && (role !== 'admin' || !active)) throw bad('You cannot remove your own admin access');
  db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?')
    .run(req.body.full_name || u.full_name, role, active, id);
  if (req.body.password) {
    if (req.body.password.length < 6) throw bad('Password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  audit(req.user.id, 'update', 'user', id, { role, active });
  res.json({ ok: true });
});

export { pr as privateAuthRoutes };
export default r;
