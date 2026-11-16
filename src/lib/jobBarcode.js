// The job barcode printed beside a print & cut job's registration marks: a Code 128 of the job number, in the
// bottom strip between the two bottom marks (15 mm clear of the corner mark, the spacing VinylMaster uses),
// with the number in plain digits after it. Scan or type that number at the cutter to bring up the cut.
import { code128Paths } from './barcode.js';

const BAR_W = 45, BAR_H = 7, CLEAR = 15, TEXT_MM = 4;

/** page { w, h } and marks { margin, size } in mm -> { bars: [[x, y, w, h]], text, textX, textY, textMm } | null */
export function jobBarcode(page, marks, jobNo, label = 'InkSign job') {
  const no = String(jobNo || '').replace(/\D/g, '');
  if (!no || !marks || !(marks.size > 0)) return null;
  const x0 = marks.margin + marks.size + CLEAR;
  const room = page.w - 2 * (marks.margin + marks.size + CLEAR);
  if (room < 25) return null; // too small a sheet for a readable barcode
  const w = Math.min(BAR_W, room);
  const h = Math.min(BAR_H, Math.max(4, marks.size * 0.6));
  const y1 = page.h - marks.margin;            // bottom edge of the bottom marks
  const { paths } = code128Paths(no, { widthMm: w, heightMm: h });
  const bars = paths.map((p) => {
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    return [x0 + Math.min(...xs), y1 - h + Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  });
  const text = `${label} ${no}`;
  const fits = room - w - 4 > text.length * TEXT_MM * 0.55;
  return { bars, text: fits ? text : no, textX: x0 + w + 4, textY: y1 - (h - TEXT_MM) / 2, textMm: TEXT_MM, no, show: room - w - 4 > no.length * TEXT_MM * 0.55 };
}
