// Text -> cut paths using installed fonts (opentype.js).
import opentype from 'opentype.js';
import { flattenCommands, normalize, bounds, scale } from './geometry.js';

const cache = new Map();

// Letter-by-letter glyph lookup. (opentype's stringToGlyphs crashes on some fonts'
// advanced substitution tables, and sign lettering doesn't want ligatures anyway.)
function glyphsFor(font, str) {
  return Array.from(str).map((ch) => font.glyphs.get(font.charToGlyphIndex(ch)));
}

// Real height of a capital H in font units (more reliable than the font's stated cap height).
function capHeightOf(font) {
  try {
    const bb = font.glyphs.get(font.charToGlyphIndex('H')).getBoundingBox();
    if (bb && bb.y2 - bb.y1 > 0) return bb.y2 - Math.max(0, bb.y1);
  } catch { /* fall through */ }
  return (font.tables.os2 && font.tables.os2.sCapHeight) || font.unitsPerEm * 0.7;
}

export async function loadFont(file) {
  if (cache.has(file)) return cache.get(file);
  const buf = await window.inksign.fonts.read(file);
  const font = opentype.parse(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  cache.set(file, font);
  return font;
}

// Returns paths whose cap height (height of "H") equals heightMm. Multi-line text supported.
export function textToPaths(font, text, { heightMm = 50.8, letterSpacing = 0, lineSpacing = 1.2, align = 'left' } = {}) {
  const unitsPerEm = font.unitsPerEm;
  const capH = capHeightOf(font);
  const fontSize = 1000; // work large, scale after
  const lines = String(text).split(/\r?\n/);
  const linePaths = lines.map((line, i) => {
    const cmds = [];
    let x = 0;
    const glyphs = glyphsFor(font, line);
    glyphs.forEach((g, gi) => {
      const p = g.getPath(x, i * fontSize * lineSpacing, fontSize);
      cmds.push(...p.commands);
      let adv = (g.advanceWidth || 0) * (fontSize / unitsPerEm);
      if (gi + 1 < glyphs.length && font.getKerningValue) adv += font.getKerningValue(g, glyphs[gi + 1]) * (fontSize / unitsPerEm);
      x += adv + letterSpacing * fontSize;
    });
    return { paths: flattenCommands(cmds, 1), width: x };
  });
  const maxW = Math.max(...linePaths.map((l) => l.width));
  const all = [];
  linePaths.forEach((l) => {
    const dx = align === 'center' ? (maxW - l.width) / 2 : align === 'right' ? maxW - l.width : 0;
    all.push(...l.paths.map((p) => p.map(({ x, y }) => ({ x: x + dx, y }))));
  });
  if (!all.length) return [];
  const capPx = capH * (fontSize / unitsPerEm);
  return normalize(scale(all, heightMm / capPx));
}

// Text along a circle. position 'top' reads over the top of the arc, 'bottom' under it.
export function textOnArc(font, text, { heightMm = 50.8, radiusMm = 150, position = 'top', letterSpacing = 0 } = {}) {
  const unitsPerEm = font.unitsPerEm;
  const capH = capHeightOf(font);
  const fontSize = 1000;
  const capPx = capH * (fontSize / unitsPerEm);
  const k = heightMm / capPx;              // px -> mm
  const R = radiusMm / k;                  // radius in px units
  const glyphs = glyphsFor(font, String(text).replace(/\r?\n/g, ' '));
  const advs = glyphs.map((g, i) => {
    let a = (g.advanceWidth || 0) * (fontSize / unitsPerEm) + letterSpacing * fontSize;
    if (i + 1 < glyphs.length && font.getKerningValue) a += font.getKerningValue(g, glyphs[i + 1]) * (fontSize / unitsPerEm);
    return a;
  });
  const total = advs.reduce((a, b) => a + b, 0);
  const all = [];
  let s = 0;
  glyphs.forEach((g, i) => {
    const w = advs[i];
    const mid = s + w / 2;
    s += w;
    const cmds = g.getPath(-w / 2, 0, fontSize).commands;
    const paths = flattenCommands(cmds, 1);
    const top = position !== 'bottom';
    const theta = top ? (mid - total / 2) / R : -(mid - total / 2) / R;
    const c = Math.cos(theta), sn = Math.sin(theta);
    for (const p of paths) {
      all.push(p.map(({ x, y }) => {
        // top: baseline sits on the circle, letters point outward.
        // bottom: cap line sits on the circle, letters read upright underneath.
        const lx = x, ly = top ? y - R : y + R + capPx;
        return { x: lx * c - ly * sn, y: lx * sn + ly * c };
      }));
    }
  });
  if (!all.length) return [];
  return normalize(scale(all, k));
}

export { bounds };
