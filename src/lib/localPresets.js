// The presets and choices InkSign keeps in this PC's browser storage (cut presets, Print window choices,
// Design view options, swatches…): gathered for a backup and put back on restore.
export function gatherLocal() {
  const out = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('inksign.')) out[k] = window.localStorage.getItem(k);
    }
  } catch { /* not available */ }
  return out;
}
export function putLocal(map) {
  let n = 0;
  try { for (const [k, v] of Object.entries(map || {})) if (k.startsWith('inksign.') && typeof v === 'string') { window.localStorage.setItem(k, v); n++; } } catch { /* not available */ }
  return n;
}
