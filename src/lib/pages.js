// Several pages in one design (front and back, or the panels of a sign set). All pages share the page
// size. The page on screen keeps its objects in doc.objects as before; the others wait in doc.sheets.
// doc.sheets = [{ id, name, objects }], doc.sheet = index of the page on screen.
let seq = 0;
const pid = () => `pg${Date.now().toString(36)}${(seq++).toString(36)}`;

/** All pages, with the one on screen up to date */
export function pagesOf(doc) {
  if (!doc.sheets || !doc.sheets.length) return [{ id: 'p1', name: 'Page 1', objects: doc.objects }];
  const cur = Math.min(doc.sheet || 0, doc.sheets.length - 1);
  return doc.sheets.map((s, i) => (i === cur ? { ...s, objects: doc.objects } : s));
}
export const pageIndex = (doc) => (doc.sheets && doc.sheets.length ? Math.min(doc.sheet || 0, doc.sheets.length - 1) : 0);
export const pageCount = (doc) => (doc.sheets && doc.sheets.length) || 1;

/** The doc ready to save: every page's objects stored */
export function syncPages(doc) {
  if (!doc.sheets || !doc.sheets.length) return doc;
  return { ...doc, sheets: pagesOf(doc) };
}
export function goToPage(doc, i) {
  const list = pagesOf(doc);
  const n = Math.max(0, Math.min(list.length - 1, i));
  if (!doc.sheets || n === pageIndex(doc)) return doc;
  return { ...doc, sheets: list, sheet: n, objects: list[n].objects };
}
export function addPage(doc, { objects = [], after = null, name } = {}) {
  const list = pagesOf(doc);
  const at = (after == null ? pageIndex(doc) : after) + 1;
  const pg = { id: pid(), name: name || `Page ${list.length + 1}`, objects };
  const next = [...list.slice(0, at), pg, ...list.slice(at)];
  return { ...doc, sheets: next, sheet: at, objects };
}
export function removePage(doc, i = pageIndex(doc)) {
  const list = pagesOf(doc);
  if (list.length < 2) return doc;
  const next = list.filter((_, k) => k !== i);
  const cur = Math.min(i, next.length - 1);
  return { ...doc, sheets: next.length > 1 ? next : undefined, sheet: next.length > 1 ? cur : undefined, objects: next[cur].objects };
}
export function renamePage(doc, i, name) {
  const list = pagesOf(doc).map((s, k) => (k === i ? { ...s, name } : s));
  return { ...doc, sheets: list };
}
/** A copy of the doc showing page i (for printing or exporting one page) */
export function docForPage(doc, i) {
  const list = pagesOf(doc);
  return { ...doc, objects: list[i].objects };
}
