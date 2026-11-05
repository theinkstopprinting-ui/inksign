// Talks to the InkSign Print Server on another PC — same functions as the local server, so the
// Job Center page works the same on every shop PC.
function make({ address, key, user }) {
  const base = /^https?:\/\//i.test(address) ? address.replace(/\/+$/, '') : `http://${String(address || '').trim().replace(/\/+$/, '')}`;
  const withPort = /:\d+$/.test(base) ? base : `${base}:8631`;
  async function call(method, p, body, { raw = false, timeoutMs = 60000 } = {}) {
    if (!address) throw new Error('Set the print server address in Settings → Print server');
    let res;
    try {
      res = await fetch(`${withPort}${p}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-inksign-key': key || '', 'x-inksign-user': user ? user() || '' : '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Can't reach the print server at ${withPort.replace(/^https?:\/\//, '')} — is InkSign open on that PC? (${e.cause?.code || e.message})`);
    }
    if (!res.ok) {
      let msg = `Print server error ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      throw new Error(msg);
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    return res.json();
  }
  return {
    remote: true,
    address: withPort,
    ping: () => call('GET', '/api/ping'),
    state: () => call('GET', '/api/state'),
    capabilities: () => call('GET', '/api/capabilities'),
    submit: (j) => call('POST', '/api/jobs', {
      name: j.name, user: j.user, from: j.from, props: j.props, hold: j.hold, inkflow: j.inkflow, source: j.source,
      pdf: j.pdf ? Buffer.from(j.pdf).toString('base64') : undefined, ps: j.ps ? Buffer.from(j.ps).toString('base64') : undefined,
    }, { timeoutMs: 15 * 60 * 1000 }),
    action: (id, act, arg) => call('POST', `/api/jobs/${id}/action`, { act, arg }, { timeoutMs: 15 * 60 * 1000 }),
    setProps: (id, props, name) => call('PUT', `/api/jobs/${id}/props`, { props, name }),
    preview: (id, props) => call('POST', `/api/jobs/${id}/preview`, { props: props || null }, { timeoutMs: 5 * 60 * 1000 }),
    checkProps: async (props) => (await call('POST', '/api/check', { props })).problems,
    thumb: (id) => call('GET', `/api/jobs/${id}/thumb`, null, { raw: true }).catch(() => null),
    original: (id) => call('GET', `/api/jobs/${id}/file`, null, { raw: true, timeoutMs: 5 * 60 * 1000 }),
    saveCatalog: (list) => call('PUT', '/api/catalog', { list }),
    saveTrays: (trays) => call('PUT', '/api/trays', { trays }),
    setPaused: async (paused) => (await call('POST', '/api/pause', { paused })).paused,
    profPatches: (kind, n) => call('GET', `/api/profiling/patches?kind=${encodeURIComponent(kind || 'main')}&n=${encodeURIComponent(n || '')}`),
    profTopups: () => call('GET', '/api/profiling/topups'),
    profChart: (o) => call('POST', '/api/profiling/chart', o, { timeoutMs: 5 * 60 * 1000 }),
    profCheck: (o) => call('POST', '/api/profiling/check', o, { timeoutMs: 5 * 60 * 1000 }),
    profBuild: (o) => call('POST', '/api/profiling/build', o, { timeoutMs: 10 * 60 * 1000 }),
    profTopupBuild: (o) => call('POST', '/api/profiling/topup-build', o, { timeoutMs: 10 * 60 * 1000 }),
  };
}

module.exports = { make };
