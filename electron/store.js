// Saves devices and job history as JSON in the app's data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const drivers = require('./drivers');

let dir = null;
let devices = [];
let jobs = [];

function file(name) { return path.join(dir, name); }
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJson(name, data) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

function newId() { return crypto.randomUUID(); }

function deviceFromPreset(presetId, name) {
  const p = drivers.presets.byId(presetId);
  if (!p) throw new Error(`Unknown preset ${presetId}`);
  return {
    id: newId(), name: name || p.name, presetId: p.id, driver: p.driver, kind: p.kind,
    config: { ...drivers.defaultsFor(p.driver), ...p.config },
  };
}

function init(userDataDir) {
  dir = userDataDir;
  fs.mkdirSync(dir, { recursive: true });
  devices = readJson('devices.json', null);
  if (!Array.isArray(devices)) {
    devices = drivers.presets.shopDefaults.map((d) => deviceFromPreset(d.presetId, d.name));
    writeJson('devices.json', devices);
  }
  // Xerox set up before the print server: tell InkSign which printer description (PPD) it uses
  let migrated = false;
  for (const d of devices) {
    if (d.presetId === 'xerox-7845' && !d.config?.model) { d.config = { ...d.config, model: 'xerox-7845' }; migrated = true; }
  }
  if (migrated) writeJson('devices.json', devices);
  jobs = readJson('jobs.json', []);
}

const getDevices = () => devices;
const getDevice = (id) => devices.find((d) => d.id === id);

function saveDevice(dev) {
  if (!dev.id) {
    const created = deviceFromPreset(dev.presetId, dev.name);
    created.config = { ...created.config, ...(dev.config || {}) };
    devices.push(created);
    writeJson('devices.json', devices);
    return created;
  }
  const i = devices.findIndex((d) => d.id === dev.id);
  if (i < 0) throw new Error('Device not found');
  devices[i] = { ...devices[i], name: dev.name, config: { ...devices[i].config, ...dev.config } };
  writeJson('devices.json', devices);
  return devices[i];
}

// Live state of a machine that isn't a setting: where the cutter's blade was jogged to, where the
// next job starts, how much of the loaded roll is used, whether its queue is paused.
function setDeviceState(id, patch) {
  const i = devices.findIndex((d) => d.id === id);
  if (i < 0) throw new Error('Device not found');
  devices[i] = { ...devices[i], state: { ...(devices[i].state || {}), ...patch } };
  writeJson('devices.json', devices);
  return devices[i];
}

function deleteDevice(id) {
  devices = devices.filter((d) => d.id !== id);
  writeJson('devices.json', devices);
}

const getJobs = () => jobs;
function saveJobs(list) {
  jobs = list.slice(-300);
  writeJson('jobs.json', jobs);
}

