import React, { useEffect, useState } from 'react';

const api = window.inksign;
const ICON = { ok: '✓', warn: '!', error: '✕', info: '·' };

// Checks the files of a job before it's sent: resolution at size, fonts, colors, bleed.
export default function Preflight({ items, purpose, bleedIn = 0 }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(true);
  const key = JSON.stringify((items || []).map((i) => [i.name, i.ext, i.widthIn, i.heightIn, (i.base64 || '').length]).concat([purpose, bleedIn]));
  useEffect(() => {
    if (!items || !items.length) { setRows(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try { const r = await api.preflight.check(items, { purpose, bleedIn }); if (!cancelled) setRows(r); }
      catch (e) { if (!cancelled) setRows([{ level: 'warn', text: `Preflight couldn't run: ${e.message}` }]); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [key]);
  if (!rows) return null;
  const worst = rows.some((r) => r.level === 'error') ? 'error' : rows.some((r) => r.level === 'warn') ? 'warn' : 'ok';
  const count = rows.filter((r) => r.level === 'error' || r.level === 'warn').length;
  return (
    <div className="tool-box">
      <div className="box-head" onClick={() => setOpen(!open)}>
        <span className="box-title">{open ? '▾' : '▸'} Preflight</span>
        <span className={`pf-${worst} small`}>{worst === 'ok' ? 'Ready' : `${count} to check`}</span>
      </div>
      {open && (
        <div className="preflight">
          {rows.map((r, i) => <div key={i} className={`pf-row pf-${r.level}`}><b>{ICON[r.level]}</b><span>{r.text}</span></div>)}
        </div>
      )}
    </div>
  );
}
