// Line icons for the Design workspace toolbars (24 × 24 grid, drawn with strokes so they stay
// crisp at any size and follow the text color).
import React from 'react';

const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const CORNERS = 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5';

export const ICONS = {
  new: 'M6 3h8l4 4v14H6z M14 3v4h4',
  open: 'M3 7h6l2 2h10v10H3z',
  save: 'M4 4h13l3 3v13H4z M8 4v5h7V4 M8 20v-6h8v6',
  import: 'M12 3v11 M8 10l4 4 4-4 M4 17v3h16v-3',
  export: 'M12 14V3 M8 7l4-4 4 4 M4 17v3h16v-3',
  print: 'M7 8V3h10v5 M7 16H5V8h14v8h-2 M7 13h10v8H7z',
  scissors: `${C(6, 6.5, 2.5)} ${C(6, 17.5, 2.5)} M8 8.3L20 18 M8 15.7L20 6`,
  printcut: `${CORNERS} ${C(12, 12, 3.5)}`,
  undo: 'M8 5L4 9l4 4 M4 9h10a5 5 0 0 1 0 10h-4',
  redo: 'M16 5l4 4-4 4 M20 9H10a5 5 0 0 0 0 10h4',
  copy: 'M9 9h11v11H9z M5 15V4h11',
  paste: 'M8 5H5v16h14V5h-3 M9 3h6v4H9z',
  dup: 'M4 4h10v10H4z M10 10h10v10H10z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v6 M14 11v6',
  group: 'M3 3h4v4H3z M17 3h4v4h-4z M3 17h4v4H3z M17 17h4v4h-4z M7 5h10 M7 19h10 M5 7v10 M19 7v10',
  ungroup: 'M3 3h8v8H3z M13 13h8v8h-8z',
  front: 'M12 20V7 M7 12l5-5 5 5 M5 3h14',
  back: 'M12 4v13 M7 12l5 5 5-5 M5 21h14',
  weld: `${C(9, 12, 5.5)} ${C(15, 12, 5.5)}`,
  contour: `M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z ${C(12, 12, 4)}`,
  zoomIn: `${C(10.5, 10.5, 6.5)} M15.5 15.5L21 21 M10.5 8v5 M8 10.5h5`,
  zoomOut: `${C(10.5, 10.5, 6.5)} M15.5 15.5L21 21 M8 10.5h5`,
  fit: `${CORNERS} M8 8h8v8H8z`,
  fitSel: `${CORNERS} ${C(12, 12, 3)}`,
  wire: 'M4 4h16v16H4z M4 4l16 16 M20 4L4 20',
  snap: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z M6 8h4 M14 8h4',
  grid: 'M4 4h16v16H4z M4 9.3h16 M4 14.7h16 M9.3 4v16 M14.7 4v16',
  page: 'M6 3h12v18H6z',
  swap: 'M4 8h13 M13 4l4 4-4 4 M20 16H7 M11 12l-4 4 4 4',
  rotL: 'M5 4v6h6 M5 10a8 8 0 1 1 2 7',
  rotR: 'M19 4v6h-6 M19 10a8 8 0 1 0-2 7',
  flipH: 'M12 3v18 M9 7l-6 5 6 5z M15 7l6 5-6 5z',
  flipV: 'M3 12h18 M7 9l5-6 5 6z M7 15l5 6 5-6z',
  alignL: 'M4 3v18 M7 6h10v4H7z M7 14h6v4H7z',
  alignC: 'M12 3v18 M6 6h12v4H6z M8 14h8v4H8z',
  alignR: 'M20 3v18 M7 6h10v4H7z M11 14h6v4h-6z',
  alignT: 'M3 4h18 M6 7h4v10H6z M14 7h4v6h-4z',
  alignM: 'M3 12h18 M6 6h4v12H6z M14 8h4v8h-4z',
  alignB: 'M3 20h18 M6 7h4v10H6z M14 11h4v6h-4z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  select: 'M5 3l13 9-6 1.5 3.5 6.5-2.5 1.3L9.5 15 5 19z',
  node: 'M4 18C8 6 16 6 20 18 M2.5 16.5h3v3h-3z M18.5 16.5h3v3h-3z M10.5 7.5h3v3h-3z',
  text: 'M5 7V4h14v3 M12 4v16 M9 20h6',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M3 12a9 6.5 0 1 0 18 0a9 6.5 0 1 0-18 0',
  star: 'M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.3L12 17.1l-5.6 3.1 1.2-6.3L3 9.6l6.3-.8z',
  line: 'M5 19L19 5',
  pen: 'M4 20l1.5-5.5L16 4l4 4L9.5 18.5z M13.5 6.5l4 4',
  eyedropper: 'M13 6l5 5 M15.5 8.5l2.6-2.6a2 2 0 0 1 2.8 2.8l-2.6 2.6 M14 10l-8 8-2 .9 .9-2 8-8',
  zoom: `${C(10.5, 10.5, 6.5)} M15.5 15.5L21 21`,
  pan: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  image: `M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 ${C(8, 9, 1.4)}`,
  layers: 'M12 3l9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  cutter: 'M3 9h18v5H3z M6 14v4 M18 14v4 M10 9V6h4v3 M12 14v4',
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg className="dz-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] || ICONS.rect} />
    </svg>
  );
}
