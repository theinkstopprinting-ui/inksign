// Link to InkFlow (the shop's order system), the same way InkRIP and DTF Prep connect:
// every call carries a short-lived token signed with a shared secret
// (INKSIGN_SHARED_SECRET on InkFlow's Railway variables = "Shared secret" in InkSign Settings).
//
//   GET  {url}/api/inksign/service/ping                     -> { ok, shop }
//   GET  {url}/api/inksign/service/orders                   -> { orders: [...] }  (in production)
//   GET  file urls from the orders (/api/files/...)         -> artwork bytes
//   POST {url}/api/inksign/service/orders/{id}/status       <- { itemId, status, note, job, cost, sqft }
//   GET  {url}/api/apps/inksign/version                     -> { version }  (public, for update checks)
const crypto = require('crypto');

const TOKEN_SECONDS = 120;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// HS256 JWT: iss=inksign, aud=inkflow — what InkFlow's requireInkSignService() checks.
function token(secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ purpose: 'service', iss: 'inksign', aud: 'inkflow', iat: now, exp: now + TOKEN_SECONDS, jti: crypto.randomUUID() }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function base(cfg) {
  const url = String(cfg.url || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Set the InkFlow address in Settings.');
  if (!/^https?:\/\//i.test(url)) throw new Error('The InkFlow address must start with https://');
  return url;
}

function secretOf(cfg) {
  const s = String(cfg.secret || '').trim();
  if (!s) throw new Error('Set the shared secret in Settings (Railway → InkFlow → Variables → INKSIGN_SHARED_SECRET).');
  if (s.length < 16) throw new Error('The shared secret is too short — it must be at least 16 characters, same as INKSIGN_SHARED_SECRET.');
  return s;
}

async function call(cfg, pathOrUrl, init = {}) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : base(cfg) + pathOrUrl;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token(secretOf(cfg))}`,
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(init.timeoutMs || 30000),
    });
  } catch (e) {
    if (/secret|address/i.test(e.message)) throw e;
    throw new Error(`Can't reach InkFlow at ${base(cfg)} — ${e.cause?.code || e.message}`);
  }
  if (res.status === 401) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch { /* not json */ }
    throw new Error(msg || 'InkFlow refused the shared secret.');
  }
  if (res.status === 404) throw new Error('InkFlow doesn\'t have the InkSign link yet — it needs the InkSign update posted to InkFlow.');
  if (!res.ok) throw new Error(`InkFlow answered ${res.status}`);
  return res;
}

async function listOrders(cfg, id, q) {
  const qs = id ? `?id=${encodeURIComponent(id)}` : q ? `?q=${encodeURIComponent(q)}` : '';
  const res = await call(cfg, `/api/inksign/service/orders${qs}`);
  const j = await res.json();
  return Array.isArray(j) ? j : (j.orders || []);
}

async function downloadFile(cfg, file) {
  const res = await call(cfg, file.url, { timeoutMs: 120000 });
  const buf = Buffer.from(await res.arrayBuffer());
  const name = file.name || decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'artwork');
  return { name, buf };
}

async function reportStatus(cfg, orderId, payload) {
  await call(cfg, `/api/inksign/service/orders/${encodeURIComponent(orderId)}/status`, { method: 'POST', body: JSON.stringify(payload) });
}

// Attach a proof (PDF layout or PNG mockup) to an order's files in InkFlow.
async function sendProof(cfg, orderId, { name, note, bytes }) {
  const isPdf = bytes.subarray(0, 4).toString('latin1') === '%PDF';
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: isPdf ? 'application/pdf' : 'image/png' }), name);
  fd.append('data', JSON.stringify({ name, note }));
  const res = await call(cfg, `/api/inksign/service/orders/${encodeURIComponent(orderId)}/proof`, { method: 'POST', body: fd, timeoutMs: 120000 });
  return res.json();
}

const post = async (cfg, p, body) => (await call(cfg, p, { method: 'POST', body: JSON.stringify(body) })).json();

// Quotes, costs and roll stock (InkFlow's Inventory → sign rolls)
async function customers(cfg, q) { return (await (await call(cfg, `/api/inksign/service/customers?q=${encodeURIComponent(q || '')}`)).json()).customers || []; }
const createQuote = (cfg, body) => post(cfg, '/api/inksign/service/quotes', body);
const addItems = (cfg, orderId, lines) => post(cfg, `/api/inksign/service/orders/${encodeURIComponent(orderId)}/items`, { lines });
const addCost = (cfg, orderId, body) => post(cfg, `/api/inksign/service/orders/${encodeURIComponent(orderId)}/cost`, body);
async function rolls(cfg) { return (await call(cfg, '/api/inksign/service/rolls')).json(); }
const rollUsage = (cfg, rollId, body) => post(cfg, `/api/inksign/service/rolls/${encodeURIComponent(rollId)}/usage`, body);

async function test(cfg) {
  const res = await call(cfg, '/api/inksign/service/ping');
  const j = await res.json().catch(() => ({}));
  const orders = await listOrders(cfg);
  return `Connected to ${j.shop || 'InkFlow'} — ${orders.length} order${orders.length === 1 ? '' : 's'} in production.`;
}

// Public — no secret needed. Returns null when nothing has been posted.
async function latestVersion(cfg) {
  const res = await fetch(`${base(cfg)}/api/apps/inksign/version`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const j = await res.json();
  return j && j.version ? j : null;
}

module.exports = { listOrders, downloadFile, reportStatus, sendProof, customers, createQuote, addItems, addCost, rolls, rollUsage, test, latestVersion, token };
