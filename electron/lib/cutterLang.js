// Cutter language generators (HP-GL and Graphtec GP-GL).
// All geometry is in millimetres. A "path" is an array of {x, y} points.

const MM_PER_IN = 25.4;

function isNum(v) {
  return v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v));
}

// Rotate / mirror the job, then shift it so the lowest point sits at (0,0).
function transformPaths(paths, { rotate = 0, mirror = false } = {}) {
  const r = ((Number(rotate) % 360) + 360) % 360;
  let out = paths.map((p) =>
    p.map(({ x, y }) => {
      let nx = mirror ? -x : x;
      let ny = y;
      if (r === 90) [nx, ny] = [-ny, nx];
      else if (r === 180) [nx, ny] = [-nx, -ny];
      else if (r === 270) [nx, ny] = [ny, -nx];
      return { x: nx, y: ny };
    })
  );
  const b = bounds(out);
  return out.map((p) => p.map(({ x, y }) => ({ x: x - b.minX, y: y - b.minY })));
}

function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const { x, y } of p) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function isClosed(p) {
  if (p.length < 3) return false;
  const a = p[0], b = p[p.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
}

// For closed shapes, keep cutting past the start point so the weed is clean.
function addOvercut(paths, overcutMm) {
  const oc = Number(overcutMm) || 0;
  if (oc <= 0) return paths;
  return paths.map((p) => {
    if (!isClosed(p)) return p;
    const out = p.slice();
    let remaining = oc;
    for (let i = 1; i < p.length && remaining > 0; i++) {
      const a = p[i - 1], b = p[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      if (len >= remaining) {
        const t = remaining / len;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        remaining = 0;
      } else {
        out.push(b);
        remaining -= len;
      }
    }
    return out;
  });
}

function prepare(paths, cfg = {}) {
  // Registered (print & cut) jobs: coordinates are already relative to the marks — don't move them.
  if (cfg.keepOrigin) return addOvercut(paths, cfg.overcutMm);
  const t = transformPaths(paths, cfg);
  const margin = Number(cfg.marginMm) || 0;
  // shiftX/shiftY: where the job starts — after the last job on the roll, or a start point set by jogging
  const dx = margin + (Number(cfg.shiftX) || 0), dy = margin + (Number(cfg.shiftY) || 0);
  const shifted = dx || dy ? t.map((p) => p.map(({ x, y }) => ({ x: x + dx, y: y + dy }))) : t;
  return addOvercut(shifted, cfg.overcutMm);
}

// HP-GL exactly as Flexi 22 sends it to the shop's cutters (captured 5 Nov 2026):
//  Titan 3:   IN;PU x,y;PD;PD x,y;PD x,y;…;PU;  …  !PG;            (marks: MK0,0,dx,dy; first)
//  Graphtec:  IN;FD35;VS50;PA x,y;PR;PD;PD dx,dy;…;PU;  …  PA end,0;!PG0;IN;
function flexiStyleHPGL(prepared, cfg, u) {
  const style = cfg.hpglStyle;
  let s = 'IN;';
  if (style === 'graphtec') {
    if (isNum(cfg.force)) s += `FD${Number(cfg.force)};`;
    if (isNum(cfg.speed)) s += `VS${Number(cfg.speed)};`;
  } else {
    if (isNum(cfg.speed)) s += `VS${Number(cfg.speed)};`;
    if (isNum(cfg.force)) s += `FS${Number(cfg.force)};`;
  }
  for (const p of prepared) {
    if (p.length < 2) continue;
    const pts = p.map((pt) => [u(pt.x), u(pt.y)]);
    if (style === 'graphtec') {
      s += `PA${pts[0][0]},${pts[0][1]};PR;PD;`;
      for (let i = 1; i < pts.length; i++) s += `PD${pts[i][0] - pts[i - 1][0]},${pts[i][1] - pts[i - 1][1]};`;
      s += 'PU;';
    } else {
      s += `PU${pts[0][0]},${pts[0][1]};PD;`;
      for (let i = 1; i < pts.length; i++) s += `PD${pts[i][0]},${pts[i][1]};`;
      s += 'PU;';
    }
  }
  if (style === 'graphtec') {
    const b = bounds(prepared);
    s += `PA${u(b.maxX + (Number(cfg.advanceMm) || 0))},0;!PG0;IN;`;
  } else s += '!PG;';
  return s;
}

function toHPGL(paths, cfg = {}) {
  const upm = Number(cfg.unitsPerMm) || 40;
  const u = (v) => Math.round(v * upm);
  const prepared = prepare(paths, cfg);
  if (cfg.hpglStyle === 'titan' || cfg.hpglStyle === 'graphtec') return flexiStyleHPGL(prepared, cfg, u);
  let s = cfg.noInit ? '' : 'IN;';
  if (isNum(cfg.speed)) s += `VS${Number(cfg.speed)};`;
  if (isNum(cfg.force)) s += `FS${Number(cfg.force)};`;
  s += 'PA;';
  for (const p of prepared) {
    if (p.length < 2) continue;
    s += `PU${u(p[0].x)},${u(p[0].y)};`;
    s += 'PD' + p.slice(1).map((pt) => `${u(pt.x)},${u(pt.y)}`).join(',') + ';';
  }
  const b = bounds(prepared);
  const adv = Number(cfg.advanceMm) || 0;
  s += adv > 0 ? `PU${u(b.maxX + adv)},0;` : 'PU0,0;';
  return s;
}

function toGPGL(paths, cfg = {}) {
  const ETX = '\x03';
  const step = Number(cfg.gpglStepMm) || 0.1;
  const u = (v) => Math.round(v / step);
  const prepared = prepare(paths, cfg);
  let s = '';
  if (isNum(cfg.speed)) s += `!${Number(cfg.speed)}${ETX}`;
  if (isNum(cfg.force)) s += `FX${Number(cfg.force)}${ETX}`;
  for (const p of prepared) {
    if (p.length < 2) continue;
    s += `M${u(p[0].x)},${u(p[0].y)}${ETX}`;
    s += 'D' + p.slice(1).map((pt) => `${u(pt.x)},${u(pt.y)}`).join(',') + ETX;
  }
  const b = bounds(prepared);
  const adv = Number(cfg.advanceMm) || 0;
  s += adv > 0 ? `M${u(b.maxX + adv)},0${ETX}` : `M0,0${ETX}`;
  return s;
}

// Turns typed escapes into the real control characters: \x03, \r, \n, <ETX>, <ESC>.
function unescapeCommands(t) {
  return String(t || '')
    .replace(/<ETX>/gi, '\x03').replace(/<ESC>/gi, '\x1b')
    .replace(/\\x([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\r/g, '\r').replace(/\\n/g, '\n');
}

// The mark-reading commands for a registered (print & cut) job, from the cutter's settings.
// Placeholders: {DX_MM} {DY_MM} = distance between the marks in mm, {DX} {DY} = same in cutter units,
// {CUT} = where the cut goes (if missing, the cut follows the commands).
function registeredJob(paths, cfg) {
  const gp = cfg.language === 'gpgl';
  const unit = gp ? 1 / (Number(cfg.gpglStepMm) || 0.1) : (Number(cfg.unitsPerMm) || 40);
  const dx = Number(cfg.markDxMm) || 0, dy = Number(cfg.markDyMm) || 0;
  const tpl = unescapeCommands(cfg.regCommands)
    .replace(/\{DX_MM\}/g, dx.toFixed(1)).replace(/\{DY_MM\}/g, dy.toFixed(1))
    .replace(/\{DX\}/g, String(Math.round(dx * unit))).replace(/\{DY\}/g, String(Math.round(dy * unit)));
  const body = gp ? toGPGL(paths, cfg) : toHPGL(paths, { ...cfg, noInit: true });
  return tpl.includes('{CUT}') ? tpl.replace('{CUT}', body) : tpl + body;
}

// How far along the roll (X) a job reaches once placed, in mm — for remembering the roll position.
function jobExtent(paths, cfg = {}) {
  return bounds(prepare(paths, cfg)).maxX;
}

// A pen-up move to an absolute spot (mm from the cutter's origin) — jogging the blade.
function moveTo(x, y, cfg = {}) {
  if (cfg.language === 'gpgl') {
    const step = Number(cfg.gpglStepMm) || 0.1;
    return `M${Math.round(x / step)},${Math.round(y / step)}\x03`;
  }
  const upm = Number(cfg.unitsPerMm) || 40;
  return `IN;PA;PU${Math.round(x * upm)},${Math.round(y * upm)};`;
}

function generate(paths, cfg = {}) {
  if (cfg.keepOrigin && String(cfg.regCommands || '').trim()) return registeredJob(paths, cfg);
  return cfg.language === 'gpgl' ? toGPGL(paths, cfg) : toHPGL(paths, cfg);
}

// 1" x 1" square with a triangle pointing along +X. Measure it after cutting:
// if it isn't exactly 1 inch, the units/step setting is wrong. The triangle shows
// which way the cutter treats +X so rotate/mirror can be set to match Flexi.
function testPattern() {
  const S = MM_PER_IN;
  const square = [
    { x: 0, y: 0 }, { x: S, y: 0 }, { x: S, y: S }, { x: 0, y: S }, { x: 0, y: 0 },
  ];
  const tri = [
    { x: 6, y: 7 }, { x: 19, y: S / 2 }, { x: 6, y: S - 7 }, { x: 6, y: 7 },
  ];
  return [square, tri];
}

module.exports = { transformPaths, bounds, addOvercut, toHPGL, toGPGL, generate, registeredJob, jobExtent, moveTo, testPattern, unescapeCommands, MM_PER_IN };
