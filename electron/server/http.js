// Network API of the InkSign Print Server, used by InkSign on the other shop PCs (like Command
// WorkStation talking to a Fiery). Every request carries the server key shown in
// Settings → Print server on the server PC.
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 700 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Job is too big to send (700 MB limit)'), { status: 413 })); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Bad request'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function start({ server, port, getKey, version, log, asUser }) {
  const srv = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p === '/api/ping') return send(200, { ok: true, app: 'InkSign Print Server', version, name: server.config().serverName });
      if (!safeEqual(req.headers['x-inksign-key'], getKey())) return send(401, { error: 'Wrong print server key — copy it from Settings → Print server on the server PC' });
      const user = String(req.headers['x-inksign-user'] || '').slice(0, 40) || null;
      const run = (fn) => (asUser ? asUser(user, fn) : fn());
      let m;
      if (req.method === 'GET' && p === '/api/state') return send(200, server.state());
      if (req.method === 'GET' && p === '/api/capabilities') return send(200, server.capabilities());
      if (req.method === 'POST' && p === '/api/jobs') {
        const b = await readBody(req);
        const job = await run(() => server.submit({
          name: b.name, user: b.user || user, from: b.from || req.socket.remoteAddress?.replace(/^::ffff:/, ''), props: b.props, hold: !!b.hold, inkflow: b.inkflow || null,
          pdf: b.pdf ? Buffer.from(b.pdf, 'base64') : null, ps: b.ps ? Buffer.from(b.ps, 'base64') : null, source: b.source || 'inksign',
        }));
        return send(200, job);
      }
      if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/action$/)) && req.method === 'POST') {
        const b = await readBody(req);
        return send(200, await run(() => server.action(m[1], b.act, b.arg)));
      }
      if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/props$/)) && req.method === 'PUT') {
        const b = await readBody(req);
        return send(200, await run(() => server.setProps(m[1], b.props, b.name)));
      }
      if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/preview$/)) && req.method === 'POST') {
        const b = await readBody(req);
        return send(200, await server.preview(m[1], b.props || null));
      }
      if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/thumb$/)) && req.method === 'GET') {
        const png = server.thumb(m[1]);
        return png ? send(200, png, 'image/png') : send(404, { error: 'No thumbnail' });
      }
      if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/file$/)) && req.method === 'GET') return send(200, server.original(m[1]), 'application/pdf');
      if (req.method === 'POST' && p === '/api/check') { const b = await readBody(req); return send(200, { problems: server.checkProps(b.props || {}) }); }
      if (req.method === 'PUT' && p === '/api/catalog') { const b = await readBody(req); return send(200, run(() => server.saveCatalog(b.list))); }
      if (req.method === 'PUT' && p === '/api/trays') { const b = await readBody(req); return send(200, run(() => server.saveTrays(b.trays))); }
      if (req.method === 'POST' && p === '/api/pause') { const b = await readBody(req); return send(200, { paused: server.setPaused(b.paused) }); }
      return send(404, { error: 'Not found' });
    } catch (e) {
      return send(e.status || 500, { error: e.message });
    }
  });
  srv.on('error', (e) => log && log(`Print server network port ${port}: ${e.message}`));
  srv.listen(port, '0.0.0.0');
  return srv;
}

module.exports = { start };
