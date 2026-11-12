// One job queue per device: jobs to the same machine go one at a time, different machines run in parallel.
// Waiting jobs go in their own order (move up / down / to the top), can be moved to another machine of the
// same kind, and a job being sent can be stopped on drivers that support it (the HP Latex).
let store, drivers, notify, onDone = () => {}, notifyDevice = null, getUser = null;
let thumbMaker = null, thumbRemover = null;
const busy = new Set();
const controllers = new Map(); // job id -> { aborted } for the job being sent

const WAITING = (s) => s === 'queued' || s === 'held';
const FINISHED = (s) => s === 'done' || s === 'warning' || s === 'error' || s === 'cancelled';
const orderOf = (j) => (Number.isFinite(j.order) ? j.order : j.createdAt);

function init(s, d, onUpdate, onFinished) {
  store = s; drivers = d; notify = onUpdate; if (onFinished) onDone = onFinished;
  controllers.clear();
  const jobs = store.getJobs().map((j) =>
    j.status === 'queued' || j.status === 'sending' ? { ...j, status: 'error', message: 'Interrupted — InkSign was closed', progress: null } : j);
  store.saveJobs(jobs);
}

/** fn(job) -> Promise<{ thumb?, info? }> — makes the picture shown in the queue (set by main) */
function setThumbMaker(make, remove) { thumbMaker = make || null; thumbRemover = remove || null; }

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  store.saveJobs(store.getJobs());
  notify(job);
}

function makeThumb(job) {
  if (!thumbMaker) return;
  Promise.resolve()
    .then(() => thumbMaker(job))
    .then((r) => {
      if (!r) return;
      const live = store.getJobs().find((j) => j.id === job.id);
      if (live) update(live, { thumb: r.thumb || live.thumb || null, info: { ...(live.info || {}), ...(r.info || {}) } });
    })
    .catch(() => { /* the queue works without a picture */ });
}

// What the job prints on, in words (HP: media + print mode), from the driver when it can tell
function describe(device, options) {
  try {
    const drv = drivers.get(device.driver);
    return drv.describe ? drv.describe(device.config || {}, options || {}) : '';
  } catch { return ''; }
}

function add({ deviceId, action, filePath, name, copies, options, hold, holdMessage, usage, inkflow, meta, user }) {
  const device = store.getDevice(deviceId);
  if (!device) throw new Error('Device not found');
  const job = {
    id: store.newId(), deviceId, deviceName: device.name, action, filePath: filePath || null, copies: copies || null, options: options || null, usage: usage || null, inkflow: inkflow || null, meta: meta || null, user: user || (getUser ? getUser() : null),
    name: name || (action === 'test' ? 'Test job' : require('path').basename(filePath || 'job')),
    status: hold ? 'held' : 'queued', message: hold ? (holdMessage || 'Held — press Release to print') : 'Waiting', createdAt: Date.now(), updatedAt: Date.now(),
    order: Date.now() + Math.random() / 1000, progress: null, thumb: null, info: { setup: describe(device, options) },
  };
  store.saveJobs([...store.getJobs(), job]);
  notify(job);
  makeThumb(job);
  pump(deviceId);
  return job;
}

const nextFor = (deviceId) => store.getJobs()
  .filter((j) => j.deviceId === deviceId && j.status === 'queued')
  .sort((a, b) => orderOf(a) - orderOf(b))[0];

async function pump(deviceId) {
  if (busy.has(deviceId)) return;
  busy.add(deviceId);
  try {
    let job;
    while ((job = nextFor(deviceId))) {
      if (store.getDevice(deviceId)?.state?.paused) break; // queue paused (queue page or cutter controls)
      const ctl = { aborted: false };
      controllers.set(job.id, ctl);
      update(job, { status: 'sending', message: 'Sending…', startedAt: Date.now(), progress: 0 });
      try {
        const device = store.getDevice(deviceId);
        if (!device) throw new Error('Device was removed');
        const drv = drivers.get(device.driver);
        const miss = drv.missing(device.config);
        if (miss.length) throw new Error(`Device needs setup: ${miss.join(', ')}`);
        let lastMsg = 0;
        const progress = (text, fraction) => {
          if (ctl.aborted || Date.now() - lastMsg < 500) return;
          lastMsg = Date.now();
          update(job, { message: text, ...(Number.isFinite(fraction) ? { progress: Math.max(0, Math.min(1, fraction)) } : {}) });
        };
        const ctx = { jobName: job.name, deviceName: device.name, copies: job.copies, options: job.options || {}, progress, signal: ctl };
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
        if (ctl.aborted || res.aborted) {
          update(job, { status: 'cancelled', progress: null, finishedAt: Date.now(),
            message: res.aborted ? (res.message || 'Cancelled while sending') : 'Cancel came too late — the whole job had already gone to the machine. Stop it on the machine.' });
        } else {
          update(job, { status: res.warning ? 'warning' : 'done', message: res.message, finishedAt: Date.now(), progress: 1 });
          if (job.usage && store.addUsage) store.addUsage({ ...job.usage, date: Date.now(), jobId: job.id, jobName: job.name, deviceName: job.deviceName });
        }
        try { onDone(job); } catch { /* reporting must never break the queue */ }
      } catch (e) {
        update(job, { status: ctl.aborted ? 'cancelled' : 'error', message: ctl.aborted ? `Cancelled (${e.message})` : e.message, finishedAt: Date.now(), progress: null });
        try { onDone(job); } catch { /* history must never break the queue */ }
      } finally {
        controllers.delete(job.id);
      }
    }
  } finally {
    busy.delete(deviceId);
  }
}

function setDeviceNotifier(fn) { notifyDevice = fn; }
function setUserSource(fn) { getUser = fn; }

