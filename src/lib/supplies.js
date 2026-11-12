// What the HP says about its cartridges and printheads that can hurt print quality: non-HP (refilled /
// compatible) supplies and printheads past their date. Shown in the Print window before a job goes out.
const HEAD_NAME = { CZ677A: 'cyan/black', CZ678A: 'yellow/magenta', CZ679A: 'light cyan/light magenta', CZ680A: 'optimizer' };
const INK_WORD = { K: 'black', C: 'cyan', M: 'magenta', Y: 'yellow', LC: 'light cyan', LM: 'light magenta', OP: 'optimizer' };

const headName = (h) => `${HEAD_NAME[h.product] || 'printhead'} head (slot ${h.slot})`;
const inkName = (k) => `${INK_WORD[k.code] || k.name || k.code}${k.code === 'OP' ? '' : ' ink'}`;

/** printer: { ink: [{ code, state }], heads: [{ slot, product, state }] } -> { nonHp: [..], expired: [..] } | null */
export function supplyWarnings(printer) {
  if (!printer) return null;
  const nonHp = [
    ...(printer.ink || []).filter((k) => /nonhp/i.test(k.state || '')).map(inkName),
    ...(printer.heads || []).filter((h) => /nonhp/i.test(h.state || '')).map(headName),
  ];
  const expired = [
    ...(printer.ink || []).filter((k) => /expired/i.test(k.state || '')).map(inkName),
    ...(printer.heads || []).filter((h) => /expired/i.test(h.state || '')).map(headName),
  ];
  return nonHp.length || expired.length ? { nonHp, expired } : null;
}
