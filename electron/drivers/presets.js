// Ready-made machine setups. Add a new printer or cutter model by adding a line here.
const list = [
  { id: 'graphtec-ce6000-60plus', name: 'Graphtec CE6000-60 Plus', maker: 'Graphtec', kind: 'cutter', driver: 'cutter',
    config: { connection: 'printer', language: 'hpgl', unitsPerMm: 40, mediaWidthIn: 24 } },
  { id: 'uscutter-titan3-68', name: 'US Cutter Titan 3 (68")', maker: 'US Cutter', kind: 'cutter', driver: 'cutter',
    config: { connection: 'printer', language: 'hpgl', unitsPerMm: 40, mediaWidthIn: 64 } },
  { id: 'generic-hpgl-cutter', name: 'Other HP-GL cutter', maker: 'Generic', kind: 'cutter', driver: 'cutter',
    config: { language: 'hpgl' } },
  { id: 'generic-gpgl-cutter', name: 'Other Graphtec GP-GL cutter', maker: 'Graphtec', kind: 'cutter', driver: 'cutter',
    config: { language: 'gpgl' } },
  { id: 'hp-latex-335', name: 'HP Latex 335 (via Flexi)', maker: 'HP', kind: 'printer', driver: 'flexi-hotfolder',
    config: { mediaWidthIn: 64 } },
  { id: 'hp-latex-115', name: 'HP Latex 115 (via Flexi)', maker: 'HP', kind: 'printer', driver: 'flexi-hotfolder',
    config: { mediaWidthIn: 64 } },
  { id: 'generic-flexi-printer', name: 'Other printer run by Flexi', maker: 'Generic', kind: 'printer', driver: 'flexi-hotfolder',
    config: {} },
  { id: 'xerox-7845', name: 'Xerox 7845', maker: 'Xerox', kind: 'printer', driver: 'network-printer',
    config: { port: 9100, usePjl: true, testPaper: 'Letter' } },
  { id: 'generic-network-printer', name: 'Other network printer (PDF/PS/PCL)', maker: 'Generic', kind: 'printer', driver: 'network-printer',
    config: {} },
];

// The shop's machines, created on first launch so they only need hooking up.
const shopDefaults = [
  { name: 'Graphtec CE6000-60 Plus', presetId: 'graphtec-ce6000-60plus' },
  { name: 'Titan 3 68"', presetId: 'uscutter-titan3-68' },
  { name: 'HP Latex 335', presetId: 'hp-latex-335' },
  { name: 'HP Latex 115', presetId: 'hp-latex-115' },
  { name: 'Xerox 7845', presetId: 'xerox-7845' },
];

function byId(id) { return list.find((p) => p.id === id); }

module.exports = { list, shopDefaults, byId };
