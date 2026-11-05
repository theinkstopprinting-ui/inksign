// Skyline nesting: packs pieces (by their bounding box) across the roll width,
// trying both orientations, to use the least roll length.
// pieces: [{id, w, h}] in mm, w = along roll (X), h = across roll (Y).
// Returns [{id, x, y, rotated}].
export function nest(pieces, rollWidth, { gap = 6, allowRotate = true } = {}) {
  let sky = [{ y: 0, len: rollWidth, x: 0 }]; // segments across the roll, x = used length
  const order = [...pieces].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  const out = [];
  for (const p of order) {
    const opts = [{ w: p.w, h: p.h, rotated: false }];
    if (allowRotate && !p.noRotate && Math.abs(p.w - p.h) > 0.5) opts.push({ w: p.h, h: p.w, rotated: true });
    let best = null;
    for (const o of opts) {
      const across = o.h + gap;
      if (o.h > rollWidth) continue;
      for (let i = 0; i < sky.length; i++) {
        const y = sky[i].y;
        if (y + o.h > rollWidth + 0.01) break;
        let x = 0, j = i, covered = 0;
        while (covered < across && j < sky.length) { x = Math.max(x, sky[j].x); covered += sky[j].len; j++; }
        if (covered < Math.min(across, rollWidth - y) - 0.01) continue;
        const score = x + o.w;
        if (!best || score < best.score - 0.01 || (Math.abs(score - best.score) < 0.01 && y < best.y)) best = { score, x, y, o };
      }
    }
    if (!best) {
      // Too big for the roll in any orientation: place it after everything (tiling will split it)
      const x = Math.max(0, ...sky.map((s) => s.x));
      out.push({ id: p.id, x, y: 0, rotated: false });
      sky = [{ y: 0, len: rollWidth, x: x + p.w + gap }];
      continue;
    }
    out.push({ id: p.id, x: best.x, y: best.y, rotated: best.o.rotated });
    // Update skyline: segment [y, y+across) now has x = best.x + w + gap
    const y0 = best.y, y1 = Math.min(rollWidth, best.y + best.o.h + gap), nx = best.x + best.o.w + gap;
    const next = [];
    for (const s of sky) {
      const s0 = s.y, s1 = s.y + s.len;
      if (s1 <= y0 || s0 >= y1) { next.push(s); continue; }
      if (s0 < y0) next.push({ y: s0, len: y0 - s0, x: s.x });
      if (s1 > y1) next.push({ y: y1, len: s1 - y1, x: s.x });
    }
    next.push({ y: y0, len: y1 - y0, x: nx });
    next.sort((a, b) => a.y - b.y);
    // merge equal neighbours
    sky = next.reduce((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && Math.abs(last.x - s.x) < 0.01 && Math.abs(last.y + last.len - s.y) < 0.01) last.len += s.len;
      else acc.push({ ...s });
      return acc;
    }, []);
  }
  return out;
}
