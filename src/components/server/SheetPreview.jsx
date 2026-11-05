import React, { useEffect, useState } from 'react';
import { renderPages, b64ToBytes } from '../../lib/pdfRender.js';
import { cleanErr } from './common.js';

const api = window.inksign;

// Fiery-style sheet view: every printed side as it comes off the Xerox, with the paper it's on
export default function SheetPreview({ job, props, onClose }) {
  const [data, setData] = useState(null);
  const [pages, setPages] = useState(null);
  const [err, setErr] = useState('');
  const [limit, setLimit] = useState(24);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await api.server.preview(job.id, props || null);
        if (!live) return;
        setData(r);
        if (r.error) { setErr(r.error); return; }
        const pv = await renderPages(b64ToBytes(r.base64), { maxPages: limit, width: 300 });
        if (live) setPages(pv);
      } catch (e) { if (live) setErr(cleanErr(e)); }
    })();
    return () => { live = false; };
  }, [job.id, props, limit]);

  const duplex = (props || job.props)?.sides === 'two';
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sp-modal">
        <div className="modal-head">
          <h2>Preview — {job.name}</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        {data && !data.error && (
          <div className="muted small" style={{ margin: '6px 0 10px' }}>
            {data.pages} page{data.pages === 1 ? '' : 's'} in the file → {data.sides} side{data.sides === 1 ? '' : 's'} on {data.sheets} sheet{data.sheets === 1 ? '' : 's'} per copy
            {data.info?.perSheet > 1 ? ` · ${data.info.perSheet} per sheet` : ''}{data.info?.blankPages ? ` · ${data.info.blankPages} blank side${data.info.blankPages > 1 ? 's' : ''} added` : ''}
          </div>
        )}
        {data?.problems?.length > 0 && <div className="jp-problems">{data.problems.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>}
        {err && <div className="studio-msg">{err}</div>}
        {!pages && !err && <div className="empty">Laying out the sheets…</div>}
        {pages && (
          <div className="sp-grid">
            {pages.images.map((im, i) => (
              <figure key={i} className={duplex && i % 2 === 0 ? 'sp-front' : ''}>
                <img src={im} alt="" />
                <figcaption>
                  {duplex ? `Sheet ${Math.floor(i / 2) + 1} ${i % 2 ? 'back' : 'front'}` : `Sheet ${i + 1}`}
                  <span className="muted"> · {data.papers[i]?.name}{data.papers[i]?.blank ? ' (blank)' : ''}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {pages && pages.pages > pages.images.length && <button className="btn" style={{ marginTop: 10 }} onClick={() => { setPages(null); setLimit((l) => l + 48); }}>Show more ({pages.pages - pages.images.length} more sides)</button>}
      </div>
    </div>
  );
}
