import React, { useEffect, useRef, useState } from 'react';
import { INTENTS, INTENT_PERCEPTUAL, INTENT_RELATIVE_COLORIMETRIC, profileInfo, softProof, hexToRgb, rgbToLab, labToCmyk, nearestColors } from '../lib/color.js';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function ColorPage({ devices }) {
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [msg, setMsg] = useState('');
  const reload = async () => { setSettings(await api.settings.get()); setProfiles(await api.color.profiles()); };
  useEffect(() => { reload(); }, []);
  const cmykProfiles = profiles.filter((p) => /CMYK/i.test(p.space));

  const addProfile = async () => {
    setMsg('');
    try {
      const f = await api.color.pickProfile();
      if (!f) return;
      const info = await profileInfo(f.bytes);
      setProfiles(await api.color.addProfile({ fileName: f.fileName, bytes: f.bytes, name: info.name || f.fileName, space: info.space }));
      setMsg(`Added ${info.name} (${info.space}).`);
    } catch (e) { setMsg(clean(e.message)); }
  };
  const assign = async (deviceId, patch) => {
    const cp = { ...(settings.colorProfiles || {}) };
    cp[deviceId] = { ...(cp[deviceId] || { intent: INTENT_PERCEPTUAL }), ...patch };
    setSettings(await api.settings.save({ colorProfiles: cp }));
    window.dispatchEvent(new Event('inksign-settings')); // open tools pick up the new profile
  };

  // ---- Soft proof ----
  const [proofProfile, setProofProfile] = useState('');
  const [proofIntent, setProofIntent] = useState(INTENT_PERCEPTUAL);
  const [img, setImg] = useState(null);
  const [showGamut, setShowGamut] = useState(true);
  const [proofInfo, setProofInfo] = useState(null);
  const origRef = useRef(null), proofRef = useRef(null);
  useEffect(() => { if (!proofProfile && cmykProfiles[0]) setProofProfile(cmykProfiles[0].id); }, [profiles]);
  const loadImage = async () => {
    const files = await api.printcut.openImages();
    if (!files.length) return;
    const im = new Image(); im.src = files[0].dataUrl; await im.decode();
    setImg({ el: im, name: files[0].name });
  };
  useEffect(() => {
    if (!img || !proofProfile) return;
    let cancelled = false;
    (async () => {
      const max = 700, k = Math.min(1, max / Math.max(img.el.naturalWidth, img.el.naturalHeight));
      const w = Math.round(img.el.naturalWidth * k), h = Math.round(img.el.naturalHeight * k);
      for (const c of [origRef.current, proofRef.current]) { c.width = w; c.height = h; }
      const o = origRef.current.getContext('2d', { willReadFrequently: true });
      o.clearRect(0, 0, w, h); o.drawImage(img.el, 0, 0, w, h);
      const data = o.getImageData(0, 0, w, h);
      try {
        const r = await softProof(data.data, proofProfile, Number(proofIntent));
        if (cancelled) return;
        const out = new ImageData(r.rgba, w, h);
        if (showGamut) for (let i = 0; i < r.gamut.length; i++) if (r.gamut[i] && ((i % w) + Math.floor(i / w)) % 4 < 2) { out.data[i * 4] = 255; out.data[i * 4 + 1] = 0; out.data[i * 4 + 2] = 255; }
        proofRef.current.getContext('2d').putImageData(out, 0, 0);
        setProofInfo({ pct: r.outOfGamutPct });
      } catch (e) { setMsg(clean(e.message)); }
    })();
    return () => { cancelled = true; };
  }, [img, proofProfile, proofIntent, showGamut]);

  // ---- Color match ----
  const [hex, setHex] = useState('#d0202e');
  const [matchProfile, setMatchProfile] = useState('');
  const [match, setMatch] = useState(null);
  useEffect(() => { if (!matchProfile && cmykProfiles[0]) setMatchProfile(cmykProfiles[0].id); }, [profiles]);
  useEffect(() => {
    const rgb = hexToRgb(hex);
    if (!rgb || !settings) return;
    let cancelled = false;
    (async () => {
      try {
        const lab = await rgbToLab(rgb);
        const near = (await nearestColors(lab, settings.colors || [])).slice(0, 5);
        const recipe = matchProfile ? await labToCmyk(lab, matchProfile, INTENT_RELATIVE_COLORIMETRIC) : null;
        if (!cancelled) setMatch({ lab, near, recipe });
      } catch (e) { if (!cancelled) setMsg(clean(e.message)); }
    })();
    return () => { cancelled = true; };
  }, [hex, matchProfile, settings]);

  const printers = devices.filter((d) => d.kind === 'printer');
  if (!settings) return null;
  const pname = (id) => profiles.find((p) => p.id === id)?.name || '';

  return (
    <div className="color-page">
      <header className="page-head">
        <div><h1>Color</h1><p className="muted">ICC profiles for your printers, soft proofs, and matching brand colors to vinyl and CMYK.</p></div>
        <button className="btn primary" onClick={addProfile}>+ Add ICC profile…</button>
      </header>
      {msg && <div className="studio-msg" style={{ marginBottom: 12 }}>{msg}</div>}

      <section className="card">
        <h2 className="card-title">Profiles</h2>
        {!profiles.length && <p className="muted small">No profiles yet. Get the Xerox 7845's output profile (for each paper you use) from Xerox's site or the printer's own web page, and add it here. Generic profiles like GRACoL or SWOP also work for proofing.</p>}
        {profiles.map((p) => (
          <div key={p.id} className="prof-row">
            <span><b>{p.name}</b> <span className="muted small">{p.space} · {p.fileName}</span></span>
            <button className="btn ghost small" onClick={async () => setProfiles(await api.color.removeProfile(p.id))}>✕</button>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="card-title">Printer profiles</h2>
        <p className="muted small">Press and Print &amp; Cut convert photos and PNG/JPG artwork to CMYK with this profile before sending to the printer (PDFs go as they are). The HP Latex printers use the profile picked for their media in each printer's settings (Flexi's own HP profiles are found automatically).</p>
        {printers.map((d) => {
          const a = settings.colorProfiles?.[d.id] || {};
          if (d.driver === 'flexi-hotfolder') return <div key={d.id} className="prof-row"><span>{d.name}</span><span className="muted small">Flexi handles color</span></div>;
          if (d.driver === 'hp-latex') return <div key={d.id} className="prof-row"><span>{d.name}</span><span className="muted small">Uses the media's profile — pick it in Devices → {d.name} → Settings</span></div>;
          return (
            <div key={d.id} className="prof-row">
              <span>{d.name}</span>
              <span className="row">
                <select value={a.profileId || ''} onChange={(e) => assign(d.id, { profileId: e.target.value })}>
                  <option value="">No conversion (printer's own color)</option>
                  {cmykProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={a.intent ?? INTENT_PERCEPTUAL} onChange={(e) => assign(d.id, { intent: Number(e.target.value) })}>
                  {INTENTS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </span>
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2 className="card-title">Soft proof</h2>
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <button className="btn" onClick={loadImage}>{img ? 'Change picture…' : 'Load a picture…'}</button>
          <select value={proofProfile} onChange={(e) => setProofProfile(e.target.value)}>
            {!cmykProfiles.length && <option value="">Add a CMYK profile first</option>}
            {cmykProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={proofIntent} onChange={(e) => setProofIntent(Number(e.target.value))}>{INTENTS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
          <label className="check"><input type="checkbox" checked={showGamut} onChange={(e) => setShowGamut(e.target.checked)} /> Mark colors the printer can't reach</label>
        </div>
        {img && (
          <div className="proof-pair">
            <figure><canvas ref={origRef} /><figcaption>On screen</figcaption></figure>
            <figure><canvas ref={proofRef} /><figcaption>Printed on {pname(proofProfile) || '—'}{proofInfo ? ` · ${proofInfo.pct.toFixed(1)}% out of range` : ''}</figcaption></figure>
          </div>
        )}
        {!img && <p className="muted small">See how a customer's photo or logo will come out before printing. Striped magenta = colors that will shift (bright RGB greens, oranges and blues usually).</p>}
      </section>

      <section className="card">
        <h2 className="card-title">Match a color</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input type="color" value={hexToRgb(hex) ? hex : '#000000'} onChange={(e) => setHex(e.target.value)} />
          <input type="text" className="btn" style={{ width: 110 }} value={hex} onChange={(e) => setHex(e.target.value.trim())} />
          <select value={matchProfile} onChange={(e) => setMatchProfile(e.target.value)}>
            <option value="">No printer profile</option>
            {cmykProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {match && (
          <div className="match-grid">
            <div>
              <div className="box-title">CMYK to print it</div>
              {match.recipe ? (<>
                <div className="recipe">C {match.recipe.cmyk[0]} · M {match.recipe.cmyk[1]} · Y {match.recipe.cmyk[2]} · K {match.recipe.cmyk[3]}</div>
                <div className={`small ${match.recipe.deltaE > 5 ? 'st-error' : match.recipe.deltaE > 2 ? 'st-warning' : 'st-done'}`}>
                  {match.recipe.deltaE <= 2 ? 'Prints as a match' : match.recipe.deltaE <= 5 ? 'Prints close' : 'Out of range — the printer can\'t hit this exactly'} (ΔE {match.recipe.deltaE.toFixed(1)})
                </div>
              </>) : <div className="muted small">Pick a printer profile.</div>}
              <div className="muted small">Lab {match.lab.map((v) => v.toFixed(1)).join(', ')}</div>
            </div>
            <div>
              <div className="box-title">Closest in your color library (vinyl)</div>
              {match.near.map((c) => (
                <div key={c.name} className="near-row">
                  <i className="dot big" style={{ background: c.hex }} /> <span>{c.name}</span>
                  <span className={`small ${c.deltaE > 5 ? 'st-error' : c.deltaE > 2 ? 'st-warning' : 'st-done'}`}>ΔE {c.deltaE.toFixed(1)}</span>
                </div>
              ))}
              <div className="help">Add your vinyl colors (Oracal, 3M…) with their hex values in Cut Studio → Materials, colors &amp; pricing.</div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
