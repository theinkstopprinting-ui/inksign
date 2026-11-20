// Preflight for a design before it's printed or cut: picture resolution at the printed size, things
// hanging off the page, hairlines that won't print, text still live, cut lines, and art too close to the
// registration marks. Returns rows { level: 'ok' | 'info' | 'warn' | 'error', text }.
import { objBounds } from './doc.js';

const MM = 25.4;

export function preflightDoc(doc, { purpose = 'print' } = {}) {
  const rows = [];
  const vis = doc.objects.filter((o) => !o.hidden);
  if (!vis.length) return [{ level: 'error', text: 'The design is empty.' }];
  const name = (o) => o.name || o.type;
  // pictures: resolution at the size they print
  for (const o of vis.filter((x) => x.type === 'image' && x.natPx)) {
    const ppi = Math.round(Math.min(o.natPx.w / (o.w / MM), o.natPx.h / (o.h / MM)));
    const big = o.w / MM > 36 || o.h / MM > 36;
    const low = big ? 60 : 100, bad = big ? 30 : 60;
    if (ppi < bad) rows.push({ level: 'error', text: `${name(o)}: ${ppi} ppi at this size — it will print blurry or blocky. Use a bigger picture or vector art.` });
    else if (ppi < low) rows.push({ level: 'warn', text: `${name(o)}: ${ppi} ppi at this size — fine from a distance, soft up close.` });
    else rows.push({ level: 'ok', text: `${name(o)}: ${ppi} ppi at this size.` });
  }
  // off the page
  const off = vis.filter((o) => { const b = objBounds(o); return b && (b.minX < -0.5 || b.minY < -0.5 || b.maxX > doc.page.w + 0.5 || b.maxY > doc.page.h + 0.5); });
  if (off.length) rows.push({ level: 'warn', text: `${off.length} object${off.length > 1 ? 's hang' : ' hangs'} off the page (${off.slice(0, 3).map(name).join(', ')}${off.length > 3 ? '…' : ''}) — the part outside won't ${purpose === 'cut' ? 'cut' : 'print'}.` });
  // hairlines
  const thin = vis.filter((o) => !o.cut && o.stroke?.color && o.stroke.width > 0 && o.stroke.width < 0.1 && (!o.fill || o.fill.type === 'none'));
  if (thin.length && purpose !== 'cut') rows.push({ level: 'warn', text: `${thin.length} outline${thin.length > 1 ? 's are' : ' is'} thinner than 0.1 mm and may not show when printed.` });
  // live text
  const live = vis.filter((o) => o.type === 'text');
  if (live.length) rows.push({ level: 'info', text: `${live.length} text object${live.length > 1 ? 's' : ''} — printed and cut as outlines, so the font doesn't need to be on the other PC.` });
  // cut lines
  const cuts = vis.filter((o) => o.cut);
  if (purpose === 'printcut' && !cuts.length) rows.push({ level: 'error', text: 'No cut line yet — use Curves › Create cut contour.' });
  else if (cuts.length && purpose === 'print') rows.push({ level: 'info', text: `${cuts.length} cut line${cuts.length > 1 ? 's' : ''} — left off the print.` });
  // registration marks
  if (doc.marks) {
    const c = doc.marks.margin + doc.marks.size + 2;
    const close = vis.filter((o) => { const b = objBounds(o); return b && (b.minX < c || b.minY < c || b.maxX > doc.page.w - c || b.maxY > doc.page.h - c); });
    if (close.length) rows.push({ level: 'error', text: `${close.length} object${close.length > 1 ? 's are' : ' is'} inside the registration-mark area — the cutter may read it as a mark.` });
  }
  // banner finishing
  if (doc.finish?.hemMm > 0) rows.push({ level: 'info', text: `Hems: ${(doc.finish.hemMm / MM).toFixed(2)}″ on every side are part of the page — keep text inside the fold guides.` });
  if (!rows.some((r) => r.level === 'error' || r.level === 'warn')) rows.unshift({ level: 'ok', text: 'Ready.' });
  return rows;
}
