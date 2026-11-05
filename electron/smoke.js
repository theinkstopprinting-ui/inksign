// Self-test of an installed InkSign: `InkSign.exe --smoke-test=C:\path\result.json`
// Starts InkSign normally but in a throw-away data folder (never touches the real setup or printers),
// points the Xerox at a fake printer (a local TCP listener), then: prints a booklet with fold +
// staple, a held mixed-media job (process & hold, print, reprint), a PostScript job sent to the
// Windows "virtual printer" Hold port, uses the network API like another shop PC would, clicks
// through every page of the window, and writes the results.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out'); await wait(250); }
}

// Called at the very start of main.js (before the app is ready)
function start(outFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inksign-smoke-'));
  app.setPath('userData', tmp);
  const results = { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, checks: [], ok: false };
  const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail: detail ?? null }); };
  const finish = (code) => {
    results.ok = code === 0 && results.checks.every((c) => c.ok);
    try { fs.writeFileSync(outFile, JSON.stringify(results, null, 2)); } catch (e) { console.error(e); }
    console.log(JSON.stringify(results, null, 2));
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } app.exit(results.ok ? 0 : 1); }, 300);
  };
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (...a) => {
      const ev = a[0]; const level = ev?.level ?? a[1]; const message = ev?.message ?? a[2];
      if (level === 'error' || level === 3) (results.consoleErrors = results.consoleErrors || []).push(String(message).slice(0, 300));
    });
    wc.on('render-process-gone', (_ev, d) => check('Window crashed', false, d.reason));
  });
  // Fake Xerox: records every job it receives
  const received = [];
  const fake = net.createServer((sock) => { const chunks = []; sock.on('data', (d) => chunks.push(d)); sock.on('end', () => received.push(Buffer.concat(chunks))); sock.on('error', () => {}); });
  const ports = {};
  const ready = (async () => {
    ports.xerox = await freePort();
    await new Promise((r) => fake.listen(ports.xerox, '127.0.0.1', r));
    [ports.api, ports.hold, ports.print] = [await freePort(), await freePort(), await freePort()];
  })();
  const watchdog = setTimeout(() => { check('Smoke test finished in time', false); finish(1); }, 8 * 60 * 1000);
  watchdog.unref?.();

  // Right after the data folder is loaded, before the print server starts
  function configure(store) {
    const xerox = store.getDevices().find((d) => d.presetId === 'xerox-7845');
    check('Xerox 7845 device preset', xerox && xerox.config.model === 'xerox-7845');
    store.saveDevice({ ...xerox, config: { ...xerox.config, host: '127.0.0.1', port: ports.xerox } });
    store.saveSettings({ printServer: { role: 'server', apiPort: ports.api, holdPort: ports.hold, printPort: ports.print, printerDeviceId: xerox.id } });
  }

  async function run({ getWin, printSrv }) {
    const holdPort = ports.hold, apiPort = ports.api;
    try {
      const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
      const srv = printSrv.backend();
      check('Print server is running on this PC', printSrv.role() === 'server');

      // PPD
      const caps = srv.capabilities();
      check('Xerox 7845 PPD loaded', caps.model === 'Xerox WorkCentre 7845' && caps.trays.length === 6 && caps.mediaTypes.length >= 30, `${caps.model} ${caps.fileVersion}: ${caps.trays.length} trays, ${caps.mediaTypes.length} paper types, ${caps.sizes.length} sizes`);

      // An 8-page letter document
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (let i = 1; i <= 8; i++) {
        const p = doc.addPage([612, 792]);
        p.drawRectangle({ x: 36, y: 36, width: 540, height: 720, borderColor: rgb(0.9, 0.4, 0.1), borderWidth: 4 });
        p.drawText(`InkSign smoke test — page ${i}`, { x: 90, y: 400, size: 28, font, color: rgb(0.1, 0.1, 0.1) });
      }
      const pdf = Buffer.from(await doc.save());

      // 1) Booklet, 11x17 70# text, fold + staple, 2 copies, straight to print
      const t0 = Date.now();
      const job = await srv.submit({ name: 'Smoke booklet', pdf, props: { copies: 2, media: { catalogId: 'pc-tabloid-text' }, sides: 'two', layout: { mode: 'booklet', cropMarks: false }, finishing: { fold: 'BiFoldStaple' } } });
      const printed = await until(() => { const j = srv.state().jobs.find((x) => x.id === job.id); return j && (j.status === 'printed' || j.status === 'error' || j.status === 'held') ? j : null; });
      check('Booklet job printed', printed.status === 'printed', `${printed.status}: ${printed.message} (${Date.now() - t0} ms, ${printed.sheets} sheets)`);
      await until(() => received.length >= 1, 10000);
      const s1 = received[0].toString('latin1');
      check('Job starts with the Xerox PJL header', s1.startsWith('\x1b%-12345X@PJL JOB\n@PJL\n@PJL COMMENT XRXbegin\n') && s1.includes('@PJL ENTER LANGUAGE = POSTSCRIPT'));
      for (const f of ['*PageSize Tabloid', '*MediaType Plain', '*XRFold BiFoldStaple', '*Duplex DuplexTumble', '*Collate True']) check(`Booklet sends ${f}`, s1.includes(`%%BeginFeature: ${f}`));
      check('Booklet sends 2 copies', s1.includes('%%BeginNonPPDFeature: NumCopies 2'));
      check('Booklet is 2 sheets / 4 sides', printed.sheets === 2 && (s1.match(/^%%Page:/gm) || []).length === 4);
      check('Job ends with the Xerox PJL trailer', s1.endsWith('\x1b%-12345X@PJL EOJ\n\x1b%-12345X\n'));

      // 2) Mixed media: blue page 1 from tray 2, insert after page 4, staple, B&W — held, then processed, then printed
      const cat = srv.state().catalog;
      srv.saveCatalog([...cat, { id: 'blue', name: 'Blue 24# letter', size: 'Letter', type: 'Plain', color: 'Blue', tray: 'Tray2' }]);
      srv.saveTrays({ Tray1: 'pc-letter-bond' });
      const mx = await srv.submit({ name: 'Smoke mixed media', pdf, hold: true, props: { copies: 1, media: { catalogId: 'pc-letter-bond' }, sides: 'two', color: { mode: 'gray' }, finishing: { staple: 'SinglePortrait' }, mixed: { ranges: [{ pages: '1', catalogId: 'blue' }], inserts: [{ after: 4, catalogId: 'blue' }] } } });
      check('Held job waits in the Held queue', srv.state().jobs.find((x) => x.id === mx.id).queue === 'held');
      const pv = await srv.preview(mx.id);
      check('Preview of mixed media', !pv.error && pv.sides === 12, `${pv.sides} sides / ${pv.sheets} sheets: ${pv.papers.map((p) => p.name + (p.blank ? ' (blank)' : '')).join(', ')}`);
      await srv.action(mx.id, 'processHold');
      check('Process and hold', /Processed/.test(srv.state().jobs.find((x) => x.id === mx.id).message));
      await srv.action(mx.id, 'print');
      await until(() => srv.state().jobs.find((x) => x.id === mx.id).status === 'printed');
      await until(() => received.length >= 2, 10000);
      const s2 = received[1].toString('latin1');
      check('Mixed media: tray 1 for the job, tray 2 + blue for its pages', s2.includes('%%BeginFeature: *InputSlot Tray1') && s2.includes('%%BeginFeature: *InputSlot Tray2') && s2.includes('%%BeginFeature: *MediaColor Blue'));
      check('Mixed media: staple + B&W accounting', s2.includes('%%BeginFeature: *StapleLocation SinglePortrait') && s2.includes('OID_VAL_COLOR_MODE_BLACK_WHITE'));
      // Reprint from the Printed queue
      await srv.action(mx.id, 'print');
      await until(() => received.length >= 3, 30000);
      const rp = await until(() => { const j = srv.state().jobs.find((x) => x.id === mx.id); return j.status === 'printed' && j.printCount === 2 ? j : null; }, 30000).catch(() => null);
      check('Reprint from Printed queue', !!rp);

      // 3) Conflicts are caught before printing
      const bad = srv.checkProps({ media: { catalogId: 'pc-12x18-14pt' }, sides: 'two' });
      check('Xerox rules: heavyweight card can\'t be 2-sided', bad.length > 0, bad[0]);

      // 4) Windows virtual printer (Hold port): a PostScript job from a "driver"
      const ps = Buffer.from('\x1b%-12345X@PJL JOB\n@PJL COMMENT XRXbegin\n@PJL COMMENT OID_ATT_JOB_NAME "Flyer from Word";\n@PJL COMMENT OID_ATT_JOB_OWNER "Front desk";\n@PJL COMMENT XRXend\n@PJL ENTER LANGUAGE = POSTSCRIPT\n%!PS-Adobe-3.0\n%%Title: Flyer\n%%Pages: 1\n%%EndComments\n%%BeginSetup\n[{\n%%BeginFeature: *InputSlot Tray3\n<< (tray-3) xerox$MediaInputTray >> setpagedevice\n%%EndFeature\n} stopped cleartomark\n[{\n%%BeginFeature: *Duplex None\n<< /Duplex false /Tumble false >> setpagedevice\n%%EndFeature\n} stopped cleartomark\n%%EndSetup\n%%Page: 1 1\n/Helvetica findfont 36 scalefont setfont 72 600 moveto (Hello from Word) show showpage\n%%EOF\n\x1b%-12345X@PJL EOJ\n\x1b%-12345X\n', 'latin1');
      await new Promise((resolve, reject) => { const c = net.createConnection({ host: '127.0.0.1', port: holdPort }, () => c.end(ps)); c.on('close', resolve); c.on('error', reject); });
      const cap = await until(() => srv.state().jobs.find((j) => j.source === 'virtual-printer' && j.status !== 'processing'), 60000);
      check('Windows printer job lands in Held queue', cap.queue === 'held' && cap.name === 'Flyer from Word' && cap.user === 'Front desk' && cap.props.media.tray === 'Tray3', `${cap.name} by ${cap.user}: ${cap.message}, tray ${cap.props.media.tray}, ${cap.pages} page`);
      await srv.action(cap.id, 'print');
      await until(() => received.length >= 4, 30000);
      check('Unchanged Windows job is sent exactly as the driver made it', received[3].equals(ps));

      // 5) Network API (what the other shop PCs use)
      const key = printSrv.info().key;
      const client = require('./server/client').make({ address: `127.0.0.1:${apiPort}`, key });
      const ping = await client.ping();
      const rs = await client.state();
      check('Network API answers with the key', ping.ok && rs.jobs.length === srv.state().jobs.length, `${rs.jobs.length} jobs`);
      let refused = false;
      try { await require('./server/client').make({ address: `127.0.0.1:${apiPort}`, key: 'wrong' }).state(); } catch { refused = true; }
      check('Network API refuses a wrong key', refused);
      const rj = await client.submit({ name: 'From another PC', pdf, hold: true, props: { media: { catalogId: 'pc-letter-bond' } } });
      check('Job submitted from another PC', rj.queue === 'held' && rj.pages === 8);
      const thumb = await client.thumb(rj.id);
      check('Thumbnails over the network', thumb && thumb.length > 100 && thumb.subarray(1, 4).toString() === 'PNG');

      // 6) The app window and pages render
      const win = getWin();
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
      const pages = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 80 && !document.querySelector('.sidebar'); i++) await wait(100);
        const out = {};
        for (const b of [...document.querySelectorAll('.sidebar nav button')]) {
          b.click(); await wait(500);
          out[b.textContent.replace(/\\d+$/, '').trim()] = !!document.querySelector('.content') && !document.querySelector('.crash');
        }
        const jc = [...document.querySelectorAll('.sidebar nav button')].find((b) => /Xerox Server/.test(b.textContent));
        if (jc) { jc.click(); await wait(2500); }
        const all = [...document.querySelectorAll('.jc-queues button')].find((b) => /All jobs/.test(b.textContent));
        if (all) { all.click(); await wait(800); }
        out.__jobRows = document.querySelectorAll('.jc-row').length;
        // open Job Properties on the first job and walk every tab
        const row = document.querySelector('.jc-row');
        if (row) {
          row.click(); await wait(300);
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(1200);
          out.__propTabs = [...document.querySelectorAll('.jp-tabs button')].map((b) => { b.click(); return b.textContent; }).length;
          await wait(500);
          const cancel = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Cancel');
          if (cancel) cancel.click();
          await wait(300);
          const pc = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Paper catalog');
          if (pc) { pc.click(); await wait(800); out.__catalog = document.querySelectorAll('.pc-list .piece').length; }
        }
        return out;
      })()`);
      const rows = pages.__jobRows; const propTabs = pages.__propTabs; const catalogN = pages.__catalog;
      delete pages.__jobRows; delete pages.__propTabs; delete pages.__catalog;
      check('Every page opens', Object.keys(pages).length >= 10 && Object.values(pages).every(Boolean), Object.keys(pages).join(', '));
      check('Xerox Server page lists the jobs', rows >= 4, `${rows} rows`);
      check('Job Properties opens with all its tabs', propTabs === 6, `${propTabs} tabs`);
      check('Paper catalog opens', catalogN >= 8, `${catalogN} papers`);
      check('No errors in the app window', !results.consoleErrors?.length, results.consoleErrors);
      fake.close();
      printSrv.stopServer();
      clearTimeout(watchdog);
      finish(0);
    } catch (e) {
      check('Smoke test ran to the end', false, String(e?.stack || e));
      finish(1);
    }
  }
  return { ready, configure, run };
}

module.exports = { start };
