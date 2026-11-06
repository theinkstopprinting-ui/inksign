import React from 'react';

// Simple line icons (24×24, drawn for InkSign)
const P = {
  home: 'M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-6h3v6h5V9.5',
  vinyl: 'M6 3v18M6 5h11a3 3 0 0 1 0 6H6M9 11l8 10',
  sticker: 'M5 4h10l5 5v11H5zM15 4v5h5',
  banner: 'M3 5h18v11H3zM3 16l2 4M21 16l-2 4M7 9h10M7 12h6',
  press: 'M7 8V3h10v5M5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2zM7 14h10',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h5M12 17h5',
  queue: 'M4 6h16M4 12h16M4 18h10',
  history: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4',
  orders: 'M8 4h8v3H8zM6 5H4v16h16V5h-2M8 12h8M8 16h5',
  stock: 'M6 6a3 3 0 1 0 0 12h12V6zM6 9a3 3 0 1 1 0 6M18 6v12',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  mockup: 'M8 3 4 6v4h3v11h10V10h3V6l-4-3a4 4 0 0 1-8 0z',
  devices: 'M9 3v4M15 3v4M7 7h10v5a5 5 0 0 1-10 0zM12 17v4',
  color: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5 10 17l9-10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  cutter: 'M3 15h18v4H3zM7 15V9h10v6M12 9V5',
  print: 'M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  zoomIn: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20M8 10.5h5M10.5 8v5',
  zoomOut: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20M8 10.5h5',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  pointer: 'M5 3l13 8-6 1.5L9.5 19z',
  nest: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  tile: 'M3 3h18v18H3zM12 3v18M3 12h18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  align: 'M4 4v16M8 7h12v4H8zM8 14h7v4H8z',
  money: 'M12 3v18M16.5 7.5C16 6 14.3 5 12 5c-2.8 0-4.5 1.4-4.5 3.3C7.5 13 16.5 10.5 16.5 15.7c0 1.9-1.8 3.3-4.5 3.3-2.4 0-4.2-1.1-4.7-2.8',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  dot: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  ruler: 'M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  grid: 'M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
};

export default function Icon({ name, size = 18, stroke = 1.8, className = '', title }) {
  const d = P[name] || P.dot;
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
