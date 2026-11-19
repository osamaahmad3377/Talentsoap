// Moving data: download everything as one data file, restore it on another
// computer or on Cloudflare, and the first-time setup of an empty system.
import { Router } from 'express';
import { db, tx, audit, installFyTriggers } from '../db.js';
import { hashPassword } from '../auth.js';
import { bad, HttpError } from '../errors.js';
import { STARTING_PASSWORD } from './auth.js';

const FORMAT = 'soap-factory-erp-data';
const NOT_COPIED = new Set(['sessions']); // logins are never copied

/** Business tables (not SQLite's own, not the hosting platform's, not sessions). */
function dataTables() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`)
    .all().map((r) => r.name).filter((n) => !NOT_COPIED.has(n));
}
const columnsOf = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

export function exportData() {
  const tables = {};
  for (const t of dataTables()) {
    const columns = columnsOf(t);
    const list = columns.map((c) => `"${c}"`).join(', ');
    tables[t] = { columns, rows: db.prepare(`SELECT ${list} FROM "${t}" ORDER BY rowid`).all().map((r) => columns.map((c) => r[c])) };
  }
  return { format: FORMAT, schema_version: db.getVersion(), exported_at: new Date().toISOString(), tables };
}

/** Replace ALL data with the file's data, in one transaction (all or nothing). */
export function restoreData(dump) {
  if (!dump || dump.format !== FORMAT || typeof dump.tables !== 'object') throw bad('That is not a data file from this ERP.');
  const current = db.getVersion();
  if (Number(dump.schema_version) !== current) {
    throw bad(Number(dump.schema_version) > current
      ? 'That data file comes from a newer version of the ERP. Update this one first, then try again.'
      : 'That data file comes from an older version of the ERP. Update the other copy, download the data again, then try again.');
  }
  const counts = {};
  tx(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    // year-lock triggers would refuse old entries; they are put back at the end
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    const here = dataTables();
    for (const t of [...here, ...NOT_COPIED]) db.exec(`DELETE FROM "${t}"`);
    for (const [t, data] of Object.entries(dump.tables)) {
      if (!here.includes(t)) continue;
      const have = new Set(columnsOf(t));
      const keep = (data.columns || []).map((c, i) => [c, i]).filter(([c]) => have.has(c));
      if (!keep.length || !Array.isArray(data.rows)) continue;
      const ins = db.prepare(`INSERT INTO "${t}" (${keep.map(([c]) => `"${c}"`).join(', ')}) VALUES (${keep.map(() => '?').join(', ')})`);
      for (const row of data.rows) ins.run(...keep.map(([, i]) => row[i]));
      counts[t] = data.rows.length;
    }
    installFyTriggers();
  });
  return counts;
}

function strongPassword(p) {
  const s = String(p || '');
  if (s.length < 8) throw bad('Choose a password of at least 8 characters.');
  if (s === STARTING_PASSWORD) throw bad('Choose a new password, not the starting one.');
  return s;
}

/** A brand-new, empty install: nobody has logged in, one admin, no business data. */
export function isFresh() {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'setup_done'").get()) return false;
  if (db.prepare("SELECT 1 FROM audit_log WHERE action = 'login' LIMIT 1").get()) return false;
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n !== 1) return false;
  for (const t of ['items', 'sales', 'purchases', 'employees', 'expenses']) {
    if (db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()) return false;
  }
  return true;
}

// ---------- public: first-time setup ---------------------------------------
export const setupRoutes = Router();

setupRoutes.get('/setup/status', (req, res) => res.json({ fresh: isFresh() }));

/**
 * Only while the system is brand new: load a data file (optional) and set the
 * admin's password, so nobody ever needs the starting password online.
 */
setupRoutes.post('/setup/restore', (req, res) => {
  if (!isFresh()) throw new HttpError(403, 'This system is already set up. Please log in.');
  const { data, username = 'admin', password } = req.body || {};
  const pw = strongPassword(password);
  let counts = null;
  const user = tx(() => {
    if (data) counts = restoreData(data);
    const u = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin' AND active = 1").get(String(username).trim());
    if (!u) throw bad(data ? `There is no active admin called "${username}" in that data file.` : 'Use the username "admin".');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
    db.prepare("INSERT INTO settings(key, value) VALUES ('setup_done', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    return u;
  });
  audit(user.id, data ? 'setup_restore' : 'setup', 'user', user.id, counts ? { tables: Object.keys(counts).length } : null);
  res.json({ ok: true, username: user.username, restored: counts });
});

// ---------- admin: download / restore ----------------------------------------
export const backupRoutes = Router();

backupRoutes.get('/', (req, res) => {
  const name = `factory-data-${new Date().toISOString().slice(0, 10)}.json`;
  res.set({ 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.json(exportData());
});

backupRoutes.post('/restore', (req, res) => {
  const counts = restoreData(req.body);
  const still = db.prepare('SELECT id FROM users WHERE id = ?').get(req.user.id);
  audit(still ? req.user.id : null, 'restore', null, null, { tables: Object.keys(counts).length });
  res.json({ ok: true, restored: counts, relogin: true });
});
