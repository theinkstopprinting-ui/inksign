const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const store = require('./store');
const queue = require('./queue');
const drivers = require('./drivers');
const T = require('./transports');
const fs = require('fs');
const fonts = require('./fonts');
const inkflow = require('./inkflow');
const watchFolders = require('./watchFolders');
const updates = require('./updates');
const shop = require('./shop');
const printSrv = require('./server');
const capture = require('./capture');
const { generate } = require('./lib/cutterLang');
const { buildPrintCutPdf, toMarkOrigin, markDistances } = require('./lib/printCutPdf');
const { impose } = require('./lib/impose');
const { layoutWide, buildWidePdf } = require('./lib/wideFormat');
const { PDFDocument } = require('pdf-lib');

let win = null;
// Self-test of an installed copy: InkSign.exe --smoke-test=C:\path\result.json
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));
const smoke = smokeArg ? require('./smoke').start(smokeArg.slice('--smoke-test='.length)) : null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#121418', title: 'InkSign', show: !smoke,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('catalog', () => drivers.catalog());
  ipcMain.handle('devices:list', () => store.getDevices());
  ipcMain.handle('devices:fieldOptions', (_e, driverId, key, cfg) => drivers.fieldOptions(driverId, key, cfg));
  // Device setup and calibration are owner-only when sign-in is on
  ipcMain.handle('devices:save', (_e, d) => { shop.requireOwner(); const r = store.saveDevice(d); shop.changed(); return r; });
  ipcMain.handle('devices:delete', (_e, id) => { shop.requireOwner(); store.deleteDevice(id); shop.changed(); });
  ipcMain.handle('devices:status', async (_e, id) => {
    const d = store.getDevice(id);
    if (!d) return { state: 'error', message: 'Device not found' };
    try { return await drivers.get(d.driver).checkStatus(d.config); }
    catch (e) { return { state: 'error', message: e.message }; }
  });

  ipcMain.handle('system:printers', () => T.listPrinters());
  ipcMain.handle('system:comports', () => T.listComPorts());
  ipcMain.handle('system:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('jobs:list', () => store.getJobs());
  ipcMain.handle('jobs:sendTest', (_e, deviceId) => queue.add({ deviceId, action: 'test' }));
  ipcMain.handle('jobs:sendFile', async (_e, deviceId) => {
    const d = store.getDevice(deviceId);
    if (!d) throw new Error('Device not found');
    const types = drivers.get(d.driver).fileTypes.map((t) => t.replace('.', ''));
    const r = await dialog.showOpenDialog(win, {
      title: `Send a file to ${d.name}`, properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported files', extensions: types }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((filePath) => queue.add({ deviceId, action: 'file', filePath }));
  });
  ipcMain.handle('jobs:sendCut', (_e, deviceId, { name, panels, overrides, inkflow: ifl }) => {
    const d = store.getDevice(deviceId);
    if (!d) throw new Error('Device not found');
    if (d.kind !== 'cutter') throw new Error(`${d.name} is not a cutter`);
    const dir = path.join(app.getPath('userData'), 'cutjobs');
    fs.mkdirSync(dir, { recursive: true });
    return panels.map((p) => {
      const file = path.join(dir, `${store.newId()}.json`);
      fs.writeFileSync(file, JSON.stringify({ paths: p.paths, overrides: overrides || {} }));
      // A new vinyl color waits until it's loaded: held with a "load … vinyl" message, released from the queue.
      return queue.add({ deviceId, action: 'paths', filePath: file, name: panels.length > 1 ? `${name} — ${p.name}` : name, inkflow: ifl, hold: !!p.hold, holdMessage: p.holdMessage, meta: p.meta || null });
    });
  });

  ipcMain.handle('files:savePng', async (_e, name, dataUrl) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save picture', defaultPath: `${String(name || 'mockup').replace(/[\\/:*?"<>|]+/g, '-')}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
    return r.filePath;
  });

  // Proofs to InkFlow: builds the same PDF the job prints (or takes a PNG mockup) and attaches it to the order.
  ipcMain.handle('proof:send', async (_e, orderId, { kind, name, note, payload }) => {
    let bytes;
    if (kind === 'png') bytes = Buffer.from(String(payload.dataUrl).split(',')[1], 'base64');
    else if (kind === 'wide') bytes = (await buildWidePdf(layoutWide({ items: payload.items, ...payload.opts }), { showGrommets: true, white: payload.opts.white ? { ...payload.opts.white } : null })).pdf;
    else if (kind === 'press') bytes = (await impose(pressSource(payload.src), payload.opts)).pdf;
    else if (kind === 'printcut') bytes = await buildPrintCutPdf({ ...payload.job, cutContour: true });
    else throw new Error('Unknown proof');
    return inkflow.sendProof(store.getSettings().inkflow || {}, orderId, { name, note, bytes: Buffer.from(bytes) });
  });
  // Variable data: one page per row on the template, returned as a PDF to impose
  ipcMain.handle('vdp:build', async (_e, template, o) => {
    const { buildVdp, numberRows } = require('./lib/vdp');
    let tpl = null;
    if (template) {
      const bytes = Buffer.from(template.base64, 'base64');
      tpl = template.ext === 'pdf' ? { pdf: bytes } : { image: { bytes, png: template.ext === 'png' } };
    }
    const rows = o.source === 'csv' ? (o.rows || []) : numberRows(o.numbers || {});
    // Only fonts from the installed-fonts list may be read
    const installed = new Set((await fonts.listFonts()).map((f) => f.file));
    for (const f of o.fields || []) if (f.fontFile && !installed.has(f.fontFile)) delete f.fontFile;
    const pdf = await buildVdp({ template: tpl, rows, fields: o.fields, widthIn: o.widthIn, heightIn: o.heightIn, bleedIn: o.bleedIn });
    return { base64: pdf.toString('base64'), pages: rows.length };
  });
  ipcMain.handle('vdp:openCsv', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open a list', properties: ['openFile'], filters: [{ name: 'CSV / text', extensions: ['csv', 'txt', 'tsv'] }] });
    return r.canceled ? null : fs.readFileSync(r.filePaths[0], 'utf8');
  });
  ipcMain.handle('preflight:check', (_e, items, opts) => require('./lib/preflight').preflight(items, opts));

  // ---- Color management: ICC profiles ----
  const profDir = () => { const d = path.join(app.getPath('userData'), 'profiles'); fs.mkdirSync(d, { recursive: true }); return d; };
  const wasmPath = () => require.resolve('lcms-wasm/dist/lcms.wasm');
  ipcMain.handle('color:wasm', () => fs.readFileSync(wasmPath()));
  ipcMain.handle('color:profiles', () => store.getSettings().iccProfiles || []);
  ipcMain.handle('color:pickProfile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add an ICC color profile', properties: ['openFile'], filters: [{ name: 'ICC profile', extensions: ['icc', 'icm'] }] });
    if (r.canceled) return null;
    return { fileName: path.basename(r.filePaths[0]), bytes: fs.readFileSync(r.filePaths[0]) };
  });
  ipcMain.handle('color:addProfile', (_e, { fileName, bytes, name, space }) => {
    shop.requireOwner();
    const id = store.newId();
    fs.writeFileSync(path.join(profDir(), `${id}.icc`), Buffer.from(bytes));
    const list = [...(store.getSettings().iccProfiles || []), { id, fileName, name: name || fileName, space }];
    store.saveSettings({ iccProfiles: list });
    return list;
  });
  ipcMain.handle('color:removeProfile', (_e, id) => {
    shop.requireOwner();
    try { fs.unlinkSync(path.join(profDir(), `${id}.icc`)); } catch { /* already gone */ }
    const s = store.getSettings();
    const list = (s.iccProfiles || []).filter((p) => p.id !== id);
    const assigned = Object.fromEntries(Object.entries(s.colorProfiles || {}).filter(([, v]) => v.profileId !== id));
    store.saveSettings({ iccProfiles: list, colorProfiles: assigned });
    return list;
  });
  ipcMain.handle('color:profileBytes', (_e, id) => fs.readFileSync(path.join(profDir(), `${String(id).replace(/[^\w-]/g, '')}.icc`)));

  // ---- Clip-art library ----
  ipcMain.handle('library:list', () => store.getLibrary());
  ipcMain.handle('library:save', (_e, item) => { const r = store.saveLibraryItem(item); shop.changed(); return r; });
  ipcMain.handle('library:delete', (_e, id) => { store.deleteLibraryItem(id); shop.changed(); });

  // ---- Live cutter control ----
  const cutterOf = (id) => {
    const d = store.getDevice(id);
    if (!d || d.kind !== 'cutter') throw new Error('Pick a cutter');
    return d;
  };
  const pushDevice = (d) => { if (win && !win.isDestroyed()) win.webContents.send('devices:update', d); return d; };
  ipcMain.handle('cutter:jog', async (_e, id, { dx = 0, dy = 0, to } = {}) => {
    const d = cutterOf(id);
    const st = d.state || {};
    const maxY = (Number(d.config.mediaWidthIn) || 24) * 25.4;
    let x = to ? to.x : (Number(st.jogX) || 0) + dx;
    let y = to ? to.y : (Number(st.jogY) || 0) + dy;
    x = Math.max(0, Math.min(x, 50000)); y = Math.max(0, Math.min(y, maxY));
    await drivers.get(d.driver).jog(d.config, x, y);
    return pushDevice(store.setDeviceState(id, { jogX: x, jogY: y }));
  });
  ipcMain.handle('cutter:setStart', (_e, id, here) => {
    const d = cutterOf(id);
    const st = d.state || {};
    const patch = here ? { startX: Number(st.jogX) || 0, startY: Number(st.jogY) || 0, rollUsedMm: 0 } : { startX: 0, startY: 0, jogX: 0, jogY: 0, rollUsedMm: 0 };
    return pushDevice(store.setDeviceState(id, patch));
  });
  ipcMain.handle('cutter:roll', (_e, id, patch) => pushDevice(store.setDeviceState(cutterOf(id).id, {
    ...(patch.continueRoll !== undefined ? { continueRoll: !!patch.continueRoll } : {}),
    ...(patch.newRoll ? { rollUsedMm: 0, rollLoadedAt: Date.now() } : {}),
    ...(patch.rollUsedMm !== undefined ? { rollUsedMm: Math.max(0, Number(patch.rollUsedMm) || 0) } : {}),
  })));
  ipcMain.handle('cutter:pause', (_e, id, paused) => { cutterOf(id); queue.setPaused(id, paused); return pushDevice(store.getDevice(id)); });
  ipcMain.handle('cutter:cancel', async (_e, id) => {
    const d = cutterOf(id);
    const n = queue.cancelWaiting(id);
    let spooled = 0;
    try { spooled = await drivers.get(d.driver).cancelSpool(d.config); } catch { /* not a printer-queue cutter */ }
    return { cancelled: n, spooled };
  });
  ipcMain.handle('files:openArt', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import artwork', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Artwork', extensions: ['svg', 'pdf', 'ai', 'dxf', 'eps', 'png', 'jpg', 'jpeg'] }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((f) => {
      const ext = path.extname(f).toLowerCase().slice(1);
      const name = path.basename(f, path.extname(f));
      const buf = fs.readFileSync(f);
      if (ext === 'svg' || ext === 'dxf') return { name, ext, text: buf.toString('utf8') };
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return { name, ext, dataUrl: `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}` };
      // .ai saved with "PDF compatible" starts with %PDF; true EPS / old AI do not.
      const isPdf = buf.subarray(0, 1024).toString('latin1').includes('%PDF');
      if (ext === 'eps' || !isPdf) return { name, ext, error: 'EPS and older Illustrator files need a PostScript reader. Save as PDF or SVG instead (Illustrator: Save As > PDF, or keep "Create PDF Compatible File" checked).' };
      return { name, ext, base64: buf.toString('base64') };
    });
  });
  // ---- Design workspace ----
  // Open artwork to edit: PDF / AI / EPS come back as a PDF with text outlined and CutContour marked
  ipcMain.handle('design:openArt', async (_e, multi = true) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import artwork', properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Artwork', extensions: ['pdf', 'ai', 'eps', 'svg', 'dxf', 'png', 'jpg', 'jpeg'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled) return [];
    const { prepareArt } = require('./lib/artPrep');
    const gs = require('./lib/ghostscript');
    const out = [];
    for (const f of r.filePaths) {
      const ext = path.extname(f).toLowerCase().slice(1);
      const name = path.basename(f, path.extname(f));
      const buf = fs.readFileSync(f);
      try {
        if (ext === 'svg' || ext === 'dxf') out.push({ name, ext, text: buf.toString('utf8') });
        else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') out.push({ name, ext, dataUrl: `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}` });
        else {
          const prep = await prepareArt(buf, ext, gs);
          out.push({ name, ext, base64: prep.pdf.toString('base64'), notes: prep.notes });
        }
      } catch (e) { out.push({ name, ext, error: e.message }); }
    }
    return out;
  });
  const designDir = () => { const d = path.join(app.getPath('userData'), 'designjobs'); fs.mkdirSync(d, { recursive: true }); return d; };
  const safeName = (s) => String(s || 'design').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
  ipcMain.handle('design:export', async (_e, format, scene, name, text) => {
    const filters = { pdf: [{ name: 'PDF', extensions: ['pdf'] }], eps: [{ name: 'EPS', extensions: ['eps'] }], svg: [{ name: 'SVG', extensions: ['svg'] }] }[format];
    if (!filters) throw new Error('Unknown format');
    const r = await dialog.showSaveDialog(win, { title: `Export ${format.toUpperCase()}`, defaultPath: `${safeName(name)}.${format}`, filters });
    if (r.canceled || !r.filePath) return null;
    if (format === 'svg') { fs.writeFileSync(r.filePath, String(text)); return r.filePath; }
    const { buildDesignPdf } = require('./lib/designPdf');
    const { pdf } = await buildDesignPdf(scene, { cut: 'spot', title: name });
    if (format === 'pdf') { fs.writeFileSync(r.filePath, pdf); return r.filePath; }
    const gs = require('./lib/ghostscript');
    const g = await gs.run(['-sDEVICE=eps2write', '-dNoOutputFonts', '-sOutputFile=/out/art.eps', '/in/art.pdf'], { files: { '/in/art.pdf': pdf }, outputs: ['/out/art.eps'] });
    if (g.code !== 0 || !g.out['/out/art.eps']) throw new Error('Could not write the EPS file');
    fs.writeFileSync(r.filePath, g.out['/out/art.eps']);
    return r.filePath;
  });
  // RIP and print the design: builds the PDF and queues it on the printer (HP Latex, Xerox, …)
  ipcMain.handle('design:print', async (_e, deviceId, scene, job = {}) => {
    const d = store.getDevice(deviceId);
    if (!d || d.kind !== 'printer') throw new Error('Pick a printer');
    const { buildDesignPdf } = require('./lib/designPdf');
    // Through Flexi the cut line rides along as CutContour; printed directly by InkSign it is left off
    const { pdf } = await buildDesignPdf(scene, { cut: job.keepCutLines ? 'spot' : 'omit', title: job.name });
    const file = path.join(designDir(), `${safeName(job.name)}-${Date.now()}.pdf`);
    fs.writeFileSync(file, pdf);
    const options = {};
    if (d.driver === 'hp-latex') {
      if (job.hpMediaId) options.mediaId = job.hpMediaId;
      if (job.hpModeKey) options.modeKey = job.hpModeKey;
      options.orientation = job.orientation || 'auto';
    }
    return queue.add({ deviceId, action: 'file', filePath: file, name: job.name || 'Design', options, inkflow: job.inkflow || null });
  });
  // ---- Print window (Flexi's RIP and Print): ask the printer what's loaded, then print a laid-out job ----
  ipcMain.handle('print:printerState', async (_e, deviceId) => {
    const d = store.getDevice(deviceId);
    if (!d) throw new Error('Printer not found');
    if (d.driver !== 'hp-latex' || !d.config.host) throw new Error(`${d.name} can't report its media — type the media size instead`);
    const st = await require('./lib/hpStatus').printerState(d.config.host);
    const M = require('./lib/hpMedia');
    const list = M.listMedia(d.config.host);
    const match = st.media && st.media.mediaKey ? list.find((m) => String(m.id) === String(st.media.mediaKey)) : null;
    return { ...st, mediaMatch: match ? { id: match.id, name: match.name } : null };
  });
  ipcMain.handle('print:fieldOptions', (_e, deviceId, key, patch) => {
    const d = store.getDevice(deviceId);
    if (!d) return [];
    return drivers.fieldOptions(d.driver, key, { ...d.config, ...(patch || {}) });
  });
  ipcMain.handle('print:send', async (_e, deviceId, source, layout, job = {}) => {
    const d = store.getDevice(deviceId);
    if (!d || d.kind !== 'printer') throw new Error('Pick a printer');
    let src;
    if (source.scene) src = (await require('./lib/designPdf').buildDesignPdf(source.scene, { cut: job.keepCutLines ? 'spot' : 'omit', title: job.name })).pdf;
    else if (source.pdfBase64) src = Buffer.from(source.pdfBase64, 'base64');
    else if (source.filePath) src = fs.readFileSync(source.filePath);
    else throw new Error('Nothing to print');
    const roll = ['hp-latex', 'flexi-hotfolder'].includes(d.driver);
    let pdf = src;
    if (roll && layout) pdf = (await require('./lib/printLayout').buildLayoutPdf(src, { ...layout, name: job.name })).pdf;
    const file = path.join(designDir(), `${safeName(job.name)}-${Date.now()}.pdf`);
    fs.writeFileSync(file, pdf);
    const options = {};
    if (d.driver === 'hp-latex') {
      Object.assign(options, { orientation: 'across', offsetIn: (Number(job.rightMarginMm) || 0) / 25.4, removeCut: !job.keepCutLines });
      if (job.mediaWidthMm) options.rollWidthIn = job.mediaWidthMm / 25.4;
      if (job.hpMediaId) options.mediaId = job.hpMediaId;
      if (job.hpModeKey) options.modeKey = job.hpModeKey;
      if (job.icc) options.icc = job.icc;
      if (job.intent != null && job.intent !== '') options.intent = Number(job.intent);
    }
    const repeat = Math.max(1, Math.min(50, Math.round(Number(job.repeat) || 1)));
    const out = [];
    for (let i = 0; i < repeat; i++) {
      out.push(queue.add({ deviceId, action: 'file', filePath: file, name: repeat > 1 ? `${job.name || 'Print'} (${i + 1} of ${repeat})` : (job.name || 'Print'),
        options, hold: job.sendMode === 'hold', holdMessage: job.sendMode === 'hold' ? 'Held — press Release to print' : undefined, inkflow: job.inkflow || null,
        meta: layout ? { feet: (layout.usedL || 0) / 25.4 / 12 } : null }));
    }
    return out;
  });
  // ---- HP Latex profile maker (Nix Mini, InkRIP's profile maker) ----
  const hpProf = require('./color/hpProfiling');
  hpProf.init({ store, queue, gs: require('./lib/ghostscript'), profilesDir: () => path.join(app.getPath('userData'), 'profiles') });
  ipcMain.handle('hpprof:patches', (_e, kind, n) => hpProf.patchList(kind, n));
  ipcMain.handle('hpprof:chart', (_e, o) => hpProf.printChart(o));
  ipcMain.handle('hpprof:check', (_e, o) => hpProf.check(o));
  ipcMain.handle('hpprof:build', (_e, o) => { shop.requireOwner(); return hpProf.build(o); });
  ipcMain.handle('hpprof:topups', () => hpProf.topups());
  ipcMain.handle('hpprof:topupBuild', (_e, o) => { shop.requireOwner(); return hpProf.topupBuild(o); });
  ipcMain.handle('design:pdfBytes', async (_e, scene, cut) => {
    const { buildDesignPdf } = require('./lib/designPdf');
    return (await buildDesignPdf(scene, { cut: cut || 'spot' })).pdf.toString('base64');
  });
  ipcMain.handle('files:openSvg', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import artwork', properties: ['openFile', 'multiSelections'], filters: [{ name: 'SVG artwork', extensions: ['svg'] }] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => ({ name: path.basename(f, path.extname(f)), text: fs.readFileSync(f, 'utf8') }));
  });
  ipcMain.handle('files:saveCut', async (_e, deviceId, { name, panels, overrides }) => {
    const ov = Object.fromEntries(Object.entries(overrides || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
    const d = store.getDevice(deviceId);
    if (!d) throw new Error('Device not found');
    const r = await dialog.showSaveDialog(win, { title: 'Save cut file', defaultPath: `${name}.plt`, filters: [{ name: 'Cut file', extensions: [d.config.language === 'gpgl' ? 'gpgl' : 'plt'] }] });
    if (r.canceled || !r.filePath) return [];
    const ext = path.extname(r.filePath), base = r.filePath.slice(0, -ext.length || undefined);
    return panels.map((p) => {
      const out = panels.length > 1 ? `${base} ${p.name}${ext}` : r.filePath;
      fs.writeFileSync(out, Buffer.from(generate(p.paths, { ...d.config, ...ov }), 'latin1'));
      return out;
    });
  });
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, patch) => {
    shop.requireOwner();
    const r = store.saveSettings(patch);
    startWatchers();
    if ('phone' in patch) shop.startPhone();
    if ('shared' in patch) shop.startShared();
    shop.changed();
    return r;
  });

  // ---- InkFlow ----
  const iflCfg = () => store.getSettings().inkflow || {};
  ipcMain.handle('inkflow:test', (_e, cfg) => inkflow.test(cfg || iflCfg()));
  ipcMain.handle('inkflow:orders', (_e, id) => inkflow.listOrders(iflCfg(), id));
  ipcMain.handle('inkflow:files', async (_e, files) => {
    const out = [];
    for (const f of files || []) {
      const { name, buf } = await inkflow.downloadFile(iflCfg(), f);
      const ext = path.extname(name).toLowerCase().slice(1).replace('jpeg', 'jpg');
      const item = { name: path.basename(name, path.extname(name)), ext, base64: buf.toString('base64') };
      if (ext === 'pdf') {
        try { const pg = (await PDFDocument.load(buf, { ignoreEncryption: true })).getPage(0); item.widthIn = pg.getWidth() / 72; item.heightIn = pg.getHeight() / 72; } catch { /* not readable by pdf-lib */ }
      }
      if (ext === 'svg' || ext === 'dxf') item.text = buf.toString('utf8');
      out.push(item);
    }
    return out;
  });
  ipcMain.handle('inkflow:report', (_e, orderId, payload) => inkflow.reportStatus(iflCfg(), orderId, payload));

  // ---- Updates ----
  ipcMain.handle('updates:state', () => updates.getState());
  ipcMain.handle('updates:check', () => updates.check({ updateUrl: store.getSettings().updateUrl, inkflow: store.getSettings().inkflow }));
  ipcMain.handle('updates:install', () => updates.install());
  ipcMain.handle('files:saveJob', async (_e, name, data) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save InkSign job', defaultPath: `${name || 'job'}.inksign`, filters: [{ name: 'InkSign job', extensions: ['inksign'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(data));
    return r.filePath;
  });
  ipcMain.handle('files:openJob', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open InkSign job', properties: ['openFile'], filters: [{ name: 'InkSign job', extensions: ['inksign'] }] });
    if (r.canceled) return null;
    return { path: r.filePaths[0], data: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) };
  });
  // ---- Print & cut ----
  ipcMain.handle('files:openImages', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add artwork to print', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (r.canceled) return [];
    return r.filePaths.map((f) => {
      const ext = path.extname(f).toLowerCase();
      return { name: path.basename(f, ext), dataUrl: `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}` };
    });
  });
  const printDir = () => { const d = path.join(app.getPath('userData'), 'printjobs'); fs.mkdirSync(d, { recursive: true }); return d; };
  const safe = (s) => String(s || 'job').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
  ipcMain.handle('printcut:print', async (_e, deviceId, job) => {
    const d = store.getDevice(deviceId);
    if (!d || d.kind !== 'printer') throw new Error('Pick a printer');
    const pdf = await buildPrintCutPdf({ ...job, cutContour: job.route === 'flexi' });
    const file = path.join(printDir(), `${safe(job.name)}-${Date.now()}.pdf`);
    fs.writeFileSync(file, pdf);
    return queue.add({ deviceId, action: 'file', filePath: file, name: `${job.name} (print)`, inkflow: job.inkflow ? { ...job.inkflow, status: 'printed' } : null });
  });
  // One cut job per frame (a sheet is one frame; a long roll has several segments, each with its own
  // four marks). The first segment goes straight to the cutter; the rest wait in the queue until you've
  // fed to that segment and scanned its marks, then press Release.
  ipcMain.handle('printcut:cut', (_e, deviceId, job) => {
    const d = store.getDevice(deviceId);
    if (!d || d.kind !== 'cutter') throw new Error('Pick a cutter');
    if (!job.marks || !(job.marks.size > 0)) throw new Error('This layout has no registration marks to cut from.');
    const frames = job.frames && job.frames.length ? job.frames : [{ y0: 0, h: job.sheetH }];
    const frameCuts = job.frameCuts && job.frameCuts.length ? job.frameCuts : [job.cutPaths || []];
    const cal = { rotate: d.config.regRotate, offsetXmm: d.config.regOffsetXmm, offsetYmm: d.config.regOffsetYmm };
    const rot = ((Number(cal.rotate) || 0) % 360 + 360) % 360;
    const dir = path.join(app.getPath('userData'), 'cutjobs');
    fs.mkdirSync(dir, { recursive: true });
    const n = frames.length;
    const jobs = [];
    frames.forEach((frame, i) => {
      const cuts = frameCuts[i] || [];
      if (!cuts.length) return;
      const paths = toMarkOrigin(cuts, job.sheetW, frame, job.marks.margin, cal);
      const dist = markDistances(job.sheetW, frame, job.marks.margin);
      const [dx, dy] = rot === 90 || rot === 270 ? [dist.dy, dist.dx] : [dist.dx, dist.dy];
      const file = path.join(dir, `${store.newId()}.json`);
      fs.writeFileSync(file, JSON.stringify({ paths, overrides: { ...(job.overrides || {}), keepOrigin: true, markDxMm: dx, markDyMm: dy } }));
      const last = i === n - 1;
      jobs.push(queue.add({
        meta: { cutMm: cuts.reduce((s, q) => s + q.reduce((a, pt, k) => (k ? a + Math.hypot(pt.x - q[k - 1].x, pt.y - q[k - 1].y) : 0), 0), 0) },
        deviceId, action: 'paths', filePath: file,
        name: n > 1 ? `${job.name} (contour cut, segment ${i + 1} of ${n})` : `${job.name} (contour cut)`,
        hold: i > 0,
        holdMessage: `Feed to segment ${i + 1}, scan its marks, then press Release`,
        inkflow: job.inkflow && last ? { ...job.inkflow, status: 'cut' } : null,
      }));
    });
    if (!jobs.length) throw new Error('Nothing to cut.');
    return jobs;
  });
  ipcMain.handle('printcut:savePdf', async (_e, job) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save print file', defaultPath: `${safe(job.name)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, await buildPrintCutPdf({ ...job, cutContour: true }));
    return r.filePath;
  });
  // ---- Press (Xerox imposition) ----
  ipcMain.handle('press:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open a print file', properties: ['openFile'], filters: [{ name: 'PDF or image', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0], ext = path.extname(f).toLowerCase();
    return { name: path.basename(f, ext), ext: ext.slice(1), base64: fs.readFileSync(f).toString('base64') };
  });
  const pressSource = (src) => {
    const bytes = Buffer.from(src.base64, 'base64');
    if (src.ext === 'pdf') return { pdf: bytes };
    if (src.cmyk) return { cmyk: { w: src.cmyk.w, h: src.cmyk.h, bytes: Buffer.from(src.cmyk.base64, 'base64') }, trimW: (src.widthIn || 3.5) * 72, trimH: (src.heightIn || 2) * 72 };
    return { image: { bytes, png: src.ext === 'png' }, trimW: (src.widthIn || 3.5) * 72, trimH: (src.heightIn || 2) * 72 };
  };
  ipcMain.handle('press:impose', async (_e, src, opts) => {
    const r = await impose(pressSource(src), opts);
    return { info: r.info, base64: r.pdf.toString('base64') };
  });
  ipcMain.handle('press:send', async (_e, deviceId, src, opts, job) => {
    const d = store.getDevice(deviceId);
    if (!d || d.driver !== 'network-printer') throw new Error('Pick a network printer (Xerox)');
    const r = await impose(pressSource(src), opts);
    const file = path.join(printDir(), `${safe(job.name)}-${Date.now()}.pdf`);
    fs.writeFileSync(file, r.pdf);
    return queue.add({ deviceId, action: 'file', filePath: file, name: job.name, copies: job.copies, options: job.options, hold: job.hold, inkflow: job.inkflow });
  });
  // Learn from Flexi: capture what Flexi sends a machine
  capture.init({ dataDir: app.getPath('userData'), notify: (r) => { if (win && !win.isDestroyed()) win.webContents.send('capture:event', r); } });
  ipcMain.handle('capture:state', () => capture.state());
  ipcMain.handle('capture:listen', (_e, o) => capture.listen(o));
  ipcMain.handle('capture:stop', () => capture.stop());
  ipcMain.handle('capture:kit', async () => { const r = await capture.kit(); shell.openPath(r.folder); return r; });
  ipcMain.handle('capture:openFolder', () => shell.openPath(capture.state().folder));
  ipcMain.handle('capture:import', async (_e, machine) => {
    const r = await dialog.showOpenDialog(win, { title: `Pick the file Flexi saved for ${machine}`, properties: ['openFile'] });
    if (r.canceled) return null;
    return capture.importFile(machine, r.filePaths[0]);
  });
  // Press page -> InkSign Print Server: the server imposes, applies paper / finishing / color and prints
  ipcMain.handle('press:toServer', async (_e, src, props, job) => {
    const { loadSource } = require('./lib/impose');
    const doc = await loadSource(pressSource(src));
    const pdf = src.ext === 'pdf' ? Buffer.from(src.base64, 'base64') : Buffer.from(await doc.save());
    return printSrv.backend().submit({ name: job.name, user: shop.userName(), from: require('os').hostname(), props, hold: !!job.hold, inkflow: job.inkflow || null, pdf, source: 'press' });
  });
  ipcMain.handle('press:save', async (_e, src, opts, name) => {
    const r = await impose(pressSource(src), opts);
    const out = await dialog.showSaveDialog(win, { title: 'Save imposed PDF', defaultPath: `${safe(name)} imposed.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (out.canceled || !out.filePath) return null;
    fs.writeFileSync(out.filePath, r.pdf);
    return out.filePath;
  });
  // ---- Wide format (HP via Flexi) ----
  ipcMain.handle('wide:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add print files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF or image', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const ext = path.extname(f).toLowerCase().slice(1).replace('jpeg', 'jpg');
      const buf = fs.readFileSync(f);
      let widthIn = null, heightIn = null;
      if (ext === 'pdf') {
        const d = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pg = d.getPage(0);
        widthIn = pg.getWidth() / 72; heightIn = pg.getHeight() / 72;
      }
      out.push({ name: path.basename(f, path.extname(f)), ext, base64: buf.toString('base64'), widthIn, heightIn });
    }
    return out;
  });
  const stripLayout = (L) => ({
    lengthIn: L.lengthIn, rollWidthIn: L.rollWidthIn, printableW: L.printableW, printedSqFt: L.printedSqFt, mediaSqFt: L.mediaSqFt,
    pieces: L.pieces.map((p) => ({ itemId: p.item.id, label: p.label, x: p.x, y: p.y, pw: p.pw, ph: p.ph, rotated: p.rotated, extraRot: p.extraRot, tiles: p.tiles, crop: p.cropAcross, w: p.w, h: p.h, outerW: p.outerW, outerH: p.outerH, hem: p.hem })),
  });
  ipcMain.handle('wide:layout', (_e, items, opts) => stripLayout(layoutWide({ items, ...opts })));
  ipcMain.handle('wide:send', async (_e, deviceId, items, opts, job) => {
    const d = store.getDevice(deviceId);
    if (!d || !['hp-latex', 'flexi-hotfolder'].includes(d.driver)) throw new Error('Pick an HP Latex printer');
    const L = layoutWide({ items, ...opts });
    const { pdf } = await buildWidePdf(L, { showGrommets: true, white: opts.white ? { ...opts.white } : null });
    const file = path.join(printDir(), `${safe(job.name)}-${Date.now()}.pdf`);
    fs.writeFileSync(file, pdf);
    const st = store.getSettings();
    const media = st.wideMedia.find((m) => m.name === job.media) || {};
    const inkMl = L.printedSqFt * (Number(media.inkMlPerSqFt) || 0);
    const usage = {
      kind: 'wide', media: job.media || '', rollWidthIn: L.rollWidthIn, lengthFt: L.lengthIn / 12,
      mediaSqFt: L.mediaSqFt, printedSqFt: L.printedSqFt, inkMl,
      mediaCost: L.mediaSqFt * (Number(media.costPerSqFt) || 0), inkCost: inkMl * (Number(st.inkCostPerMl) || 0),
    };
    // HP direct: the layout's x runs along the roll; the job can pick its own HP media / print mode
    const options = { media: job.media, orientation: 'along' };
    if (job.hpMediaId) options.mediaId = job.hpMediaId;
    if (job.hpModeKey) options.modeKey = job.hpModeKey;
    return queue.add({ deviceId, action: 'file', filePath: file, name: job.name, options, usage, inkflow: job.inkflow, meta: job.rollId ? { rollId: job.rollId, feet: L.lengthIn / 12 } : null });
  });
  ipcMain.handle('wide:save', async (_e, items, opts, name) => {
    const L = layoutWide({ items, ...opts });
    const { pdf } = await buildWidePdf(L, { showGrommets: true, white: opts.white ? { ...opts.white } : null });
    const out = await dialog.showSaveDialog(win, { title: 'Save print PDF', defaultPath: `${safe(name)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (out.canceled || !out.filePath) return null;
    fs.writeFileSync(out.filePath, pdf);
    return out.filePath;
  });
  ipcMain.handle('usage:list', () => store.getUsage());
  ipcMain.handle('usage:export', async () => {
    const rows = store.getUsage();
    const out = await dialog.showSaveDialog(win, { title: 'Export usage', defaultPath: 'InkSign usage.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (out.canceled || !out.filePath) return null;
    const cols = ['date', 'deviceName', 'jobName', 'media', 'rollWidthIn', 'lengthFt', 'mediaSqFt', 'printedSqFt', 'inkMl', 'mediaCost', 'inkCost'];
    const esc = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : `"${String(v ?? '').replace(/"/g, '""')}"`);
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => (c === 'date' ? `"${new Date(r.date).toLocaleString()}"` : esc(r[c]))).join(','))].join('\r\n');
    fs.writeFileSync(out.filePath, csv);
    return out.filePath;
  });
  ipcMain.handle('jobs:release', (_e, id) => queue.release(id));
  ipcMain.handle('fonts:list', () => fonts.listFonts());
  ipcMain.handle('fonts:read', (_e, file) => fonts.readFont(file));
  ipcMain.handle('jobs:retry', (_e, id) => queue.retry(id));
  ipcMain.handle('jobs:remove', (_e, id) => queue.remove(id));
  ipcMain.handle('jobs:clearFinished', () => queue.clearFinished());
}

