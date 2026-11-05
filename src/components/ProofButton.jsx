import React, { useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// "Send proof to InkFlow": attaches the job's print PDF (or a mockup PNG) to an order's files,
// ready to send for approval from InkFlow. Uses the linked order, or lets you pick one.
export default function ProofButton({ order, makeProof, label = 'Send proof to InkFlow', disabled }) {
  const [picking, setPicking] = useState(false);
  const [orders, setOrders] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const send = async (orderId, labelText) => {
    setBusy(true); setMsg('');
    try {
      const proof = await makeProof();
      const r = await api.proof.send(orderId, proof);
      setMsg(`Attached "${r.name}" to ${labelText}. Send it for approval from InkFlow.`);
      setPicking(false);
    } catch (e) { setMsg(clean(e.message)); }
    setBusy(false);
  };
  const open = async () => {
    if (order) return send(order.orderId, order.label || 'the order');
    setPicking(true); setMsg('');
    try { setOrders(await api.inkflow.orders()); } catch (e) { setMsg(clean(e.message)); setOrders([]); }
  };
  const shown = (orders || []).filter((o) => !q || `${o.number} ${o.customer} ${o.nickname || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <button className="btn wide" disabled={disabled || busy} onClick={open}>{busy ? 'Sending proof…' : label}</button>
      {msg && <div className="studio-msg">{msg}</div>}
      {picking && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setPicking(false)}>
          <div className="modal">
            <div className="modal-head"><h2>Attach the proof to which order?</h2><button className="btn ghost" onClick={() => setPicking(false)}>✕</button></div>
            <input className="btn" style={{ width: '100%', margin: '10px 0' }} placeholder="Search orders…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            {orders === null && <div className="muted">Loading orders…</div>}
            <div className="pick-list">
              {shown.map((o) => (
                <button key={o.id} className="piece" disabled={busy} onClick={() => send(o.id, o.number)}>
                  <span><b>{o.number}</b> — {o.customer}{o.nickname ? ` · ${o.nickname}` : ''}</span>
                  <span className="muted small">{o.dueDate ? `due ${new Date(o.dueDate).toLocaleDateString()}` : ''}</span>
                </button>
              ))}
              {orders && !shown.length && <div className="muted small">No orders in production{q ? ' match' : ''}.</div>}
            </div>
            {msg && <div className="studio-msg">{msg}</div>}
          </div>
        </div>
      )}
    </>
  );
}