// ---- Settings (materials, pricing) ----
const DEFAULT_SETTINGS = {
  materials: [
    { id: 'calendared', name: 'Calendared vinyl', costPerFt: 1.25, rollWidthIn: 24, speed: '', force: '', overcutMm: 0.5, note: 'Enter force/speed from your test cut' },
    { id: 'cast', name: 'Cast vinyl', costPerFt: 2.5, rollWidthIn: 24, speed: '', force: '', overcutMm: 0.5, note: '' },
    { id: 'htv', name: 'Heat transfer vinyl (HTV)', costPerFt: 2.0, rollWidthIn: 15, speed: '', force: '', overcutMm: 0.3, mirror: true, note: 'Cuts mirrored automatically' },
    { id: 'reflective', name: 'Reflective', costPerFt: 6.0, rollWidthIn: 24, speed: '', force: '', overcutMm: 0.5, note: 'Usually needs more force and slower speed' },
    { id: 'stencil', name: 'Sandblast / paint mask', costPerFt: 3.0, rollWidthIn: 24, speed: '', force: '', overcutMm: 0.5, note: '' },
  ],
  pricing: { laborPerHour: 45, weedMinPerFt: 0.4, setupMin: 5, markup: 2.0, minimum: 15 },
  wideMedia: [
    { name: 'Banner 13oz', costPerSqFt: 0.35, inkMlPerSqFt: 1.1 },
    { name: 'Adhesive vinyl', costPerSqFt: 0.65, inkMlPerSqFt: 1.0 },
    { name: 'Window perf', costPerSqFt: 0.9, inkMlPerSqFt: 0.9 },
    { name: 'Canvas', costPerSqFt: 1.5, inkMlPerSqFt: 1.4 },
    { name: 'Wallpaper', costPerSqFt: 1.1, inkMlPerSqFt: 1.0 },
  ],
  inkCostPerMl: 0.2,
  // Paper catalog for the Xerox print server (Fiery-style). Types are the Xerox 7845 driver's media
  // types — match each to what the stock is programmed as at the Xerox tray.
  paperCatalog: [
    { id: 'pc-letter-bond', name: 'Letter 24# bond', size: 'Letter', type: 'Plain', color: 'White', weightGsm: 90, coated: false, tray: 'auto', costPerSheet: 0.02 },
    { id: 'pc-letter-gloss-text', name: 'Letter 100# gloss text', size: 'Letter', type: 'LightweightGlossyCardstock', color: 'White', weightGsm: 148, coated: true, tray: 'auto', costPerSheet: 0.08 },
    { id: 'pc-letter-cover', name: 'Letter 80# cover', size: 'Letter', type: 'ThinCardStock', color: 'White', weightGsm: 216, coated: false, tray: 'auto', costPerSheet: 0.12 },
    { id: 'pc-tabloid-text', name: '11x17 70# text', size: 'Tabloid', type: 'Plain', color: 'White', weightGsm: 104, coated: false, tray: 'auto', costPerSheet: 0.06 },
    { id: 'pc-tabloid-gloss', name: '11x17 100# gloss text', size: 'Tabloid', type: 'LightweightGlossyCardstock', color: 'White', weightGsm: 148, coated: true, tray: 'auto', costPerSheet: 0.16 },
    { id: 'pc-12x18-gloss-cover', name: '12x18 100# gloss cover', size: '12x18', type: 'HeavyweightGlossyCardstock', color: 'White', weightGsm: 270, coated: true, tray: 'auto', costPerSheet: 0.35 },
    { id: 'pc-12x18-14pt', name: '12x18 14pt card (business cards)', size: '12x18', type: 'HeavyweightCardstock', color: 'White', weightGsm: 300, coated: false, tray: 'Tray5', costPerSheet: 0.4 },
    { id: 'pc-letter-labels', name: 'Letter labels', size: 'Letter', type: 'Labels', color: 'White', weightGsm: null, coated: false, tray: 'auto', costPerSheet: 0.3 },
  ],
  inkflow: { url: '', secret: '', autoReport: true },
  updateUrl: '',
  watchFolders: [],
  colors: [
    { name: 'Black', hex: '#000000', cmyk: '0,0,0,100' },
    { name: 'White', hex: '#ffffff', cmyk: '0,0,0,0' },
    { name: 'Red', hex: '#d0202e', cmyk: '0,100,90,5' },
    { name: 'Royal blue', hex: '#1f3f9a', cmyk: '100,80,0,5' },
    { name: 'Yellow', hex: '#ffd200', cmyk: '0,15,100,0' },
    { name: 'Green', hex: '#00843d', cmyk: '100,0,100,20' },
    { name: 'Orange', hex: '#ff7a1a', cmyk: '0,60,100,0' },
    { name: 'Silver metallic', hex: '#a8a9ad', cmyk: '0,0,0,40' },
    { name: 'Gold metallic', hex: '#b5964d', cmyk: '0,20,70,30' },
  ],
};

function getSettings() {
  const s = readJson('settings.json', null);
  return { ...DEFAULT_SETTINGS, ...(s || {}), colors: (s && s.colors) || DEFAULT_SETTINGS.colors, wideMedia: (s && s.wideMedia) || DEFAULT_SETTINGS.wideMedia, pricing: { ...DEFAULT_SETTINGS.pricing, ...((s && s.pricing) || {}) } };
}
function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson('settings.json', next);
  return next;
}

// ---- Shared setup from the main shop PC ----
// Settings and library are replaced; devices are merged by id, keeping this PC's own connection
// (USB printer name, COM port) and live state (roll position, meters).
function importShared({ settings, devices: shared, library, localKeys }) {
  saveSettings(settings || {});
  if (Array.isArray(library)) writeJson('library.json', library);
  if (Array.isArray(shared)) {
    const mine = new Map(devices.map((d) => [d.id, d]));
    devices = shared.map((s) => {
      const m = mine.get(s.id);
      const keep = m ? Object.fromEntries(Object.entries(m.config).filter(([k]) => localKeys.includes(k))) : {};
      return { ...(m || {}), id: s.id, name: s.name, presetId: s.presetId, driver: s.driver, kind: s.kind, config: { ...drivers.defaultsFor(s.driver), ...s.config, ...keep }, state: m ? m.state : undefined };
    });
    writeJson('devices.json', devices);
  }
}

// ---- Clip-art library (saved logos, shapes, layouts) ----
function getLibrary() { return readJson('library.json', []); }
function saveLibraryItem(item) {
  const list = getLibrary();
  const it = { ...item, id: item.id || newId(), savedAt: Date.now() };
  const i = list.findIndex((x) => x.id === it.id);
  if (i >= 0) list[i] = it; else list.push(it);
  writeJson('library.json', list);
  return it;
}
function deleteLibraryItem(id) { writeJson('library.json', getLibrary().filter((x) => x.id !== id)); }

// ---- Usage log (media & ink per job) ----
function getUsage() { return readJson('usage.json', []); }
function addUsage(entry) {
  const list = getUsage();
  list.push(entry);
  writeJson('usage.json', list.slice(-5000));
}

module.exports = { importShared, getLibrary, saveLibraryItem, deleteLibraryItem, setDeviceState, getUsage, addUsage, getSettings, saveSettings, init, getDevices, getDevice, saveDevice, deleteDevice, getJobs, saveJobs, newId };
