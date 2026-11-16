// The work behind the "Send to be Cut" window (modeled on VinylMaster's): takes the shapes to cut,
// grouped by color, and the options picked in the window, and returns the cut jobs exactly as they go to
// the cutter — so the preview, the Area Test and the cut all come from the same numbers.
//
// Geometry is in mm. X runs along the roll (the feed), Y across it. A job's paths start at (0, 0).
import { bounds, isClosed, sortCutOrder, weedBorder, tileJob, totalLength } from './geometry.js';
import { weld, groupShapes } from './cuttools.js';

export const MM = 25.4;

// Starting points for the cutting condition (VinylMaster's blade list). Blank force / speed = whatever is
// set on the cutter's own panel.
export const TOOL_PRESETS = [
  { name: '45° blade — vinyl', force: '', speed: '', overcutMm: 0.5, passes: 1, dash: null },
  { name: '30° blade — thin film / window tint', force: '', speed: '', overcutMm: 0.3, passes: 1, dash: null },
  { name: '60° blade — thick or reflective', force: '', speed: '', overcutMm: 0.75, passes: 1, dash: null },
  { name: '60° blade — sandblast / magnet (2 passes)', force: '', speed: '', overcutMm: 0.75, passes: 2, dash: null },
  { name: 'Pen — draw, don\'t cut', force: '', speed: '', overcutMm: 0, passes: 1, dash: null },
  { name: 'Perforate — dashed cut (pounce, tear-off)', force: '', speed: '', overcutMm: 0, passes: 1, dash: { cutMm: 20, gapMm: 1 } },
];

export const DEFAULTS = {
  separate: true,        // one job per color (each on its own vinyl); false = everything in one job
  rotate: false,         // turn the job 90°
  mirror: false,         // heat transfer, inside-glass lettering
  copies: 1, copyGapMm: 6.35,
  weldOverlaps: false,   // overlapping letters become one outline (script fonts)
  weedBox: false,        // a box around the job
  speedWeed: false,      // the box plus lines between rows, so the waste comes off in strips
  weedOffsetMm: 5,
  easyLift: false,       // a short cut inside each hole (the middles of O, A, e…) to lift it out
  regMarks: false,       // small squares in the same place on every color, to line the layers up
  cutHolesFirst: true,   // insides before outsides, and nearest-next ordering
  passes: 1,
  dash: null,            // { cutMm, gapMm } = perforated cut
  posXMm: 0, posYMm: 0,  // move the job from the origin
  mediaWidthMm: 0,       // usable width across the roll (0 = don't check)
  autoTile: false, tileLengthMm: 0, tileOverlapMm: 10,
};

const move = (paths, dx, dy) => paths.map((p) => p.map((q) => ({ x: q.x + dx, y: q.y + dy })));
const boxPath = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];

/** A short cut across the inside of every hole, so the middles lift out fast when weeding */
export function liftMarks(paths) {
  const out = [];
  for (const shape of groupShapes(paths.filter(isClosed))) {
    for (const hole of shape.slice(1)) {
      const b = bounds([hole]);
      if (b.w < 3 || b.h < 3) continue;
      const cy = (b.minY + b.maxY) / 2 + 0.013;
      const xs = [];
      for (let i = 1; i < hole.length; i++) {
        const a = hole[i - 1], c = hole[i];
        if ((a.y <= cy && c.y > cy) || (c.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (c.y - a.y)) * (c.x - a.x));
      }
      xs.sort((m, n) => m - n);
      if (xs.length < 2) continue;
      const gap = Math.min(1, (xs[1] - xs[0]) * 0.15);
      if (xs[1] - xs[0] - 2 * gap < 1) continue;
      out.push([{ x: xs[0] + gap, y: cy }, { x: xs[1] - gap, y: cy }]);
    }
  }
  return out;
}

/** Lines across the weed box in the gaps between rows of shapes (lines of text) */
export function rowLines(paths, box, minGapMm = 3) {
  const rows = paths.filter(isClosed).map((p) => bounds([p])).map((b) => [b.minY, b.maxY]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1];
    if (gap < minGapMm) continue;
    const y = (merged[i][0] + merged[i - 1][1]) / 2;
    out.push([{ x: box.minX, y }, { x: box.maxX, y }]);
  }
  return out;
}

/** Cut a path as dashes: cutMm down, gapMm up, all the way round */
export function dashPath(p, cutMm, gapMm) {
  const cut = Math.max(0.5, Number(cutMm) || 0), gap = Math.max(0.2, Number(gapMm) || 0);
  const out = [];
  let cur = [p[0]], left = cut, down = true;
  for (let i = 1; i < p.length; i++) {
    let a = p[i - 1];
    const b = p[i];
    let len = Math.hypot(b.x - a.x, b.y - a.y);
    while (len > left) {
      const t = left / len;
      const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (down) { cur.push(m); if (cur.length > 1) out.push(cur); }
      cur = [m];
      a = m; len -= left;
      down = !down; left = down ? cut : gap;
    }
    left -= len;
    if (down) cur.push(b); else cur = [b];
  }
  if (down && cur.length > 1) out.push(cur);
  return out;
}

