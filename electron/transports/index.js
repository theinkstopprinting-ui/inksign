// Ways InkSign talks to machines:
//  - Windows printer queue in RAW mode (USB cutters like the Graphtec CE6000 and Titan 3)
//  - COM / serial port
//  - TCP socket (network cutters, Xerox port 9100)
//  - Hot folder copy (Flexi Production Manager)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SCRIPT_DIR = path.join(os.tmpdir(), 'inksign-scripts');

const RAW_PRINT_PS1 = String.raw`param([string]$PrinterName,[string]$FilePath,[string]$DocName="InkSign Job")
$ErrorActionPreference='Stop'
if (-not ([System.Management.Automation.PSTypeName]'InkSignRaw').Type) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class InkSignRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] bytes, int count, out int written);
  public static void Send(string printer, byte[] data, string docName) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Could not open printer '" + printer + "' (Windows error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = docName; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter failed (Windows error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("WritePrinter failed (Windows error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
}
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[InkSignRaw]::Send($PrinterName, $bytes, $DocName)
Write-Output ("OK " + $bytes.Length)
`;

const SERIAL_PS1 = String.raw`param([string]$Port,[int]$Baud=9600,[string]$Handshake='RequestToSend',[string]$FilePath)
$ErrorActionPreference='Stop'
$sp = New-Object System.IO.Ports.SerialPort $Port,$Baud,'None',8,'One'
$sp.Handshake = $Handshake
$sp.WriteTimeout = 120000
$sp.Open()
try {
  $b = [System.IO.File]::ReadAllBytes($FilePath)
  for ($i = 0; $i -lt $b.Length; $i += 1024) { $n = [Math]::Min(1024, $b.Length - $i); $sp.Write($b, $i, $n) }
  Start-Sleep -Milliseconds 500
} finally { $sp.Close() }
Write-Output "OK"
`;

function ensureScript(name, content) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const p = path.join(SCRIPT_DIR, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').trim() || err.message;
        reject(new Error(msg.split('\n').filter(Boolean).slice(0, 4).join(' ')));
      } else resolve(stdout.toString());
    });
  });
}

function powershell(scriptPath, params, timeout) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  for (const [k, v] of Object.entries(params)) args.push(`-${k}`, String(v));
  return run('powershell.exe', args, timeout);
}

function powershellCommand(command, timeout = 20000) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], timeout);
}

function writeTemp(data, ext = '.bin') {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const p = path.join(SCRIPT_DIR, `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
  fs.writeFileSync(p, data);
  return p;
}

async function sendToPrinterQueue(printerName, data, docName = 'InkSign Job') {
  if (!printerName) throw new Error('No Windows printer selected for this device.');
  const file = writeTemp(data);
  try {
    if (IS_WIN) {
      const script = ensureScript('raw-print.ps1', RAW_PRINT_PS1);
      await powershell(script, { PrinterName: printerName, FilePath: file, DocName: docName });
    } else {
      await run('lp', ['-d', printerName, '-o', 'raw', file]);
    }
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

async function sendToSerial(port, baud, handshake, data) {
  if (!port) throw new Error('No COM port selected for this device.');
  if (!IS_WIN) {
    fs.writeFileSync(port, data);
    return;
  }
  const file = writeTemp(data);
  try {
    const script = ensureScript('serial-send.ps1', SERIAL_PS1);
    await powershell(script, { Port: port, Baud: baud || 9600, Handshake: handshake || 'RequestToSend', FilePath: file });
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

function sendToTcp(host, port, data, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('No IP address set for this device.'));
    const sock = net.createConnection({ host, port: Number(port) || 9100 });
    let done = false;
    const finish = (err) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(); };
    sock.setTimeout(timeoutMs, () => finish(new Error(`Timed out talking to ${host}:${port}`)));
    sock.on('error', (e) => finish(new Error(`Could not reach ${host}:${port} — ${e.message}`)));
    sock.on('connect', () => sock.end(data, () => setTimeout(() => finish(), 250)));
  });
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = net.createConnection({ host, port: Number(port) });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('error', () => done(false));
    sock.on('connect', () => done(true));
  });
}

// Removes the jobs still waiting in a Windows printer queue. Returns how many were removed.
async function clearPrinterQueue(printerName) {
  if (!IS_WIN) { try { await run('cancel', ['-a', printerName]); } catch { /* nothing queued */ } return 0; }
  const name = String(printerName).replace(/'/g, "''");
  const out = await powershellCommand(`$j = @(Get-PrintJob -PrinterName '${name}' -ErrorAction SilentlyContinue); $j | Remove-PrintJob -ErrorAction SilentlyContinue; $j.Count`);
  return Number(String(out).trim()) || 0;
}

async function listPrinters() {
  try {
    if (IS_WIN) {
      const out = await powershellCommand('Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | ConvertTo-Json -Compress');
      if (!out.trim()) return [];
      const j = JSON.parse(out);
      return (Array.isArray(j) ? j : [j]).map((p) => ({ name: p.Name, driver: p.DriverName, port: p.PortName, status: String(p.PrinterStatus ?? '') }));
    }
    const out = await run('lpstat', ['-e']);
    return out.split('\n').filter(Boolean).map((name) => ({ name, driver: '', port: '' }));
  } catch {
    return [];
  }
}

async function listComPorts() {
  try {
    if (IS_WIN) {
      const out = await powershellCommand('[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress');
      if (!out.trim()) return [];
      const j = JSON.parse(out);
      return Array.isArray(j) ? j : [j];
    }
    return fs.readdirSync('/dev').filter((n) => /^tty(USB|ACM|S)\d+$/.test(n)).map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

// Write to a temp name first, then rename, so Flexi never grabs a half-written file.
function dropInHotFolder(folder, fileName, data) {
  if (!folder) throw new Error('No hot folder set for this device.');
  if (!fs.existsSync(folder)) throw new Error(`Hot folder not found: ${folder}`);
  const finalPath = path.join(folder, fileName);
  const tmpPath = finalPath + '.part';
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

function waitForPickup(filePath, timeoutSec = 60) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (!fs.existsSync(filePath)) { clearInterval(t); resolve(true); }
      else if (Date.now() - start > timeoutSec * 1000) { clearInterval(t); resolve(false); }
    }, 1000);
  });
}

async function sendViaConnection(cfg, data, docName) {
  switch (cfg.connection) {
    case 'serial': return sendToSerial(cfg.comPort, cfg.baud, cfg.handshake, data);
    case 'tcp': return sendToTcp(cfg.tcpHost, cfg.tcpPort || 9100, data);
    case 'printer':
    default: return sendToPrinterQueue(cfg.printerName, data, docName);
  }
}

module.exports = {
  IS_WIN, clearPrinterQueue, sendToPrinterQueue, sendToSerial, sendToTcp, tcpReachable, listPrinters, listComPorts,
  dropInHotFolder, waitForPickup, sendViaConnection,
};
