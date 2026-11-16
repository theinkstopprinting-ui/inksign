import React, { useEffect, useState } from 'react';

// Cut a printed job by its number (InkSign's take on VinylMaster's Barcode Controller): every print & cut
// job printed with a barcode has its cut lines kept under that number. Scan the barcode with a handheld
// scanner (it types the digits and Enter) or type the number, and the cut goes to this cutter, which
// reads the four marks and cuts.
const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function BarcodeCut({ cutter, compact = false, onSent }) {
  const [no, setNo] = useState('');
  const [msg, setMsg] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState([]);
  const [open, setOpen] = useState(false);
  const refresh = () => api.printcut.savedJobs().then(setSaved).catch(() => {});
  useEffect(() => { if (open) refresh(); }, [open]);
  if (!cutter) return null;
  const cut = async (n) => {
    const num = String(n ?? no).trim();
    if (!num) return;
    setBusy(true); setMsg(''); setBad(false);
    try {
      const r = await api.printcut.cutSaved(cutter.id, num);
      setMsg(`Job ${r.no} “${r.name}” sent to ${cutter.name}. Load the print, set the blade on the first mark, and let it read the marks.`);
      setNo('');
      if (onSent) onSent();
      if (open) refresh();
    } catch (e) { setBad(true); setMsg(clean(e.message)); }
    setBusy(false);
  };
  return (
    <div className={`bc-cut ${compact ? 'compact' : ''}`}>
      <div className="bc-row">
        <span className="bc-ico" aria-hidden="true">▮▯▮▮▯▮</span>
        <input type="text" inputMode="numeric" value={no} placeholder="Scan or type a job number" disabled={busy}
          onChange={(e) => setNo(e.target.value.replace(/[^\d]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') cut(); }} />
        <button className="btn small primary" disabled={busy || !no} onClick={() => cut()}>{busy ? 'Sending…' : 'Cut job'}</button>
        <button className="btn small ghost" onClick={() => setOpen((v) => !v)}>{open ? 'Hide list' : 'Printed jobs…'}</button>
      </div>
      {msg && <div className={bad ? 'bc-msg error' : 'bc-msg'}>{msg}</div>}
      {open && (
        <div className="bc-list">
          {!saved.length && <div className="muted small">No barcode jobs yet. In Design, use File › Print & Cut with "Print a job number and barcode" ticked.</div>}
          {saved.map((j) => (
            <div key={j.no} className="bc-item">
              <b>{j.no}</b>
              <span className="bc-name" title={j.name}>{j.name}</span>
              <span className="muted">{j.wIn.toFixed(1)}″ × {j.hIn.toFixed(1)}″ · {new Date(j.savedAt).toLocaleDateString()}{j.cuts ? ` · cut ${j.cuts}×` : ' · not cut yet'}</span>
              <button className="btn small" disabled={busy} onClick={() => cut(j.no)}>Cut</button>
              <button className="btn small ghost" title="Forget this job" onClick={async () => { await api.printcut.deleteSaved(j.no); refresh(); }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
