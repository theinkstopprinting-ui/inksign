import React, { useEffect, useMemo, useState } from 'react';

const api = window.inksign;

function visible(field, cfg) {
  if (!field.showIf) return true;
  return Object.entries(field.showIf).every(([k, v]) => String(cfg[k] ?? '') === String(v));
}

function Field({ field, value, onChange, printers, comPorts, refreshLists, dynOptions }) {
  const id = `f-${field.key}`;
  let input;
  switch (field.type) {
    case 'select':
      input = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'dynselect': {
      // Choices worked out by the driver (HP media list, the chosen media's print modes, profiles on this PC)
      const opts = dynOptions[field.optionsFrom] || [];
      const groups = [...new Set(opts.map((o) => o.group || ''))];
      const option = (o) => <option key={o.value} value={o.value}>{o.label}</option>;
      input = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {value && !opts.some((o) => o.value === value) && <option value={value}>{opts.length ? 'Not available — pick again' : 'Loading…'}</option>}
          {groups.length > 1 ? groups.map((g) => (g ? <optgroup key={g} label={g}>{opts.filter((o) => (o.group || '') === g).map(option)}</optgroup> : opts.filter((o) => !o.group).map(option))) : opts.map(option)}
        </select>
      );
      break;
    }
    case 'textarea':
      input = <textarea id={id} rows={4} className="code-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
      break;
    case 'bool':
      input = <label className="check"><input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> On</label>;
      break;
    case 'number':
      input = <input id={id} type="number" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
      break;
    case 'printer':
      input = (
        <div className="row">
          <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">— choose the cutter's Windows printer —</option>
            {value && !printers.some((p) => p.name === value) && <option value={value}>{value} (not found)</option>}
            {printers.map((p) => <option key={p.name} value={p.name}>{p.name}{p.port ? `  [${p.port}]` : ''}</option>)}
          </select>
          <button type="button" className="btn ghost" onClick={refreshLists}>↻</button>
        </div>
      );
      break;
    case 'comport':
      input = (
        <div className="row">
          <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">— choose a port —</option>
            {value && !comPorts.includes(value) && <option value={value}>{value} (not found)</option>}
            {comPorts.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button type="button" className="btn ghost" onClick={refreshLists}>↻</button>
        </div>
      );
      break;
    case 'folder':
      input = (
        <div className="row">
          <input id={id} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="C:\HotFolders\Latex335" />
          <button type="button" className="btn" onClick={async () => { const f = await api.system.pickFolder(); if (f) onChange(f); }}>Browse…</button>
        </div>
      );
      break;
    default:
      input = <input id={id} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}{field.required && <span className="req"> *</span>}</label>
      {input}
      {field.help && <div className="help">{field.help}</div>}
    </div>
  );
}

export default function DeviceEditor({ catalog, device, onClose, onSaved }) {
  const [presetId, setPresetId] = useState(device?.presetId || null);
  const [name, setName] = useState(device?.name || '');
  const [cfg, setCfg] = useState(device?.config || {});
  const [printers, setPrinters] = useState([]);
  const [comPorts, setComPorts] = useState([]);
  const [error, setError] = useState('');
  const [dynOptions, setDynOptions] = useState({});

  const preset = catalog.presets.find((p) => p.id === presetId);
  const driver = useMemo(() => preset && catalog.drivers.find((d) => d.id === preset.driver), [preset, catalog]);

  const refreshLists = async () => {
    setPrinters(await api.system.printers());
    setComPorts(await api.system.comPorts());
  };
  useEffect(() => { refreshLists(); }, []);
  // Re-ask the driver for dependent choices when the settings they hang on change
  const dynKeys = driver ? driver.fields.filter((f) => f.type === 'dynselect').map((f) => f.optionsFrom) : [];
  const dynDeps = JSON.stringify([driver?.id, cfg.host, cfg.model, cfg.mediaId]);
  useEffect(() => {
    if (!driver || !dynKeys.length || !api.devices.fieldOptions) return undefined;
    let live = true;
    Promise.all(dynKeys.map((k) => api.devices.fieldOptions(driver.id, k, cfg).then((o) => [k, o]).catch(() => [k, []])))
      .then((pairs) => { if (live) setDynOptions(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [dynDeps]); // eslint-disable-line react-hooks/exhaustive-deps

  const choosePreset = (p) => {
    setPresetId(p.id);
    setName(p.name);
    const d = catalog.drivers.find((x) => x.id === p.driver);
    const defaults = {};
    d.fields.forEach((f) => { if (f.default !== undefined) defaults[f.key] = f.default; });
    setCfg({ ...defaults, ...p.config });
  };

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Give the device a name.');
    try {
      await window.inksign.devices.save({ id: device?.id, presetId, name: name.trim(), config: cfg });
      onSaved();
    } catch (e) { setError(e.message); }
  };

  const remove = async () => {
    if (!confirm(`Remove ${device.name}? Its job history stays in the queue.`)) return;
    await api.devices.remove(device.id);
    onSaved();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{device ? `Settings — ${device.name}` : preset ? `Add ${preset.name}` : 'Add a device'}</h2>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>

        {!preset && (
          <div className="preset-pick">
            {['cutter', 'printer'].map((kind) => (
              <div key={kind}>
                <h3 className="section-title">{kind === 'cutter' ? 'Cutters' : 'Printers'}</h3>
                <div className="preset-grid">
                  {catalog.presets.filter((p) => p.kind === kind).map((p) => (
                    <button key={p.id} className="preset" onClick={() => choosePreset(p)}>
                      <strong>{p.name}</strong><span className="muted small">{p.maker}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {preset && driver && (
          <div className="form">
            <div className="field">
              <label>Name in InkSign</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
              <div className="help">{driver.name}</div>
            </div>
            {driver.fields.filter((f) => visible(f, cfg)).map((f) => (
              <React.Fragment key={f.key}>
                {f.section && <h3 className="section-title form-section">{f.section}</h3>}
                <div className={f.type === 'textarea' ? 'field-wide' : undefined} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                  <Field field={f} value={cfg[f.key]} printers={printers} comPorts={comPorts} dynOptions={dynOptions}
                    refreshLists={refreshLists} onChange={(v) => setCfg((c) => ({ ...c, [f.key]: v, ...(f.key === 'mediaId' ? { modeKey: '' } : {}) }))} />
                </div>
              </React.Fragment>
            ))}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="modal-foot">
          {device ? <button className="btn danger" onClick={remove}>Remove device</button> : <span />}
          <div className="row">
            {!device && preset && <button className="btn ghost" onClick={() => setPresetId(null)}>← Back</button>}
            <button className="btn" onClick={onClose}>Cancel</button>
            {preset && <button className="btn primary" onClick={save}>Save</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
