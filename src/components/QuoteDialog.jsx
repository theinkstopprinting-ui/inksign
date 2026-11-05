import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Create an InkFlow quote from InkSign's price (or add the lines to an order), and attach the proof.
export default function QuoteDialog({ lines: initial, defaultName, makeProof, onClose }) {
  const [lines, setLines] = useState(initial);
  const [mode, setMode] = useState('new');
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [pick, setPick] = useState(null);
  const [nickname, setNickname] = useState(defaultName || '');
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let cancelled = false;
    const h = setTimeout(async () => {
      try {
        const r = mode === 'new' ? await api.shopflow.customers(q) : (q.trim() ? await api.shopflow.searchOrders(q) : await api.inkflow.orders());
        if (!cancelled) setFound(r.slice(0, 15));
      } catch (e) { if (!cancelled) { setFound([]); setMsg(clean(e.message)); } }
    }, 300);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, mode]);
  const total = lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0);
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const go = async () => {
    if (!pick) return setMsg(mode === 'new' ? 'Pick the customer.' : 'Pick the order.');
    setBusy(true); setMsg('');
    try {
      let orderId, label;
      if (mode === 'new') { const r = await api.shopflow.quote({ customerId: pick.id, nickname, lines }); orderId = r.orderId; label = r.number; }
      else { await api.shopflow.addItems(pick.id, lines); orderId = pick.id; label = pick.number; }
      let extra = '';
      if (attach && makeProof) { try { await api.proof.send(orderId, await makeProof()); extra = ' with the proof attached'; } catch (e) { extra = ` (proof not attached: ${clean(e.message)})`; } }
      setMsg(`${mode === 'new' ? 'Quote' : 'Added to'} ${label}${extra}. Open it in InkFlow to send it.`);
      setPick(null);
    } catch (e) { setMsg(clean(e.message)); }
    setBusy(false);
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-head"><h2>InkFlow quote</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <div className="seg" style={{ margin: '10px 0' }}>
          <button className={mode === 'new' ? 'on' : ''} onClick={() => { setMode('new'); setPick(null); setQ(''); }}>New quote for a customer</button>
          <button className={mode === 'add' ? 'on' : ''} onClick={() => { setMode('add'); setPick(null); setQ(''); }}>Add to an existing order</button>
        </div>
        <table className="table">
          <thead><tr><th>Line</th><th>Qty</th><th>Each</th><th>Total</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><input className="btn" style={{ width: '100%' }} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input className="btn" type="number" style={{ width: 70 }} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /></td>
              <td><input className="btn" type="number" step="0.01" style={{ width: 90 }} value={(l.unitPriceCents / 100).toFixed(2)} onChange={(e) => setLine(i, { unitPriceCents: Math.round((Number(e.target.value) || 0) * 100) })} /></td>
              <td className="nowrap">${((l.quantity * l.unitPriceCents) / 100).toFixed(2)}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="muted small" style={{ margin: '6px 0 12px' }}>Total ${(total / 100).toFixed(2)} before tax — InkFlow adds tax and the deposit rules.</div>
        <input className="btn" style={{ width: '100%' }} placeholder={mode === 'new' ? 'Search customers…' : 'Order # or customer…'} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pick-list" style={{ maxHeight: 200, marginTop: 6 }}>
          {found.map((f) => (
            <button key={f.id} className={`piece ${pick?.id === f.id ? 'on' : ''}`} onClick={() => setPick(f)}>
              <span>{mode === 'new' ? <><b>{f.label}</b> {f.email ? <span className="muted small">{f.email}</span> : null}</> : <><b>{f.number}</b> — {f.customer} <span className="muted small">{f.status}</span></>}</span>
            </button>
          ))}
          {!found.length && <div className="muted small">{mode === 'new' ? 'No customers found — add new customers in InkFlow.' : 'No open orders found.'}</div>}
        </div>
        {mode === 'new' && <label className="mini-field" style={{ marginTop: 8 }}><span>Job title (optional)</span><input className="btn" value={nickname} onChange={(e) => setNickname(e.target.value)} /></label>}
        {makeProof && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach the proof</label>}
        {msg && <div className="studio-msg" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="modal-foot"><span /><div className="row"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={busy || !pick} onClick={go}>{busy ? 'Working…' : mode === 'new' ? 'Create quote' : 'Add to order'}</button></div></div>
      </div>
    </div>
  );
}
