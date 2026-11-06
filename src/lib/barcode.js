// QR codes and Code 128 barcodes as filled shapes (mm), ready to print or cut — Flexi's Text > QR Code / Barcode.
import qrcode from 'qrcode-generator';

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];

/** QR code: sizeMm square (without the quiet zone unless quiet = modules of white border, default 0) */
export function qrPaths(text, { sizeMm = 50, level = 'M', quiet = 0 } = {}) {
  if (!String(text || '').length) throw new Error('Type what the QR code should say');
  const q = qrcode(0, level);
  q.addData(unescape(encodeURIComponent(String(text))), 'Byte');
  q.make();
  const n = q.getModuleCount();
  const m = sizeMm / (n + 2 * quiet);
  const paths = [];
  // merge each row's dark runs into one rectangle (fewer shapes, cleaner cut)
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!q.isDark(r, c)) { c++; continue; }
      let e = c;
      while (e < n && q.isDark(r, e)) e++;
      paths.push(rect((c + quiet) * m, (r + quiet) * m, (e - c) * m, m));
      c = e;
    }
  }
  return { paths, modules: n, moduleMm: m };
}

// ---- Code 128 (auto B / C) ----
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

export function code128Codes(text) {
  const s = String(text);
  if (!s.length) throw new Error('Type what the barcode should say');
  for (const ch of s) if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) throw new Error('Code 128 here takes plain letters, numbers and symbols');
  const digitsAt = (i) => { let k = i; while (k < s.length && s[k] >= '0' && s[k] <= '9') k++; return k - i; };
  const codes = [];
  let set = digitsAt(0) >= 4 ? 'C' : 'B';
  codes.push(set === 'C' ? START_C : START_B);
  let i = 0;
  while (i < s.length) {
    const run = digitsAt(i);
    if (set === 'B' && run >= 6) { codes.push(CODE_C); set = 'C'; }
    if (set === 'C') {
      if (run >= 2) { codes.push(Number(s.slice(i, i + 2))); i += 2; continue; }
      codes.push(CODE_B); set = 'B';
    }
    codes.push(s.charCodeAt(i) - 32); i++;
  }
  let sum = codes[0];
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
  codes.push(sum % 103, STOP);
  return codes;
}

/** Code 128 bars: widthMm overall (quiet zones not included), heightMm tall */
export function code128Paths(text, { widthMm = 60, heightMm = 20 } = {}) {
  const codes = code128Codes(text);
  const modules = codes.reduce((s, c) => s + PATTERNS[c].split('').reduce((a, d) => a + Number(d), 0), 0);
  const m = widthMm / modules;
  const paths = [];
  let x = 0;
  for (const c of codes) {
    const pat = PATTERNS[c];
    for (let k = 0; k < pat.length; k++) {
      const w = Number(pat[k]) * m;
      if (k % 2 === 0) paths.push(rect(x, 0, w, heightMm));
      x += w;
    }
  }
  return { paths, moduleMm: m };
}
