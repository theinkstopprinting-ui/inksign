// Ready-made starting points for File › New from template. Sizes are the finished size in inches.
// hemIn grows the page for banner hems (with fold guides); grommetIn puts grommets about that far apart;
// safeIn draws guides that far in from the edge (keep text inside them); marks adds print & cut
// registration marks; kind says what the job usually is, shown on the card.
export const TEMPLATES = [
  { id: 'yard-24x18', group: 'Signs', name: 'Yard sign', w: 24, h: 18, safeIn: 0.5, kind: 'Coroplast · HP print' },
  { id: 'yard-18x12', group: 'Signs', name: 'Small yard sign', w: 18, h: 12, safeIn: 0.5, kind: 'Coroplast · HP print' },
  { id: 'rider-6x24', group: 'Signs', name: 'Real estate rider', w: 24, h: 6, safeIn: 0.375, kind: 'Coroplast / aluminum' },
  { id: 'parking-12x18', group: 'Signs', name: 'Parking / aluminum sign', w: 12, h: 18, safeIn: 0.75, kind: 'Aluminum · print or vinyl' },
  { id: 'sheet-4x8', group: 'Signs', name: 'Full sheet 4 × 8 ft', w: 96, h: 48, safeIn: 1, kind: 'Coroplast / PVC / ACM' },
  { id: 'poster-24x36', group: 'Signs', name: 'Poster', w: 24, h: 36, safeIn: 0.5, kind: 'HP print' },
  { id: 'banner-2x4', group: 'Banners', name: 'Banner 2 × 4 ft', w: 48, h: 24, hemIn: 1, grommetIn: 24, safeIn: 1.5, kind: '13 oz banner · hems + grommets' },
  { id: 'banner-3x6', group: 'Banners', name: 'Banner 3 × 6 ft', w: 72, h: 36, hemIn: 1, grommetIn: 24, safeIn: 1.5, kind: '13 oz banner · hems + grommets' },
  { id: 'banner-4x8', group: 'Banners', name: 'Banner 4 × 8 ft', w: 96, h: 48, hemIn: 1, grommetIn: 24, safeIn: 1.5, kind: '13 oz banner · hems + grommets' },
  { id: 'banner-3x10', group: 'Banners', name: 'Banner 3 × 10 ft', w: 120, h: 36, hemIn: 1, grommetIn: 24, safeIn: 1.5, kind: '13 oz banner · hems + grommets' },
  { id: 'canvas-16x20', group: 'Banners', name: 'Canvas 16 × 20 (1.5″ wrap)', w: 16, h: 20, hemIn: 1.5, safeIn: 0.25, kind: 'Canvas · gallery wrap' },
  { id: 'door-24x12', group: 'Vinyl', name: 'Vehicle door lettering', w: 24, h: 12, safeIn: 0, kind: 'Cut vinyl' },
  { id: 'window-36x12', group: 'Vinyl', name: 'Storefront window lettering', w: 36, h: 12, safeIn: 0, kind: 'Cut vinyl' },
  { id: 'decal-12x12', group: 'Vinyl', name: 'Decal / logo 12 × 12', w: 12, h: 12, safeIn: 0, kind: 'Cut vinyl' },
  { id: 'hours-12x8', group: 'Vinyl', name: 'Store hours', w: 12, h: 8, safeIn: 0, kind: 'Cut vinyl (white)' },
  { id: 'stickers-12x18', group: 'Print & cut', name: 'Sticker sheet 12 × 18', w: 12, h: 18, marks: true, kind: 'Xerox print · contour cut' },
  { id: 'stickers-letter', group: 'Print & cut', name: 'Sticker sheet letter', w: 8.5, h: 11, marks: true, kind: 'Xerox print · contour cut' },
  { id: 'stickers-roll', group: 'Print & cut', name: 'Roll stickers 24 × 24', w: 24, h: 24, marks: true, kind: 'HP print · Titan contour cut' },
  { id: 'wrap-panel', group: 'Print & cut', name: 'Printed decal 48 × 24', w: 48, h: 24, marks: true, kind: 'HP print · contour cut' },
];

/** The settings a template turns into: page size, guides, banner finishing and marks (all in mm) */
export function templateSetup(t) {
  const MM = 25.4;
  const w = t.w * MM, h = t.h * MM, s = (t.safeIn || 0) * MM;
  return {
    page: { w, h },
    guides: s > 0 ? { x: [s, w - s], y: [s, h - s] } : { x: [], y: [] },
    hemMm: (t.hemIn || 0) * MM,
    grommetMm: (t.grommetIn || 0) * MM,
    marks: t.marks ? { margin: 10.16, size: 10.16, thickness: 0.5 } : null,
  };
}
