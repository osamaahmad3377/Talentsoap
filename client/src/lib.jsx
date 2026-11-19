import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---------- API -------------------------------------------------------
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Financial year being viewed ---------------------------------
// Set by the year switcher. Sent with every request; also makes today()/thisMonth()
// default to that year (its last day for a past year), so every page is scoped to it.
let FY = null;
export const setActiveFY = (fy) => { FY = fy; };
export const activeFY = () => FY;
const READ_ONLY_OK = ['/auth/', '/financial-years', '/settings', '/users'];

async function request(method, url, body) {
  if (FY?.readOnly && method !== 'GET' && !READ_ONLY_OK.some((p) => url.startsWith(p))) {
    throw new ApiError(403, `${FY.name} is closed — it is read-only. Switch to the current year to make changes.`);
  }
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(FY ? { 'X-Fiscal-Year': String(FY.id) } : {}) };
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('auth:expired'));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Something went wrong');
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};

/** Load data from the API. Returns { data, loading, error, reload, setData }. */
export function useFetch(url, deps = []) {
  const [state, setState] = useState({ data: null, loading: !!url, error: null });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(url)
      .then((data) => n === seq.current && setState({ data, loading: false, error: null }))
      .catch((e) => n === seq.current && setState({ data: null, loading: false, error: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(load, [load]);
  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

// ---------- App context (user, settings, toasts) -----------------------
const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = logged out
  const [toasts, setToasts] = useState([]);
  const [fyData, setFyData] = useState(null); // { years, current_id }
  const [fy, setFy] = useState(null); // year being viewed

  const refreshMe = useCallback(() => api.get('/auth/me').then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { refreshMe(); }, [refreshMe]);

  const choose = useCallback((years, currentId, id) => {
    const y = years.find((x) => x.id === Number(id)) || years.find((x) => x.id === currentId) || years[0];
    if (!y) { setActiveFY(null); setFy(null); return; }
    const v = { ...y, readOnly: y.status === 'closed', isCurrent: y.id === currentId };
    setActiveFY(v); // before children render, so their first requests are scoped
    setFy(v);
    try { localStorage.setItem('fyId', String(y.id)); } catch { /* private mode */ }
  }, []);
  const loadYears = useCallback(async (keepId) => {
    setActiveFY(null);
    const d = await api.get('/financial-years');
    let saved = keepId;
    try { saved ??= localStorage.getItem('fyId'); } catch { /* ignore */ }
    setFyData(d);
    choose(d.years, d.current_id, saved);
  }, [choose]);
  useEffect(() => { if (me) loadYears(); else { setActiveFY(null); setFy(null); setFyData(null); } }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const switchFY = useCallback((id) => fyData && choose(fyData.years, fyData.current_id, id), [fyData, choose]);
  useEffect(() => {
    const h = () => setMe(null);
    window.addEventListener('auth:expired', h);
    return () => window.removeEventListener('auth:expired', h);
  }, []);

  const toast = useCallback((msg, type = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 3000);
  }, []);

  const can = useCallback((role) => {
    const rank = { staff: 1, manager: 2, admin: 3 };
    return !!me && rank[me.role] >= rank[role];
  }, [me]);

  return (
    <AppCtx.Provider value={{ me, setMe, refreshMe, toast, can, settings: me?.settings || {}, fy, years: fyData?.years || [], currentFyId: fyData?.current_id, switchFY, reloadYears: () => loadYears(fy?.id) }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.type}`}>{t.type === 'error' ? '⚠️' : '✅'} {t.msg}</div>)}
      </div>
    </AppCtx.Provider>
  );
}

/** Wrap an async action: shows success/error toast and tracks busy state. */
export function useAction() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return undefined;
    } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

// ---------- Formatting -----------------------------------------------
const nf2 = new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const nf2d = new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function useMoney() {
  const { settings } = useApp();
  const cur = settings.currency || 'Rs';
  return (n, { sign = false } = {}) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const abs = Math.round(Math.abs(v) * 100) / 100;
    const s = `${cur} ${Number.isInteger(abs) ? nf0.format(abs) : nf2d.format(abs)}`;
    return v < 0 ? `−${s}` : sign && v > 0 ? `+${s}` : s;
  };
}
export const qty = (n, unit) => (n === null || n === undefined ? '—' : `${nf2.format(n)}${unit ? ' ' + unit : ''}`);
export const int = (n) => nf0.format(n || 0);
export const realToday = () => new Date().toLocaleDateString('en-CA');
/** "Today" inside the selected financial year (clamped to its dates). */
export const today = () => {
  const t = realToday();
  if (!FY) return t;
  return t < FY.start_date ? FY.start_date : t > FY.end_date ? FY.end_date : t;
};
export const thisMonth = () => today().slice(0, 7);
/** First month of the selected financial year — month navigators stop here. */
export const fyStartMonth = () => (FY ? FY.start_date.slice(0, 7) : '0000-00');
export function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(`${d.slice(0, 10)}T12:00:00`);
  return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const monthName = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
export const payLabel = (total, paid) => (paid >= total - 0.005 ? 'Cash' : paid > 0 ? 'Partial' : 'Credit');

export const KIND_LABEL = { raw: 'Raw Material', finished: 'Finished Goods', trading: 'Trading Item' };
