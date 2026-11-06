// Ready-made machine setups. Add a new printer or cutter model by adding a line here.
const list = [
  { id: 'graphtec-ce6000-60plus', name: 'Graphtec CE6000-60 Plus', maker: 'Graphtec', kind: 'cutter', driver: 'cutter',
    config: { connection: 'printer', language: 'hpgl', hpglStyle: 'graphtec', unitsPerMm: 40, mediaWidthIn: 24 } },
  { id: 'uscutter-titan3-68', name: 'US Cutter Titan 3 (68")', maker: 'US Cutter', kind: 'cutter', driver: 'cutter',
    // Flexi reads the Titan's marks with MK0,0,<mark distance X>,<Y>; and turns the cut 90° to the print
    config: { connection: 'printer', language: 'hpgl', hpglStyle: 'titan', unitsPerMm: 40, mediaWidthIn: 64, regCommands: 'MK0,0,{DX},{DY};', regRotate: '90' } },
  // Mutoh Kona 1400: HP-GL over USB (shows as a Windows printer with Mutoh's driver) or serial; 1400 mm max media
  { id: 'mutoh-kona-1400', name: 'Mutoh Kona 1400', maker: 'Mutoh', kind: 'cutter', driver: 'cutter',
    config: { connection: 'printer', language: 'hpgl', unitsPerMm: 40, mediaWidthIn: 53 } },
  { id: 'generic-hpgl-cutter', name: 'Other HP-GL cutter', maker: 'Generic', kind: 'cutter', driver: 'cutter',
    config: { language: 'hpgl' } },
  { id: 'generic-gpgl-cutter', name: 'Other Graphtec GP-GL cutter', maker: 'Graphtec', kind: 'cutter', driver: 'cutter',
    config: { language: 'gpgl' } },
  // HP Latex printed directly by InkSign (the job format Flexi sends, captured from the shop's printers)
  { id: 'hp-latex-335', name: 'HP Latex 335', maker: 'HP', kind: 'printer', driver: 'hp-latex',
    config: { model: 'hp-latex-335', rollWidthIn: 64 } },
  { id: 'hp-latex-115', name: 'HP Latex 115', maker: 'HP', kind: 'printer', driver: 'hp-latex',
    config: { model: 'hp-latex-115', rollWidthIn: 54 } },
  { id: 'hp-latex-335-flexi', name: 'HP Latex 335 (through Flexi)', maker: 'HP', kind: 'printer', driver: 'flexi-hotfolder',
    config: { mediaWidthIn: 64 } },
  { id: 'hp-latex-115-flexi', name: 'HP Latex 115 (through Flexi)', maker: 'HP', kind: 'printer', driver: 'flexi-hotfolder',
    config: { mediaWidthIn: 54 } },
  { id: 'generic-flexi-printer', name: 'Other printer run by Flexi', maker: 'Generic', kind: 'printer', driver: 'flexi-hotfolder',
    config: {} },
  { id: 'xerox-7845', name: 'Xerox 7845', maker: 'Xerox', kind: 'printer', driver: 'network-printer',
    config: { port: 9100, usePjl: true, testPaper: 'Letter', model: 'xerox-7845' } },
  { id: 'generic-network-printer', name: 'Other network printer (PDF/PS/PCL)', maker: 'Generic', kind: 'printer', driver: 'network-printer',
    config: {} },
];

// The shop's machines, created on first launch so they only need hooking up.
const shopDefaults = [
  { name: 'Graphtec CE6000-60 Plus', presetId: 'graphtec-ce6000-60plus' },
  { name: 'Titan 3 68"', presetId: 'uscutter-titan3-68' },
  { name: 'Mutoh Kona 1400', presetId: 'mutoh-kona-1400' },
  { name: 'HP Latex 335', presetId: 'hp-latex-335', config: { host: '10.1.1.23' } },
  { name: 'HP Latex 115', presetId: 'hp-latex-115', config: { host: '10.1.1.21' } },
  { name: 'Xerox 7845', presetId: 'xerox-7845' },
];

function byId(id) { return list.find((p) => p.id === id); }

module.exports = { list, shopDefaults, byId };
