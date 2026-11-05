// InkSign Print Server: Xerox 7845 PPD, job tickets, mixed media, queues, virtual printer, network API
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ppdLib = require('../electron/lib/ppd');
const ticket = require('../electron/server/ticket');
const gs = require('../electron/lib/ghostscript');

const ppd = ppdLib.loadPpd('xerox-7845');
test.after(() => gs.shutdown());

async function doc(n, w = 612, h = 792) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) d.addPage([w, h]).drawText(`Page ${i}`, { x: 100, y: 100, size: 30, font: f });
  return Buffer.from(await d.save());
}
const CAT = [
  { id: 'tab', name: '11x17 text', size: 'Tabloid', type: 'Plain', color: 'White', tray: 'auto' },
  { id: 'let', name: 'Letter bond', size: 'Letter', type: 'Plain', color: 'White', tray: 'Tray1' },
  { id: 'blue', name: 'Blue', size: 'Letter', type: 'Plain', color: 'Blue', tray: 'Tray2' },
  { id: 'card', name: '12x18 card', size: '12x18', type: 'HeavyweightCardstock', color: 'White', tray: 'Tray5' },
];

test('PPD: the exact Xerox 7845 commands', () => {
  assert.strictEqual(ppd.nickName, 'Xerox WorkCentre 7845');
  assert.strictEqual(ppd.fileVersion, '5.482.0.0');
  const code = (o, c) => ppd.options[o].choices.find((x) => x.key === c).code.trim();
  assert.strictEqual(code('InputSlot', 'Tray5'), '<< (bypass-tray) xerox$MediaInputTray >> setpagedevice');
  assert.strictEqual(code('MediaType', 'HeavyweightGlossyCardstock'), '1 dict dup /MediaType (cardstock-heavyweight-glossy) put setpagedevice');
  assert.match(code('XRFold', 'BiFoldStaple'), /\/Booklet true \/BookletDetails << \/Type 2 \/Staples 2 >>/);
  assert.match(code('StapleLocation', 'DualLandscape'), /\/StapleLocation \(DualLandscape\)/);
  assert.match(code('XRPunch', '3HolePunch'), /\/NumHoles 3/);
  assert.strictEqual(ppd.options.InputSlot.choices.length, 6);
  assert.ok(ppd.options.MediaType.choices.length >= 30);
  assert.ok(ppd.constraints.length > 1000);
  assert.strictEqual(ppd.jcl.begin, '\x1b%-12345X@PJL JOB\n@PJL\n@PJL COMMENT XRXbegin\n');
  assert.deepStrictEqual([ppd.custom.minW, ppd.custom.maxW], [249.4, 936]);
});

