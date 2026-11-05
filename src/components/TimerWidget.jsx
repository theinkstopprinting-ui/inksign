import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const TASKS = ['Weeding', 'Masking / transfer tape', 'Application', 'Design / layout', 'Laminating', 'Trimming / finishing', 'Install', 'Other'];

// Labor timer in the sidebar: start on an order, stop when done → minutes × labor rate added to the order's costs in InkFlow.
export default function TimerWidget({ notice }) {
  const [t, setT] = useState({ running: [], log: [] });
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState(TASKS[0]);
  const [q, setQ] = useState('');
  const [orders, setOrders] = useState([]);
  const [order, setOrder] = useState(null);
  const [, tick] = useState(0);
  const load = async () => setT(await api.timers.list());
  useEffect(() => { load(); const i = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      try { const r = q.trim() ? await api.shopflow.searchOrders(q.trim()) : await api.inkflow.orders(); if (!cancelled) setOrders(r.slice(0, 12)); } catch { if (!cancelled) setOrders([]); }
    }, 300);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, open]);
  const start = async () => { setT(await api.timers.start({ task, orderId: order?.id || null, orderLabel: order ? `${order.number} ${order.customer}` : null })); setOpen(false); setOrder(null); setQ(''); };
  const stop = async (id, discard) => {
    try {
      const r = await api.timers.stop(id, { discard });
      setT(r.timers);
      if (r.entry) notice(`${r.entry.task}: ${r.entry.minutes} min ($${(r.entry.costCents / 100).toFixed(2)})${r.entry.sentToInkFlow ? ' added to the order in InkFlow' : r.entry.orderId ? '' : ' logged'}.${r.note ? ` ${r.note}` : ''}`);
    } catch (e) { notice(clean(e.message)); }
  };
  const mins = (s) => Math.floor((Date.now() - s) / 60000);
  return (
    <div className="timer-widget">
      {t.running.map((r) => (
        <div key={r.id} className="timer-run">
          <div><b>{r.task}</b> · {mins(r.start)} min<div className="muted small">{r.orderLabel || 'No order'} · {r.user}</div></div>
          <div className="row"><button className="btn small primary" onClick={() => stop(r.id)}>Stop</button><button className="btn ghost small" title="Discard" onClick={() => stop(r.id, true)}>✕</button></div>
        </div>
      ))}
      {!open && <button className="btn small wide" onClick={() => setOpen(true)}>⏱ Start a labor timer</button>}
      {open && (
        <div className="timer-new">
          <select value={task} onChange={(e) => setTask(e.target.value)}>{TASKS.map((x) => <option key={x}>{x}</option>)}</select>
          <input type="text" placeholder="Order # or customer…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="timer-orders">
            {orders.map((o) => <button key={o.id} className={`piece ${order?.id === o.id ? 'on' : ''}`} onClick={() => setOrder(o)}><span>{o.number} {o.customer}</span></button>)}
          </div>
          <div className="row"><button className="btn ghost small" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary small" onClick={start}>Start{order ? '' : ' (no order)'}</button></div>
        </div>
      )}
    </div>
  );
}
