// Builds a profile off the main thread (takes a few seconds), so the print server keeps answering.
const { parentPort, workerData } = require('worker_threads');
const { makeProfile } = require(workerData.profilemaker);

parentPort.on('message', ({ samples, opts }) => {
  try {
    const p = makeProfile(samples, opts);
    parentPort.postMessage({ ok: true, icc: p.icc, fit: p.fit, paperLab: p.paperLab, blackLab: p.blackLab });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
});
