export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

/** Parse a positive number or throw a friendly 400. */
export function num(v, label, { min = 0, allowZero = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (!allowZero && n === 0)) throw bad(`Please enter a valid ${label}`);
  return n;
}

export function date(v) {
  if (!v) return new Date().toLocaleDateString('en-CA');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Invalid date');
  return v;
}

export function required(v, label) {
  if (v === undefined || v === null || String(v).trim() === '') throw bad(`${label} is required`);
  return typeof v === 'string' ? v.trim() : v;
}
