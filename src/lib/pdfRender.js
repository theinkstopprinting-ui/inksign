// Render PDF pages to small images for previews.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function renderPages(bytes, { maxPages = 4, width = 520 } = {}) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const out = [];
  const sizes = [];
  for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
    const page = await pdf.getPage(i);
    const v = page.getViewport({ scale: 1 });
    sizes.push({ widthIn: v.width / 72, heightIn: v.height / 72 });
    const vp = page.getViewport({ scale: width / v.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    out.push(c.toDataURL('image/png'));
  }
  return { images: out, pages: pdf.numPages, sizes };
}

export const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
