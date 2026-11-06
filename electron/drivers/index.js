// Driver registry. To support a new kind of machine, add a driver file here
// (fields + checkStatus + sendTest + sendFile) and a preset in presets.js.
const cutter = require('./cutter');
const flexi = require('./flexiHotFolder');
const net = require('./networkPrinter');
const hpLatex = require('./hpLatex');
const presets = require('./presets');

const DRIVERS = Object.fromEntries([cutter, hpLatex, flexi, net].map((d) => [d.id, d]));

function get(id) {
  const d = DRIVERS[id];
  if (!d) throw new Error(`Unknown driver "${id}"`);
  return d;
}

function defaultsFor(driverId) {
  const out = {};
  for (const f of get(driverId).fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

// Plain-data description for the window (functions can't cross into it).
function catalog() {
  return {
    drivers: Object.values(DRIVERS).map((d) => ({ id: d.id, name: d.name, kind: d.kind, fields: d.fields, fileTypes: d.fileTypes })),
    presets: presets.list,
  };
}

// Choices for drop-downs that depend on other settings (HP media -> its print modes, profiles on this PC)
function fieldOptions(driverId, key, cfg) {
  const d = get(driverId);
  return d.fieldOptions ? d.fieldOptions(key, cfg || {}) : [];
}

module.exports = { get, defaultsFor, catalog, presets, fieldOptions };
