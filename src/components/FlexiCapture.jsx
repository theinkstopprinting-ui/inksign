import React, { useEffect, useState } from 'react';
import Icon from './shell/Icon.jsx';

const api = window.inksign;
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const mb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Which test file to send from Flexi for each kind of machine
const TESTS = {
  printer: [['1 - HP print test 12x12.pdf', 'Print it at 100% on your usual media (e.g. Generic Self-Adhesive Vinyl).']],
  cutter: [
    ['2 - Cutter test 4x4 (CutContour).pdf', 'A plain cut: 2" square, 1" circle, star.'],
    ['3 - Print and cut test 6x4.pdf', 'Then a print & cut job: let Flexi add its registration marks and send the cut part to this cutter.'],
  ],
};

// "Learn from Flexi": records exactly what Flexi sends a machine, so InkSign can be matched to it.
export default function FlexiCapture({ devices, onClose }) {
  const machines = devices.filter((d) => d.kind === 'cutter' || /latex|flexi/i.test(`${d.name} ${d.driver}`));
  const [devId, setDevId] = useState(machines[0]?.id || '');
  const dev = machines.find((d) => d.id === devId);
  const kind = dev?.kind === 'cutter' ? 'cutter' : 'printer';
  const [route, setRoute] = useState('network');
  const [port, setPort] = useState(9100);
  const [st, setSt] = useState(null);
  const [recv, setRecv] = useState(0);
  const [got, setGot] = useState([]);
  const [msg, setMsg] = useState('');
  const [kit, setKit] = useState(null);

  useEffect(() => {
    api.capture.state().then(setSt);
    const off = api.capture.onEvent((r) => {
      if (r.receiving) setRecv(r.receiving);
      else if (r.file) { setGot((g) => [r, ...g]); setRecv(0); }
    });
    return () => { off(); api.capture.stop(); };
  }, []);
  useEffect(() => { setRoute(kind === 'printer' ? 'network' : 'network'); }, [kind]);

  const listen = async () => { setMsg(''); try { setSt({ ...(await api.capture.state()), ...(await api.capture.listen({ machine: dev.name, port })) }); } catch (e) { setMsg(clean(e)); } };
  const stop = async () => { await api.capture.stop(); setSt(await api.capture.state()); };
  const makeKit = async () => { setMsg(''); try { setKit(await api.capture.kit()); } catch (e) { setMsg(clean(e)); } };
  const pick = async () => { setMsg(''); try { const r = await api.capture.importFile(dev.name); if (r) setGot((g) => [r, ...g]); } catch (e) { setMsg(clean(e)); } };
  const printerIp = dev?.config?.printerHost || dev?.config?.host || dev?.config?.tcpHost || '';

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fc-modal">
        <div className="modal-head"><h2><Icon name="info" /> Learn from Flexi</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
        <p className="muted">Flexi sends one small test job to InkSign instead of the machine. InkSign saves it so it can be made to send <b>exactly</b> the same commands. Nothing prints or cuts while you do this.</p>

        <div className="fc-steps">
          <section className="fc-step">
            <div className="fc-num">1</div>
            <div className="fc-body">
              <b>Which machine?</b>
              <div className="fc-machines">
                {machines.map((d) => (
                  <button key={d.id} className={`fc-machine ${d.id === devId ? 'on' : ''}`} onClick={() => setDevId(d.id)}>
                    <Icon name={d.kind === 'cutter' ? 'cutter' : 'print'} /> {d.name}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="fc-step">
            <div className="fc-num">2</div>
            <div className="fc-body">
              <b>Get the test files</b>
              <div className="row"><button className="btn" onClick={makeKit}><Icon name="file" size={15} /> Save the test files to Downloads</button>{kit && <span className="ok-text small">Saved in {kit.folder}</span>}</div>
              <ul className="fc-list">{(TESTS[kind] || []).map(([f, t]) => <li key={f}><b>{f}</b> — {t}</li>)}</ul>
            </div>
          </section>

          <section className="fc-step">
            <div className="fc-num">3</div>
            <div className="fc-body">
              <b>Point Flexi at InkSign</b>
              {kind === 'cutter' && (
                <div className="seg" style={{ margin: '4px 0 8px' }}>
                  <button className={route === 'network' ? 'on' : ''} onClick={() => setRoute('network')}>Flexi port: TCP/IP (easiest)</button>
                  <button className={route === 'file' ? 'on' : ''} onClick={() => setRoute('file')}>Flexi port: File</button>
                </div>
              )}
              {route === 'network' ? (<>
                <ol className="fc-list">
                  <li>Click <b>Start listening</b> below.</li>
                  <li>In <b>Flexi Production Manager</b>, right-click the <b>{dev?.name}</b> setup → <b>Properties</b> → <b>Port</b>.</li>
                  {kind === 'printer'
                    ? <li>Write down the printer's IP address{printerIp ? ` (InkSign has ${printerIp})` : ''}, then change it to <b className="mono">127.0.0.1</b> and the port to <b className="mono">{port}</b>. OK.</li>
                    : <li>Choose <b>TCP/IP</b> (if Flexi offers it for this cutter), address <b className="mono">127.0.0.1</b>, port <b className="mono">{port}</b>. OK. If there's no TCP/IP choice, use <b>File</b> instead (button above).</li>}
                  <li>Send the test file from Flexi to that setup like a normal job.</li>
                  <li><b>Afterwards: put the port back</b> ({kind === 'printer' ? `the printer's IP${printerIp ? ` ${printerIp}` : ''}` : 'USB'}) so real jobs reach the machine again.</li>
                </ol>
                <div className="row">
                  {st?.listening ? <button className="btn" onClick={stop}>Stop listening</button>
                    : <button className="btn primary" disabled={!dev} onClick={listen}><Icon name="dot" size={14} /> Start listening</button>}
                  <label className="mini-field" style={{ maxWidth: 110 }}><span>Port</span><input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 9100)} disabled={st?.listening} /></label>
                  {st?.listening && <span className="fc-live"><i />Listening on port {st.port}{recv ? ` — receiving ${mb(recv)}…` : ' — send the job from Flexi now'}</span>}
                </div>
              </>) : (<>
                <ol className="fc-list">
                  <li>In Flexi Production Manager, right-click the <b>{dev?.name}</b> setup → <b>Properties</b> → <b>Port</b> → choose <b>File</b>. OK.</li>
                  <li>Send the test file from Flexi to that setup. Flexi asks where to save — save it anywhere (Desktop is fine).</li>
                  <li>Click <b>Pick the file Flexi saved</b>. Then set the port back to <b>USB</b>.</li>
                </ol>
                <button className="btn primary" disabled={!dev} onClick={pick}><Icon name="file" size={15} /> Pick the file Flexi saved…</button>
              </>)}
            </div>
          </section>

          <section className="fc-step">
            <div className="fc-num">4</div>
            <div className="fc-body">
              <b>Captured</b>
              {got.length ? got.map((g) => (
                <div key={g.file} className="fc-got"><Icon name="check" /> <span><b>{g.machine}</b> — {mb(g.bytes)} of {g.looks} ({g.how})<br /><small className="muted">{g.file}</small></span></div>
              )) : <div className="muted small">Nothing yet.</div>}
              <div className="row"><button className="btn small" onClick={() => api.capture.openFolder()}>Open the captures folder</button><span className="help">Tell Claude when they're there — it reads them from Downloads\InkSign captures.</span></div>
            </div>
          </section>
        </div>
        {msg && <div className="studio-msg">{msg}</div>}
        <div className="modal-foot"><span className="muted small">One capture per machine is enough to start; the print & cut one teaches the mark reading.</span><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
