import React, { useEffect, useRef, useState } from 'react';
import { cleanErr, withDefaults, paperText } from './common.js';

const api = window.inksign;
const TABS = [
  ['info', 'Job info'],
  ['media', 'Media'],
  ['layout', 'Layout'],
  ['color', 'Color & image'],
  ['finishing', 'Finishing'],
  ['mixed', 'Mixed media'],
];
const INTENTS = [[0, 'Perceptual (photos)'], [1, 'Relative colorimetric (logos, spot colors)'], [2, 'Saturation (charts, bright graphics)'], [3, 'Absolute colorimetric (proofing)']];

function Num({ label, value, onChange, step = 1, min, placeholder, width }) {
  const [t, setT] = useState(value ?? '');
  useEffect(() => setT(value ?? ''), [value]);
  const commit = () => onChange(t === '' ? '' : Number(t));
  return (
    <label className="mini-field" style={width ? { maxWidth: width } : null}><span>{label}</span>
      <input type="number" step={step} min={min} value={t} placeholder={placeholder} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}
function Sel({ label, value, onChange, options, disabled }) {
  return (
    <label className="mini-field"><span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.key ?? o[0]} value={o.key ?? o[0]}>{o.label ?? o[1]}</option>)}
      </select>
    </label>
  );
}

// Paper picker: catalog entries (plus an optional "none"/"job paper" first choice)
function PaperSel({ label, value, onChange, catalog, caps, empty }) {
  return (
    <label className="mini-field"><span>{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {empty && <option value="">{empty}</option>}
        {catalog.map((c) => <option key={c.id} value={c.id}>{paperText(c, caps)}</option>)}
      </select>
    </label>
  );
}

export default function JobProperties({ job, caps, catalog, profiles: serverProfiles, onClose, onSaved, onPreview }) {
  const [tab, setTab] = useState('media');
  const [p, setP] = useState(() => withDefaults(job.props));
  const [name, setName] = useState(job.name);
  const [problems, setProblems] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  // the server's profiles: that's where jobs are converted
  useEffect(() => { if (serverProfiles) setProfiles(serverProfiles); else api.color.profiles().then(setProfiles).catch(() => {}); }, [serverProfiles]);
  // Live check against the Xerox's rules (PPD constraints) and the layout
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(() => api.server.check(p).then((r) => { if (id === seq.current) setProblems(r || []); }).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [p]);

  const set = (path, value) => setP((cur) => {
    const next = JSON.parse(JSON.stringify(cur));
    const keys = path.split('.');
    let o = next;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
    return next;
  });
  const usingCatalog = !!p.media.catalogId;
  const paper = catalog.find((c) => c.id === p.media.catalogId);
  const booklet = p.layout.mode === 'booklet';
  const trayOpts = [{ key: 'auto', label: 'Automatic (Xerox picks the tray with this paper)' }, ...caps.trays];
  const rgbProfiles = profiles.filter((x) => (x.space || '').toUpperCase().startsWith('RGB'));
  const cmykProfiles = profiles.filter((x) => (x.space || '').toUpperCase().startsWith('CMYK'));
  const profOpts = (list, none) => [{ key: '', label: none }, ...list.map((x) => ({ key: x.id, label: x.name }))];

  const setLayout = (mode) => setP((cur) => {
    const n = withDefaults({ ...cur, layout: { ...cur.layout, mode } });
    if (mode === 'booklet') { n.sides = 'two'; n.binding = 'short'; n.layout.cropMarks = false; if (n.finishing.staple !== 'None') n.finishing.staple = 'None'; if (n.finishing.fold === 'None') n.finishing.fold = 'BiFoldStaple'; }
    else if (cur.layout.mode === 'booklet') { n.finishing.fold = 'None'; n.layout.cropMarks = true; }
    return n;
  });

  const save = async (andPrint) => {
    setSaving(true); setMsg('');
    try {
      await api.server.setProps(job.id, p, name !== job.name ? name : undefined);
      await onSaved(andPrint);
    } catch (e) { setMsg(cleanErr(e)); setSaving(false); }
  };

  const mixedOff = p.layout.mode !== 'none';
  const ranges = p.mixed.ranges, inserts = p.mixed.inserts;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal jp-modal">
        <div className="modal-head">
          <h2>Job properties — {job.name}</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="jp-body">
          <nav className="jp-tabs">
            {TABS.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
          </nav>
          <div className="jp-pane tool-box">
            {tab === 'info' && (<>
              <label className="mini-field"><span>Job name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <div className="mini-row">
                <Num label="Copies" value={p.copies} min={1} onChange={(v) => set('copies', Math.max(1, Math.round(Number(v) || 1)))} width={140} />
                <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={p.collate} onChange={(e) => set('collate', e.target.checked)} /> Collate (1-2-3, 1-2-3)</label>
              </div>
              <label className="mini-field"><span>Notes for the operator</span><textarea rows={3} value={p.notes} onChange={(e) => set('notes', e.target.value)} /></label>
              <div className="stats small">
                <div><span>Sent by</span><b>{job.user || '—'} ({job.from})</b></div>
                <div><span>Pages in the file</span><b>{job.pages ?? '—'}</b></div>
                {job.inkflow?.label && <div><span>InkFlow order</span><b>{job.inkflow.label}</b></div>}
                {job.source === 'virtual-printer' && <div><span>Came from</span><b>Windows printer (Xerox driver settings were read in)</b></div>}
              </div>
            </>)}

            {tab === 'media' && (<>
              <div className="seg">
                <button className={usingCatalog ? 'on' : ''} onClick={() => set('media', { ...p.media, catalogId: catalog[0]?.id || '' })} disabled={!catalog.length}>Paper catalog</button>
                <button className={!usingCatalog ? 'on' : ''} onClick={() => set('media', { ...p.media, catalogId: '' })}>Set by hand</button>
              </div>
              {usingCatalog ? (<>
                <PaperSel label="Paper" value={p.media.catalogId} onChange={(v) => set('media.catalogId', v)} catalog={catalog} caps={caps} />
                {paper && <div className="help">{paper.weightGsm ? `${paper.weightGsm} gsm · ` : ''}{paper.coated ? 'coated · ' : ''}tray: {paper.tray === 'auto' ? 'automatic' : caps.trays.find((t) => t.key === paper.tray)?.label || paper.tray}{paper.notes ? ` · ${paper.notes}` : ''}</div>}
              </>) : (<>
                <div className="mini-row">
                  <Sel label="Paper size" value={p.media.size} onChange={(v) => set('media.size', v)} options={[...caps.sizes, { key: 'Custom', label: 'Custom size…' }]} />
                  {p.media.size === 'Custom' && <Num label='Width (")' value={p.media.customW} step={0.125} onChange={(v) => set('media.customW', v)} />}
                  {p.media.size === 'Custom' && <Num label='Length (")' value={p.media.customH} step={0.125} onChange={(v) => set('media.customH', v)} />}
                </div>
                <div className="mini-row">
                  <Sel label="Paper type" value={p.media.type} onChange={(v) => set('media.type', v)} options={caps.mediaTypes} />
                  <Sel label="Paper color" value={p.media.color} onChange={(v) => set('media.color', v)} options={caps.mediaColors} />
                </div>
                <Sel label="Tray" value={p.media.tray} onChange={(v) => set('media.tray', v)} options={trayOpts} />
              </>)}
              <div className="box-title" style={{ marginTop: 6 }}>Sides</div>
              <div className="mini-row">
                <Sel label="Print" value={p.sides} disabled={booklet} onChange={(v) => set('sides', v)} options={[['one', '1-sided'], ['two', '2-sided']]} />
                <Sel label="Flip" value={booklet ? 'short' : p.binding} disabled={p.sides !== 'two' || booklet} onChange={(v) => set('binding', v)} options={[['long', 'On long edge (book)'], ['short', 'On short edge (calendar / tablet)']]} />
              </div>
              {p.layout.mode === 'none' && (<>
                <div className="box-title" style={{ marginTop: 6 }}>Fit to the paper</div>
                <div className="mini-row">
                  <Sel label="Scale" value={p.scale} onChange={(v) => set('scale', v)} options={[['fit', 'Fit to paper (shrink or enlarge)'], ['fill', 'Fill the paper (crops edges)'], ['none', '100% — centered on the paper']]} />
                </div>
                <div className="help">Pages are turned automatically when the art is landscape and the paper portrait.</div>
              </>)}
              <label className="check"><input type="checkbox" checked={p.rotate180} onChange={(e) => set('rotate180', e.target.checked)} /> Rotate 180°</label>
            </>)}

            {tab === 'layout' && (<>
              <div className="jp-layouts">
                {[['none', 'Normal', 'One page per side, as the file is.'], ['nup', 'N-up', 'Pages in order, as many per sheet as fit (proof sets, handouts).'],
                  ['repeat', 'Step & repeat', 'One design (page 2 = the back) filled across the sheet — business cards, postcards, labels.'],
                  ['booklet', 'Booklet (saddle stitch)', 'Pages put in booklet order two-up; fold & staple on the finisher.']].map(([id, label, help]) => (
                  <button key={id} className={`preset ${p.layout.mode === id ? 'on' : ''}`} onClick={() => setLayout(id)}><b>{label}</b><span className="help">{help}</span></button>
                ))}
              </div>
              {p.layout.mode !== 'none' && (<>
                <div className="mini-row">
                  <Num label='Bleed in the file (")' value={p.layout.bleedIn} step={0.0625} onChange={(v) => set('layout.bleedIn', Number(v) || 0)} />
                  {!booklet && <Num label='Gutter (")' value={p.layout.gapIn} step={0.0625} placeholder="auto" onChange={(v) => set('layout.gapIn', v)} />}
                </div>
                <label className="check"><input type="checkbox" checked={p.layout.cropMarks} onChange={(e) => set('layout.cropMarks', e.target.checked)} /> Crop marks</label>
                {!booklet && <label className="check"><input type="checkbox" checked={p.layout.allowRotate} onChange={(e) => set('layout.allowRotate', e.target.checked)} /> Turn pieces if more fit</label>}
                {p.layout.mode === 'repeat' && <label className="check"><input type="checkbox" checked={p.layout.repeatBack} onChange={(e) => set('layout.repeatBack', e.target.checked)} /> Page 2 is the back (when 2-sided)</label>}
                {p.layout.mode === 'repeat' && <div className="help">Step & repeat lays out one sheet; Copies = how many sheets to print.</div>}
                {booklet && <div className="help">Booklet pages are padded to a multiple of 4. The sheet is the job's paper (e.g. 11×17 for a letter booklet, letter for a 5.5×8.5 booklet). Cover on different stock: Mixed media → Front cover.</div>}
              </>)}
            </>)}

            {tab === 'color' && (<>
              <Sel label="Color mode" value={p.color.mode} onChange={(v) => set('color.mode', v)} options={[['color', 'Color (CMYK)'], ['gray', 'Grayscale — black toner only, billed as B&W']]} />
              {p.color.mode !== 'gray' && (<>
                <label className="check"><input type="checkbox" checked={p.color.manage} onChange={(e) => set('color.manage', e.target.checked)} /> InkSign color management — convert to the Xerox's CMYK here with ICC profiles</label>
                {p.color.manage ? (<>
                  <div className="mini-row">
                    <Sel label="RGB source" value={p.color.rgbProfileId} onChange={(v) => set('color.rgbProfileId', v)} options={profOpts(rgbProfiles, 'sRGB (built in)')} />
                    <Sel label="CMYK source" value={p.color.cmykProfileId} onChange={(v) => set('color.cmykProfileId', v)} options={profOpts(cmykProfiles, 'Built-in CMYK')} />
                  </div>
                  <Sel label="Output profile (the Xerox on this paper)" value={p.color.outputProfileId} onChange={(v) => set('color.outputProfileId', v)} options={profOpts(cmykProfiles, paper?.outputProfileId ? "Paper's own profile (paper catalog)" : 'Built-in CMYK')} />
                  <Sel label="Rendering intent" value={p.color.intent} onChange={(v) => set('color.intent', Number(v))} options={INTENTS} />
                  <label className="check"><input type="checkbox" checked={p.color.blackText} onChange={(e) => set('color.blackText', e.target.checked)} /> Pure black text & lines (100% K — crisp small type)</label>
                  <div className="help">Add the Xerox's ICC profile on the Color page (ask Xerox/your dealer for the 7845 profile per paper). With this off, color is left to the Xerox's own settings.</div>
                </>) : <div className="help">Color is converted by the Xerox's own color settings, same as printing from the Xerox driver.</div>}
              </>)}
              <Sel label="Overprint" value={p.color.overprint} onChange={(v) => set('color.overprint', v)} options={[['printer', 'Let the printer handle it'], ['simulate', 'Simulate overprint (preview-accurate spot overprints)']]} />
              <div className="box-title" style={{ marginTop: 6 }}>Image quality</div>
              <Sel label="Print quality" value={p.quality} onChange={(v) => set('quality', v)} options={caps.quality} />
            </>)}

            {tab === 'finishing' && (<>
              <Sel label="Stapling" value={p.finishing.staple} onChange={(v) => set('finishing.staple', v)} options={caps.staple} disabled={booklet} />
              <Sel label="Booklet fold" value={p.finishing.fold} onChange={(v) => set('finishing.fold', v)} options={caps.fold} disabled={!booklet} />
              {!booklet && <div className="help">Booklet fold needs Layout → Booklet.</div>}
              <Sel label="Hole punch" value={p.finishing.punch} onChange={(v) => set('finishing.punch', v)} options={caps.punch} />
              <label className="check"><input type="checkbox" checked={p.collate} onChange={(e) => set('collate', e.target.checked)} /> Collate</label>
              <label className="check"><input type="checkbox" checked={p.finishing.banner} onChange={(e) => set('finishing.banner', e.target.checked)} /> Banner sheet (job name page before the job)</label>
              <div className="help">These are the 7845 finisher's choices from Xerox's driver. Sizes and paper types the finisher can't handle are flagged below.</div>
            </>)}

            {tab === 'mixed' && (<>
              {mixedOff && <div className="studio-msg">Page ranges, inserts and chapters work with Layout → Normal. A booklet can still have a cover on different paper (front cover below).</div>}
              {[['frontCover', 'Front cover'], ['backCover', 'Back cover']].map(([k, label]) => (booklet && k === 'backCover' ? null : (
                <div className="mini-row" key={k}>
                  <PaperSel label={label} value={p.mixed[k].catalogId} onChange={(v) => set(`mixed.${k}.catalogId`, v)} catalog={catalog} caps={caps} empty="None (same as the job)" />
                  {!booklet && <Sel label="Cover prints" value={p.mixed[k].content} disabled={!p.mixed[k].catalogId} onChange={(v) => set(`mixed.${k}.content`, v)}
                    options={[['print', p.sides === 'two' ? 'Front & back (first/last 2 pages)' : `The ${k === 'frontCover' ? 'first' : 'last'} page`], ['front', 'Outside only (inside blank)'], ['blank', 'Blank cover sheet']]} />}
                </div>
              )))}
              {!mixedOff && (<>
                <div className="box-title" style={{ marginTop: 6 }}>Page ranges on other paper</div>
                {ranges.map((r, i) => (
                  <div className="mini-row" key={i}>
                    <label className="mini-field" style={{ maxWidth: 140 }}><span>Pages</span><input type="text" value={r.pages} placeholder="e.g. 3-4, 9" onChange={(e) => set('mixed.ranges', ranges.map((x, j) => (j === i ? { ...x, pages: e.target.value } : x)))} /></label>
                    <PaperSel label="Paper" value={r.catalogId} onChange={(v) => set('mixed.ranges', ranges.map((x, j) => (j === i ? { ...x, catalogId: v } : x)))} catalog={catalog} caps={caps} />
                    <button className="btn ghost small" style={{ flex: 0 }} onClick={() => set('mixed.ranges', ranges.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <button className="btn small" disabled={!catalog.length} onClick={() => set('mixed.ranges', [...ranges, { pages: '', catalogId: catalog[0]?.id }])}>+ Page range</button>
                <div className="box-title" style={{ marginTop: 6 }}>Inserts (blank sheets — tabs, dividers, colored slip sheets)</div>
                {inserts.map((r, i) => (
                  <div className="mini-row" key={i}>
                    <Num label="After page" value={r.after} min={0} width={110} onChange={(v) => set('mixed.inserts', inserts.map((x, j) => (j === i ? { ...x, after: v } : x)))} />
                    <PaperSel label="Paper" value={r.catalogId} onChange={(v) => set('mixed.inserts', inserts.map((x, j) => (j === i ? { ...x, catalogId: v } : x)))} catalog={catalog} caps={caps} />
                    <Num label="Sheets" value={r.count} min={1} width={80} onChange={(v) => set('mixed.inserts', inserts.map((x, j) => (j === i ? { ...x, count: v } : x)))} />
                    <button className="btn ghost small" style={{ flex: 0 }} onClick={() => set('mixed.inserts', inserts.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <button className="btn small" disabled={!catalog.length} onClick={() => set('mixed.inserts', [...inserts, { after: 1, catalogId: catalog[0]?.id, count: 1 }])}>+ Insert</button>
                <label className="mini-field" style={{ marginTop: 6 }}><span>Chapter starts (these pages start on a new sheet)</span>
                  <input type="text" value={p.mixed.chapters} placeholder="e.g. 5, 12, 20" onChange={(e) => set('mixed.chapters', e.target.value)} /></label>
                {p.sides === 'two' && <div className="help">2-sided: a page on different paper, an insert or a chapter always starts a new sheet (a blank back is added before it when needed).</div>}
              </>)}
            </>)}
          </div>
        </div>
        {problems.length > 0 && <div className="jp-problems">{problems.map((x, i) => <div key={i}>⚠ {x}</div>)}</div>}
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="modal-foot">
          <button className="btn" onClick={() => onPreview(p)}>Preview…</button>
          <div className="row">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={saving} onClick={() => save(false)}>OK</button>
            <button className="btn primary" disabled={saving || problems.length > 0} onClick={() => save(true)}>{job.queue === 'printed' ? 'OK & reprint' : 'OK & print'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
