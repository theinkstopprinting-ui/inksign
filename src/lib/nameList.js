// Name lists / variable data for Text › Name list: a pasted list (one name per line) or a CSV / spreadsheet
// paste (first row = column names). Text objects with {Column} in them get each row's value; a single
// text object without any {…} is simply replaced by the first column.

function splitRow(line, sep) {
  if (sep === '\t') return line.split('\t').map((c) => c.trim());
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** → { headers: string[], rows: string[][] } */
export function parseList(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.every((l) => l.includes(',')) ? ',' : null;
  if (!sep) return { headers: ['Name'], rows: lines.map((l) => [l.trim()]) };
  const all = lines.map((l) => splitRow(l, sep));
  return { headers: all[0].map((h, i) => h || `Column ${i + 1}`), rows: all.slice(1) };
}

/** The fields a text uses: {Name}, {Number} … */
export function fieldsIn(text) {
  return [...new Set((String(text || '').match(/\{([^{}]+)\}/g) || []).map((m) => m.slice(1, -1).trim()))];
}

/** The text for one row */
export function fillText(text, row, headers) {
  const f = fieldsIn(text);
  if (!f.length) return row[0] ?? '';
  return String(text).replace(/\{([^{}]+)\}/g, (m, k) => {
    const i = headers.findIndex((h) => h.toLowerCase() === k.trim().toLowerCase());
    return i >= 0 ? (row[i] ?? '') : m;
  });
}
