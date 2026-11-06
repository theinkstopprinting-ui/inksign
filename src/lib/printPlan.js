// Where a job lands on the printer's media — the layout behind the Print window (Flexi's RIP and Print).
// Everything in mm. The printer's origin is the RIGHT edge of the printable area at the LEADING edge
// (the first part out of the printer), so x is measured from the right and y along the feed, the way
// Flexi's preview rulers read.
//
// job:   { w, h }                     natural size of the job (mm)
// set:   { scale (%), rotate (0|90|180|270), x, y (mm, position of the first copy),
//          copies, gapX, gapY, tile (bool), overlap (mm), labels (bool), trim (bool), fit (bool) }
// media: { widthMm, lengthMm|null, margins: { left, right, lead, trail } }
//
// Returns { pieces: [{ x, y, w, h, clip: [u0, v0, u1, v1], copy, tile }], shownW, shownH, tiles,
//           usedW, usedL, printableW, problems: [], labels: [{ x, y, text }], label }

export const LABEL_MM = 7;
export const TRIM_MM = 9; // room kept around each piece for trim marks (3 mm gap + 6 mm line)

export function printableWidth(media) {
  const m = media.margins || {};
  return Math.max(10, (media.widthMm || 0) - (m.left || 0) - (m.right || 0));
}

export function shownSize(job, set) {
  const s = (Number(set.scale) || 100) / 100;
  const w = job.w * s, h = job.h * s;
  return (set.rotate || 0) % 180 ? { w: h, h: w } : { w, h };
}

/** Scale (%) that makes the job fill the printable width (Fit to media) */
export function fitScale(job, set, media) {
  const pw = printableWidth(media);
  const base = (set.rotate || 0) % 180 ? job.h : job.w;
  return base > 0 ? Math.floor((pw / base) * 10000) / 100 : 100;
}

export function plan(job, set, media) {
  const problems = [];
  const pw = printableWidth(media);
  const { w, h } = shownSize(job, set);
  const pad = set.trim ? TRIM_MM : 0;
  // Tiles across the media when the job is wider than it can print
  let tiles = [{ u0: 0, u1: w }];
  if (w + 2 * pad > pw + 0.01) {
    if (set.tile) {
      const ov = Math.max(0, Number(set.overlap) || 0);
      const room = pw - 2 * pad;
      const n = Math.max(2, Math.ceil((w - ov) / Math.max(1, room - ov)));
      const tw = (w + (n - 1) * ov) / n;
      tiles = [];
      // the first tile is the job's right-hand piece, so tile 1 is at the printer's origin
      for (let i = 0; i < n; i++) { const u1 = w - i * (tw - ov), u0 = Math.max(0, u1 - tw); tiles.push({ u0, u1 }); }
    } else problems.push(`The job is ${(w / 25.4).toFixed(2)}" wide — wider than the ${(pw / 25.4).toFixed(2)}" you can print on. Turn it, scale it down, or tile it.`);
  }
  const units = [];
  const count = Math.max(1, Math.round(Number(set.copies) || 1));
  for (let c = 0; c < count; c++) tiles.forEach((t, ti) => units.push({ copy: c + 1, tile: tiles.length > 1 ? ti + 1 : 0, w: t.u1 - t.u0, h, clip: [t.u0, 0, t.u1, h] }));

  const gapX = Math.max(0, Number(set.gapX) || 0), gapY = Math.max(0, Number(set.gapY) || 0);
  const label = set.labels ? LABEL_MM : 0;
  const x0 = Math.max(0, Number(set.x) || 0), y0 = Math.max(0, Number(set.y) || 0) + label;
  const pieces = [];
  let cx = x0, cy = y0, rowH = 0;
  for (const u of units) {
    const W = u.w + 2 * pad, H = u.h + 2 * pad;
    if (cx > x0 && cx + W > pw + 0.01) { cx = x0; cy += rowH + gapY; rowH = 0; }
    pieces.push({ x: cx + pad, y: cy + pad, w: u.w, h: u.h, clip: u.clip, copy: u.copy, tile: u.tile });
    cx += W + gapX;
    rowH = Math.max(rowH, H);
  }
  const usedW = pieces.length ? Math.max(...pieces.map((p) => p.x + p.w + pad)) : 0;
  const usedL = pieces.length ? Math.max(...pieces.map((p) => p.y + p.h + pad)) : 0;
  if (usedW > pw + 0.01 && !problems.length) problems.push(`The layout runs ${((usedW - pw) / 25.4).toFixed(2)}" past the printable width — move it right (toward 0) or make it smaller.`);
  if (media.lengthMm && usedL > media.lengthMm) problems.push(`It needs ${(usedL / 25.4 / 12).toFixed(1)} ft but only ${(media.lengthMm / 25.4 / 12).toFixed(1)} ft is left on the roll.`);
  const labels = set.labels ? [{ x: x0, y: y0 - label + 1.5, text: set.labelText || '' }] : [];
  return { pieces, shownW: w, shownH: h, tiles: tiles.length, usedW, usedL, printableW: pw, problems, labels, pad };
}

/** Trim mark lines for the pieces (in the same x-from-right / y-along coordinates) */
export function trimLines(pieces, gap = 3, len = 6) {
  const out = [];
  for (const p of pieces) {
    for (const [x, sx] of [[p.x, -1], [p.x + p.w, 1]]) for (const [y, sy] of [[p.y, -1], [p.y + p.h, 1]]) {
      out.push([{ x: x + sx * gap, y }, { x: x + sx * (gap + len), y }]);
      out.push([{ x, y: y + sy * gap }, { x, y: y + sy * (gap + len) }]);
    }
  }
  return out;
}
