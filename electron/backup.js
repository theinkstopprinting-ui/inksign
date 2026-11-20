// Backup & restore: everything that makes this PC's InkSign yours — settings (materials, pricing, media
// presets, paper catalog), devices with their cutter corrections, maintenance log, timers, history,
// saved barcode cut jobs and ICC profiles — in one .inksign-backup file. Point it at a Nextcloud (or any
// synced) folder and a copy is made by itself once a day, keeping the last 14.
const fs = require('fs');
const path = require('path');

const FILES = ['settings.json', 'devices.json', 'library.json', 'maintlog.json', 'timers.json', 'history.json', 'usage.json'];
const DIRS = ['barcode-jobs', 'profiles'];
const MAX_DIR_BYTES = 60 * 1024 * 1024;
const KEEP = 14;

function collect(dataDir, localStore = {}) {
  const files = {};
  for (const f of FILES) { const p = path.join(dataDir, f); if (fs.existsSync(p)) files[f] = fs.readFileSync(p, 'utf8'); }
  const dirs = {};
  for (const d of DIRS) {
    const root = path.join(dataDir, d);
    if (!fs.existsSync(root)) continue;
    let total = 0;
    dirs[d] = {};
    for (const f of fs.readdirSync(root)) {
      const p = path.join(root, f);
      const st = fs.statSync(p);
      if (!st.isFile() || total + st.size > MAX_DIR_BYTES) continue;
      total += st.size;
      dirs[d][f] = fs.readFileSync(p).toString('base64');
    }
  }
  return { kind: 'inksign-backup', version: 1, at: Date.now(), host: require('os').hostname(), files, dirs, localStore };
}

function write(folder, data) {
  fs.mkdirSync(folder, { recursive: true });
  const d = new Date(data.at);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const file = path.join(folder, `InkSign-backup_${data.host}_${stamp}.inksign-backup`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
  // keep the newest KEEP backups from this PC
  const mine = fs.readdirSync(folder).filter((f) => f.startsWith(`InkSign-backup_${data.host}_`) && f.endsWith('.inksign-backup')).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - KEEP))) fs.rmSync(path.join(folder, f), { force: true });
  return file;
}

function read(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.kind !== 'inksign-backup' || !data.files) throw new Error('That is not an InkSign backup file');
  return data;
}

/** Put a backup's files back. The current files are kept beside them as *.before-restore. */
function restore(dataDir, data) {
  for (const [f, text] of Object.entries(data.files || {})) {
    if (!FILES.includes(f)) continue;
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.before-restore`);
    fs.writeFileSync(p, text);
  }
  for (const [d, list] of Object.entries(data.dirs || {})) {
    if (!DIRS.includes(d)) continue;
    const root = path.join(dataDir, d);
    fs.mkdirSync(root, { recursive: true });
    for (const [f, b64] of Object.entries(list)) {
      if (f.includes('/') || f.includes('\\') || f.startsWith('.')) continue;
      fs.writeFileSync(path.join(root, f), Buffer.from(b64, 'base64'));
    }
  }
  return { files: Object.keys(data.files || {}).length, localStore: data.localStore || {} };
}

function lastBackup(folder) {
  try {
    const list = fs.readdirSync(folder).filter((f) => f.endsWith('.inksign-backup')).map((f) => ({ f, t: fs.statSync(path.join(folder, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return list[0] ? { file: path.join(folder, list[0].f), at: list[0].t } : null;
  } catch { return null; }
}

module.exports = { collect, write, read, restore, lastBackup, FILES, DIRS };