test('PPD: feature code follows the driver order', () => {
  const c = ppdLib.featureCode(ppd, { Duplex: 'DuplexNoTumble', PageSize: 'Letter', StapleLocation: 'SinglePortrait', InputSlot: 'Tray2' });
  const order = [...c.matchAll(/BeginFeature: \*(\w+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(order, ['PageSize', 'InputSlot', 'StapleLocation', 'SetPageDevice', 'Duplex']);
});

test('PPD: Xerox rules are enforced', () => {
  const msgs = (picks) => ppdLib.conflicts(ppd, picks).map((x) => x.message);
  assert.ok(msgs({ MediaType: 'HeavyweightCardstock', Duplex: 'DuplexNoTumble' }).length);
  assert.ok(msgs({ PageSize: '12x18', InputSlot: 'Tray1' }).length);
  assert.ok(msgs({ XRFold: 'BiFoldStaple', StapleLocation: 'SinglePortrait' }).length);
  assert.strictEqual(msgs({ PageSize: 'Tabloid', MediaType: 'Plain', XRFold: 'BiFoldStaple' }).length, 0);
});

test('ticket: booklet on 11x17 with fold + staple', async () => {
  const props = { copies: 3, media: { catalogId: 'tab' }, sides: 'two', layout: { mode: 'booklet', cropMarks: false }, finishing: { fold: 'BiFoldStaple' } };
  assert.deepStrictEqual(ticket.check(ppd, props, CAT, {}), []);
  const prep = await ticket.preparePdf(await doc(10), props, { ppd, catalog: CAT });
  assert.strictEqual(prep.sides, 6); // 10 pages -> 12 -> 3 sheets, 2 sides each
  assert.strictEqual(prep.sheets, 3);
  const out = await PDFDocument.load(prep.pdf);
  for (const p of out.getPages()) assert.deepStrictEqual([Math.round(p.getWidth()), Math.round(p.getHeight())], [792, 1224]);
  const s = (await ticket.buildStream(prep, { ppd, gs, trays: { Tray3: 'tab' }, jobName: 'Booklet', user: 'Jo' })).toString('latin1');
  assert.ok(s.startsWith(ppd.jcl.begin));
  assert.ok(s.includes('@PJL COMMENT OID_ATT_JOB_NAME "Booklet";'));
  assert.ok(s.includes('@PJL COMMENT OID_ATT_START_SHEET OID_VAL_JOB_SHEET_NONE'));
  assert.ok(s.includes('%%BeginFeature: *InputSlot Tray3'), 'tray from tray loading');
  assert.ok(s.includes('%%BeginFeature: *XRFold BiFoldStaple'));
  assert.ok(s.includes('%%BeginFeature: *Duplex DuplexTumble'));
  assert.ok(s.includes('%%BeginNonPPDFeature: NumCopies 3'));
  assert.strictEqual((s.match(/^%%Page:/gm) || []).length, 6);
  assert.ok(s.endsWith(ppd.jcl.end));
  // setup comes before the first page
  assert.ok(s.indexOf('%%EndSetup') < s.indexOf('%%Page: 1'));
});

test('ticket: booklet rules', () => {
  assert.ok(ticket.check(ppd, { media: { catalogId: 'tab' }, sides: 'one', layout: { mode: 'booklet' } }, CAT).some((m) => /2-sided/.test(m)));
  assert.ok(ticket.check(ppd, { media: { catalogId: 'tab' }, finishing: { fold: 'BiFold' } }, CAT).some((m) => /Booklet/.test(m)));
  assert.ok(ticket.check(ppd, { media: { catalogId: 'card' }, sides: 'two' }, CAT).length > 0);
  assert.ok(ticket.check(ppd, { media: { catalogId: 'gone' } }, CAT).length > 0);
});

test('ticket: mixed media — page range, insert, chapter, covers', async () => {
  const props = {
    media: { catalogId: 'let' }, sides: 'two',
    mixed: { ranges: [{ pages: '3', catalogId: 'blue' }], inserts: [{ after: 4, catalogId: 'blue', count: 1 }], chapters: '6', frontCover: { catalogId: 'tab', content: 'blank' } },
  };
  // a tabloid cover on a letter job is fine for the printer; check catches nothing here
  const prep = await ticket.preparePdf(await doc(8), props, { ppd, catalog: CAT });
  const seq = prep.pages.map((p) => p.paper.id + (p.blank ? '_' : ''));
  // blank cover sheet (2 sides), p1 p2 | p3 on blue + blank back | p4 + pad | insert (2 blank sides) | p5 + pad (chapter at 6) | p6 p7 | p8 + pad
  assert.deepStrictEqual(seq, ['tab_', 'tab_', 'let', 'let', 'blue', 'blue_', 'let', 'let_', 'blue_', 'blue_', 'let', 'let_', 'let', 'let', 'let', 'let_']);
  assert.strictEqual(prep.sheets, 8);
  const s = (await ticket.buildStream(prep, { ppd, gs, trays: {}, jobName: 'Mixed' })).toString('latin1');
  // job paper: tray 1; the paper changes are in the page setups
  const setup = s.slice(s.indexOf('%%BeginSetup'), s.indexOf('%%EndSetup'));
  assert.ok(setup.includes('*InputSlot Tray1'));
  const pages = s.split(/^%%Page:/m).slice(1);
  assert.strictEqual(pages.length, 16);
  assert.ok(pages[0].includes('*PageSize Tabloid'), 'cover sheet on 11x17');
  assert.ok(pages[2].includes('*PageSize Letter') && pages[2].includes('*InputSlot Tray1'), 'back to the job paper');
  assert.ok(pages[4].includes('*MediaColor Blue') && pages[4].includes('*InputSlot Tray2'), 'page 3 on blue');
  assert.ok(!pages[5].includes('BeginFeature'), 'no change for the blank back on the same paper');
  assert.ok(pages[6].includes('*InputSlot Tray1'));
});

test('ticket: fit, center and auto-rotate onto the paper', async () => {
  const land = await doc(1, 792, 612); // landscape letter
  const prep = await ticket.preparePdf(land, { media: { size: 'Letter', type: 'Plain' }, scale: 'fit' }, { ppd, catalog: [] });
  const p = (await PDFDocument.load(prep.pdf)).getPage(0);
  assert.deepStrictEqual([Math.round(p.getWidth()), Math.round(p.getHeight())], [612, 792]);
  const custom = await ticket.preparePdf(await doc(1), { media: { size: 'Custom', customW: 9, customH: 12 } }, { ppd, catalog: [] });
  const s = (await ticket.buildStream(custom, { ppd, gs, trays: {}, jobName: 'C' })).toString('latin1');
  assert.ok(s.includes('%%BeginFeature: *CustomPageSize True\n648.00 864.00 0 0 0'));
  assert.ok(ticket.check(ppd, { media: { size: 'Custom', customW: 20, customH: 30 } }, []).some((m) => /Custom size/.test(m)));
});

test('ticket: step & repeat business cards on 12x18', async () => {
  const card = await doc(2, 3.75 * 72, 2.25 * 72); // 3.5x2 + 0.125 bleed
  const prep = await ticket.preparePdf(card, { copies: 10, media: { catalogId: 'card' }, sides: 'one', layout: { mode: 'repeat', bleedIn: 0.125 } }, { ppd, catalog: CAT });
  assert.ok(prep.info.perSheet >= 20, `${prep.info.perSheet} per sheet`);
  assert.strictEqual(prep.sides, 1);
});

test('reads settings from a Windows Xerox driver job', () => {
  const raw = Buffer.from('\x1b%-12345X@PJL JOB\n@PJL COMMENT OID_ATT_JOB_NAME "Menu.docx";\n@PJL COMMENT OID_ATT_JOB_OWNER "Amy";\n@PJL ENTER LANGUAGE = POSTSCRIPT\n%!PS-Adobe-3.0\n%%BeginNonPPDFeature: NumCopies 12\n%%BeginFeature: *PageSize Tabloid\n%%BeginFeature: *MediaType ThinCardStock\n%%BeginFeature: *InputSlot Tray4\n%%BeginFeature: *Duplex DuplexTumble\n%%BeginFeature: *StapleLocation DualLandscape\n%%EOF\n\x1b%-12345X@PJL EOJ\n\x1b%-12345X\n', 'latin1');
  const r = ticket.readCapturedJob(raw);
  assert.strictEqual(r.name, 'Menu.docx');
  assert.strictEqual(r.user, 'Amy');
  assert.strictEqual(r.props.copies, 12);
  assert.deepStrictEqual(r.props.media, { size: 'Tabloid', type: 'ThinCardStock', tray: 'Tray4' });
  assert.strictEqual(r.props.sides, 'two');
  assert.strictEqual(r.props.binding, 'short');
  assert.strictEqual(r.props.finishing.staple, 'DualLandscape');
  const body = ticket.stripPjl(raw).toString('latin1');
  assert.ok(body.startsWith('%!PS-Adobe-3.0') && body.endsWith('%%EOF\n'));
});

// ---- the server itself, with a fake Xerox ----
function fakeStore(dir, xeroxPort) {
  let settings = { paperCatalog: CAT, printServer: { holdPort: 0, printPort: 0 } };
  const devices = [{ id: 'x', name: 'Xerox 7845', driver: 'network-printer', presetId: 'xerox-7845', config: { host: '127.0.0.1', port: xeroxPort, model: 'xerox-7845' } }];
  return { getSettings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; }, getDevices: () => devices, getDevice: (id) => devices.find((d) => d.id === id) };
}
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };

test('server: hold → process → print → reprint, virtual printer, network API', async () => {
  const received = [];
  const fake = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => received.push(Buffer.concat(c))); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-srv-'));
  const store = fakeStore(dir, fake.address().port);
  const srv = require('../electron/server/printServer');
  const done = [];
  // pick free ports for the virtual printer
  const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const holdPort = await free();
  store.saveSettings({ printServer: { holdPort, printPort: 0 } });
  srv.init({ dir, store, gs, ppdLib, transports: require('../electron/transports'), userName: () => 'Owner', onFinished: (j) => done.push(j), log: () => {} });

  const pdf = await doc(4);
  const j = await srv.submit({ name: 'Flyers', pdf, hold: true, props: { copies: 2, media: { catalogId: 'let' }, finishing: { staple: 'SinglePortrait' } } });
  assert.strictEqual(j.queue, 'held');
  assert.strictEqual(j.pages, 4);
  assert.strictEqual(j.paperName, 'Letter bond');
  await srv.action(j.id, 'processHold');
  assert.match(srv.state().jobs[0].message, /Processed/);
  await srv.action(j.id, 'print');
  await until(() => srv.state().jobs[0].status === 'printed');
  await until(() => received.length === 1);
  assert.ok(received[0].toString('latin1').includes('*StapleLocation SinglePortrait'));
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].lastSheets, 8);

  // edit properties on a printed job, reprint
  srv.setProps(j.id, { ...srv.state().jobs[0].props, copies: 1, sides: 'two' });
  await srv.action(j.id, 'print');
  await until(() => received.length === 2);
  assert.ok(received[1].toString('latin1').includes('*Duplex DuplexNoTumble'));
  await until(() => srv.state().jobs[0].printCount === 2);

  // conflicts hold the job instead of printing it
  const bad = await srv.submit({ name: 'Bad', pdf, props: { media: { catalogId: 'card' }, sides: 'two' } });
  assert.strictEqual(bad.queue, 'held');
  assert.match(bad.message, /Check job properties/);

  // duplicate + remove
  const dup = await srv.action(j.id, 'duplicate');
  assert.strictEqual(dup.queue, 'held');
  await srv.action(dup.id, 'remove');
  assert.ok(!srv.state().jobs.some((x) => x.id === dup.id));

  // Windows virtual printer -> Held, untouched job is passed through byte for byte
  const ps = Buffer.from('\x1b%-12345X@PJL JOB\n@PJL COMMENT OID_ATT_JOB_NAME "From Word";\n@PJL ENTER LANGUAGE = POSTSCRIPT\n%!PS-Adobe-3.0\n%%Pages: 1\n%%EndComments\n%%BeginFeature: *PageSize Letter\n%%EndFeature\n%%BeginFeature: *MediaType Plain\n%%EndFeature\n%%Page: 1 1\n/Helvetica findfont 20 scalefont setfont 72 72 moveto (Hi) show showpage\n%%EOF\n\x1b%-12345X@PJL EOJ\n\x1b%-12345X\n', 'latin1');
  await new Promise((r) => { const c = net.createConnection({ host: '127.0.0.1', port: holdPort }, () => c.end(ps)); c.on('close', r); });
  const cap = await until(() => srv.state().jobs.find((x) => x.source === 'virtual-printer' && x.status !== 'processing'));
  assert.strictEqual(cap.name, 'From Word');
  assert.strictEqual(cap.queue, 'held');
  assert.strictEqual(cap.props.media.catalogId, 'let', 'matched to the catalog paper');
  await srv.action(cap.id, 'print');
  await until(() => received.length === 3);
  assert.ok(received[2].equals(ps));

  // preview
  const pv = await srv.preview(j.id);
  assert.strictEqual(pv.sides, 4);

  // network API + client
  const http = require('../electron/server/http');
  const api = http.start({ server: srv, port: 0, getKey: () => 'secret', version: 'test' });
  await new Promise((r) => api.once('listening', r));
  const client = require('../electron/server/client').make({ address: `127.0.0.1:${api.address().port}`, key: 'secret' });
  const st = await client.state();
  assert.strictEqual(st.jobs.length, srv.state().jobs.length);
  const rj = await client.submit({ name: 'Remote', pdf, hold: true, props: { media: { catalogId: 'blue' } } });
  assert.strictEqual(rj.pages, 4);
  assert.ok((await client.checkProps({ media: { catalogId: 'card' }, sides: 'two' })).length > 0);
  await assert.rejects(require('../electron/server/client').make({ address: `127.0.0.1:${api.address().port}`, key: 'nope' }).state(), /key/);
  api.close();
  srv.stop();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('network printer driver: Xerox model uses the PPD path', async () => {
  const drv = require('../electron/drivers/networkPrinter');
  const got = [];
  const fake = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => got.push(Buffer.concat(c))); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await drv.sendTest({ host: '127.0.0.1', port: fake.address().port, model: 'xerox-7845', testPaper: 'Tabloid' }, { jobName: 'T' });
  await until(() => got.length === 1);
  const s = got[0].toString('latin1');
  assert.ok(s.includes('@PJL COMMENT XRXbegin') && s.includes('*PageSize Tabloid'));
  fake.close();
});
