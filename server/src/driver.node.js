// Database driver for a normal computer: one SQLite file via better-sqlite3.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA_SQL = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

export function openDatabase() {
  const file = process.env.DB_FILE || path.join(here, '..', 'data', 'factory.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');   // safe concurrent reads while writing
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.kind = 'file';
  db.getVersion = () => db.pragma('user_version', { simple: true });
  db.setVersion = (v) => db.pragma(`user_version = ${Number(v)}`);
  return db;
}
