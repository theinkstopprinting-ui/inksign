// Watch folders: files dropped into a folder are sent to a device automatically,
// then moved into "Done" (or "Errors") inside that folder.
const fs = require('fs');
const path = require('path');

let timer = null;
const seen = new Map(); // path -> { size, mtime, stableCount }

function start({ getConfig, getDevice, getDriver, addJob, log }) {
  stop();
  timer = setInterval(() => {
    for (const w of getConfig() || []) {
      if (!w.enabled || !w.folder || !w.deviceId) continue;
      let entries;
      try { entries = fs.readdirSync(w.folder, { withFileTypes: true }); } catch { continue; }
      const device = getDevice(w.deviceId);
      if (!device) continue;
      const drv = getDriver(device.driver);
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.') || e.name.startsWith('~') || /\.(part|tmp|crdownload)$/i.test(e.name)) continue;
        const full = path.join(w.folder, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        // Wait until the file stops growing (copying over the network can take a while)
        const prev = seen.get(full);
        if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) { seen.set(full, { size: st.size, mtime: st.mtimeMs, stable: 0 }); continue; }
        if (++prev.stable < 2) continue;
        seen.delete(full);
        const ext = path.extname(e.name).toLowerCase();
        const moveTo = (sub) => {
          const dir = path.join(w.folder, sub);
          fs.mkdirSync(dir, { recursive: true });
          let dest = path.join(dir, e.name);
          if (fs.existsSync(dest)) dest = path.join(dir, `${path.basename(e.name, ext)} ${Date.now()}${ext}`);
          fs.renameSync(full, dest);
          return dest;
        };
        try {
          if (!drv.fileTypes.includes(ext)) { moveTo('Errors'); log(`${e.name}: ${device.name} can't take ${ext} files`); continue; }
          const dest = moveTo('Done');
          addJob({ deviceId: device.id, action: 'file', filePath: dest, name: `${e.name} (watch folder)`, options: w.options || {}, hold: !!w.hold });
        } catch (err) { log(`${e.name}: ${err.message}`); }
      }
    }
  }, 2000);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop };
