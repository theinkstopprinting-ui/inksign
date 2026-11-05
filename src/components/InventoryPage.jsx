import React, { useEffect, useState } from 'react';

const api = window.inksign;
const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Roll stock lives in InkFlow (Inventory → sign rolls). InkSign takes the feet used off the roll
// you pick in Cut Studio / Wide Format when each job finishes, and warns at the reorder level.
export default function InventoryPage() {
  const [rolls, setRolls] = useState(null);
  const [err, setErr] = useState('');
  const load = async () => { setErr(''); try { setRolls(await api.shopflow.rolls()); } catch (e) { setErr(clean(e.message)); setRolls([]); } };
  useEffect(() => { load(); }, []);
  const groups = [...new Set((rolls || []).map((r) => r.materialName))].sort();
  const low = (rolls || []).filter((r) => r.reorderFeet > 0 && r.remainingFeet <= r.reorderFeet);
  return (
    <div>
      <header className="page-head">
        <div><h1>Media inventory</h1><p className="muted">Rolls from InkFlow. Pick the roll in Cut Studio or Wide Format and InkSign takes the feet off when the job finishes.</p></div>
        <button className="btn" onClick={load}>Refresh</button>
      </header>
      {err && <div className="empty" style={{ textAlign: 'left' }}><b>Can't load rolls.</b><div className="muted">{err}</div></div>}
      {!!low.length && <div className="low-banner">Reorder: {low.map((r) => `${r.widthIn}" ${r.materialName} (${Math.round(r.remainingFeet)} ft)`).join(' · ')}</div>}
      {rolls && !rolls.length && !err && <div className="empty">No rolls in InkFlow yet — add them in InkFlow → Inventory.</div>}
      {groups.map((g) => (
        <section key={g}>
          <h2 className="section-title">{g}</h2>
          <div className="grid">
            {rolls.filter((r) => r.materialName === g).map((r) => {
              const isLow = r.reorderFeet > 0 && r.remainingFeet <= r.reorderFeet;
              return (
                <div key={r.id} className={`card roll-card ${isLow ? 'low' : ''}`}>
                  <div className="card-title">{r.widthIn}" wide{r.color ? ` · ${r.color}` : ""}</div>
                  <div className="roll-left"><b>{Math.round(r.remainingFeet * 10) / 10}</b> ft left</div>
                  <div className="muted small">{[r.reorderFeet ? `reorder at ${r.reorderFeet} ft` : '', r.costPerFootCents ? `$${(r.costPerFootCents / 100).toFixed(2)}/ft` : '', r.location || ''].filter(Boolean).join(' · ')}</div>
                  {isLow && <div className="pill pill-error" style={{ alignSelf: 'flex-start' }}>Reorder</div>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
