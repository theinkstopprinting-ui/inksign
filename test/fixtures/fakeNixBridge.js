// Stand-in for NixBridge.exe in tests: same JSON-lines protocol, made-up readings.
const rl = require('readline').createInterface({ input: process.stdin });
let n = 0, connected = false;
process.stdout.write(`${JSON.stringify({ evt: 'ready', license: 'Activated' })}\n`);
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const out = { id: m.id, ok: true };
  if (m.cmd === 'status') Object.assign(out, { license: 'Activated', device: connected ? { name: 'Nix Mini 3 (test)' } : null });
  if (m.cmd === 'connect') { connected = true; out.device = { name: 'Nix Mini 3 (test)' }; }
  if (m.cmd === 'measure') { n++; Object.assign(out, connected ? { lab: [95 - n, n % 7, -(n % 5)], mode: 'M2' } : { ok: false, error: 'Not connected' }); }
  if (m.cmd === 'disconnect') connected = false;
  process.stdout.write(`${JSON.stringify(out)}\n`);
});
