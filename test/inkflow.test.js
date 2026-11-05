const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const inkflow = require('../electron/inkflow');

const SECRET = 'test-secret-0123456789abcdef';

// Same checks InkFlow's requireInkSignService() makes (via jose): HS256, iss/aud, not expired.
function verify(tok, secret) {
  const [h, p, s] = String(tok || '').split('.');
  if (!s) return false;
  const want = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (want !== s) return false;
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  const pay = JSON.parse(Buffer.from(p, 'base64url'));
  const now = Date.now() / 1000;
  return head.alg === 'HS256' && pay.iss === 'inksign' && pay.aud === 'inkflow' && pay.exp > now && pay.iat <= now + 30;
}

function fakeInkFlow() {
  const reports = [];
  const srv = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/apps/inksign/version') return json(200, { version: '9.9.9', notes: 'new' });
    if (req.url.startsWith('/api/files/')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg/>'); }
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!verify(tok, SECRET)) return json(401, { error: 'Invalid or expired token — check INKSIGN_SHARED_SECRET matches on both apps.' });
    if (req.url === '/api/inksign/service/ping') return json(200, { ok: true, shop: 'The Ink Stop' });
    if (req.url === '/api/inksign/service/orders') return json(200, { orders: [{ id: 'o1', number: 1042, customer: 'Miller', items: [{ id: 'i1', name: 'Yard sign', files: [{ name: 'logo.svg', url: '/api/files/orders/o1/logo.svg' }] }] }] });
    const m = req.url.match(/^\/api\/inksign\/service\/orders\/([^/]+)\/status$/);
    if (m && req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { reports.push({ id: m[1], body: JSON.parse(b) }); json(200, { ok: true }); });
      return;
    }
    json(404, { error: 'not found' });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}`, reports })));
}

test('token is a valid HS256 JWT for iss=inksign aud=inkflow', () => {
  assert.ok(verify(inkflow.token(SECRET), SECRET));
  assert.ok(!verify(inkflow.token(SECRET), 'some-other-secret-123456'));
});

test('connects, lists orders, downloads artwork and reports status', async () => {
  const { srv, url, reports } = await fakeInkFlow();
  const cfg = { url, secret: SECRET };
  try {
    assert.match(await inkflow.test(cfg), /Connected to The Ink Stop — 1 order in production/);
    const orders = await inkflow.listOrders(cfg);
    assert.strictEqual(orders[0].number, 1042);
    const f = await inkflow.downloadFile(cfg, orders[0].items[0].files[0]);
    assert.strictEqual(f.name, 'logo.svg');
    assert.strictEqual(f.buf.toString(), '<svg/>');
    await inkflow.reportStatus(cfg, 'o1', { itemId: 'i1', status: 'cut', note: 'x' });
    assert.deepStrictEqual(reports, [{ id: 'o1', body: { itemId: 'i1', status: 'cut', note: 'x' } }]);
    assert.strictEqual((await inkflow.latestVersion(cfg)).version, '9.9.9');
  } finally { srv.close(); }
});

test('wrong secret gives InkFlow\'s message; missing setup is explained', async () => {
  const { srv, url } = await fakeInkFlow();
  try {
    await assert.rejects(inkflow.listOrders({ url, secret: 'wrong-secret-0123456789' }), /INKSIGN_SHARED_SECRET/);
    await assert.rejects(inkflow.listOrders({ url, secret: '' }), /shared secret/i);
    await assert.rejects(inkflow.listOrders({ url: '', secret: SECRET }), /InkFlow address/);
  } finally { srv.close(); }
});
