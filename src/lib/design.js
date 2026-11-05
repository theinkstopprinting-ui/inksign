// Design helpers for Cut Studio: envelope effects, simplifying nodes, shadows, and sign templates.
// Units: mm. Paths: arrays of {x, y}.
import { bounds, translate, isClosed } from './geometry.js';

// ---- Simplify (fewer nodes, same shape) — Douglas–Peucker -------------------
export function simplifyPath(p, tol) {
  if (p.length < 4 || tol <= 0) return p;
  const closed = isClosed(p);
  const pts = closed ? p.slice(0, -1) : p;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i].x - dx * pts[i].y + B.x * A.y - B.y * A.x) / L;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  if (closed) out.push({ ...out[0] });
  return out.length >= (closed ? 4 : 2) ? out : p;
}
export const simplify = (paths, tol) => paths.map((p) => simplifyPath(p, tol));
export const nodeCount = (paths) => paths.reduce((s, p) => s + p.length - (isClosed(p) ? 1 : 0), 0);

// Adds points along long straight runs so an envelope can bend them smoothly.
function densify(p, maxSeg) {
  const out = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(L / maxSeg);
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

// ---- Envelopes (text effects) -------------------------------------------
// amount: -100..100. Canvas Y grows downward, so "up" is negative Y.
export const ENVELOPES = [
  { id: 'arch', name: 'Arch' },
  { id: 'bulge', name: 'Bulge' },
  { id: 'pinch', name: 'Pinch' },
  { id: 'wave', name: 'Wave' },
  { id: 'flag', name: 'Flag' },
  { id: 'perspective', name: 'Perspective' },
  { id: 'taper', name: 'Taper (bigger on the right)' },
  { id: 'slant', name: 'Slant (italic)' },
];

export function envelope(paths, kind, amount = 30) {
  const b = bounds(paths);
  const W = b.w || 1, H = b.h || 1, k = amount / 100;
  const dense = paths.map((p) => densify(p, Math.max(W, H) / 120));
  const f = (pt) => {
    const u = (pt.x - b.minX) / W, v = (pt.y - b.minY) / H; // 0..1
    const cy = b.minY + H / 2;
    switch (kind) {
      case 'arch': return { x: pt.x, y: pt.y - k * H * Math.sin(Math.PI * u) };
      case 'bulge': { const s = 1 + k * Math.sin(Math.PI * u); return { x: pt.x, y: cy + (pt.y - cy) * s }; }
      case 'pinch': { const s = 1 - k * 0.8 * Math.sin(Math.PI * u); return { x: pt.x, y: cy + (pt.y - cy) * s }; }
      case 'wave': return { x: pt.x, y: pt.y - k * H * 0.5 * Math.sin(2 * Math.PI * u) };
      case 'flag': return { x: pt.x, y: pt.y - k * H * 0.4 * Math.sin(2 * Math.PI * u) * (0.3 + u) };
      case 'perspective': { const s = 1 - k * (1 - v) * 0.8; const cx = b.minX + W / 2; return { x: cx + (pt.x - cx) * s, y: pt.y }; }
      case 'taper': { const s = 1 + k * (u - 0.5); return { x: pt.x, y: cy + (pt.y - cy) * s }; }
      case 'slant': return { x: pt.x + k * H * 0.5 * (1 - v), y: pt.y };
      default: return pt;
    }
  };
  return dense.map((p) => simplifyPath(p.map(f), 0.02));
}

// ---- Shadow: a copy pushed down/right, as its own color layer --------------
export function dropShadow(paths, dxMm, dyMm) {
  return translate(paths, dxMm, dyMm);
}

// ---- Templates -------------------------------------------------------------
// Each template returns lines of text with letter heights; the caller renders them in a font.
export const TEMPLATES = [
  {
    id: 'usdot', name: 'USDOT number (truck door)',
    fields: [['company', 'Company name', 'THE INK STOP'], ['city', 'City, State', 'ANYTOWN, TX'], ['dot', 'USDOT number', '1234567'], ['mc', 'MC number (optional)', '']],
    help: 'FMCSA: the name and USDOT number must contrast with the truck and be readable from 50 ft while stopped — 2" letters are the usual minimum. Both sides of the vehicle.',
    lines: (f) => [
      { text: f.company, heightIn: 3 },
      f.city ? { text: f.city, heightIn: 1.5 } : null,
      { text: `USDOT ${String(f.dot).replace(/\D/g, '')}`, heightIn: 2 },
      f.mc ? { text: `MC ${String(f.mc).replace(/\D/g, '')}`, heightIn: 2 } : null,
    ].filter(Boolean),
    align: 'center', copies: 2,
  },
  {
    id: 'boat', name: 'Boat registration number',
    fields: [['state', 'State letters', 'TX'], ['number', 'Numbers', '1234'], ['suffix', 'Suffix letters', 'AB']],
    help: 'USCG (33 CFR 173.27): plain vertical block letters at least 3" high, contrasting color, both sides of the bow, read left to right. Spaces between groups equal to one letter width — done automatically. Use a plain block font (e.g. Arial Bold).',
    lines: (f) => [{ text: `${String(f.state).toUpperCase()} ${String(f.number).replace(/\D/g, '')} ${String(f.suffix).toUpperCase()}`.trim(), heightIn: 3, spaceAsLetter: true }],
    align: 'left', copies: 2,
  },
  {
    id: 'yard', name: 'Yard sign 24 × 18',
    fields: [['line1', 'Headline', 'FOR SALE'], ['line2', 'Second line', 'CALL 555-0100']],
    help: 'Coroplast 24 × 18 with a 1/2" border frame. Cut the lettering in vinyl, or use the frame as a guide.',
    lines: (f) => [{ text: f.line1, heightIn: 4 }, f.line2 ? { text: f.line2, heightIn: 2 } : null].filter(Boolean),
    frame: { wIn: 24, hIn: 18, borderIn: 0.5 }, align: 'center',
  },
  {
    id: 'door', name: 'Vehicle door lettering',
    fields: [['company', 'Company', 'THE INK STOP'], ['tag', 'What you do', 'SCREEN PRINTING · SIGNS'], ['phone', 'Phone', '555-0100'], ['web', 'Website', 'theinkstopprinting.com']],
    help: 'Sized for a pickup door (about 36" wide). Resize to the vehicle — measure the flat area first.',
    lines: (f) => [
      { text: f.company, heightIn: 4 }, f.tag ? { text: f.tag, heightIn: 1.5 } : null,
      f.phone ? { text: f.phone, heightIn: 2.5 } : null, f.web ? { text: f.web, heightIn: 1.25 } : null,
    ].filter(Boolean),
    align: 'center', copies: 2, maxWidthIn: 34,
  },
  {
    id: 'hours', name: 'Store hours (window)',
    fields: [['title', 'Title', 'HOURS'], ['l1', 'Line 1', 'MON–FRI  9AM – 6PM'], ['l2', 'Line 2', 'SAT  10AM – 2PM'], ['l3', 'Line 3', 'SUN  CLOSED']],
    help: 'Typical door vinyl: 1" lines, 2" title. Mirror it if it goes on the inside of the glass.',
    lines: (f) => [{ text: f.title, heightIn: 2 }, ...[f.l1, f.l2, f.l3].filter(Boolean).map((t) => ({ text: t, heightIn: 1 }))],
    align: 'center',
  },
];

// Stacks rendered lines (each {paths, w, h}) centered/left with a line gap, optional frame.
export function stackLines(rendered, { align = 'center', gapMm = 12.7, frame = null } = {}) {
  const maxW = Math.max(...rendered.map((r) => r.w));
  const out = [];
  let y = 0;
  for (const r of rendered) {
    const x = align === 'center' ? (maxW - r.w) / 2 : 0;
    out.push(...translate(r.paths, x, y));
    y += r.h + gapMm;
  }
  if (!frame) return out;
  const W = frame.wIn * 25.4, H = frame.hIn * 25.4, bdr = frame.borderIn * 25.4;
  const b = bounds(out);
  const placedText = translate(out, (W - b.w) / 2 - b.minX, (H - b.h) / 2 - b.minY);
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
  return [rect(0, 0, W, H), rect(bdr, bdr, W - bdr, H - bdr), ...placedText];
}
