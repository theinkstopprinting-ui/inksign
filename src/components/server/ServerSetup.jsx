import React, { useEffect, useState } from 'react';
import { cleanErr } from './common.js';

const api = window.inksign;

// Which PC is the print server, how the other PCs reach it, and the Windows printers
export default function ServerSetup({ onClose }) {
  const [info, setInfo] = useState(null);
  const [devices, setDevices] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [address, setAddress] = useState('');
  const [key, setKey] = useState('');

  const load = async () => {
    const i = await api.server.info();
    setInfo(i); setAddress(i.address || ''); setKey(i.clientKey || '');
    setDevices((await api.devices.list()).filter((d) => d.driver === 'network-printer'));
  };
  useEffect(() => { load(); }, []);
  if (!info) return null;

  const save = async (patch, note) => {
    setMsg('');
    try { setInfo(await api.server.saveConfig(patch)); if (note) setMsg(note); } catch (e) { setMsg(cleanErr(e)); }
  };
  const doing = async (label, fn) => {
    setBusy(label); setMsg('');
    try { setMsg(await fn()); } catch (e) { setMsg(cleanErr(e)); } finally { setBusy(''); }
  };
  const test = () => doing('test', async () => { const r = await api.server.test(address, key); return `Connected to the print server on ${r.name} (InkSign ${r.version}).`; });
  const useRemote = () => doing('save', async () => { await api.server.test(address, key); await save({ role: 'client', address, clientKey: key }); return 'This PC now uses that print server.'; });
  const printers = () => doing('printers', async () => { const names = await api.server.addPrinters({}); return `Added ${names.join(' and ')} to this PC. Print to them from any program with the Xerox's normal print options.`; });
  const firewall = () => doing('fw', async () => `Windows Firewall now lets the shop PCs reach ports ${await api.server.firewall()} (private networks).`);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h2>Print server setup</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <p className="muted small">One shop PC — the one next to the Xerox — is the print server. It holds the jobs and feeds the Xerox. InkSign on the other PCs connects to it, like Command WorkStation to a Fiery.</p>
        <div className="seg" style={{ margin: '10px 0' }}>
          {[['server', 'This PC is the print server'], ['client', 'Use the server on another PC'], ['auto', 'Automatic (from shared setup)'], ['off', 'Off']].map(([r, l]) => (
            <button key={r} className={info.setting === r ? 'on' : ''} onClick={() => (r === 'client' ? setInfo({ ...info, setting: 'client' }) : save({ role: r }))}>{l}</button>
          ))}
        </div>
        {info.setting === 'auto' && <div className="help">Automatic: a PC that follows the shared setup uses the main PC's server; otherwise this PC is the server. Right now: <b>{info.role === 'server' ? 'this PC is the server' : info.role === 'client' ? `using ${info.address}` : 'off'}</b>.</div>}

        {info.role === 'server' && info.setting !== 'client' && (
          <div className="tool-box">
            <div className="box-title">This PC is the print server</div>
            <div className="stats small">
              <div><span>Server address (for the other PCs)</span><b>{info.addresses.join(', ') || 'no network'}</b></div>
              <div><span>Server key</span><b className="mono">{info.key}</b></div>
              <div><span>Windows printer ports</span><b>Hold {info.holdPort} · Print {info.printPort}</b></div>
            </div>
            <label className="mini-field"><span>Xerox it prints to</span>
              <select value={info.printerDeviceId || devices.find((d) => d.config?.model === 'xerox-7845')?.id || ''} onChange={(e) => save({ printerDeviceId: e.target.value })}>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.name} {d.config?.host ? `(${d.config.host})` : '(no IP yet)'}</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={info.capture} onChange={(e) => save({ capture: e.target.checked })} /> Accept jobs from Windows printers (ports {info.holdPort} / {info.printPort})</label>
            <label className="mini-field" style={{ maxWidth: 220 }}><span>Keep printed jobs for (days)</span>
              <input type="number" min="1" value={info.keepPrintedDays} onChange={(e) => save({ keepPrintedDays: Number(e.target.value) || 30 })} /></label>
            <div className="row">
              <button className="btn small" disabled={!info.isWindows || !!busy} onClick={firewall}>{busy === 'fw' ? 'Waiting for Windows…' : 'Allow through Windows Firewall'}</button>
              <button className="btn small ghost" onClick={async () => { if (window.confirm('Make a new key? Every other PC will need the new key.')) setInfo(await api.server.newKey()); }}>New key</button>
            </div>
            <div className="help">On the other PCs: Setup → "Use the server on another PC", type the address and key above. If they follow the shared setup they connect by themselves.</div>
          </div>
        )}

        {(info.setting === 'client' || info.role === 'client') && (
          <div className="tool-box">
            <div className="box-title">Print server on another PC</div>
            <div className="mini-row">
              <label className="mini-field"><span>Server address</span><input type="text" placeholder="192.168.1.20:8631" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
              <label className="mini-field"><span>Server key</span><input type="text" value={key} onChange={(e) => setKey(e.target.value)} /></label>
            </div>
            {info.linkFromShared && <div className="help">From the shared setup: {info.linkFromShared.name} at {info.linkFromShared.address}</div>}
            <div className="row">
              <button className="btn small" disabled={!!busy || !address} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
              <button className="btn small primary" disabled={!!busy || !address} onClick={useRemote}>Use this server</button>
            </div>
          </div>
        )}

        <div className="tool-box" style={{ marginTop: 10 }}>
          <div className="box-title">Windows printers on this PC</div>
          <div className="small">Adds <b>InkSign 7845 - Hold</b> and <b>InkSign 7845 - Print</b> with Xerox's own 7845 PostScript driver (included with InkSign). Print from Word, Acrobat, Illustrator… — Hold waits in the Held queue, Print goes straight to the Xerox through the server. The driver's tray, paper and finishing choices come through to the job.</div>
          <button className="btn small" disabled={!info.isWindows || !!busy || info.role === 'off'} onClick={printers}>{busy === 'printers' ? 'Waiting for Windows…' : 'Add the InkSign printers'}</button>
          {!info.isWindows && <div className="help">Windows only.</div>}
        </div>
        {msg && <div className="studio-msg" style={{ marginTop: 8 }}>{msg}</div>}
        <div className="modal-foot"><span className="muted small">{info.computer}</span><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
