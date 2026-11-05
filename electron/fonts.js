// Lists installed fonts (Windows registry, machine + per-user) and reads font files.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
let cached = null;

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (e, out) => resolve(e ? '' : String(out))));
}

async function listFonts() {
  if (cached) return cached;
  const fonts = [];
  if (IS_WIN) {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    const ps = `
$out = @()
foreach ($k in @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')) {
  if (Test-Path $k) { $p = Get-ItemProperty $k; $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $out += [pscustomobject]@{ n = $_.Name; f = [string]$_.Value } } }
}
$out | ConvertTo-Json -Compress`;
    const raw = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let list = [];
    try { list = JSON.parse(raw || '[]'); if (!Array.isArray(list)) list = [list]; } catch { list = []; }
    for (const { n, f } of list) {
      if (!/\.(ttf|otf)$/i.test(f)) continue; // .ttc collections not supported yet
      const file = path.isAbsolute(f) ? f : path.join(winDir, 'Fonts', f);
      fonts.push({ name: n.replace(/\s*\((TrueType|OpenType)\)\s*$/i, ''), file });
    }
  } else {
    const raw = await run('fc-list', ['--format', '%{file}|%{fullname}\n']);
    for (const line of raw.split('\n')) {
      const [file, name] = line.split('|');
      if (file && /\.(ttf|otf)$/i.test(file)) fonts.push({ name: (name || path.basename(file)).split(',')[0], file });
    }
  }
  const seen = new Set();
  cached = fonts.filter((f) => !seen.has(f.name) && seen.add(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

async function readFont(file) {
  const fonts = await listFonts();
  if (!fonts.some((f) => f.file === file)) throw new Error('Font not in the installed list');
  return fs.readFileSync(file);
}

module.exports = { listFonts, readFont };