/** Can this job be stopped while it's being sent? (the driver has to support it) */
function canAbort(job) {
  try {
    const d = store.getDevice(job.deviceId);
    return !!(d && drivers.get(d.driver).canAbort);
  } catch { return false; }
}

// Cancel one job: waiting (queued / held) jobs come off the queue; a job being sent is stopped when its
// driver supports it. Returns true when something was cancelled or a stop was asked for.
function cancelJob(id) {
  const j = store.getJobs().find((x) => x.id === id);
  if (!j) return false;
  if (j.status === 'sending') {
    const ctl = controllers.get(id);
    if (!ctl || !canAbort(j)) return false;
    ctl.aborted = true;
    update(j, { message: 'Stopping…' });
    return true;
  }
  if (!WAITING(j.status)) return false;
  update(j, { status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() });
  try { onDone(j); } catch { /* history only */ }
  return true;
}

// Pause / resume one machine's queue (jobs stay waiting while paused).
function setPaused(deviceId, paused) {
  store.setDeviceState(deviceId, { paused: !!paused });
  if (notifyDevice) notifyDevice(store.getDevice(deviceId));
  if (!paused) pump(deviceId);
}

// Cancel everything waiting for one machine (queued + held). The job being sent finishes.
function cancelWaiting(deviceId) {
  let n = 0;
  for (const j of store.getJobs()) {
    if (j.deviceId === deviceId && WAITING(j.status)) {
      Object.assign(j, { status: 'cancelled', message: 'Cancelled', updatedAt: Date.now(), finishedAt: Date.now() });
      notify(j); n++;
      try { onDone(j); } catch { /* history only */ }
    }
  }
  store.saveJobs(store.getJobs());
  return n;
}

/** Waiting jobs for one machine in the order they'll go */
function waitingFor(deviceId) {
  return store.getJobs().filter((j) => j.deviceId === deviceId && WAITING(j.status)).sort((a, b) => orderOf(a) - orderOf(b));
}

// Move a waiting job: 'up' / 'down' one place, or to the 'top' / 'bottom' of its machine's queue
function move(id, where) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job || !WAITING(job.status)) return false;
  const list = waitingFor(job.deviceId);
  const i = list.findIndex((j) => j.id === id);
  let to = i;
  if (where === 'up') to = i - 1;
  else if (where === 'down') to = i + 1;
  else if (where === 'top') to = 0;
  else if (where === 'bottom') to = list.length - 1;
  to = Math.max(0, Math.min(list.length - 1, to));
  if (to === i) return false;
  list.splice(i, 1);
  list.splice(to, 0, job);
  // renumber this machine's waiting jobs in their new order (keeps them after anything already sent)
  const base = Math.min(...list.map(orderOf));
  list.forEach((j, k) => { j.order = base + k; j.updatedAt = Date.now(); });
  store.saveJobs(store.getJobs());
  list.forEach((j) => notify(j));
  return true;
}

// Send a waiting job to another machine of the same kind; it goes to the end of that machine's queue
function reassign(id, deviceId) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job || !WAITING(job.status)) throw new Error('Only waiting jobs can be moved');
  const to = store.getDevice(deviceId), from = store.getDevice(job.deviceId);
  if (!to) throw new Error('Device not found');
  if (from && from.driver !== to.driver) throw new Error(`${to.name} is a different kind of machine — send the job from the Print window instead`);
  const last = waitingFor(deviceId).pop();
  update(job, { deviceId: to.id, deviceName: to.name, order: last ? orderOf(last) + 1 : Date.now(), info: { ...(job.info || {}), setup: describe(to, job.options) } });
  pump(to.id);
  return job;
}

// Print a finished job again (same file and settings, as a new job at the end of the queue)
function reprint(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job) throw new Error('Job not found');
  if (job.action !== 'test' && (!job.filePath || !require('fs').existsSync(job.filePath))) throw new Error('The print file for this job is gone — send it again from where you made it');
  const again = add({ deviceId: job.deviceId, action: job.action, filePath: job.filePath, name: job.name, copies: job.copies, options: job.options, usage: job.usage, meta: job.meta });
  if (job.thumb && !again.thumb) update(again, { thumb: job.thumb, info: { ...(job.info || {}), ...(again.info || {}) } });
  return again;
}

function retry(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job) return;
  update(job, { status: 'queued', message: 'Waiting (retry)', progress: null });
  pump(job.deviceId);
}

function release(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job || job.status !== 'held') return;
  update(job, { status: 'queued', message: 'Waiting (released)' });
  pump(job.deviceId);
}

// pictures still used by jobs that stay (a reprint shares its original's picture)
function dropThumbs(gone, kept) {
  if (!thumbRemover) return;
  const inUse = new Set(kept.map((j) => j.thumb).filter(Boolean));
  for (const j of gone) if (j.thumb && !inUse.has(j.thumb)) { try { thumbRemover(j.thumb); } catch { /* already gone */ } }
}

function remove(id) {
  const all = store.getJobs();
  const keep = all.filter((j) => j.id !== id || j.status === 'sending');
  store.saveJobs(keep);
  dropThumbs(all.filter((j) => !keep.includes(j)), keep);
}

function clearFinished(deviceId) {
  const all = store.getJobs();
  const keep = all.filter((j) => !FINISHED(j.status) || (deviceId && j.deviceId !== deviceId));
  store.saveJobs(keep);
  dropThumbs(all.filter((j) => !keep.includes(j)), keep);
}

module.exports = {
  init, add, retry, release, remove, clearFinished, setPaused, cancelWaiting, cancelJob, move, reassign, reprint,
  canAbort, setDeviceNotifier, setUserSource, setThumbMaker,
};
