const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inksign', {
  catalog: () => ipcRenderer.invoke('catalog'),
  vdp: {
    build: (template, opts) => ipcRenderer.invoke('vdp:build', template, opts),
    openCsv: () => ipcRenderer.invoke('vdp:openCsv'),
  },
  proof: { send: (orderId, proof) => ipcRenderer.invoke('proof:send', orderId, proof) },
  preflight: { check: (items, opts) => ipcRenderer.invoke('preflight:check', items, opts) },
  color: {
    wasm: () => ipcRenderer.invoke('color:wasm'),
    profiles: () => ipcRenderer.invoke('color:profiles'),
    pickProfile: () => ipcRenderer.invoke('color:pickProfile'),
    addProfile: (p) => ipcRenderer.invoke('color:addProfile', p),
    removeProfile: (id) => ipcRenderer.invoke('color:removeProfile', id),
    profileBytes: (id) => ipcRenderer.invoke('color:profileBytes', id),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    save: (item) => ipcRenderer.invoke('library:save', item),
    remove: (id) => ipcRenderer.invoke('library:delete', id),
  },
  cutter: {
    jog: (id, move) => ipcRenderer.invoke('cutter:jog', id, move),
    setStart: (id, here) => ipcRenderer.invoke('cutter:setStart', id, here),
    roll: (id, patch) => ipcRenderer.invoke('cutter:roll', id, patch),
    pause: (id, paused) => ipcRenderer.invoke('cutter:pause', id, paused),
    cancel: (id) => ipcRenderer.invoke('cutter:cancel', id),
  },
  devices: {
    onUpdate: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('devices:update', h); return () => ipcRenderer.removeListener('devices:update', h); },
    list: () => ipcRenderer.invoke('devices:list'),
    save: (d) => ipcRenderer.invoke('devices:save', d),
    remove: (id) => ipcRenderer.invoke('devices:delete', id),
    status: (id) => ipcRenderer.invoke('devices:status', id),
  },
  fonts: {
    list: () => ipcRenderer.invoke('fonts:list'),
    read: (file) => ipcRenderer.invoke('fonts:read', file),
  },
  inkflow: {
    test: (cfg) => ipcRenderer.invoke('inkflow:test', cfg),
    orders: (id) => ipcRenderer.invoke('inkflow:orders', id),
    files: (files) => ipcRenderer.invoke('inkflow:files', files),
    report: (orderId, payload) => ipcRenderer.invoke('inkflow:report', orderId, payload),
    onOpen: (cb) => { const h = (_e, id) => cb(id); ipcRenderer.on('inkflow:open', h); return () => ipcRenderer.removeListener('inkflow:open', h); },
  },
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('updates:state', h); return () => ipcRenderer.removeListener('updates:state', h); },
  },
  onReload: (cb) => { const h = () => cb(); ipcRenderer.on('app:reload', h); return () => ipcRenderer.removeListener('app:reload', h); },
  users: {
    state: () => ipcRenderer.invoke('users:state'),
    login: (id, pin) => ipcRenderer.invoke('users:login', id, pin),
    logout: () => ipcRenderer.invoke('users:logout'),
    save: (list, requireLogin) => ipcRenderer.invoke('users:save', list, requireLogin),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    reprint: (id, deviceId) => ipcRenderer.invoke('history:reprint', id, deviceId),
  },
  timers: {
    list: () => ipcRenderer.invoke('timers:list'),
    start: (t) => ipcRenderer.invoke('timers:start', t),
    stop: (id, opts) => ipcRenderer.invoke('timers:stop', id, opts),
  },
  maint: {
    list: () => ipcRenderer.invoke('maint:list'),
    done: (deviceId, taskId, note) => ipcRenderer.invoke('maint:done', deviceId, taskId, note),
    saveTasks: (deviceId, tasks) => ipcRenderer.invoke('maint:saveTasks', deviceId, tasks),
    log: () => ipcRenderer.invoke('maint:log'),
  },
  shared: {
    publish: () => ipcRenderer.invoke('shared:publish'),
    pull: () => ipcRenderer.invoke('shared:pull'),
  },
  phone: { addresses: () => ipcRenderer.invoke('phone:addresses') },
  shopflow: {
    customers: (q) => ipcRenderer.invoke('inkflow:customers', q),
    quote: (body) => ipcRenderer.invoke('inkflow:quote', body),
    addItems: (orderId, lines) => ipcRenderer.invoke('inkflow:addItems', orderId, lines),
    searchOrders: (q) => ipcRenderer.invoke('inkflow:searchOrders', q),
    rolls: () => ipcRenderer.invoke('inkflow:rolls'),
  },
  onNotice: (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('app:notice', h); return () => ipcRenderer.removeListener('app:notice', h); },
  wide: {
    open: () => ipcRenderer.invoke('wide:open'),
    layout: (items, opts) => ipcRenderer.invoke('wide:layout', items, opts),
    send: (deviceId, items, opts, job) => ipcRenderer.invoke('wide:send', deviceId, items, opts, job),
    save: (items, opts, name) => ipcRenderer.invoke('wide:save', items, opts, name),
  },
  usage: {
    list: () => ipcRenderer.invoke('usage:list'),
    exportCsv: () => ipcRenderer.invoke('usage:export'),
  },
  press: {
    open: () => ipcRenderer.invoke('press:open'),
    impose: (src, opts) => ipcRenderer.invoke('press:impose', src, opts),
    send: (deviceId, src, opts, job) => ipcRenderer.invoke('press:send', deviceId, src, opts, job),
    save: (src, opts, name) => ipcRenderer.invoke('press:save', src, opts, name),
  },
  printcut: {
    openImages: () => ipcRenderer.invoke('files:openImages'),
    print: (deviceId, job) => ipcRenderer.invoke('printcut:print', deviceId, job),
    cut: (deviceId, job) => ipcRenderer.invoke('printcut:cut', deviceId, job),
    savePdf: (job) => ipcRenderer.invoke('printcut:savePdf', job),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (patch) => ipcRenderer.invoke('settings:save', patch),
  },
  files: {
    saveJob: (name, data) => ipcRenderer.invoke('files:saveJob', name, data),
    savePng: (name, dataUrl) => ipcRenderer.invoke('files:savePng', name, dataUrl),
    openJob: () => ipcRenderer.invoke('files:openJob'),
    openSvg: () => ipcRenderer.invoke('files:openSvg'),
    openArt: () => ipcRenderer.invoke('files:openArt'),
    saveCut: (deviceId, job) => ipcRenderer.invoke('files:saveCut', deviceId, job),
  },
  system: {
    printers: () => ipcRenderer.invoke('system:printers'),
    comPorts: () => ipcRenderer.invoke('system:comports'),
    pickFolder: () => ipcRenderer.invoke('system:pickFolder'),
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    sendTest: (deviceId) => ipcRenderer.invoke('jobs:sendTest', deviceId),
    sendFile: (deviceId) => ipcRenderer.invoke('jobs:sendFile', deviceId),
    retry: (id) => ipcRenderer.invoke('jobs:retry', id),
    release: (id) => ipcRenderer.invoke('jobs:release', id),
    remove: (id) => ipcRenderer.invoke('jobs:remove', id),
    sendCut: (deviceId, job) => ipcRenderer.invoke('jobs:sendCut', deviceId, job),
    clearFinished: () => ipcRenderer.invoke('jobs:clearFinished'),
    onUpdate: (cb) => {
      const h = (_e, job) => cb(job);
      ipcRenderer.on('jobs:update', h);
      return () => ipcRenderer.removeListener('jobs:update', h);
    },
  },
});
