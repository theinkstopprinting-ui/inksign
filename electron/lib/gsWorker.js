// Runs Ghostscript (compiled to WebAssembly) in a worker thread so big jobs never freeze InkSign.
// Each request gets a fresh Ghostscript instance (clean file system); the compiled WebAssembly is reused.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

globalThis.fetch = undefined; // make the Emscripten loader use the bytes we hand it
const Module = require(workerData.gsJs);
let compiled = null;
function compiledWasm() {
  if (!compiled) compiled = WebAssembly.compile(fs.readFileSync(workerData.gsWasm));
  return compiled;
}

function mkdirs(gs, dir) {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try { gs.FS.mkdir(cur); } catch { /* already there */ }
  }
}

async function run({ args, files = {}, outputs = [], outputGlob }) {
  const log = [];
  const wasm = await compiledWasm();
  const gs = await Module({
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasm, imports).then((inst) => done(inst));
      return {};
    },
  });
  for (const [p, data] of Object.entries(files)) {
    mkdirs(gs, p.slice(0, p.lastIndexOf('/')));
    gs.FS.writeFile(p, data);
  }
  for (const p of [...outputs, outputGlob ? `${outputGlob.dir}/x` : null].filter(Boolean)) mkdirs(gs, p.slice(0, p.lastIndexOf('/')));
  let code;
  try { code = gs.callMain(args); } catch (e) { code = typeof e?.status === 'number' ? e.status : -1; log.push(String(e?.message || e)); }
  const out = {};
  const want = [...outputs];
  if (outputGlob) {
    // e.g. { dir: '/out', prefix: 'p' } -> every file in /out starting with prefix
    try { for (const f of gs.FS.readdir(outputGlob.dir)) if (f.startsWith(outputGlob.prefix)) want.push(`${outputGlob.dir}/${f}`); } catch { /* none */ }
  }
  for (const p of want) {
    try { out[p] = gs.FS.readFile(p); } catch { /* not produced */ }
  }
  return { code, log, out };
}

parentPort.on('message', async (msg) => {
  try {
    const r = await run(msg.req);
    const transfer = Object.values(r.out).map((b) => b.buffer);
    parentPort.postMessage({ id: msg.id, ok: true, ...r }, transfer);
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.stack || e) });
  }
});
