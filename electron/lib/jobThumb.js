// Pictures of queued jobs for the Job queue page: the first page of a PDF (Ghostscript), a picture file
// shrunk down, or the cut lines of a cutter job drawn as SVG. Saved as small files next to the job list,
// so jobs.json stays small. Also works out the job's size for the job card.
const fs = require('fs');
const path = require('path');

const MAX_PX = 360; // longest side of a picture

function svgOfPaths(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p || []) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  if (!Number.isFinite(minX)) return null;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const pad = Math.max(w, h) * 0.04;
  const d = paths.filter((p) => p && p.length > 1).map((p) => `M${p.map((q) => `${(q.x - minX).toFixed(2)},${(q.y - minY).toFixed(2)}`).join('L')}`).join('');
  const sw = Math.max(w, h) / 220;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}"><rect x="${-pad}" y="${-pad}" width="${w + 2 * pad}" height="${h + 2 * pad}" fill="#ffffff"/><path d="${d}" fill="none" stroke="#e5482b" stroke-width="${sw.toFixed(3)}" stroke-linejoin="round"/></svg>`;
  return { svg, wIn: w / 25.4, hIn: h / 25.4 };
}

async function pdfThumb(bytes, gs) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPageCount();
  const p = doc.getPage(0);
  const { width, height } = p.getSize();
  const rot = ((p.getRotation().angle % 360) + 360) % 360;
  const wPt = rot % 180 ? height : width, hPt = rot % 180 ? width : height;
  const info = { wIn: wPt / 72, hIn: hPt / 72, pages };
  if (!gs) return { info };
  const res = Math.max(1, Math.min(150, (MAX_PX / Math.max(wPt, hPt)) * 72));
  const r = await gs.run(['-sDEVICE=png16m', `-r${res.toFixed(3)}`, '-dFirstPage=1', '-dLastPage=1', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-o', '/out/t.png', '/in/t.pdf'],
    { files: { '/in/t.pdf': bytes }, outputs: ['/out/t.png'], timeoutMs: 3 * 60 * 1000 });
  return { png: r.out['/out/t.png'] || null, info };
}

/**
 * Make the picture for one job. opts: { dir, gs, resizeImage(buf) -> png Buffer | null }
 * Returns { thumb: fileName | null, info: { wIn, hIn, pages } } or null
 */
async function makeJobThumb(job, { dir, gs, resizeImage } = {}) {
  if (!dir || job.action === 'test' || !job.filePath || !fs.existsSync(job.filePath)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(job.filePath).toLowerCase();
  const save = (buf, suffix) => { const name = `${job.id}${suffix}`; fs.writeFileSync(path.join(dir, name), buf); return name; };
  if (job.action === 'paths') {
    const data = JSON.parse(fs.readFileSync(job.filePath, 'utf8'));
    const r = svgOfPaths(Array.isArray(data) ? data : data.paths || []);
    if (!r) return null;
    return { thumb: save(Buffer.from(r.svg), '.svg'), info: { wIn: r.wIn, hIn: r.hIn } };
  }
  const bytes = fs.readFileSync(job.filePath);
  if (ext === '.pdf') {
    const r = await pdfThumb(bytes, gs);
    return { thumb: r.png ? save(r.png, '.png') : null, info: r.info };
  }
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const pf = require('./preflight');
    const meta = ext === '.png' ? pf.pngInfo(bytes) : pf.jpegInfo(bytes);
    const ppi = (meta && meta.dpi) || 150;
    const info = meta ? { wIn: meta.w / ppi, hIn: meta.h / ppi } : {};
    let png = null;
    try { png = resizeImage ? resizeImage(bytes, MAX_PX) : null; } catch { png = null; }
    return { thumb: png ? save(png, '.png') : null, info };
  }
  return null;
}

/** A saved picture as a data: URL for the window */
function thumbDataUrl(dir, name) {
  const safe = path.basename(String(name || ''));
  if (!safe) return null;
  const file = path.join(dir, safe);
  if (!fs.existsSync(file)) return null;
  const type = safe.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

function removeThumb(dir, name) {
  const safe = path.basename(String(name || ''));
  if (safe) fs.rmSync(path.join(dir, safe), { force: true });
}

module.exports = { makeJobThumb, thumbDataUrl, removeThumb, svgOfPaths };