const SQ = 5, SQ_OUT = 8; // layer-alignment squares: 5 mm, 8 mm outside the art
function alignSquares(b) {
  const xs = [b.minX - SQ_OUT - SQ, b.maxX + SQ_OUT], ys = [b.minY - SQ_OUT - SQ, b.maxY + SQ_OUT];
  return xs.flatMap((x) => ys.map((y) => boxPath(x, y, x + SQ, y + SQ)));
}

/**
 * groups: [{ name, color, paths }] in page mm (as drawn). opts: see DEFAULTS.
 * Returns { jobs: [{ name, color, paths, w, h, cutMm }], warnings: [], totalCutMm, mediaMm (roll length used) }
 */
export function planCut(groups, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const warnings = [];
  let sets = groups.filter((g) => g.paths && g.paths.length);
  if (!sets.length) return { jobs: [], warnings, totalCutMm: 0, mediaMm: 0 };
  if (!o.separate && sets.length > 1) sets = [{ name: 'All colors', color: null, paths: sets.flatMap((g) => g.paths) }];
  const all = bounds(sets.flatMap((g) => g.paths));
  const marks = o.regMarks ? alignSquares(all) : [];
  const copies = Math.max(1, Math.round(Number(o.copies) || 1));
  const passes = Math.max(1, Math.min(5, Math.round(Number(o.passes) || 1)));
  const jobs = [];

  for (const g of sets) {
    let paths = o.weldOverlaps ? weld(g.paths) : g.paths.map((p) => p.slice());
    const art = paths;
    const extra = [];
    if (o.easyLift) extra.push(...liftMarks(art));
    if (o.weedBox || o.speedWeed) {
      // with alignment squares the box goes round them too, the same on every color
      const border = weedBorder([...art, ...marks], Number(o.weedOffsetMm) || 0);
      const bb = bounds([border]);
      if (o.speedWeed) extra.push(...rowLines(art, bb));
      extra.push(border);
    }
    paths = [...art, ...marks.map((m) => m.slice()), ...extra];

    // as it will sit on the roll
    if (o.rotate) paths = paths.map((p) => p.map(({ x, y }) => ({ x: -y, y: x })));
    if (o.mirror) paths = paths.map((p) => p.map(({ x, y }) => ({ x: -x, y })));
    let b = bounds(paths);
    paths = move(paths, -b.minX, -b.minY);
    b = bounds(paths);

    // copies: side by side across the roll while they fit, then further along it
    if (copies > 1) {
      const gap = Number(o.copyGapMm) || 0;
      const across = o.mediaWidthMm > 0 ? Math.max(1, Math.floor((o.mediaWidthMm - (Number(o.posYMm) || 0) + gap) / (b.h + gap))) : 1;
      const one = paths;
      paths = [];
      for (let k = 0; k < copies; k++) paths.push(...move(one, Math.floor(k / across) * (b.w + gap), (k % across) * (b.h + gap)));
      b = bounds(paths);
    }
    if (o.cutHolesFirst) paths = sortCutOrder(paths);
    if (o.dash && o.dash.cutMm > 0) paths = paths.flatMap((p) => dashPath(p, o.dash.cutMm, o.dash.gapMm));
    if (passes > 1) paths = paths.flatMap((p) => Array.from({ length: passes }, () => p));
    if (o.posXMm || o.posYMm) paths = move(paths, Number(o.posXMm) || 0, Number(o.posYMm) || 0);

    const wide = o.mediaWidthMm > 0 && b.h + (Number(o.posYMm) || 0) > o.mediaWidthMm + 0.01;
    const long = o.tileLengthMm > 0 && b.w > o.tileLengthMm + 0.01;
    if (o.autoTile && (wide || long)) {
      const tiles = tileJob(paths, { maxAcrossMm: o.mediaWidthMm || 0, maxAlongMm: o.tileLengthMm || 0, overlapMm: o.tileOverlapMm });
      for (const t of tiles) {
        const tb = bounds(t.paths);
        jobs.push({ name: `${g.name} — ${t.name}`, color: g.color, paths: t.paths, w: tb.maxX, h: tb.maxY, cutMm: totalLength(t.paths), tile: t.name });
      }
      continue;
    }
    if (wide) {
      warnings.push(`${g.name}: ${(b.h / MM).toFixed(1)}″ across is wider than the ${(o.mediaWidthMm / MM).toFixed(1)}″ you can cut — turn it, scale it, or switch on tiling.`);
    }
    const fb = bounds(paths);
    jobs.push({ name: g.name, color: g.color, paths, w: fb.maxX, h: fb.maxY, cutMm: totalLength(paths) });
  }
  return {
    jobs, warnings,
    totalCutMm: jobs.reduce((s, j) => s + j.cutMm, 0),
    mediaMm: jobs.reduce((s, j) => s + j.w, 0),
  };
}

/** The outline the Area Test traces with the blade up: the job's outer box */
export function areaBox(job) {
  const b = bounds(job.paths);
  return boxPath(b.minX, b.minY, b.maxX, b.maxY);
}

/** Vinyl usage report rows: one per job */
export function usageReport(plan, mediaWidthMm) {
  return plan.jobs.map((j) => {
    const widthMm = mediaWidthMm > 0 ? mediaWidthMm : j.h;
    return { name: j.name, color: j.color, lengthIn: j.w / MM, widthIn: j.h / MM, sqFt: (j.w * widthMm) / (MM * MM * 144), cutFt: j.cutMm / MM / 12 };
  });
}
