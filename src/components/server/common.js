// Shared bits for the print server pages
export const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const STATUS = {
  held: { label: 'Held', cls: 'pill-setup' },
  waiting: { label: 'Waiting', cls: 'pill-wait' },
  processing: { label: 'Processing', cls: 'pill-job-sending' },
  printing: { label: 'Printing', cls: 'pill-job-sending' },
  printed: { label: 'Printed', cls: 'pill-ok' },
  error: { label: 'Error', cls: 'pill-error' },
};

export function fmtDate(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Paper sizes in inches for labels: "Tabloid (11 x 17")"
export const sizeLabel = (caps, key) => caps.sizes.find((s) => s.key === key)?.label || key;
export const choiceLabel = (list, key) => list.find((c) => c.key === key)?.label || key;

export const DEFAULT_PROPS = {
  copies: 1, collate: true, notes: '',
  media: { catalogId: '', size: 'Letter', customW: 8.5, customH: 11, type: 'PrinterDefault', color: 'White', tray: 'auto' },
  sides: 'one', binding: 'long', scale: 'fit', rotate180: false,
  layout: { mode: 'none', bleedIn: 0, gapIn: '', cropMarks: true, allowRotate: true, repeatBack: true },
  color: { mode: 'color', manage: false, rgbProfileId: '', cmykProfileId: '', outputProfileId: '', intent: 0, blackText: false, overprint: 'printer' },
  quality: 'Standard',
  finishing: { staple: 'None', fold: 'None', punch: 'None', banner: false },
  mixed: { ranges: [], inserts: [], chapters: '', frontCover: { catalogId: '', content: 'print' }, backCover: { catalogId: '', content: 'print' } },
};

export function withDefaults(p = {}) {
  const d = DEFAULT_PROPS;
  return {
    ...d, ...p,
    media: { ...d.media, ...(p.media || {}) }, layout: { ...d.layout, ...(p.layout || {}) }, color: { ...d.color, ...(p.color || {}) },
    finishing: { ...d.finishing, ...(p.finishing || {}) },
    mixed: { ...d.mixed, ...(p.mixed || {}), frontCover: { ...d.mixed.frontCover, ...(p.mixed?.frontCover || {}) }, backCover: { ...d.mixed.backCover, ...(p.mixed?.backCover || {}) }, ranges: p.mixed?.ranges || [], inserts: p.mixed?.inserts || [] },
  };
}

export const paperText = (c, caps) => `${c.name} — ${sizeLabel(caps, c.size).replace(/\s*\(.*\)/, '')}${c.size === 'Custom' ? ` ${c.customW}×${c.customH}"` : ''}, ${choiceLabel(caps.mediaTypes, c.type)}`;
