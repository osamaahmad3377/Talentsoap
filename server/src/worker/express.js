// A small stand-in for Express on Cloudflare Workers. It covers exactly what this
// app uses (routers, middleware, params, query, JSON bodies, cookies, error
// handlers), so the same route files run on a computer (real Express) and here.

function pathRegex(path, end) {
  const keys = [];
  if (path === '*' || path === '/*') return { re: /^.*$/, keys };
  const clean = path === '/' ? '' : path.replace(/\/$/, '');
  const src = clean.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+?)'; });
  return { re: new RegExp(`^${src}${end ? '/?$' : '(?=/|$)'}`, 'i'), keys };
}

function run(fn, err, req, res, next) {
  try {
    const out = err ? fn(err, req, res, next) : fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
}

export function Router() {
  const stack = [];
  const router = (req, res, next) => router.handle(req, res, next);
  router.stack = stack;
  router.use = (...args) => {
    const paths = typeof args[0] === 'string' || Array.isArray(args[0]) ? [].concat(args.shift()) : ['/'];
    for (const p of paths) for (const fn of args.flat()) stack.push({ method: null, route: false, fn, ...pathRegex(p, false) });
    return router;
  };
  for (const m of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
    router[m] = (path, ...fns) => {
      for (const fn of fns.flat()) stack.push({ method: m === 'all' ? null : m.toUpperCase(), route: true, fn, ...pathRegex(path, true) });
      return router;
    };
  }
  router.handle = (req, res, done) => {
    let i = 0;
    const path0 = req.path, base0 = req.baseUrl;
    const next = (err) => {
      req.path = path0; req.baseUrl = base0;
      if (err === 'route' || err === 'router') err = undefined;
      if (res.finished) return;
      while (i < stack.length) {
        const L = stack[i++];
        if (L.method && L.method !== req.method && !(L.method === 'GET' && req.method === 'HEAD')) continue;
        const m = L.re.exec(req.path);
        if (!m) continue;
        const isErrHandler = L.fn.length === 4;
        if (Boolean(err) !== isErrHandler) continue;
        if (L.route) {
          req.params = Object.fromEntries(L.keys.map((k, j) => [k, decodeURIComponent(m[j + 1])]));
        } else if (m[0]) {
          req.baseUrl = base0 + m[0];
          req.path = req.path.slice(m[0].length) || '/';
        }
        return run(L.fn, err, req, res, next);
      }
      done(err);
    };
    next();
  };
  return router;
}

class Res {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.body = null;
    this.finished = false;
    this.done = new Promise((r) => { this.resolve = r; });
  }
  get headersSent() { return this.finished; }
  status(c) { this.statusCode = c; return this; }
  set(k, v) {
    if (typeof k === 'object') for (const [a, b] of Object.entries(k)) this.headers.set(a, String(b));
    else this.headers.set(k, String(v));
    return this;
  }
  setHeader(k, v) { return this.set(k, v); }
  get(k) { return this.headers.get(k); }
  json(o) {
    if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/json; charset=utf-8');
    return this.send(JSON.stringify(o));
  }
  send(b) {
    if (this.finished) return this;
    if (typeof b === 'object' && b !== null && !(b instanceof ArrayBuffer) && !ArrayBuffer.isView(b)) return this.json(b);
    this.body = b ?? null; this.finished = true; this.resolve();
    return this;
  }
  end(b) { return this.send(b); }
  sendStatus(c) { return this.status(c).send(String(c)); }
  cookie(name, value, o = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=${o.path || '/'}`;
    if (o.maxAge != null) c += `; Max-Age=${Math.floor(o.maxAge / 1000)}; Expires=${new Date(Date.now() + o.maxAge).toUTCString()}`;
    if (o.httpOnly) c += '; HttpOnly';
    if (o.secure) c += '; Secure';
    if (o.sameSite) c += `; SameSite=${o.sameSite === true ? 'Strict' : o.sameSite[0].toUpperCase() + o.sameSite.slice(1)}`;
    this.headers.append('set-cookie', c);
    return this;
  }
  clearCookie(name, o = {}) {
    this.headers.append('set-cookie', `${name}=; Path=${o.path || '/'}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    return this;
  }
  toResponse() {
    const empty = this.statusCode === 204 || this.statusCode === 304;
    return new Response(empty ? null : this.body, { status: this.statusCode, headers: this.headers });
  }
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function httpError(status, type, message) {
  const e = new Error(message); e.status = status; e.type = type; return e;
}

function json({ limit = '100kb' } = {}) {
  const units = { b: 1, kb: 1024, mb: 1024 ** 2 };
  const m = /^(\d+)\s*(b|kb|mb)$/i.exec(String(limit));
  const max = m ? Number(m[1]) * units[m[2].toLowerCase()] : 100 * 1024;
  return (req, res, next) => {
    if (req._body) return next();
    req.body = req.body || {};
    if (!/application\/json/i.test(req.headers['content-type'] || '') || req.rawBody == null || req.rawBody === '') return next();
    req._body = true;
    if (new TextEncoder().encode(req.rawBody).length > max) return next(httpError(413, 'entity.too.large', 'request entity too large'));
    try { req.body = JSON.parse(req.rawBody); } catch { return next(httpError(400, 'entity.parse.failed', 'Invalid JSON')); }
    next();
  };
}

export default function express() {
  const app = Router();
  app.disable = () => app;
  app.enable = () => app;
  app.set = () => app;
  /** Turn a Fetch Request into a response by running it through the app. */
  app.fetch = async (request) => {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    const query = {};
    for (const k of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(k);
      query[k] = all.length > 1 ? all : all[0];
    }
    const req = {
      method: request.method.toUpperCase(),
      url: url.pathname + url.search, originalUrl: url.pathname + url.search,
      path: decodeURI(url.pathname), baseUrl: '', query, params: {}, headers,
      cookies: parseCookies(headers.cookie),
      secure: url.protocol === 'https:' || /"scheme":"https"/.test(headers['cf-visitor'] || ''),
      protocol: url.protocol.replace(':', ''),
      ip: headers['cf-connecting-ip'] || '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }, // every request reaches us through Cloudflare
      get(name) { return headers[String(name).toLowerCase()]; },
      header(name) { return headers[String(name).toLowerCase()]; },
      rawBody: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
    };
    const res = new Res();
    app.handle(req, res, (err) => {
      if (res.finished) return;
      if (err) { console.error(err); res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' }); }
      else res.status(404).json({ error: 'Not found' });
    });
    await res.done;
    return res.toResponse();
  };
  return app;
}

express.json = json;
express.Router = Router;
express.static = () => (req, res, next) => next();
