// Financial year helpers + request middleware.
import { db, today } from './db.js';
import { HttpError } from './errors.js';

const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const fyForDate = (d) => db.prepare('SELECT * FROM financial_years WHERE ? BETWEEN start_date AND end_date').get(d);
export const getFy = (id) => db.prepare('SELECT * FROM financial_years WHERE id = ?').get(Number(id));

/** active | upcoming | ended (not closed yet) | closed */
export function fyState(fy, t = today()) {
  if (fy.status === 'closed') return 'closed';
  if (t < fy.start_date) return 'upcoming';
  if (t > fy.end_date) return 'ended';
  return 'active';
}

/** The year people work in by default: the one containing today, else the latest open one. */
export function currentFy() {
  return fyForDate(today())
    || db.prepare("SELECT * FROM financial_years WHERE status = 'open' ORDER BY start_date DESC LIMIT 1").get()
    || db.prepare('SELECT * FROM financial_years ORDER BY start_date DESC LIMIT 1').get();
}

/** "Today" as seen from inside a year: today, clamped to the year's dates. */
export function asOfFor(fy) {
  const t = today();
  return t < fy.start_date ? fy.start_date : t > fy.end_date ? fy.end_date : t;
}

/** Throw a friendly error unless the date is inside an open financial year. */
export function assertOpenDate(d, what = 'This entry') {
  const fy = fyForDate(d);
  if (!fy) throw new HttpError(400, `No financial year covers ${fmt(d)}. Add it under Financial Years first.`);
  if (fy.status === 'closed') throw new HttpError(400, `${fy.name} is closed and locked. ${what} dated ${fmt(d)} cannot be added, changed or deleted.`);
  return fy;
}

// Requests that change data but are allowed while viewing a closed year
const ALLOWED_WHEN_READ_ONLY = ['/financial-years', '/auth', '/settings', '/users', '/hr/settings'];

/**
 * Express middleware: the year being viewed comes from the X-Fiscal-Year header
 * (sent by the year switcher). Sets req.fy (with .state) and req.asOf. Viewing a
 * closed year is read-only: changes are refused here, and again by the database triggers.
 */
export function fyContext(req, res, next) {
  const id = Number(req.get('x-fiscal-year'));
  const fy = (id && getFy(id)) || currentFy();
  if (fy) {
    req.fy = { ...fy, state: fyState(fy) };
    req.asOf = asOfFor(fy);
    if (fy.status === 'closed' && req.method !== 'GET' && !ALLOWED_WHEN_READ_ONLY.some((p) => req.path.startsWith(p))) {
      return res.status(403).json({ error: `You are viewing ${fy.name}, which is closed (read-only). Switch to the current year to make changes.` });
    }
  } else {
    req.asOf = today();
  }
  next();
}
