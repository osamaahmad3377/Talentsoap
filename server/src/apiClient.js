// Tiny in-process HTTP client used by the seed script and tests.
export async function startClient(app, { username = 'admin', password = process.env.ADMIN_PASSWORD || 'admin123' } = {}) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie, ...(api.fy ? { 'x-fiscal-year': String(api.fy) } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`${method} ${url} -> ${res.status}: ${data.error}`); e.status = res.status; e.data = data; throw e; }
    return data;
  };
  const api = {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b || {}), del: (u) => call('DELETE', u),
    close: () => new Promise((r) => server.close(r)),
    base, fy: null, // set to a financial year id to act as the year switcher
  };
  await api.post('/auth/login', { username, password });
  return api;
}
