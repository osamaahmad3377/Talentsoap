// Database driver for Cloudflare: the SQLite database built into a Durable Object.
// It offers the small part of the better-sqlite3 API this app uses
// (prepare().get/all/run, exec, transaction), so the rest of the code is unchanged.
import SCHEMA_SQL from './schema.sql';

export { SCHEMA_SQL };

/** Turn @name / :name / $name parameters into ? and remember their order. */
function compile(sql) {
  let out = '';
  const names = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === "'" || c === '"') {                       // string or quoted name: copy as is
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {               // comment
      const j = sql.indexOf('\n', i); const e = j < 0 ? sql.length : j;
      out += sql.slice(i, e); i = e; continue;
    }
    if ((c === '@' || c === ':' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j++;
      names.push(sql.slice(i + 1, j)); out += '?'; i = j; continue;
    }
    out += c; i++;
  }
  return { text: out, names: names.length ? names : null };
}

const toValue = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);

/** Same shape as better-sqlite3 errors: constraint errors get err.code, trigger messages stay exact. */
function translate(e) {
  const msg = String(e?.message || e);
  const m = /^(.*?): (SQLITE_[A-Z]+)(?: \(extended: (SQLITE_[A-Z_]+)\))?$/s.exec(msg);
  if (!m) return e;
  const err = new Error(m[1]);
  err.code = m[3] || m[2];
  return err;
}

class Statement {
  constructor(db, sql) { this.db = db; this.src = sql; Object.assign(this, compile(sql)); }
  bind(args) {
    if (this.names) {
      const o = args[0] || {};
      return this.names.map((n) => {
        if (!(n in o)) throw new RangeError(`Missing named parameter "${n}"`);
        return toValue(o[n]);
      });
    }
    const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return list.map(toValue);
  }
  cursor(args) {
    try { return this.db.sql.exec(this.text, ...this.bind(args)); } catch (e) { throw translate(e); }
  }
  rows(args) {
    const c = this.cursor(args);
    const cols = c.columnNames;
    const out = [];
    try {
      for (const raw of c.raw()) {
        const o = {};
        for (let i = 0; i < cols.length; i++) o[cols[i]] = raw[i]; // like better-sqlite3: last same-named column wins
        out.push(o);
      }
    } catch (e) { throw translate(e); }
    return out;
  }
  get(...args) { return this.rows(args)[0]; }
  all(...args) { return this.rows(args); }
  run(...args) {
    this.rows(args);
    const { c, id } = this.db.sql.exec('SELECT changes() AS c, last_insert_rowid() AS id').one();
    return { changes: c, lastInsertRowid: id };
  }
}

// Cloudflare can restart the Durable Object at any time (e.g. after being idle);
// each new instance brings its own storage handle, so always use the current one.
const storageNow = () => {
  const s = globalThis.__ERP_STORAGE;
  if (!s) throw new Error('Durable Object storage is not ready');
  return s;
};

class DurableSqlite {
  constructor() {
    this.kind = 'durable-object';
    this.sql.exec('CREATE TABLE IF NOT EXISTS _erp_meta (key TEXT PRIMARY KEY, value TEXT)');
  }
  get storage() { return storageNow(); }
  get sql() { return storageNow().sql; }
  prepare(sql) { return new Statement(this, sql); }
  exec(sql) {
    try { this.sql.exec(sql); } catch (e) { throw translate(e); }
    return this;
  }
  transaction(fn) {
    return (...args) => this.storage.transactionSync(() => fn(...args));
  }
  /** Only the pragmas the app uses; the rest are fixed by Cloudflare. */
  pragma(text, opts) {
    const t = String(text).trim();
    if (/^user_version/i.test(t)) {
      const m = /=\s*(\d+)/.exec(t);
      if (m) { this.setVersion(Number(m[1])); return []; }
      return opts?.simple ? this.getVersion() : [{ user_version: this.getVersion() }];
    }
    if (/^(journal_mode|busy_timeout|foreign_keys\s*=)/i.test(t)) return [];
    const rows = this.prepare(`PRAGMA ${t}`).all();
    return opts?.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
  }
  getVersion() {
    return Number(this.sql.exec("SELECT value FROM _erp_meta WHERE key = 'schema_version'").toArray()[0]?.value || 0);
  }
  setVersion(v) {
    this.sql.exec("INSERT INTO _erp_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(v));
  }
}

export function openDatabase() {
  return new DurableSqlite();
}
