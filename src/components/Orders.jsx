import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Checked top to bottom; the first match wins, so the most specific come first.
const TARGETS = [
  { id: 'printcut', label: 'Print & Cut', kinds: ['sticker', 'label', 'print & cut', 'print and cut', 'contour', 'die-cut', 'die cut', 'kiss cut'] },
  { id: 'studio', label: 'Cut Studio', kinds: ['vinyl', 'decal', 'lettering', 'heat transfer', 'htv', 'cut vinyl'] },
  { id: 'wide', label: 'Wide Format', kinds: ['banner', 'sign', 'rigid', 'coroplast', 'canvas', 'poster', 'wide', 'mesh'] },
  { id: 'press', label: 'Press (Xerox)', kinds: ['card', 'flyer', 'postcard', 'brochure', 'booklet', 'paper', 'xerox', 'menu'] },
];

function guessTarget(item) {
  const t = `${item.product || ''} ${item.name || ''} ${item.type || ''}`.toLowerCase();
  return (TARGETS.find((x) => x.kinds.some((k) => t.includes(k))) || TARGETS[2]).id;
}

const DONE = ['done', 'printed', 'cut'];

export default function Orders({ openIn, focusOrder, goSettings }) {
  const [orders, setOrders] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('');
  const [hideDone, setHideDone] = useState(false);
  const [targets, setTargets] = useState({});

  const load = async (id) => {
    setErr('');
    try { setOrders(await api.inkflow.orders(id)); } catch (e) { setErr(clean(e.message)); setOrders([]); }
  };
  useEffect(() => {
    // inksign://order/<id> from InkFlow: load that order even if it isn't in production, and show just it
    if (focusOrder?.id) { setFilter(focusOrder.id); load(focusOrder.id); } else load();
  }, [focusOrder]);

  const q = filter.trim().toLowerCase();
  const shown = (orders || [])
    .filter((o) => !q || `${o.number} ${o.customer} ${o.nickname || ''} ${o.id}`.toLowerCase().includes(q))
    .filter((o) => !hideDone || (o.items || []).some((it) => !DONE.includes(it.status)));

  const send = async (order, item) => {
    const target = targets[`${order.id}:${item.id}`] || guessTarget(item);
    setBusy(`${order.id}:${item.id}`);
    setErr('');
    try {
      const files = await api.inkflow.files(item.files || []);
      openIn(target, {
        files, item, order,
        name: `${order.number} ${item.name || ''}`.trim(),
        inkflow: { orderId: order.id, itemId: item.id, status: target === 'studio' ? 'cut' : target === 'printcut' ? 'cut' : 'printed' },
      });
    } catch (e) { setErr(clean(e.message)); }
    setBusy('');
  };
  const mark = async (order, item, status) => {
    try { await api.inkflow.report(order.id, { itemId: item.id, status, note: 'Marked in InkSign' }); load(focusOrder?.id); } catch (e) { setErr(clean(e.message)); }
  };

  const notSetUp = err && /Settings|secret|address/i.test(err);

  return (
    <div>
      <header className="page-head">
        <div><h1>Orders</h1><p className="muted">Orders in production in InkFlow. Open an item's artwork in the right tool — it's marked printed / cut on the order when the job finishes.</p></div>
        <div className="row">
          <input className="btn" placeholder="Search orders…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check small"><input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide finished</label>
          <button className="btn" onClick={() => load(focusOrder?.id)}>Refresh</button>
        </div>
      </header>
      {err && (
        <div className="empty" style={{ textAlign: 'left' }}>
          <b>{notSetUp ? 'InkFlow isn\'t connected yet.' : 'Couldn\'t load orders.'}</b>
          <div className="muted">{err}</div>
          <button className="btn small" style={{ marginTop: 10 }} onClick={goSettings}>Open Settings</button>
        </div>
      )}
      {orders === null && !err && <div className="empty">Loading orders…</div>}
      {orders && !err && !shown.length && <div className="empty">{q ? 'No orders match.' : 'No orders in production.'}</div>}
      <div className="orders">
        {shown.map((o) => (
          <div className="card" key={o.id}>
            <div className="card-top">
              <div>
                <div className="card-title">{o.number} — {o.customer}{o.nickname ? <span className="muted"> · {o.nickname}</span> : null}</div>
                <div className="muted small">
                  {o.dueDate ? `Due ${new Date(o.dueDate).toLocaleDateString()}` : 'No due date'}{o.status ? ` · ${o.status}` : ''}
                </div>
                {o.notes && <div className="small" style={{ marginTop: 4 }}>{o.notes}</div>}
              </div>
            </div>
            <table className="table order-items">
              <tbody>
                {(o.items || []).map((it) => {
                  const key = `${o.id}:${it.id}`;
                  const target = targets[key] || guessTarget(it);
                  const nFiles = (it.files || []).length;
                  return (
                    <tr key={it.id}>
                      <td>
                        <b>{it.name}</b>
                        <div className="muted small">{[it.qty && `Qty ${it.qty}`, it.widthIn && it.heightIn && `${it.widthIn}×${it.heightIn}"`, it.material, it.finishing].filter(Boolean).join(' · ')}</div>
                        {it.notes && <div className="small">{it.notes}</div>}
                      </td>
                      <td className="muted small nowrap" title={(it.files || []).map((f) => f.name).join('\n')}>{nFiles} file{nFiles === 1 ? '' : 's'}</td>
                      <td><span className={`pill pill-job-${DONE.includes(it.status) ? 'done' : 'queued'}`}>{it.status || 'to do'}</span></td>
                      <td className="nowrap">
                        <select className="btn small" value={target} onChange={(e) => setTargets((t) => ({ ...t, [key]: e.target.value }))}>
                          {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>{' '}
                        <button className="btn primary small" disabled={!!busy || !nFiles} onClick={() => send(o, it)}>
                          {busy === key ? 'Loading…' : 'Open'}
                        </button>{' '}
                        <button className="btn ghost small" onClick={() => mark(o, it, 'done')}>Mark done</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
