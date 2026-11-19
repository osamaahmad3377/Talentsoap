import crypto from 'node:crypto';

const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/** Lazily imported to avoid a circular import with db.js */
async function getDb() {
  return (await import('./db.js')).db;
}

export async function createSession(userId) {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return { token, maxAge: SESSION_DAYS * 864e5 };
}

export async function destroySession(token) {
  const db = await getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Express middleware: attaches req.user or responds 401 */
export function requireAuth() {
  return async (req, res, next) => {
    const db = await getDb();
    const token = req.cookies?.sid;
    if (!token) return res.status(401).json({ error: 'Please log in' });
    const user = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, new Date().toISOString());
    if (!user) return res.status(401).json({ error: 'Session expired, please log in again' });
    req.user = user;
    next();
  };
}

/**
 * Role gate. admin > manager > staff.
 *  staff   : stock, production, attendance, sales entry
 *  manager : everything except users & settings
 *  admin   : everything
 */
const RANK = { staff: 1, manager: 2, admin: 3 };
export const requireRole = (min) => (req, res, next) =>
  RANK[req.user?.role] >= RANK[min] ? next() : res.status(403).json({ error: 'You do not have permission for this' });
