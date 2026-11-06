// One job queue per device: jobs to the same machine go one at a time, different machines run in parallel.
let store, drivers, notify, onDone = () => {}, notifyDevice = null, getUser = null;
const busy = new Set();

function init(s, d, onUpdate, onFinished) {
  store = s; drivers = d; notify = onUpdate; if (onFinished) onDone = onFinished;
  const jobs = store.getJobs().map((j) =>
    j.status === 'queued' || j.status === 'sending' ? { ...j, status: 'error', message: 'Interrupted — InkSign was closed' } : j);
  store.saveJobs(jobs);
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  store.saveJobs(store.getJobs());
  notify(job);
}

function add({ deviceId, action, filePath, name, copies, options, hold, holdMessage, usage, inkflow, meta, user }) {
  const device = store.getDevice(deviceId);
  if (!device) throw new Error('Device not found');
  const job = {
    id: store.newId(), deviceId, deviceName: device.name, action, filePath: filePath || null, copies: copies || null, options: options || null, usage: usage || null, inkflow: inkflow || null, meta: meta || null, user: user || (getUser ? getUser() : null),
    name: name || (action === 'test' ? 'Test job' : require('path').basename(filePath || 'job')),
    status: hold ? 'held' : 'queued', message: hold ? (holdMessage || 'Held — press Release to print') : 'Waiting', createdAt: Date.now(), updatedAt: Date.now(),
  };
  store.saveJobs([...store.getJobs(), job]);
  notify(job);
  pump(deviceId);
  return job;
}

async function pump(deviceId) {
  if (busy.has(deviceId)) return;
  busy.add(deviceId);
  try {
    let job;
    while ((job = store.getJobs().find((j) => j.deviceId === deviceId && j.status === 'queued'))) {
      if (store.getDevice(deviceId)?.state?.paused) break; // queue paused from the cutter controls
      update(job, { status: 'sending', message: 'Sending…', startedAt: Date.now() });
      try {
        const device = store.getDevice(deviceId);
        if (!device) throw new Error('Device was removed');
        const drv = drivers.get(device.driver);
        const miss = drv.missing(device.config);
        if (miss.length) throw new Error(`Device needs setup: ${miss.join(', ')}`);
        let lastMsg = 0;
        const progress = (text) => { if (Date.now() - lastMsg > 500) { lastMsg = Date.now(); update(job, { message: text }); } };
        const ctx = { jobName: job.name, deviceName: device.name, copies: job.copies, options: job.options || {}, progress };
        let res;
        if (job.action === 'test') res = await drv.sendTest(device.config, ctx);
        else if (job.action === 'paths') {
          if (!drv.sendPaths) throw new Error(`${device.name} can't take cut jobs`);
          const data = JSON.parse(require('fs').readFileSync(job.filePath, 'utf8'));
          const paths = Array.isArray(data) ? data : data.paths;
          const ov = Array.isArray(data) ? {} : Object.fromEntries(Object.entries(data.overrides || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
          // Where this job starts: a start point set by jogging, and/or right after the last job on the roll.
          const st = device.state || {};
          const shift = ov.keepOrigin ? {} : {
            shiftX: (Number(st.startX) || 0) + (st.continueRoll ? (Number(st.rollUsedMm) || 0) : 0),
            shiftY: Number(st.startY) || 0,
          };
          res = await drv.sendPaths({ ...device.config, ...ov, ...shift }, paths, job.name);
          if (res.extentXmm != null && st.continueRoll) {
            const gap = Number(device.config.jobGapMm ?? 12.7) || 0;
            const used = res.extentXmm + gap - (Number(st.startX) || 0);
            store.setDeviceState(device.id, { rollUsedMm: Math.max(Number(st.rollUsedMm) || 0, used), lastJobEndMm: res.extentXmm });
            if (notifyDevice) notifyDevice(store.getDevice(device.id));
          }
        } else res = await drv.sendFile(device.config, job.filePath, ctx);
        update(job, { status: res.warning ? 'warning' : 'done', message: res.message, finishedAt: Date.now() });
        if (job.usage && store.addUsage) store.addUsage({ ...job.usage, date: Date.now(), jobId: job.id, jobName: job.name, deviceName: job.deviceName });
        try { onDone(job); } catch { /* reporting must never break the queue */ }
      } catch (e) {
        update(job, { status: 'error', message: e.message, finishedAt: Date.now() });
        try { onDone(job); } catch { /* history must never break the queue */ }
      }
    }
  } finally {
    busy.delete(deviceId);
  }
}

function setDeviceNotifier(fn) { notifyDevice = fn; }
function setUserSource(fn) { getUser = fn; }

// Cancel one waiting (queued or held) job.
function cancelJob(id) {
  const j = store.getJobs().find((x) => x.id === id);
  if (!j || (j.status !== 'queued' && j.status !== 'held')) return false;
  update(j, { status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() });
  try { onDone(j); } catch { /* history only */ }
  return true;
}

// Pause / resume one machine's queue (jobs stay waiting while paused).
function setPaused(deviceId, paused) {
  store.setDeviceState(deviceId, { paused: !!paused });
  if (!paused) pump(deviceId);
}

// Cancel everything waiting for one machine (queued + held). The job being sent finishes.
function cancelWaiting(deviceId) {
  let n = 0;
  for (const j of store.getJobs()) {
    if (j.deviceId === deviceId && (j.status === 'queued' || j.status === 'held')) {
      Object.assign(j, { status: 'cancelled', message: 'Cancelled', updatedAt: Date.now(), finishedAt: Date.now() });
      notify(j); n++;
      try { onDone(j); } catch { /* history only */ }
    }
  }
  store.saveJobs(store.getJobs());
  return n;
}

function retry(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job) return;
  update(job, { status: 'queued', message: 'Waiting (retry)' });
  pump(job.deviceId);
}

function release(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job || job.status !== 'held') return;
  update(job, { status: 'queued', message: 'Waiting (released)' });
  pump(job.deviceId);
}

function remove(id) {
  store.saveJobs(store.getJobs().filter((j) => j.id !== id || j.status === 'sending'));
}

function clearFinished() {
  store.saveJobs(store.getJobs().filter((j) => j.status === 'queued' || j.status === 'sending' || j.status === 'held'));
}

module.exports = { init, add, retry, release, remove, clearFinished, setPaused, cancelWaiting, cancelJob, setDeviceNotifier, setUserSource };