function startWatchers() {
  watchFolders.start({
    getConfig: () => store.getSettings().watchFolders || [],
    getDevice: (id) => store.getDevice(id),
    getDriver: (id) => drivers.get(id),
    addJob: (j) => queue.add(j),
    log: (m) => { if (win && !win.isDestroyed()) win.webContents.send('app:notice', m); },
  });
}

// Links like inksign://order/1234 from InkFlow open that order here.
function handleLink(url) {
  if (!url || !/^inksign:\/\//i.test(url)) return;
  const m = url.match(/^inksign:\/\/(?:open\/)?order\/([^/?#]+)/i);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('inkflow:open', m ? decodeURIComponent(m[1]) : null);
  } else pendingLink = url;
}
let pendingLink = process.argv.find((a) => /^inksign:\/\//i.test(a)) || null;

if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (smoke) {
  app.whenReady().then(async () => {
    await smoke.ready;
    store.init(app.getPath('userData'));
    smoke.configure(store);
    queue.init(store, drivers, () => {}, () => {});
    queue.setUserSource(() => shop.userName());
    registerIpc();
    shop.register(ipcMain);
    shop.init({ store, queue, drivers, inkflow, app, dir: app.getPath('userData'), notice: () => {}, reloadUi: () => {} });
    printSrv.init({ app, store, shop, inkflow, transports: T, ipcMain, dialog, getWin: () => win, notice: () => {} });
    createWindow();
    smoke.run({ getWin: () => win, printSrv, store });
  });
} else {
  app.on('second-instance', (_e, argv) => handleLink(argv.find((a) => /^inksign:\/\//i.test(a))));
  app.on('open-url', (e, url) => { e.preventDefault(); handleLink(url); });
  if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient('inksign', process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient('inksign');

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    queue.init(store, drivers, (job) => { if (win && !win.isDestroyed()) win.webContents.send('jobs:update', job); }, (job) => {
      shop.onJobDone(job).catch(() => {}); // meters, roll stock, real costs, history
      // Tell InkFlow when an order's job is done
      if (job.status !== 'done' && job.status !== 'warning') return;
      if (!job.inkflow?.orderId) return;
      const cfg = store.getSettings().inkflow || {};
      if (!cfg.url || !cfg.secret || cfg.autoReport === false) return;
      inkflow.reportStatus(cfg, job.inkflow.orderId, {
        itemId: job.inkflow.itemId, status: job.inkflow.status || 'printed', job: job.id, device: job.deviceName,
        note: `${job.name} on ${job.deviceName} (InkSign)`,
        ...(job.usage ? { sqft: job.usage.mediaSqFt, cost: (job.usage.mediaCost || 0) + (job.usage.inkCost || 0), media: job.usage.media } : {}),
      })
        .catch((e) => { if (win && !win.isDestroyed()) win.webContents.send('app:notice', `Couldn't update InkFlow: ${e.message}`); });
    });
    queue.setDeviceNotifier((d) => { if (win && !win.isDestroyed()) win.webContents.send('devices:update', d); });
    queue.setUserSource(() => shop.userName());
    registerIpc();
    shop.register(ipcMain);
    createWindow();
    startWatchers();
    shop.init({
      store, queue, drivers, inkflow, app, dir: app.getPath('userData'),
      notice: (m) => { if (win && !win.isDestroyed()) win.webContents.send('app:notice', m); },
      reloadUi: () => { if (win && !win.isDestroyed()) win.webContents.send('app:reload'); },
    });
    printSrv.init({
      app, store, shop, inkflow, transports: T, ipcMain, dialog, getWin: () => win,
      notice: (m) => { if (win && !win.isDestroyed()) win.webContents.send('app:notice', m); },
    });
    updates.init((st) => { if (win && !win.isDestroyed()) win.webContents.send('updates:state', st); });
    const autoCheck = () => updates.check({ updateUrl: store.getSettings().updateUrl, inkflow: store.getSettings().inkflow }).catch(() => {});
    setTimeout(autoCheck, 8000);
    setInterval(autoCheck, 6 * 60 * 60 * 1000);
    win.webContents.once('did-finish-load', () => { if (pendingLink) { const l = pendingLink; pendingLink = null; setTimeout(() => handleLink(l), 1500); } });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { printSrv.stopServer(); capture.stop(); } catch { /* already stopped */ } });
