import React, { useEffect, useState } from 'react';
import { cleanErr, choiceLabel, sizeLabel } from './common.js';

const api = window.inksign;
const blank = () => ({ id: `pc-${Date.now().toString(36)}`, name: 'New paper', size: 'Letter', customW: '', customH: '', type: 'Plain', color: 'White', weightGsm: '', coated: false, tray: 'auto', outputProfileId: '', costPerSheet: 0, notes: '' });

// Fiery-style paper catalog: every stock the shop runs, with the Xerox paper type, tray, ICC profile
// and cost per sheet — plus what's loaded in each tray right now.
export default function PaperCatalog({ caps, owner, state, onClose }) {
  const [list, setList] = useState(() => JSON.parse(JSON.stringify(state.catalog || [])));
  const [trays, setTrays] = useState(() => ({ ...(state.trays || {}) }));
  const [edit, setEdit] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { api.color.profiles().then(setProfiles).catch(() => {}); }, []);

  const cur = list.find((c) => c.id === edit);
  const upd = (patch) => { setList((l) => l.map((c) => (c.id === edit ? { ...c, ...patch } : c))); setDirty(true); };
  const add = (from) => { const n = { ...(from ? JSON.parse(JSON.stringify(from)) : blank()), id: `pc-${Date.now().toString(36)}`, name: from ? `${from.name} copy` : 'New paper' }; setList((l) => [...l, n]); setEdit(n.id); setDirty(true); };
  const del = (id) => {
    if (!window.confirm('Remove this paper from the catalog? Jobs that use it will need a new paper.')) return;
    setList((l) => l.filter((c) => c.id !== id)); setEdit(null); setDirty(true);
    setTrays((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== id)));
  };
  const save = async () => {
    setMsg('');
    try {
      if (dirty) await api.server.saveCatalog(list);
      await api.server.saveTrays(trays);
      onClose();
    } catch (e) { setMsg(cleanErr(e)); }
  };
  const cmyk = profiles.filter((x) => (x.space || '').toUpperCase().startsWith('CMYK'));

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pc-modal">
        <div className="modal-head">
          <h2>Paper catalog</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted small">Pick a paper on a job and InkSign sends the Xerox the right size, paper type, color and tray. Paper types are the 7845's own — set the same type for that tray on the Xerox panel.</p>

        <div className="box-title" style={{ marginTop: 10 }}>Loaded in the trays</div>
        <div className="pc-trays">
          {caps.trays.map((t) => (
            <label key={t.key} className="mini-field"><span>{t.label}</span>
              <select value={trays[t.key] || ''} onChange={(e) => setTrays((x) => ({ ...x, [t.key]: e.target.value || undefined }))}>
                <option value="">—</option>
                {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="help">Jobs on a paper set to "Automatic" tray go to the tray it's loaded in here.</div>

        <div className="pc-split">
          <div className="pc-list">
            {list.map((c) => (
              <button key={c.id} className={`piece ${edit === c.id ? 'on' : ''}`} onClick={() => setEdit(c.id)}>
                <span><b>{c.name}</b><br /><span className="muted small">{sizeLabel(caps, c.size).replace(/\s*\(.*\)/, '')}{c.size === 'Custom' ? ` ${c.customW}×${c.customH}"` : ''} · {choiceLabel(caps.mediaTypes, c.type)}{c.color !== 'White' ? ` · ${choiceLabel(caps.mediaColors, c.color)}` : ''}</span></span>
                <span className="muted small">{Object.entries(trays).filter(([, v]) => v === c.id).map(([k]) => k.replace('Tray', 'T')).join(' ')}</span>
              </button>
            ))}
            {owner && <button className="btn small" onClick={() => add(null)}>+ New paper</button>}
          </div>
          <div className="pc-edit tool-box">
            {!cur ? <div className="muted">Pick a paper to see or change it.</div> : (<>
              <label className="mini-field"><span>Name</span><input type="text" disabled={!owner} value={cur.name} onChange={(e) => upd({ name: e.target.value })} /></label>
              <div className="mini-row">
                <label className="mini-field"><span>Size</span>
                  <select disabled={!owner} value={cur.size} onChange={(e) => upd({ size: e.target.value })}>{[...caps.sizes, { key: 'Custom', label: 'Custom size…' }].map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                </label>
                {cur.size === 'Custom' && <label className="mini-field"><span>Width (")</span><input type="number" step="0.125" disabled={!owner} value={cur.customW || ''} onChange={(e) => upd({ customW: e.target.value })} /></label>}
                {cur.size === 'Custom' && <label className="mini-field"><span>Length (")</span><input type="number" step="0.125" disabled={!owner} value={cur.customH || ''} onChange={(e) => upd({ customH: e.target.value })} /></label>}
              </div>
              <div className="mini-row">
                <label className="mini-field"><span>Xerox paper type</span>
                  <select disabled={!owner} value={cur.type} onChange={(e) => upd({ type: e.target.value })}>{caps.mediaTypes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                </label>
                <label className="mini-field"><span>Color</span>
                  <select disabled={!owner} value={cur.color} onChange={(e) => upd({ color: e.target.value })}>{caps.mediaColors.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                </label>
              </div>
              <div className="mini-row">
                <label className="mini-field"><span>Weight (gsm)</span><input type="number" disabled={!owner} value={cur.weightGsm || ''} onChange={(e) => upd({ weightGsm: e.target.value })} /></label>
                <label className="mini-field"><span>Cost per sheet ($)</span><input type="number" step="0.01" disabled={!owner} value={cur.costPerSheet || ''} onChange={(e) => upd({ costPerSheet: e.target.value })} /></label>
              </div>
              <label className="check"><input type="checkbox" disabled={!owner} checked={!!cur.coated} onChange={(e) => upd({ coated: e.target.checked })} /> Coated (gloss / silk)</label>
              <label className="mini-field"><span>Tray</span>
                <select disabled={!owner} value={cur.tray} onChange={(e) => upd({ tray: e.target.value })}>
                  <option value="auto">Automatic (where it's loaded / Xerox picks)</option>
                  {caps.trays.map((t) => <option key={t.key} value={t.key}>Always {t.label}</option>)}
                </select>
              </label>
              <label className="mini-field"><span>ICC output profile for this paper</span>
                <select disabled={!owner} value={cur.outputProfileId || ''} onChange={(e) => upd({ outputProfileId: e.target.value })}>
                  <option value="">None — the Xerox's own color</option>
                  {cmyk.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
              <label className="mini-field"><span>Notes</span><input type="text" disabled={!owner} value={cur.notes || ''} onChange={(e) => upd({ notes: e.target.value })} /></label>
              {owner && <div className="row"><button className="btn small" onClick={() => add(cur)}>Duplicate</button><button className="btn small danger" onClick={() => del(cur.id)}>Remove</button></div>}
            </>)}
          </div>
        </div>
        {!owner && <div className="help">Only an owner can change the catalog. Anyone can set what's loaded in the trays.</div>}
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="modal-foot">
          <span className="muted small">{list.length} papers · shared with every PC that uses this print server</span>
          <div className="row"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
        </div>
      </div>
    </div>
  );
}
